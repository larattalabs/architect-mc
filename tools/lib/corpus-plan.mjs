// (gate speed 3, lever A) The drivers' plan calls, cached per call and shared by every driver of a run, and planned on every core.
//
// fl-unit, s3-unit, f3-unit, kc-unit and irr-unit each planned the whole committed fixture corpus twice (this head and the merge
// base, for "byte-identical against the merge base"), one fixture after another, and the 59 asks again for their asks tables:
// about 12 CPU-minutes per tree per driver, the same answers each time. Here:
//
//   helpers(dir, o)   dir's kit/test/plan-helpers.mjs, with checkPlanVolumes and checkPlanLocal answered from a content-keyed store
//                     (a "record": the check, the IR's JSON and the first plan's, exactly as the call returned them). The key is the
//                     exact call: its shape, the plan, every option (the survey as its sha), dir's kit and scenarios trees (clean
//                     only; a dirty tree is never cached), Node's version and ARCHITECT_BIG_REGIONS. plan-helpers reads nothing else
//                     (tools/lib/plan-cache.mjs). A hit returns a lite result: { check, res: { irJson }, first: { check, res } | null }
//                     (what the drivers' signatures read), and `derived` for the named extras (corpus-derive.mjs) that need the
//                     whole result (KC's census, F3's M18/M19), computed with the head's kit and keyed by its tree too. A miss runs
//                     the call and returns the lite result built from the record it stores, so a hit and a miss read alike.
//   prewarm(jobs)     runs jobs ({ module, export, args }) on a worker_threads pool first, longest first (the last run's times), so
//                     the driver's own loop then reads every answer from the store. Jobs another process is planning are waited for.
//
// Every entry is its own file (written atomically), and planned under its own lock, so concurrent drivers, and their split parts,
// share each other's work within a run; the base's entries stay valid for every run on that base.
//
// Switches: GATE_PLAN_CACHE=0 (the exact old path: no store, no pool), GATE_PLAN_WORKERS=<n> (1: no pool, the loop plans serially),
// GATE_PLAN_CACHE_DIR (the store; default <main checkout>/artifacts/plan-cache/calls-v2, untracked; deleting it only costs a re-run).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firstAsk } from './asks-first.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// (speed audit A) v2: a record carries the plan's artifact (`art`), which coa-unit's signatures compare. A v1 entry has none and is
// never read (a different directory), so no signature can compare an absent artifact with an absent artifact.
const SCHEMA = 'calls-v2';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const cacheOn = () => process.env.GATE_PLAN_CACHE !== '0';

/** `<kit tree>-<scenarios tree>` of `dir`'s HEAD when both are clean there, else null (never cached). Memoised per process. */
const treeMemo = new Map();
export function treesOf(dir) {
  if (treeMemo.has(dir)) return treeMemo.get(dir);
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const st = git('status', '--porcelain', '--', 'kit', 'scenarios');
  const k = git('rev-parse', 'HEAD:kit');
  const s = git('rev-parse', 'HEAD:scenarios');
  const t = st.status !== 0 || k.status !== 0 || s.status !== 0 || st.stdout.trim() ? null : `${k.stdout.trim().slice(0, 16)}-${s.stdout.trim().slice(0, 16)}`;
  treeMemo.set(dir, t);
  return t;
}

export function storeDir(dir) {
  if (process.env.GATE_PLAN_CACHE_DIR) return process.env.GATE_PLAN_CACHE_DIR;
  // the main checkout (every run worktree and base tree is its sibling); a checkout elsewhere keeps its own
  const main = path.resolve(dir, '..', 'architect-mc');
  return path.join(fs.existsSync(path.join(main, '.git')) ? main : dir, 'artifacts', 'plan-cache', SCHEMA);
}

// ---- the key: the exact call ------------------------------------------------------------------------------------------------

// options whose value equals checkPlanLocal's / checkPlanVolumes' own default are dropped (the call is the same call either way)
const DEFAULTS = { anchors: {}, protected: [], regions: [], builds: [], standing: null, biomes: null, budget: {}, bible: null, fingerprint: null, keepOut: [], planCache: null, volumes: [], style: null, lotBlocks: null, survival: false, volume: {} };
const canon = (v) => {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $sha: sha256(v) };
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canon(v[k])]));
  return v;
};
function callKey(shape, plan, opts) {
  const o = {};
  for (const [k, v] of Object.entries(opts ?? {})) {
    if (v === undefined) continue;
    if (k in DEFAULTS && JSON.stringify(canon(v)) === JSON.stringify(DEFAULTS[k])) continue;
    o[k] = v;
  }
  if (o.planCache) return null; // a caller's own plan cache: stateful, never cached here
  return sha256(JSON.stringify([SCHEMA, shape, process.version, process.env.ARCHITECT_BIG_REGIONS ?? null, canon(plan), canon(o)]));
}

// ---- the store: one gzipped JSON file per entry, written atomically -------------------------------------------------------------

const entryFile = (dir, trees, key) => path.join(storeDir(dir), trees, key.slice(0, 2), `${key}.json.gz`);
function readEntry(file) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { return null; }
}
/** A plan record: an entry that carries its artifact (any other is a miss, re-planned and rewritten). */
function readRecord(file) {
  const e = readEntry(file);
  return e && typeof e.art === 'string' ? e : null;
}
function writeEntry(file, v) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(v), { level: 1 }));
    fs.renameSync(tmp, file);
  } catch { /* a cache: never fails a gate */ }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// -> true when this process holds the entry's lock; false when another live process does (wait for its entry)
function tryLock(file) {
  const lock = `${file}.lock`;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* */ }
  for (let i = 0; i < 3; i++) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}`); return true; } catch (e) {
      if (e.code !== 'EEXIST') return true; // can't lock (read-only?): plan it ourselves
      let owner = 0, age = 0;
      try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch { /* being written */ }
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
      if ((owner && !alive(owner)) || age > 30 * 60_000 || (!owner && age > 30_000)) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      return false;
    }
  }
  return true;
}
const unlock = (file) => fs.rmSync(`${file}.lock`, { recursive: true, force: true });

// per process: what the store did (the drivers print it)
export const stats = { hit: 0, miss: 0, waited: 0, uncached: 0, deriveMiss: 0 };

// ---- the record and the lite result ------------------------------------------------------------------------------------------

function record(r) {
  const first = r.first == null ? { kind: 'none' } : r.first === r ? { kind: 'self' } : { kind: 'obj', check: JSON.stringify(r.first.check), irJson: r.first.res?.irJson ?? null };
  // (speed audit A) the artifact as the call returned it (null: the plan made none, a legitimate answer); a result with no `artifact`
  // property at all is a different thing and is never stored
  if (!('artifact' in r)) throw new Error('corpus-plan: the plan result carries no artifact property');
  return { check: JSON.stringify(r.check), irJson: r.res?.irJson ?? null, first, asked: r.asked ?? null, art: JSON.stringify(r.artifact ?? null) };
}
function lite(rec, derived) {
  const r = { check: JSON.parse(rec.check), res: { irJson: rec.irJson }, cached: true };
  if (rec.first.kind === 'self') r.first = r;
  else if (rec.first.kind === 'obj') r.first = { check: JSON.parse(rec.first.check), res: { irJson: rec.first.irJson } };
  else r.first = undefined;
  if (rec.asked) r.asked = rec.asked;
  r.artifact = JSON.parse(rec.art); // (speed audit A) a record without `art` is not an entry (readRecord)
  r.derived = derived ?? {};
  return r;
}

// ---- helpers(dir): the cached plan-helpers --------------------------------------------------------------------------------------

const memo = new Map();
/**
 * dir's plan-helpers with the two plan calls cached. o.derive: names from corpus-derive.mjs to compute on every result (r.derived),
 * with o.headRoot's kit (the checkout under test). GATE_PLAN_CACHE=0: the module itself, unchanged.
 */
export async function helpers(dir, { derive = [], headRoot = null } = {}) {
  const h = await import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  if (!cacheOn()) return h;
  const mk = JSON.stringify([dir, derive, headRoot]);
  if (memo.has(mk)) return memo.get(mk);
  const D = derive.length ? await import(pathToFileURL(path.join(HERE, 'corpus-derive.mjs')).href) : null;
  const dSrc = derive.length ? sha256(fs.readFileSync(path.join(HERE, 'corpus-derive.mjs'))) : null;
  const wrap = (shape) => async (plan, opts = {}) => {
    const trees = treesOf(dir);
    const headTrees = derive.length ? treesOf(headRoot) : '-';
    const key = trees ? callKey(shape, plan, opts) : null;
    const run = async () => {
      const r = await h[shape](plan, opts);
      const derived = {};
      for (const n of derive) derived[n] = await D.DERIVE[n](r, opts, { headRoot, dir });
      return { r, derived };
    };
    if (!key || !headTrees) {
      stats.uncached++;
      const { r, derived } = await run();
      r.derived = derived;
      return r;
    }
    const file = entryFile(dir, trees, key);
    const dKey = (n) => sha256(JSON.stringify([key, n, headTrees, dSrc]));
    const dFile = (n) => entryFile(dir, trees, dKey(n));
    for (let waited = false; ;) {
      const rec = readRecord(file);
      const ds = rec ? Object.fromEntries(derive.map((n) => [n, readEntry(dFile(n))])) : null;
      if (rec && derive.every((n) => ds[n])) {
        if (waited) stats.waited++; else stats.hit++;
        return lite(rec, Object.fromEntries(derive.map((n) => [n, ds[n].v])));
      }
      if (tryLock(file)) {
        try {
          // (re-read under the lock: another process may have just written it)
          const again = readRecord(file);
          const dsAgain = again ? Object.fromEntries(derive.map((n) => [n, readEntry(dFile(n))])) : null;
          if (again && derive.every((n) => dsAgain[n])) { stats.hit++; return lite(again, Object.fromEntries(derive.map((n) => [n, dsAgain[n].v]))); }
          if (again) stats.deriveMiss++; else stats.miss++;
          const t0 = performance.now();
          const { r, derived } = await run(); // an error is thrown, never stored (a checkout mid-move must not stick)
          const rec2 = record(r);
          rec2.ms = Math.round(performance.now() - t0);
          if (!again) writeEntry(file, rec2);
          for (const n of derive) writeEntry(dFile(n), { v: derived[n] ?? null });
          return lite(again ?? rec2, derived);
        } finally { unlock(file); }
      }
      waited = true;
      await sleep(250);
    }
  };
  const w = { ...h, checkPlanVolumes: wrap('checkPlanVolumes'), checkPlanLocal: wrap('checkPlanLocal'), cachedHelpers: true };
  memo.set(mk, w);
  return w;
}

// ---- prewarm: the jobs on every core first -------------------------------------------------------------------------------------

const timesFile = (root) => path.join(storeDir(root), 'times.json');
function readTimes(root) { try { return JSON.parse(fs.readFileSync(timesFile(root), 'utf8')); } catch { return {}; } }
function writeTimes(root, add) {
  try {
    const t = { ...readTimes(root), ...add };
    fs.mkdirSync(path.dirname(timesFile(root)), { recursive: true });
    const tmp = `${timesFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t));
    fs.renameSync(tmp, timesFile(root));
  } catch { /* */ }
}

/**
 * The pool's size: GATE_PLAN_WORKERS, else the cores the machine has free now, at least 4 and at most cores - 1. (A floor: the 1-min
 * load lags, and under a turbo run it reads 30-70 on 18 cores, which left one worker, the serial loop, exactly when a driver sits on
 * the run's critical path; four CPU-bound workers on a busy machine only share it.)
 */
export function poolSize(jobs) {
  const env = Number(process.env.GATE_PLAN_WORKERS);
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  const n = Number.isFinite(env) && env >= 1 ? Math.floor(env) : Math.max(Math.min(4, cpus - 1), Math.min(cpus - 1, Math.floor(cpus - os.loadavg()[0])));
  return Math.max(1, Math.min(n, jobs));
}

/**
 * jobs: [{ id, module, export, args }] (args structured-cloneable; the export runs in a worker and plans through helpers(), filling
 * the store). Longest first by the last run's times. Never throws: a job that fails is left to the driver's own loop (which plans
 * it again and reports it as it always did). -> { jobs, workers, ms, failed }.
 */
export async function prewarm(root, jobs, { log = () => {} } = {}) {
  if (!cacheOn() || !jobs.length) return { jobs: jobs.length, workers: 0, ms: 0, failed: 0 };
  const workers = poolSize(jobs.length);
  if (workers <= 1) return { jobs: jobs.length, workers: 1, ms: 0, failed: 0, skipped: 'one worker: the loop plans serially' };
  const { Worker } = await import('node:worker_threads');
  const times = readTimes(root);
  const queue = [...jobs].sort((a, b) => (times[b.id] ?? 0) - (times[a.id] ?? 0));
  const t0 = performance.now();
  const took = {};
  let failed = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    const w = new Worker(path.join(HERE, 'corpus-plan-worker.mjs'), { env: process.env, stdout: true, stderr: true });
    w.stdout.resume(); w.stderr.resume(); // (a kit's own console output is not the driver's)
    try {
      for (let j = queue.shift(); j; j = queue.shift()) {
        const tj = performance.now();
        const res = await new Promise((resolve) => {
          const on = (m) => { w.off('message', on); w.off('error', onErr); resolve(m); };
          const onErr = (e) => { w.off('message', on); resolve({ ok: false, err: String(e?.message ?? e) }); };
          w.on('message', on); w.once('error', onErr);
          w.postMessage(j);
        });
        if (!res.ok) failed++;
        took[j.id] = Math.round(performance.now() - tj);
      }
    } finally { await w.terminate(); }
  }));
  writeTimes(root, took);
  const ms = Math.round(performance.now() - t0);
  log(`  plans: ${jobs.length} prewarmed on ${workers} worker(s) in ${(ms / 1000).toFixed(1)} s${failed ? ` (${failed} left to the loop)` : ''}`);
  return { jobs: jobs.length, workers, ms, failed };
}

/** A prewarm job: planFixture (gate6ckc-kit.mjs) of `fx` over `dir`'s cached helpers. */
export async function jobPlanFixture(dir, fxRoot, fx, derive = [], headRoot = null) {
  const { planFixture } = await import(pathToFileURL(path.join(HERE, 'gate6ckc-kit.mjs')).href);
  await planFixture(await helpers(dir, { derive, headRoot }), fxRoot, fx);
}

/** The store's line for a driver's log. */
export const statsLine = () => `plan store: ${stats.hit} hit(s), ${stats.waited} waited for another process, ${stats.miss} planned here${stats.deriveMiss ? `, ${stats.deriveMiss} re-planned for an extra` : ''}${stats.uncached ? `, ${stats.uncached} uncached (a dirty tree)` : ''}`;

/**
 * The drivers' unchanged() loops share one helpers config, so every entry they store is complete for each of them: this head's with
 * KC's census and F3's M18/M19, the base's with KC's census (both computed with this head's kit). -> { hNew, hOld }.
 */
export const HEAD_DERIVE = Object.freeze(['kcCensus', 'f3M18M19']);
export const BASE_DERIVE = Object.freeze(['kcCensus']);
export async function corpusHelpers(root, mainDir) {
  return { hNew: await helpers(root, { derive: [...HEAD_DERIVE], headRoot: root }), hOld: await helpers(mainDir, { derive: [...BASE_DERIVE], headRoot: root }) };
}
/** The prewarm jobs of a fixture loop: [[dir, fxRoot, fx, side]] -> jobs for prewarm (the same helpers config as corpusHelpers). */
export function fixtureJobs(root, list) {
  const mod = pathToFileURL(path.join(HERE, 'corpus-plan.mjs')).href;
  return list.map(([dir, fxRoot, fx, side, name]) => ({ id: `${side}:${name}`, module: mod, export: 'jobPlanFixture', args: [dir, fxRoot, fx, side === 'head' ? [...HEAD_DERIVE] : [...BASE_DERIVE], root] }));
}

/**
 * A prewarm job for the 59 asks' tables (gate6chy-b asksGap: checkPlanVolumes; gate6cfl-kit and gate6cvoc-c asksTable:
 * checkPlanLocal), the call exactly as those make it (the same key: a hit there). `fxAnchors`: VOC-c's, which adds the ask's own.
 */
export async function jobAsk(dir, shape, file, fxAnchors = false) {
  const H = await helpers(dir);
  const fx = JSON.parse(fs.readFileSync(path.join(dir, 'kit', 'test', 'fixtures', 'plan', 'asks', file), 'utf8'));
  const s = H.asksSurvey();
  if (shape === 'checkPlanVolumes') await H.checkPlanVolumes(fx.answer.plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {} });
  else await H.checkPlanLocal(fxAnchors ? fx.answer?.plan ?? fx.plan : fx.answer.plan, { survey: s.bytes, claim: s.claim, anchors: fxAnchors ? { ...H.stewardAnchors(s.claim), ...(fx.anchors ?? {}) } : H.stewardAnchors(s.claim) });
}
/** Prewarm the asks of each dir (the base's and this head's together, on one pool). */
export async function prewarmAsks(root, dirs, shape, { fxAnchors = false, log } = {}) {
  const mod = pathToFileURL(path.join(HERE, 'corpus-plan.mjs')).href;
  const jobs = [];
  for (const dir of dirs) {
    const a = path.join(dir, 'kit', 'test', 'fixtures', 'plan', 'asks');
    for (const f of fs.readdirSync(a).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) jobs.push({ id: `ask:${shape}:${f}`, module: mod, export: 'jobAsk', args: [dir, shape, f, fxAnchors] });
  }
  return prewarm(root, jobs, { log });
}

/**
 * (speed audit A) A prewarm job for an ask's FIRST recording (asks-first.mjs: what the earlier slices' asks tables read), planned by
 * checkPlanVolumes exactly as gate6crs-kit asksTables calls it: creative, or `survival: true`.
 */
export async function jobFirstAsk(dir, f, survival = false) {
  const H = await helpers(dir);
  const asks = path.join(dir, 'kit', 'test', 'fixtures', 'plan', 'asks');
  const plan = JSON.parse(fs.readFileSync(firstAsk(asks, f), 'utf8')).answer.plan;
  const s = H.asksSurvey();
  await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {}, ...(survival ? { survival: true } : {}) });
}
/** The jobs of jobFirstAsk for each of `modes` (false: creative, true: survival) over every ask under `dir`. */
export function firstAskJobs(root, dir, modes) {
  const mod = pathToFileURL(path.join(HERE, 'corpus-plan.mjs')).href;
  const a = path.join(dir, 'kit', 'test', 'fixtures', 'plan', 'asks');
  const jobs = [];
  for (const f of fs.readdirSync(a).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) for (const m of modes) jobs.push({ id: `ask1:${m ? 'surv' : 'cre'}:${f}`, module: mod, export: 'jobFirstAsk', args: [dir, f, m] });
  return jobs;
}
