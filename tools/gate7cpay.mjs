#!/usr/bin/env node
// Phase 7c slice PAY (docs/CONTRACT.md "Phase 7c" §3 row 16, §4 Spend plan, §5 Gates): the phase's only paid batch, one driver, modelled
// on 7b's tools/gate7bpa.mjs. Every paid job runs on Noah's claude login only (never an API key), guarded by the PAY ledger
// (tools/lib/pay-ledger.mjs): one phase ledger artifacts/7c/spend.json (in the main checkout), costs from each job's own reported usage;
// before each paid job: committed + its cap > $65 (Noah's hard cap) refuses and writes STOP.json; the item's committed + the job's cap past
// 1.2 x its share stops for the coordinator (exit 3, STOP.json); each job carries budgetUsd; at most one retry per item, from R; no paid
// step in the nightly window; the env of every process the driver starts has no ANTHROPIC_* / CLAUDE* variable, and a key variable in
// its own env refuses at once. No Discord, ever.
//
//   node tools/gate7cpay.mjs --plan                 every item's estimate (restated after P1), share, ceiling, cap and the running total
//   node tools/gate7cpay.mjs --only <item>          one item: P0 (the offline parts: p0-styles, then the verdict; p0-compose is a gate
//                                                   step) or P1 (p1-style, p1-compose, restate). P2-P6 and R: stage 2 (refused here)
//   node tools/gate7cpay.mjs status                 the ledger
//   node tools/gate7cpay.mjs p0-styles              P0 ($0, own sim helper): the Style jobs of P1, P2 (references off) and P5 (on), their
//                                                   draft prompts diffed (references on vs off)
//   node tools/gate7cpay.mjs p0-compose             P0 ($0, a gate step: the run dir's client on the sim): P1's three composes (images
//                                                   on, the pick skipped) over the calibration claims, P4's arm (images off), each brief's
//                                                   natural pick, P3's authoring call; the composer's prompts diffed (images on vs off)
//   node tools/gate7cpay.mjs p0-verdict             P0's verdict per paid item (artifacts/7c/P0/P0.json)
//   node tools/gate7cpay.mjs p1-style               P1 (paid, own helper on the claude login): 1 format 3 settlement Style
//   node tools/gate7cpay.mjs p1-compose             P1 (paid, the run dir's client on the claude login): the 3 calibration composes
//   node tools/gate7cpay.mjs restate                P2-P6's estimates from P1's measured unit costs (the table)
//   node tools/gate7cpay.mjs answer --step <s> --yes|--no --text "<the coordinator's words>"
//
// Ports 8896 (helper / the client's sidecar) and 8897 (DevBridge), --shards 1 (the brief; 8930/8931 are QL-b's). The helper and the
// client never run at once.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from './lib/pay-ledger.mjs';
import * as S2 from './lib/pay-stage2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const ART = process.env.PAY_OUT ? path.resolve(process.env.PAY_OUT) : path.join(MAIN, 'artifacts', '7c');
const LEDGER = path.join(ART, 'spend.json');
const RUN = process.env.PAY_RUN ? path.resolve(process.env.PAY_RUN) : path.resolve(root, '..', 'architect-mc-PAY-run');
const SIDECAR_PORT = 8896, DEV_PORT = 8897;
const SEED = '2026100906';
const REFS = path.resolve(root, '..', '..', 'references', '7c-N-7c-4');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
fs.mkdirSync(ART, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(ART, 'pay.log'), `${line}\n`);
};
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const gitHead = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();

// ---- P1's inputs: builder-written, non-scenario briefs over the calibration sites (scenarios/sites, the pinned seed) ------------------

const site = (id) => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'sites', `${id}.json`), 'utf8'));
/** P1's three composes (never a scenario brief: AGENTS "Don't tune prompts against the eval briefs"). */
export const P1_COMPOSES = Object.freeze([
  { key: 'cliff', site: 'cliff_face', style: 'rustic', brief: "A small mining hamlet at the foot of the red cliff: a few miners' cottages and a tool shed, and a lookout on the clifftop reached by a stair up the face." },
  { key: 'caravan', site: 'rift_site', style: 'medieval', brief: "A caravan stop on the open desert: a walled court round a well, a few traders' houses and stalls, and a road out of the court." },
  { key: 'hill', site: 'tunnel_hill', style: 'rustic', brief: 'A farming village at the foot of the hill: cottages round a green, fields on the flat ground, and a road through a tunnel in the hill to the far side.' },
]);
/**
 * The calibration validations of CF2's composer hints (prompt fixes are validated on non-scenario calibration briefs before any
 * scenario retry, AGENTS): districts by level band on a slope; grow a form before cutting lots. Charged to P1 (`--set validate`).
 */
export const P1_VALIDATIONS = Object.freeze([
  { key: 'hillside', site: 'hill_site', style: 'rustic', brief: 'A hillside town climbing the slope: a market square and an inn at the foot, houses and workshops on the middle of the slope, a chapel and a few larger houses at the top.' },
  { key: 'hold', site: 'tunnel_hill', style: 'medieval', brief: "A small hold hollowed inside the hill: a great hall, a forge, a storehouse and four homes under the rock, with an entrance from the hill's foot." },
]);
/** P1's format 3 settlement Style (non-scenario). */
export const P1_STYLE = Object.freeze({ name: 'PAY Badlands Hamlet', prompt: 'A red-sandstone mining hamlet in the badlands: timber-propped cottages on stone footings, lanterns on chains, tracks and spoil heaps.' });
/** P2's and P5's settlement Styles (sim only in stage 1): the scenario's brief, references off (P2) and on (P5, N-7c-4's six images). */
const SCN_STYLES = Object.freeze([
  { key: 's3', scenario: 's3_monastery', name: 'PAY S3 Monastery', refs: ['S3-monastery-1', 'S3-monastery-2', 'S3-monastery-3'] },
  { key: 's5', scenario: 's5_treehouses', name: 'PAY S5 Treehouses', refs: ['S5-treehouse-1', 'S5-treehouse-2', 'S5-treehouse-3'] },
]);
const SKIP_PICK = 'architect_mc:skipPick';
/**
 * (P0's reading, for P4) Two fresh copies of the same generated land differ by a few cells at the claim's edge chunks (P0: cliff 6
 * affordance lines, caravan 1, hill 0), so P4's images-off arm must run on a clone of the ONE saved world P2's images-on arm read,
 * never on land generated again. P4's subcommand (not built in stage 1) must honour this.
 */
export const P4_SHARED_WORLD = true;
const REF_EXT = 'architect_mc:referenceImages';

// ---- env and the helper -------------------------------------------------------------------------------------------------------------

/** No key, the claude login only: refuse when a key variable is set; every child env scrubbed (no ANTHROPIC_* / CLAUDE*). */
function envCheck(step) {
  const keys = P.KEY_VARS.filter((k) => process.env[k]?.trim());
  if (keys.length) throw Object.assign(new Error(`refusing ${step}: ${keys.join(', ')} set (claude login only)`), { code: 2 });
  const env = P.scrubbedEnv();
  const names = P.anthropicNames(env);
  if (names.length) throw Object.assign(new Error(`refusing ${step}: the child env still names anthropic: ${names.join(', ')}`), { code: 2 });
  fs.appendFileSync(path.join(ART, 'auth.log'), `${JSON.stringify({ at: new Date().toISOString(), step, envAnthropic: names, keysInEnv: keys })}\n`);
  return env;
}

class Helper {
  /** Our own sidecar (this worktree's source) on 8896: `sim` or `claude` (the claude login), its dirs under `dir`. */
  static async start(dir, backend) {
    const h = new Helper();
    h.dir = dir;
    for (const d of ['data', 'library', 'bibles', 'massings']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.rmSync(path.join(dir, 'data', 'client.token'), { force: true });
    if (!fs.existsSync(path.join(dir, 'data', 'config.json'))) writeJson(path.join(dir, 'data', 'config.json'), {});
    if (backend === 'claude') {
      // the opt-in to the local claude login (as tools/lib/run6b.mjs setClaudeLogin), never a key
      const f = path.join(dir, 'data', 'secrets.json');
      fs.writeFileSync(f, JSON.stringify({ useClaudeLogin: true }), { mode: 0o600 });
    }
    const env = envCheck(`helper:${backend}`);
    const out = fs.openSync(path.join(dir, 'sidecar.log'), 'a');
    const a = ['--import', 'tsx', 'src/main.ts', '--port', String(SIDECAR_PORT), '--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', path.join(root, 'kit'), '--bibles', path.join(dir, 'bibles'), '--massings', path.join(dir, 'massings'), '--parent-pid', String(process.pid), ...(backend === 'sim' ? ['--backend', 'sim'] : ['--backend', 'claude', '--use-claude-login'])];
    h.proc = spawn(process.execPath, a, { cwd: path.join(root, 'sidecar'), env, stdio: ['ignore', out, out] });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), String(h.proc.pid));
    log(`helper pid ${h.proc.pid} (${backend}) on ${SIDECAR_PORT}, data ${dir}`);
    for (let i = 0; i < 300 && !fs.existsSync(path.join(dir, 'data', 'client.token')); i++) await sleep(200);
    await h.open();
    for (let i = 0; i < 180 && (!h.status || h.status.auth === 'checking'); i++) await sleep(1000);
    log(`helper auth ${JSON.stringify(h.auth())}`);
    return h;
  }
  async open() {
    const token = fs.readFileSync(path.join(this.dir, 'data', 'client.token'), 'utf8').trim();
    this.ws = new WebSocket(`ws://127.0.0.1:${SIDECAR_PORT}`);
    this.msgs = []; this.bibles = new Map(); this.status = null; this.n = 0;
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'bible.upsert') this.bibles.set(m.bible.id, m.bible);
      else if (m.type === 'design.upsert') (this.designs ??= new Map()).set(m.design.id, m.design);
      else if (m.type === 'status') this.status = m.status;
      else if (m.type === 'snapshot') { this.status = m.status ?? this.status; for (const b of m.bibles ?? []) this.bibles.set(b.id, b); } else this.msgs.push(m);
    };
    await new Promise((res, rej) => ((this.ws.onopen = res), (this.ws.onerror = rej)));
    this.ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'gate7cpay', token, protocols: [2] }));
    for (let i = 0; i < 100 && !this.status; i++) await sleep(100);
  }
  auth() { return { auth: this.status?.auth ?? null, authSource: this.status?.authSource ?? null }; }
  async send(o, ms = 120_000) {
    const id = `pay${++this.n}`;
    this.ws.send(JSON.stringify({ v: 1, id, ...o }));
    for (let i = 0; i < ms / 100; i++) {
      const a = this.msgs.find((m) => m.type === 'ack' && m.re === id);
      if (a) { if (!a.ok) throw Object.assign(new Error(`${o.type}: ${a.error}`), { refused: a.error }); return a.result ?? {}; }
      await sleep(100);
    }
    throw new Error(`no ack for ${o.type}`);
  }
  async image(file) {
    const bytes = fs.readFileSync(file);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 1 << 20) chunks.push(bytes.subarray(i, i + (1 << 20)).toString('base64'));
    return (await this.send({ type: 'blob.put', kind: 'image', chunks })).blobId;
  }
  async waitBible(id, ms, onPoll) {
    const t0 = Date.now();
    for (;;) {
      const b = this.bibles.get(id);
      if (b && onPoll) onPoll(b);
      if (b && ['done', 'failed', 'cancelled'].includes(b.status)) return b;
      if (Date.now() - t0 > ms) return { ...(b ?? {}), status: 'timeout' };
      await sleep(3000);
    }
  }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { this.ws?.close(); } catch { /* closed */ }
    const done = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGTERM'); // our own child, by its handle
    await Promise.race([done, sleep(20_000)]);
  }
}

/** A Style job's draft query as the sim recorded it (<scratch>/sim-queries.jsonl, kind bible-draft). */
function bibleDraft(dir, jobId) {
  const f = path.join(dir, 'data', 'bibles', jobId, 'sim-queries.jsonl');
  const g = fs.existsSync(f) ? f : findFile(path.join(dir, 'data'), jobId, 'sim-queries.jsonl');
  if (!g) return null;
  return fs.readFileSync(g, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((q) => q.kind === 'bible-draft') ?? null;
}
// <base>/.../<id>/<name>: a job scratch dir, wherever the sidecar keeps it
function findFile(base, id, name) {
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === id && fs.existsSync(path.join(p, name))) return path.join(p, name);
      if (!['kit', 'node_modules', 'library'].includes(e.name)) stack.push(p);
    }
  }
  return null;
}
const lineDiff = (a, b) => { const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n'); const sa = new Set(A), sb = new Set(B); return { plus: B.filter((l) => !sa.has(l)), minus: A.filter((l) => !sb.has(l)) }; };

// ---- the guard around one paid job --------------------------------------------------------------------------------------------------

/** Guard and open one paid job (exit 3 with STOP.json on a stop or the $65 refusal; 2 on any other refusal). */
function openPaid({ item, step, capUsd, authSource, retry = false, minutes = 45 }) {
  envCheck(step);
  const L0 = P.readLedger(LEDGER);
  log(`${step}: the ledger before: spent $${L0.totalUsd}, committed $${L0.committedUsd} (hard cap $${P.HARD_CAP_USD}); ${item}: committed $${L0.items[item].committedUsd} of its ceiling $${P.ceilingOf(item)}; this job's cap $${capUsd}`);
  P.withLedger(LEDGER, (L) => {
    const g = P.guard(L, { item, step, capUsd, retry, minutes, authSource, envKeys: P.KEY_VARS.filter((k) => process.env[k]?.trim()) });
    if (!g.ok) {
      if (g.report) writeJson(path.join(ART, 'STOP.json'), { at: new Date().toISOString(), ...g });
      throw Object.assign(new Error(g.message), { code: g.report ? 3 : 2, pay: g });
    }
    P.openJob(L, { item, step, capUsd, retry, authSource });
  });
}
const closePaid = (step, o) => P.withLedger(LEDGER, (L) => P.updateJob(L, step, o));

const subs = {};

subs.plan = async () => {
  const L = P.readLedger(LEDGER);
  // (stage 2) `--plan --only <item>`: that item's jobs, their budgets, the worst case against its ceiling, what runs and its go
  if (opt('only')) {
    const item = String(opt('only')).toUpperCase();
    if (!P.ITEMS[item]) throw new Error(`--plan --only P0..P6|R (got ${item})`);
    const jobs = item === 'P1' ? [...P1_COMPOSES.map((c) => ({ step: `P1:compose:${c.key}`, capUsd: P.P1_BUDGETS.compose })), { step: 'P1:style', capUsd: P.P1_BUDGETS.style }] : S2.jobsOf(item);
    const worst = Math.round(jobs.reduce((a, j) => a + j.capUsd, 0) * 1e6) / 1e6;
    const it = L.items[item];
    console.log(JSON.stringify({ item, what: P.ITEMS[item].what, estUsd: P.estimateOf(L, item), shareUsd: P.ITEMS[item].shareUsd, ceilingUsd: item === 'P0' ? 0 : P.ceilingOf(item), capUsd: P.ITEMS[item].capUsd, spentUsd: it.spentUsd, committedUsd: it.committedUsd, jobs, worstCaseUsd: worst, worstFitsCeiling: item === 'P0' || it.committedUsd + worst <= P.ceilingOf(item) + 1e-9, ledgerAfterWorstUsd: Math.round((L.committedUsd + worst) * 1e6) / 1e6, hardCapUsd: P.HARD_CAP_USD, go: item === 'P0' || item === 'R' ? 'n/a' : P.approved(L, `${item}:go`) ? 'recorded' : `none (answer --step ${item}:go)`,
      inputs: item === 'P2' ? S2.P2_SCENARIOS : item === 'P3' ? S2.P3_SESSIONS : item === 'P4' ? S2.P2_SCENARIOS.filter((x) => x.saveWorld).map((x) => ({ ...x, clones: S2.p4World(x.key) })) : item === 'P5' ? S2.P5_STYLES : item === 'P6' ? { request: S2.P6_REQUEST, eligible: P.p6Eligible(L) } : null }, null, 2));
    return;
  }
  let running = 0;
  const rows = Object.entries(P.ITEMS).map(([k, it]) => {
    const est = P.estimateOf(L, k);
    running = r6(running + (k === 'R' ? it.capUsd : est));
    return { item: k, what: it.what, estUsd: est, shareUsd: it.shareUsd, ceilingUsd: k === 'P0' ? 0 : P.ceilingOf(k), capUsd: it.capUsd, spentUsd: L.items[k].spentUsd, runningTotalUsd: running };
  });
  console.log(JSON.stringify({ hardCapUsd: P.HARD_CAP_USD, rule: 'refuse past $65 committed; stop past 1.2 x share per item; one retry per item from R; claude login only', items: rows, spentUsd: L.totalUsd, committedUsd: L.committedUsd, p1Budgets: P.P1_BUDGETS, p1: P1_COMPOSES, p1Style: P1_STYLE, ledger: LEDGER, runDir: RUN, ports: [SIDECAR_PORT, DEV_PORT], restated: L.restated }, null, 2));
};
subs.status = async () => { const L = P.readLedger(LEDGER); console.log(JSON.stringify({ totalUsd: L.totalUsd, committedUsd: L.committedUsd, items: L.items, jobs: L.jobs, answers: L.answers, restated: L.restated }, null, 2)); };
subs.answer = async () => {
  const step = opt('step');
  if (!step) throw new Error('answer --step <step> --yes|--no --text "..."');
  P.withLedger(LEDGER, (L) => { L.answers.push({ at: new Date().toISOString(), step, yes: args.includes('--yes'), text: String(opt('text', '')) }); });
  log(`answer recorded for ${step}`);
};

// ---- P0 ($0) --------------------------------------------------------------------------------------------------------------------------

/** P0, the Style jobs on the sim: P1's (no references), P2's per scenario (references off) and P5's (on); the draft prompts diffed. */
subs['p0-styles'] = async () => {
  const out = path.join(ART, 'P0');
  const res = { at: new Date().toISOString(), head: gitHead(), checks: [], styles: {} };
  const check = (ok, what, data) => { res.checks.push({ ok: !!ok, what, ...(data === undefined ? {} : { data }) }); log(`${ok ? 'ok  ' : 'FAIL'} P0 ${what}`); };
  const dir = path.join(out, 'styles-sim');
  const h = await Helper.start(dir, 'sim');
  try {
    check(h.auth().auth === 'ok', `sim helper up ${JSON.stringify(h.auth())}`);
    const job = async (key, req) => {
      const a = await h.send({ type: 'bible.request', request: { budgetUsd: P.P1_BUDGETS.style, ...req } });
      const id = a.jobId;
      const b = await h.waitBible(id, 600_000);
      const q = bibleDraft(dir, id);
      const bj = readJson(path.join(dir, 'bibles', b.bibleId ?? '', 'bible.json'), {});
      res.styles[key] = { jobId: id, status: b.status, bibleId: b.bibleId, error: b.error ?? null, format: bj.format ?? null, references: bj.references ?? null, draft: q ? { prompt: q.prompt, images: q.images } : null };
      check(b.status === 'done' && bj.format === 3, `${key}: settlement Style job (sim) ${b.status} format ${bj.format}${b.error ? ` ${b.error}` : ''}`);
      return res.styles[key];
    };
    await job('P1', { prompt: P1_STYLE.prompt, name: P1_STYLE.name, scope: 'settlement' });
    for (const s of SCN_STYLES) {
      const sc = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', `${s.scenario}.json`), 'utf8'));
      const prompt = String(sc.brief).replace(/\s*\((S\d+ v\d+|[A-Z]\d+)[^)]*\)\s*$/, '').trim();
      const off = await job(`P2:${s.key}`, { prompt, name: s.name, scope: 'settlement' });
      const files = s.refs.map((r) => path.join(REFS, `${r}.png`));
      const have = files.every((f) => fs.existsSync(f));
      check(have, `${s.key}: N-7c-4's references present (${files.map((f) => path.basename(f)).join(', ')} in ${REFS})`);
      if (!have) continue;
      const blobs = [];
      for (const [i, f] of files.entries()) blobs.push({ blob: await h.image(f), label: `${s.refs[i]} (gpt-image-2)` });
      const on = await job(`P5:${s.key}`, { prompt, name: `${s.name} R`, scope: 'settlement', ext: { [REF_EXT]: blobs } });
      const df = lineDiff(off.draft?.prompt, on.draft?.prompt);
      writeJson(path.join(out, `style-diff-${s.key}-references-on-vs-off.json`), { off: off.draft, on: on.draft, diff: df });
      const plusOk = df.plus.length === 2 && df.plus.some((l) => l.startsWith('3 reference images of the place come before this text')) && df.plus.some((l) => l.startsWith('Its name:'));
      check(plusOk && df.minus.length === 1 && (off.draft?.images ?? []).length === 0, `${s.key}: Style draft prompt references on vs off: +${df.plus.length}/-${df.minus.length} (the references line and the name), images off ${(off.draft?.images ?? []).length}`, df);
      check((on.draft?.images ?? []).length === 3 && on.draft.images.every((im) => im.bytes > 1e6 && im.mediaType === 'image/png'), `${s.key}: the draft gets 3 image blocks (${(on.draft?.images ?? []).map((i) => `${i.label} ${i.bytes} B`).join('; ')})`);
      check(Array.isArray(on.references) && on.references.length === 3 && on.references.every((r, i) => r.blob === blobs[i].blob) && off.references === null, `${s.key}: the made Style records its 3 references (format 3 references); the off arm none`);
    }
  } finally { await h.stop(); }
  res.ok = res.checks.every((c) => c.ok);
  writeJson(path.join(out, 'styles.json'), res);
  log(`P0 styles: ${res.ok ? 'PASS' : 'FAIL'} (${res.checks.filter((c) => c.ok).length}/${res.checks.length})`);
  if (!res.ok) process.exitCode = 1;
};

/** The run dir's lib (GATE6B_* env: the gate runner's, or set here for the paid run). */
async function game() { return import('./lib/run6b.mjs'); }
/** The sidecar's jobs of a design's compose rounds (state.json tags `design <id> compose round <n>`) and their recorded queries. */
function roundJobs(L, designId) {
  const st = readJson(path.join(L.SIDECAR_DATA, 'state.json'), {});
  const tag = (j) => j.spec?.tag ?? j.tag;
  const jobs = (st.jobs ?? []).filter((j) => typeof tag(j) === 'string' && tag(j).startsWith(`design ${designId} compose round `));
  return jobs.map((j) => {
    const f = findFile(L.SIDECAR_DATA, j.id, 'sim-queries.jsonl');
    const q = f ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0] : null;
    return { jobId: j.id, round: Number(tag(j).split(' ').pop()), cost: j.cost?.usd ?? null, query: q ? { prompt: q.prompt, images: q.images ?? [], systemChars: q.system?.length ?? null } : null };
  }).sort((a, b) => a.round - b.round);
}
/** A calibration site's world: a fresh copy of the pinned seed's base, the player over the claim, the claim forceloaded. */
async function siteWorld(L, s, tag) {
  const claim = site(s.site).fixture.claim;
  // (a fresh copy of the base per call, rules frozen: P4's A/B arms must read the same land; P0 found a few cells of drift between two
  // composes in one live world, cave cells and an overhang's clearance moving under random ticks)
  await L.fresh(`G6B PAY ${tag} ${s.key}`, await L.claimBase(SEED, claim));
  await L.setRules('exact').catch(() => null);
  await L.tp((claim[0] + claim[2]) / 2, 200, (claim[1] + claim[3]) / 2);
  await L.call('dev.waitChunks', { timeoutMs: 180_000 }, 240_000).catch(() => null);
  await L.cmd(`/forceload add ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`);
  await L.settle(5000);
  return claim;
}
const composeRead = (d) => {
  const r = d?.result ?? {};
  return { designId: d?.designId ?? null, status: d?.status ?? null, kind: d?.kind ?? null, outcome: r.outcome ?? null, reason: r.reason ?? null, rounds: r.rounds ?? null, history: r.history ?? [], pick: r.pick ?? null, waits: r.waits ?? [], artifactSha: r.check?.artifactSha ?? null, overall: r.check?.overall ?? null, costUsd: d?.costUsd ?? r.cost ?? 0, images: (r.images ?? []).map((i) => i.name), error: d?.refused ?? d?.error ?? null, summary: r.summary ?? null };
};

/** P0, in game on the sim (a gate step): P1's composes images on, P4's arm images off, the natural pick, P3's authoring call. */
subs['p0-compose'] = async () => {
  const L = await game();
  L.refuseKeys();
  await L.connect();
  const out = path.join(ART, 'P0');
  const res = { at: new Date().toISOString(), head: gitHead(), checks: [], sites: {} };
  const check = (ok, what, data) => { res.checks.push({ ok: !!ok, what, ...(data === undefined ? {} : { data }) }); log(`${ok ? 'ok  ' : 'FAIL'} P0 ${what}`); };
  const st = await L.call('dev.sidecar.state', {}, 30_000).catch(() => ({}));
  check(/sim/i.test(st.status?.authSource ?? ''), `the run's sidecar is the sim (${st.status?.authSource})`);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  for (const s of P1_COMPOSES) {
    const claim = site(s.site).fixture.claim;
    const row = res.sites[s.key] = { site: s.site, claim, brief: s.brief };
    try {
      const arm = async (images, skip) => {
        // each arm on its own fresh copy of the same land
        await siteWorld(L, s, `P0 ${images ? 'on' : 'off'} ${skip ? 'skip' : 'pick'}`);
        const body = { brief: s.brief, claim, style: s.style, images, budgetUsd: P.P1_BUDGETS.compose, opKey: `pay-p0-${stamp}-${s.key}-${images ? 'on' : 'off'}-${skip ? 'skip' : 'pick'}`, ext: skip ? { [SKIP_PICK]: true } : {}, wait: true };
        try {
          const d = await L.call('dev.region.compose', body, 1_800_000);
          const c = composeRead(d);
          c.rounds_ = roundJobs(L, c.designId);
          return c;
        } finally {
          await L.cmd(`/forceload remove ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`).catch(() => null);
        }
      };
      const on = row.on = await arm(true, true);
      const off = row.off = await arm(false, true);
      const pick = row.pick = await arm(true, false);
      check(on.status === 'DONE' && on.kind === 'SETTLEMENT' && ['COMPOSED', 'NO_PLAN'].includes(on.outcome) && on.pick?.outcome === 'SKIPPED', `${s.key}: compose (images on, pick skipped) ${on.status} ${on.kind} ${on.outcome} (${on.history.map((x) => x.overall ?? x.refused).join(' -> ')}), pick ${on.pick?.outcome}`);
      const q1on = on.rounds_[0]?.query, q1off = off.rounds_[0]?.query;
      check(q1on && q1on.images.length === 4 && /4 images come before this text/.test(q1on.prompt), `${s.key}: round 1 (images on) sends 4 image blocks (${(q1on?.images ?? []).map((i) => i.label).join(', ')}) and names them`);
      check(q1off && q1off.images.length === 0 && !/Planning images/.test(q1off.prompt) && off.images.length === 0, `${s.key}: round 1 (images off, P4's arm) sends no image and no images section`);
      const df = lineDiff(q1off?.prompt, q1on?.prompt);
      writeJson(path.join(out, `compose-diff-${s.key}-images-on-vs-off.json`), { on: q1on, off: q1off, diff: df });
      // the images section plus the affordances header's "the images number them the same way"; any other affordance line that moved
      // is land drift between the arms (recorded: P4's arms must read the same land)
      const aff = (l) => /^\d+\. [a-z_]+ [a-z_]+_[0-9a-f]+: /.test(l) || /^## Site affordances/.test(l);
      const other = { plus: df.plus.filter((l) => !aff(l)), minus: df.minus.filter((l) => !aff(l)) };
      row.landDrift = df.plus.filter((l) => /^\d+\. /.test(l)).length;
      check(other.minus.length === 0 && other.plus.length === 2 && other.plus[0] === '## Planning images' && /^4 images come before this text/.test(other.plus[1]), `${s.key}: the prompt diff images on vs off is the images section only (+${other.plus.length}/-${other.minus.length} outside the affordance list)`, other);
      // (a reading, not a P1 gate: fresh copies of the same generated land still differ by a few cells at the claim's edge chunks, so
      // P4's two arms must clone ONE generated and saved world, not generate the land twice; P0 records the drift for P4)
      res.readings = res.readings ?? [];
      res.readings.push({ site: s.key, landDriftLines: row.landDrift, lines: df.plus.filter((l) => /^\d+\. /.test(l)) });
      log(`read P0 ${s.key}: affordance lines that differ between the arms' fresh land copies: ${row.landDrift} (P4 must clone one saved world for both arms)`);
      const shaOn = on.history.map((x) => x.planSha ?? null), shaOff = off.history.map((x) => x.planSha ?? null);
      check(JSON.stringify(shaOn) === JSON.stringify(shaOff), `${s.key}: the sim's plans with images on and off are the same, round by round (${shaOn.join(',')})`);
      check(pick.status === 'DONE' && pick.pick?.outcome, `${s.key}: the natural pick (recorded: P1 skips it) ${pick.pick?.outcome} ${pick.pick?.program ?? ''} -> ${pick.outcome}`);
      if (s.key === 'cliff') {
        // P3's mechanism: an authoring session on the sim over this claim (P3's own briefs are stage 2)
        await siteWorld(L, s, 'P0 author');
        const a = row.author = await L.call('dev.region.author', { brief: 'A builder-written test program: a terrace of three cottages along the cliff foot.', claim, budgetUsd: 1, opKey: `pay-p0-${stamp}-author`, wait: true }, 1_800_000);
        await L.cmd(`/forceload remove ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`).catch(() => null);
        check(a.status === 'DONE' && a.kind === 'PROGRAM', `P3 mechanism: Regions.authorProgram (sim) ${a.status} ${a.kind} ${a.result?.outcome ?? a.error ?? a.refused ?? ''}`);
      }
    } catch (e) {
      check(false, `${s.key}: ${e.message}`);
    }
  }
  res.ok = res.checks.every((c) => c.ok);
  writeJson(path.join(out, 'compose.json'), res);
  log(`P0 compose: ${res.ok ? 'PASS' : 'FAIL'} (${res.checks.filter((c) => c.ok).length}/${res.checks.length})`);
  if (!res.ok) process.exitCode = 1;
};

/**
 * The rows P0 judges on a plan-path run: the mechanism (the brief composed and planned, the checker, structure, spans, safety, the
 * buildings, exactness, determinism, the realised virtual world). The scenario's own bars (Fit, disturbance, ports, reachability,
 * palette, role shares) are the composer's, and the sim's stand-in plan is not one: recorded, not judged (§5: "mechanism green,
 * composer not shown" until P2's paid run).
 */
export const PLAN_PATH_MECHANISM = Object.freeze(['brief', 'determinism', 'exactness']);
// (the first run, 20261115-124257, judged the plan's own rows too: the sim stand-in's three houses and a path failed safety (M8: 7 of 7
// edges open), the checker (5 M1-M4 findings on S3's slope) and realisedVirtual (S6: street lanterns the kit's model does not predict
// over the sculpted cavern); and S3's E-normal classifier, written for terraced_monastery's IR, left 25 grass-to-dirt cells unclassified.
// Those are the plan's and the scenario's, recorded below for P2's paid run; P0 judges the path: composed, planned through plan_v0,
// deterministic, realised and removed exactly on the flat land (E-flat 0), the natural run's E-normal recorded)

/**
 * P0 for P2's forced plan path (a gate step, the run dir's client on the sim): `p0-plan-path s3|s6`: the scenario from its one-line
 * brief through Regions.compose with the template pick skipped (tools/lib/pay-compose-ext.json, CP's skipPick), the COMPOSED plan/0
 * planned through plan_v0 by the scenario harness (tools/lib/scenario-br.mjs composedParams), flat then natural.
 */
subs['p0-plan-path'] = async () => {
  const scn = args[1];
  if (!['s3', 's6'].includes(scn)) throw new Error('p0-plan-path s3|s6');
  const art = process.env.SCENARIOS_ART ?? path.join(ART, 'P0', 'scenarios');
  const res = { at: new Date().toISOString(), head: gitHead(), scenario: scn, runs: {} };
  for (const flat of [true, false]) {
    const key = flat ? 'flat' : 'natural';
    const outDir = path.join(art, `${scn}-co${flat ? '-flat' : ''}`);
    fs.mkdirSync(art, { recursive: true });
    const slog = path.join(art, `${scn}-co${flat ? '-flat' : ''}.scenario.log`);
    const fd = fs.openSync(slog, 'a');
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), 'run', scn, '--brief', '--via', 'compose', '--brief-ext', path.join(root, 'tools', 'lib', 'pay-compose-ext.json'), '--phase', '7c-pay', ...(flat ? ['--flat'] : []), '--out', outDir], { stdio: ['ignore', fd, fd], env: process.env });
    fs.closeSync(fd);
    log(`P0 plan path ${scn} ${key}: the scenario's own log ${slog} (its FAIL lines are the scenario bars, recorded here; this step prints P0's verdict)`);
    const m = readJson(path.join(outDir, 'metrics.json'), {});
    const b = readJson(path.join(outDir, 'brief.json'), {});
    const rows = m.rows ?? [];
    const by = Object.fromEntries(rows.map((x) => [x.id, x]));
    const ex = readJson(path.join(outDir, 'exact.json'), {});
    const run = readJson(path.join(outDir, 'run.json'), {});
    // the harness's own judgement per variant (tools/scenarios.mjs runBad): the flat run is held to E-flat 0 and its own IR shas and
    // 1-vs-4 tiles; the natural run's E-normal is the scenario classifier's (recorded)
    const judgedOk = {
      brief: by.brief?.pass === true,
      determinism: by.determinism?.pass === true || (flat && new Set(run.irShas ?? []).size === 1 && m.tiles?.workersSame === true),
      exactness: flat ? ex.mismatches === 0 && (ex.cellsWritten ?? 0) > 0 && (ex.restored ?? 0) > 0 : true,
    };
    const judged = PLAN_PATH_MECHANISM.filter((k) => by[k]);
    const failing = judged.filter((k) => !judgedOk[k]);
    res.runs[key] = { exit: r.status, outDir, outcome: b.outcome ?? null, composed: !!b.composed, program: b.program ?? null, artifactSha: b.artifactSha ?? null, pick: b.pick?.outcome ?? null, judged, failing, rows: rows.map((x) => ({ id: x.id, pass: x.pass, gated: x.gated, value: String(x.value).slice(0, 200) })) };
    res.runs[key].pass = rows.length > 0 && b.composed === true && b.pick?.outcome === 'SKIPPED' && judged.includes('brief') && judged.includes('exactness') && failing.length === 0;
    log(`P0 plan path ${scn} ${key}: exit ${r.status} (recorded), ${b.outcome} via ${b.program}, pick ${b.pick?.outcome}; mechanism ${res.runs[key].pass ? 'PASS' : `FAIL ${failing.join(',') || '(no rows)'}`}; scenario bars recorded: ${rows.filter((x) => !PLAN_PATH_MECHANISM.includes(x.id)).map((x) => `${x.id} ${x.pass}`).join(', ')}`);
  }
  res.pass = Object.values(res.runs).every((x) => x.pass);
  writeJson(path.join(ART, 'P0', `plan-path-${scn}.json`), res);
  if (!res.pass) process.exitCode = 1;
};

/** P0's verdict per paid item: what each item's sim dry run showed, and what is not built yet. */
subs['p0-verdict'] = async () => {
  const s = readJson(path.join(ART, 'P0', 'styles.json'));
  const c = readJson(path.join(ART, 'P0', 'compose.json'));
  const ok = (r, re) => !!r && r.checks.filter((x) => re.test(x.what)).length > 0 && r.checks.filter((x) => re.test(x.what)).every((x) => x.ok);
  const v = {
    at: new Date().toISOString(),
    P1: { pass: ok(c, /^(cliff|caravan|hill): (compose|round 1 \(images on)/) && ok(s, /^P1: /), what: 'the 3 calibration composes on the sim (images on, the pick skipped) and the settlement Style job' },
    P2: (() => {
      // the picks: BR's br-s1, br-s2, br-s5 steps at this head (--picks <a gate run's summary.json>); the plan path: p0-plan-path s3, s6
      const sum = opt('picks') ? readJson(path.resolve(String(opt('picks'))), {}) : readJson(path.join(ART, 'P0', 'picks-summary.json'), null);
      if (opt('picks') && sum) writeJson(path.join(ART, 'P0', 'picks-summary.json'), { from: path.resolve(String(opt('picks'))), head: sum.head, steps: (sum.steps ?? []).map((x) => ({ id: x.id, status: x.status })) });
      const st = Object.fromEntries((sum?.steps ?? []).map((x) => [x.id, x.status]));
      const picks = Object.fromEntries(['br-s1', 'br-s2', 'br-s5'].map((k) => [k, st[k] ?? 'not run']));
      const pp = Object.fromEntries(['s3', 's6'].map((k) => [k, readJson(path.join(ART, 'P0', `plan-path-${k}.json`))?.pass ?? null]));
      const parts = { styles: ok(s, /^P2:/), composeSkipPick: ok(c, /images on, pick skipped/), picks, picksHead: sum?.head ?? null, planPath: pp };
      return { pass: parts.styles && parts.composeSkipPick && Object.values(picks).every((x) => x === 'PASS') && Object.values(pp).every((x) => x === true), what: 'the S1/S2/S5 picks (BR\'s br-s1, br-s2, br-s5 on the sim at this head); the forced plan path on S3 and S6 (compose with the pick skipped, the COMPOSED plan/0 planned through plan_v0 by tools/scenarios.mjs, flat and natural: the mechanism rows judged, the scenario bars recorded); the settlement Styles with references off', parts };
    })(),
    P3: { pass: ok(c, /^P3 mechanism/), what: 'Regions.authorProgram on the sim over a calibration claim: the call path ran end to end, but the sim session ended NOT_SHOWN (no program installed), so no authored program is shown in sim; P3\'s own two briefs are not dry-run yet' },
    P4: { pass: ok(c, /images off|images on and off are the same|prompt diff images/), what: 'the composer with images off from the same inputs: no image blocks, the prompt diff only the images section, the same sim plans', note: `land drift between two fresh copies of the same land: ${(c?.readings ?? []).map((r) => `${r.site} ${r.landDriftLines}`).join(', ')} affordance lines; P4's arms must share one generated, saved world (stage 2)` },
    P5: { pass: ok(s, /^s[35]: /) && ok(s, /^P5:/), what: 'the settlement Style job with N-7c-4\'s six references: image blocks, one prompt line, recorded in format 3 references' },
    P6: { pass: null, what: 'optional; not dry-run in stage 1 (CM-b\'s sim castle covers the Composite path; a design job returning a Composite is stage 2 if the ledger allows it)' },
    R: { pass: null, what: 'retries of the items above; no paid step of its own' },
  };
  v.p1Ready = v.P1.pass;
  writeJson(path.join(ART, 'P0', 'P0.json'), v);
  log(`P0 verdict: ${Object.entries(v).filter(([k]) => /^P\d|^R$/.test(k)).map(([k, x]) => `${k} ${x.pass === null ? 'n/a' : x.pass ? 'PASS' : 'FAIL'}`).join(', ')}`);
};

/**
 * P0 must pass before any paid item (§4): every item P0 judges (P1-P5; P6 and R have no dry run of their own) must read PASS, unless the
 * coordinator's answer for exactly `P0:override:<item>` is recorded in the ledger (`answer --step P0:override:P1 --yes --text ...`):
 * as 7b's `--p0-reviewed`, a recorded decision, never the builder's. The item's own P0 row must pass in either case.
 */
function needP0(item) {
  const v = readJson(path.join(ART, 'P0', 'P0.json'));
  const failing = ['P1', 'P2', 'P3', 'P4', 'P5'].filter((k) => v?.[k]?.pass !== true);
  if (!failing.length) return;
  if (v?.[item]?.pass === true && P.approved(P.readLedger(LEDGER), `P0:override:${item}`)) {
    log(`${item}: P0 reads ${failing.join(', ')} not passed; the coordinator's recorded answer P0:override:${item} lets ${item} go`);
    return;
  }
  throw Object.assign(new Error(`refusing ${item}: P0 has not passed (${failing.map((k) => `${k} ${v?.[k]?.pass == null ? 'not run' : 'FAIL'}`).join(', ')}; artifacts/7c/P0/P0.json). P0 must pass before a paid item; the coordinator may record P0:override:${item}`), { code: 2 });
}

// ---- P1 (paid) ------------------------------------------------------------------------------------------------------------------------

/** P1's Style job: one format 3 settlement Style on our own helper, the claude login. */
subs['p1-style'] = async () => {
  needP0('P1');
  const out = path.join(ART, 'P1');
  const h = await Helper.start(path.join(ART, 'P1', 'helper'), 'claude');
  const res = { at: new Date().toISOString(), head: gitHead(), auth: h.auth() };
  try {
    if (res.auth.auth !== 'ok' || !/claude login/i.test(res.auth.authSource ?? '')) throw Object.assign(new Error(`refusing P1:style: the helper is not on the claude login (${JSON.stringify(res.auth)})`), { code: 2 });
    const step = `P1:style${opt('attempt') ? `:${opt('attempt')}` : ''}`;
    const retry = !!opt('retry');
    openPaid({ item: 'P1', step, capUsd: P.P1_BUDGETS.style, authSource: res.auth.authSource, retry, minutes: 40 });
    const t0 = Date.now();
    let b;
    try {
      const a = await h.send({ type: 'bible.request', request: { prompt: P1_STYLE.prompt, name: P1_STYLE.name, scope: 'settlement', budgetUsd: P.P1_BUDGETS.style } });
      const id = a.jobId;
      b = await h.waitBible(id, 40 * 60_000, (x) => P.withLedger(LEDGER, (L) => P.updateJob(L, step, { usd: x.cost?.usd ?? 0, ref: id })));
    } catch (e) {
      closePaid(step, { usd: 0, ended: true, status: 'refused', error: e.message });
      throw e;
    }
    const usd = b.cost?.usd ?? 0;
    closePaid(step, { usd, ended: b.status !== 'timeout', status: b.status, error: b.error, data: { bibleId: b.bibleId, turns: b.cost?.turns ?? null } });
    const bj = readJson(path.join(ART, 'P1', 'helper', 'bibles', b.bibleId ?? '', 'bible.json'), {});
    Object.assign(res, { step, status: b.status, error: b.error ?? null, bibleId: b.bibleId ?? null, usd, cost: b.cost ?? null, minutes: r6((Date.now() - t0) / 60000), format: bj.format ?? null, roles: bj.roles ?? null, settlement: bj.settlement ?? null, connectors: bj.connectors ?? null });
    log(`P1 style: ${b.status} $${usd.toFixed(4)} ${b.bibleId ?? b.error ?? ''} format ${bj.format}`);
  } finally {
    await h.stop();
    writeJson(path.join(out, 'style.json'), res);
  }
};

/** P1's composes: the run dir's client on the claude login, the 3 calibration briefs (images on, the pick skipped). */
subs['p1-compose'] = async () => {
  needP0('P1');
  const env = envCheck('P1:client');
  Object.assign(process.env, { GATE6B_RUN: RUN, GATE6B_DEV_PORT: String(DEV_PORT), GATE6B_SIDECAR_PORT: String(SIDECAR_PORT), GATE6B_OUT: path.join(ART, 'P1', 'gate6b') });
  fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
  const L = await game();
  const only = opt('site');
  const run = (a) => spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit', env: { ...env, GATE6B_RUN: RUN, GATE6B_DEV_PORT: String(DEV_PORT), GATE6B_SIDECAR_PORT: String(SIDECAR_PORT), GATE6B_OUT: process.env.GATE6B_OUT, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  if (!fs.existsSync(RUN)) throw new Error(`no run dir ${RUN} (P0's gate run makes it)`);
  const out = path.join(ART, 'P1');
  const res = readJson(path.join(out, opt('set') === 'validate' ? 'validate.json' : 'compose.json'), { composes: {} });
  Object.assign(res, { at: new Date().toISOString(), head: gitHead() });
  try {
    if (run([path.join(root, 'tools', 'gate6b.mjs'), 'start', 'G6B Flat Base', 'claude']).status !== 0) throw new Error('the client did not start');
    await L.connect();
    const auth = await L.logAuth('P1:compose');
    res.auth = auth;
    if (auth.auth !== 'ok' || !/claude login/i.test(auth.authSource ?? '')) throw Object.assign(new Error(`refusing P1:compose: the client's sidecar is not on the claude login (${JSON.stringify(auth)})`), { code: 2 });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const set = opt('set') === 'validate' ? P1_VALIDATIONS : P1_COMPOSES;
    for (const s of set) {
      if (only && only !== s.key) continue;
      const claim = await siteWorld(L, s, 'P1');
      const step = `P1:${set === P1_VALIDATIONS ? 'validate' : 'compose'}:${s.key}${opt('attempt') ? `:${opt('attempt')}` : ''}`;
      try {
        openPaid({ item: 'P1', step, capUsd: P.P1_BUDGETS.compose, authSource: auth.authSource, retry: !!opt('retry'), minutes: 30 });
        const t0 = Date.now();
        const d = await L.call('dev.region.compose', { brief: s.brief, claim, style: s.style, images: true, budgetUsd: P.P1_BUDGETS.compose, opKey: `pay-p1-${stamp}-${s.key}`, ext: { [SKIP_PICK]: true }, wait: true }, 1_800_000);
        const c = composeRead(d);
        c.roundJobs = roundJobs(L, c.designId).map((x) => ({ jobId: x.jobId, round: x.round, cost: x.cost }));
        closePaid(step, { usd: c.costUsd, ended: true, status: c.outcome ?? c.status, error: c.error, ref: c.designId, data: { outcome: c.outcome, rounds: c.rounds, history: c.history } });
        res.composes[s.key] = { ...c, site: s.site, claim, brief: s.brief, style: s.style, minutes: r6((Date.now() - t0) / 60000), step };
        log(`P1 ${s.key}: ${c.status} ${c.outcome} $${Number(c.costUsd).toFixed(4)} rounds ${c.rounds} (${c.history.map((x) => x.overall ?? x.refused).join(' -> ')})${c.waits.length ? ` waits ${c.waits.map((w) => w.part).join(',')}` : ''}`);
      } finally {
        await L.cmd(`/forceload remove ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`).catch(() => null);
        writeJson(path.join(out, opt('set') === 'validate' ? 'validate.json' : 'compose.json'), res);
      }
    }
  } finally {
    run([path.join(root, 'tools', 'gate6b.mjs'), 'stop']);
    writeJson(path.join(out, opt('set') === 'validate' ? 'validate.json' : 'compose.json'), res);
  }
};

/** P2-P6's estimates restated from P1's measured unit costs (§4's last rule), the table; nothing runs. */
subs.restate = async () => {
  const c = readJson(path.join(ART, 'P1', 'compose.json'), { composes: {} });
  const s = readJson(path.join(ART, 'P1', 'style.json'), {});
  // every compose that reported a cost counts: a budget-stopped one is real spend and a floor on the unit (marked in the table)
  const composes = Object.values(c.composes ?? {}).filter((x) => typeof x.costUsd === 'number' && x.costUsd > 0);
  const stopped = composes.filter((x) => x.status !== 'DONE' || /budget/i.test(String(x.error ?? '')));
  if (!composes.length || !(s.usd > 0)) throw new Error('restate needs P1\'s composes and Style (artifacts/7c/P1/compose.json, style.json)');
  const composeUsd = r6(composes.reduce((a, x) => a + x.costUsd, 0) / composes.length);
  // a site-aware archetype design: 7b's measured mean (its ledger's P1-P3 designs)
  const b7 = readJson(path.join(MAIN, 'artifacts', '7b', 'spend.json'), { jobs: [] });
  const d7 = b7.jobs.filter((j) => j.status === 'done' && j.usd > 0 && /^P[123]:/.test(j.step));
  const designUsd = d7.length ? r6(d7.reduce((a, j) => a + j.usd, 0) / d7.length) : 4.25;
  const u = { composeUsd, styleUsd: s.usd, pickUsd: Number(opt('pick', 0.05)), designUsd, authorUsd: 5.5, compositeUsd: 6 };
  const rs = P.withLedger(LEDGER, (L) => P.restate(L, u));
  const rows = Object.entries(rs.items).map(([k, x]) => `| ${k} | $${x.oldEstUsd} | $${x.newEstUsd.toFixed(2)} | $${x.ceilingUsd} | $${x.capUsd} | ${Object.entries(x.units).map(([n, m]) => `${m} ${n}`).join(', ')}${x.overCeiling ? ' (OVER its ceiling)' : ''} |`);
  const md = [`# P2-P6 restated from P1 (${rs.at})`, '', `Units: compose $${composeUsd} (P1 mean of ${composes.length}, images on${stopped.length ? `; ${stopped.length} stopped early (${stopped.map((x) => `${x.site} ${x.status}`).join('; ')}): a floor` : ''}), settlement Style $${s.usd} (P1; P5's Style with 3 reference images is this plus the images' input tokens, not measured), pick $${u.pickUsd} (6b, not measured by P1), site-aware design $${designUsd} (7b's ${d7.length} measured designs), authoring $5.5 and composite $6 (§4, not measured by P1).`, '',
    '| Item | Old est. | New est. | Ceiling (1.2 x share) | Cap | Units |', '|---|---|---|---|---|---|', ...rows, '',
    `P1 spent $${rs.p1SpentUsd}; P1 + P2-P6 estimated $${rs.totalEstUsd} (+ R $${rs.reserveUsd}); hard cap $${P.HARD_CAP_USD}: ${rs.totalEstUsd + rs.reserveUsd <= P.HARD_CAP_USD ? 'fits' : 'does NOT fit with the full reserve'}.`];
  fs.writeFileSync(path.join(ART, 'P1', 'restated.md'), `${md.join('\n')}\n`);
  console.log(md.join('\n'));
};

// ---- stage 2: P2-P6 and R ($0 on --backend sim; paid on --backend claude, after the coordinator's recorded go) ---------------------

const backendOf = () => { const b = String(opt('backend', 'sim')); if (!['sim', 'claude'].includes(b)) throw new Error('--backend sim|claude'); return b; };
/** A paid item needs all of P0 and the coordinator's recorded go `<item>:go` (Noah's words); the sim needs neither. */
function needGo(item, backend) {
  if (backend !== 'claude') return;
  needP0(item);
  if (!P.approved(P.readLedger(LEDGER), `${item}:go`)) throw Object.assign(new Error(`refusing ${item}: no recorded go (answer --step ${item}:go --yes --text "<Noah's words>")`), { code: 2 });
  if (item === 'P6' && !P.p6Eligible(P.readLedger(LEDGER))) throw Object.assign(new Error(`refusing P6: the ledger reads $${P.readLedger(LEDGER).totalUsd} (> $${P.P6_GATE_USD} after P5)`), { code: 2 });
}
const outOf = (item, backend) => path.join(ART, item, backend === 'claude' ? 'paid' : 'sim');
/** One job: on the claude backend guarded and opened in the ledger; on the sim recorded only. `run` returns {usd, status, ref?, error?, data?}. */
async function job(backend, { item, step, capUsd, authSource, minutes = 45 }, run) {
  // --retry: a retry of the item, charged to R; --retry <tag>: one retry attempt holding several jobs (each item's jobs share the tag)
  const retry = opt('retry') === true ? true : typeof opt('retry') === 'string' ? String(opt('retry')) : false;
  if (backend === 'claude') openPaid({ item, step, capUsd, authSource, retry, minutes });
  else log(`${step}: sim (budget $${capUsd} as the paid run's)`);
  let r;
  try { r = await run(); } catch (e) {
    if (backend === 'claude') closePaid(step, { usd: 0, ended: false, status: 'error_open_at_cap', error: e.message });
    throw e;
  }
  if (backend === 'claude') closePaid(step, { usd: r.usd ?? 0, ended: r.ended !== false, status: r.status, error: r.error, ref: r.ref, data: r.data });
  log(`${step}: ${r.status} $${Number(r.usd ?? 0).toFixed(4)}${r.error ? ` ${r.error}` : ''}`);
  return r;
}
/** A Style job on our own helper, waited for: {usd, status, bibleId, file (its installed bible.json)}. */
async function styleJob(h, request, ms = 40 * 60_000) {
  const a = await h.send({ type: 'bible.request', request });
  const b = await h.waitBible(a.jobId, ms);
  const dir = path.join(h.dir, 'bibles', b.bibleId ?? '');
  return { usd: b.cost?.usd ?? 0, status: b.status, ended: b.status !== 'timeout', error: b.error ?? undefined, ref: b.bibleId, bibleId: b.bibleId, file: path.join(dir, 'bible.json'), sheet: path.join(dir, 'sheet.png'), jobId: a.jobId };
}
const helperAuthOk = (h, backend) => (backend === 'sim' ? h.auth().auth === 'ok' : h.auth().auth === 'ok' && /claude login/i.test(h.auth().authSource ?? ''));
/** The run dir's client on the backend (gate6b start), base worlds made; returns {L, auth, stop}. */
async function client(backend, item) {
  const env = envCheck(`${item}:client`);
  const e6 = { GATE6B_RUN: RUN, GATE6B_DEV_PORT: String(DEV_PORT), GATE6B_SIDECAR_PORT: String(SIDECAR_PORT), GATE6B_OUT: path.join(outOf(item, backend), 'gate6b'), JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' };
  Object.assign(process.env, e6);
  fs.mkdirSync(e6.GATE6B_OUT, { recursive: true });
  if (!fs.existsSync(RUN)) throw new Error(`no run dir ${RUN}`);
  const run = (a, extra = {}) => spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit', env: { ...env, ...e6, ...extra } });
  if (run([path.join(root, 'tools', 'gate6b.mjs'), 'start', 'G6B Flat Base', backend]).status !== 0) throw new Error('the client did not start');
  const L = await game();
  await L.connect();
  if (run([path.join(root, 'tools', 'gate6b.mjs'), 'base']).status !== 0) throw new Error('gate6b base failed');
  const auth = await L.logAuth(`${item}:client`);
  if (backend === 'claude' && (auth.auth !== 'ok' || !/claude login/i.test(auth.authSource ?? ''))) { run([path.join(root, 'tools', 'gate6b.mjs'), 'stop']); throw Object.assign(new Error(`refusing ${item}: the client's sidecar is not on the claude login (${JSON.stringify(auth)})`), { code: 2 }); }
  if (backend === 'sim' && !/sim/i.test(auth.authSource ?? '')) { run([path.join(root, 'tools', 'gate6b.mjs'), 'stop']); throw new Error(`${item} sim: the client's sidecar is not the sim (${auth.authSource})`); }
  return { L, auth, env: { ...env, ...e6 }, stop: () => run([path.join(root, 'tools', 'gate6b.mjs'), 'stop']) };
}
const scnFile = (id) => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', `${id}.json`), 'utf8'));

/** P2: the Styles (own helper), then each scenario's brief run on the client (S6's site archetypes paid through scenario-sb's PAY plan). */
subs.p2 = async () => {
  const backend = backendOf();
  needGo('P2', backend);
  const out = outOf('P2', backend);
  const only = opt('scn') ? String(opt('scn')).split(',') : null;
  const scns = S2.P2_SCENARIOS.filter((s) => !only || only.includes(s.key));
  const res = readJson(path.join(out, 'p2.json'), { styles: {}, runs: {} });
  Object.assign(res, { at: new Date().toISOString(), head: gitHead(), backend });
  const B = S2.BUDGETS.P2;
  // 1. the Styles (no client: the helper and the client never share the port)
  const h = await Helper.start(path.join(out, 'helper'), backend);
  try {
    if (!helperAuthOk(h, backend)) throw Object.assign(new Error(`refusing P2: the helper's auth ${JSON.stringify(h.auth())}`), { code: 2 });
    for (const s of scns) {
      if (res.styles[s.key]?.status === 'done' && fs.existsSync(res.styles[s.key].file)) continue; // (a re-run pays nothing twice)
      const sc = scnFile(s.scenario);
      res.styles[s.key] = await job(backend, { item: 'P2', step: `P2:style:${s.key}`, capUsd: B.style, authSource: h.auth().authSource, minutes: 40 }, () => styleJob(h, { prompt: S2.briefOf(sc), name: `PAY ${s.key.toUpperCase()} Settlement`, scope: 'settlement', budgetUsd: B.style }));
      writeJson(path.join(out, 'p2.json'), res);
    }
  } finally { await h.stop(); }
  // 2. the brief runs on the client
  const c = await client(backend, 'P2');
  try {
    for (const s of scns) {
      const st = res.styles[s.key];
      if (st?.status !== 'done') { res.runs[s.key] = { skipped: `its Style is not shown (${st?.status} ${st?.error ?? ''})` }; continue; }
      const runOut = path.join(out, 'scenarios', `${s.key}-pay`);
      const budget = s.via === 'compose' ? B.compose : B.pick;
      const plan = s.designs ? { item: 'P2', backend, ledger: backend === 'claude' ? LEDGER : path.join(out, 'sim-ledger.json'), ledgerModule: 'pay', opPrefix: `pay-p2-${backend}-${Date.now().toString(36)}`, capUsd: B.design, timeoutMin: 45, auto: { maxDesigns: B.maxDesigns, request: { buildingType: 'house', style: st.bibleId, bible: st.bibleId, name: 'PAY S6', notes: 'A home carved into the rock of the hall.' } } } : null;
      const pf = plan ? path.join(out, `pa-plan-${s.key}.json`) : null;
      if (plan) writeJson(pf, plan);
      const a = ['run', s.key, '--brief', '--via', s.via, '--budget', String(budget), '--images', '--style-file', st.file, '--phase', `7c-pay-${backend}`, '--out', runOut,
        ...(s.via === 'compose' ? ['--brief-ext', path.join(root, 'tools', 'lib', 'pay-compose-ext.json')] : []), ...(s.saveWorld ? ['--save-world', S2.p4World(s.key)] : [])];
      const slog = path.join(out, `${s.key}.scenario.log`);
      res.runs[s.key] = await job(backend, { item: 'P2', step: `P2:brief:${s.key}`, capUsd: budget, authSource: c.auth.authSource, minutes: 120 }, async () => {
        const fd = fs.openSync(slog, 'a');
        const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...a], { cwd: root, stdio: ['ignore', fd, fd], env: { ...c.env, SCENARIOS_ART: path.join(out, 'scenarios'), ARCHITECT_SHOTS_DIR: path.join(out, 'shots'), ...(pf ? { PA_PLAN: pf } : {}) } });
        fs.closeSync(fd);
        const b = readJson(path.join(runOut, 'brief.json'), {});
        const m = readJson(path.join(runOut, 'metrics.json'), {});
        const se = readJson(path.join(runOut, 'site-entries.json'), null);
        const rows = (m.rows ?? []).map((x) => ({ id: x.id, pass: x.pass, gated: x.gated, value: String(x.value).slice(0, 160) }));
        // (the brief's own cost is this job's; the site archetypes are their own ledger jobs, opened by scenario-sb)
        return { usd: b.costUsd ?? 0, status: b.outcome ?? (b.status ?? `exit ${r.status}`), ended: true, ref: b.designId, error: b.error ?? undefined, data: { exit: r.status, via: s.via, outcome: b.outcome, program: b.program, composed: !!b.composed, pick: b.pick?.outcome, artifactSha: b.artifactSha, rows, failing: rows.filter((x) => x.gated && x.pass === false && x.id !== 'gallery').map((x) => x.id), archetypes: se?.pa?.jobs?.map((j) => ({ lot: j.lot, status: j.status, usd: j.usd, entryId: j.entryId })) ?? null, notShown: se?.pa?.notShown ?? null, savedWorld: s.saveWorld ? S2.p4World(s.key) : null, log: slog, out: runOut } };
      });
      writeJson(path.join(out, 'p2.json'), res);
    }
  } finally { c.stop(); writeJson(path.join(out, 'p2.json'), res); }
  report2('P2', backend, res);
};

/** P3: the two authoring sessions on builder-written briefs (Regions.authorProgram), each on a fresh copy of its pinned site. */
subs.p3 = async () => {
  const backend = backendOf();
  needGo('P3', backend);
  const out = outOf('P3', backend);
  // --budget <usd>: each session's budget (default the item's; the R retry runs two at $0.50, Noah's $1.00 for both)
  const budget = opt('budget') ? Number(opt('budget')) : S2.BUDGETS.P3.author;
  const res = { at: new Date().toISOString(), head: gitHead(), backend, budget, retry: opt('retry') ?? null, sessions: {} };
  const file = opt('retry') ? 'p3-retry.json' : 'p3.json';
  const c = await client(backend, 'P3');
  const stamp = Date.now().toString(36);
  try {
    for (const s of S2.P3_SESSIONS) {
      const claim = await siteWorld(c.L, s, 'P3');
      try {
        res.sessions[s.key] = await job(backend, { item: 'P3', step: `P3:author:${s.key}${opt('retry') ? ':retry' : ''}`, capUsd: budget, authSource: c.auth.authSource, minutes: 60 }, async () => {
          const d = await c.L.call('dev.region.author', { brief: s.brief, claim, budgetUsd: budget, opKey: `pay-p3-${backend}-${stamp}-${s.key}`, wait: true }, 3_600_000);
          const r = d.result ?? {};
          return { usd: d.costUsd ?? r.cost ?? 0, status: r.outcome ?? d.status ?? 'refused', ref: d.designId, error: d.refused ?? d.error ?? undefined, data: { site: s.site, claim, brief: s.brief, status: d.status, outcome: r.outcome ?? null, rounds: r.rounds ?? null, program: r.program ?? null, reason: r.reason ?? null } };
        });
      } finally { await c.L.cmd(`/forceload remove ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`).catch(() => null); }
      writeJson(path.join(out, file), res);
    }
  } finally { c.stop(); writeJson(path.join(out, file), res); }
  report2('P3', backend, res);
};

/** P4: the composer on S3's and S6's briefs with the images OFF, each on a clone of the world P2's images-on arm read. */
subs.p4 = async () => {
  const backend = backendOf();
  needGo('P4', backend);
  const out = outOf('P4', backend);
  const p2 = readJson(path.join(outOf('P2', backend), 'p2.json'), null);
  const res = { at: new Date().toISOString(), head: gitHead(), backend, pairs: {} };
  const c = await client(backend, 'P4');
  try {
    for (const s of S2.P2_SCENARIOS.filter((x) => x.saveWorld)) {
      const on = p2?.runs?.[s.key];
      const saved = path.join(c.L.SAVES, S2.p4World(s.key));
      // the saved world must be THIS P2 run's (its marker names the run's out dir): never an older run's, never land generated again
      const mark = readJson(path.join(saved, 'pay-saved.json'), null);
      if (!on?.data?.out || !fs.existsSync(saved) || mark?.out !== on.data.out) { res.pairs[s.key] = { skipped: `P2's ${s.key} run or its saved world is missing or another run's (${saved}, marker ${JSON.stringify(mark)}): P4 never composes on land generated again` }; continue; }
      const sc = scnFile(s.scenario);
      const claim = sc.fixture.claim;
      const st = p2.styles[s.key];
      await c.L.fresh(`G6B PAY P4 ${s.key}`, S2.p4World(s.key));
      await c.L.setRules('exact').catch(() => null);
      await c.L.tp((claim[0] + claim[2]) / 2, sc.fixture.yRange?.[1] ?? 200, (claim[1] + claim[3]) / 2);
      await c.L.call('dev.waitChunks', { timeoutMs: 180_000 }, 240_000).catch(() => null);
      await c.L.cmd(`/forceload add ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`);
      await c.L.settle(5000);
      try {
        const off = await job(backend, { item: 'P4', step: `P4:compose:${s.key}`, capUsd: S2.BUDGETS.P4.compose, authSource: c.auth.authSource, minutes: 30 }, async () => {
          const d = await c.L.call('dev.region.compose', { brief: S2.briefOf(sc), claim, style: st?.bibleId, images: false, budgetUsd: S2.BUDGETS.P4.compose, opKey: `pay-p4-${backend}-${Date.now().toString(36)}-${s.key}`, ext: { [SKIP_PICK]: true }, wait: true }, 1_800_000);
          const x = composeRead(d);
          return { usd: x.costUsd, status: x.outcome ?? x.status, ref: x.designId, error: x.error ?? undefined, data: { ...x, plan: d.result?.plan ?? null } };
        });
        const onBrief = readJson(path.join(on.data.out, 'brief.json'), {});
        res.pairs[s.key] = { savedWorld: S2.p4World(s.key), on: { outcome: onBrief.outcome, artifactSha: onBrief.artifactSha, plan: onBrief.plan ?? null, usd: onBrief.costUsd }, off: { outcome: off.data?.outcome, artifactSha: off.data?.artifactSha, plan: off.data?.plan ?? null, usd: off.usd } };
      } finally { await c.L.cmd(`/forceload remove ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`).catch(() => null); }
      writeJson(path.join(out, 'p4.json'), res);
    }
  } finally { c.stop(); writeJson(path.join(out, 'p4.json'), res); }
  abSheet('P4', out, Object.entries(res.pairs).filter(([, p]) => p.on && p.off).map(([k, p]) => ({ pair: k, on: { text: planText(p.on) }, off: { text: planText(p.off) } })), 'Plan pick sheet', 'Two plans per pair, each composed from the same brief on the same land. For each pair, pick the one you prefer (A or B).');
  report2('P4', backend, res);
};
const planText = (x) => `${x.outcome ?? '-'}\n${JSON.stringify(x.plan ?? null, null, 1)}`;

/** P5: the settlement Style job on S3 and S5 with N-7c-4's references (own helper); the off arm is P2's Style of the same scenario. */
subs.p5 = async () => {
  const backend = backendOf();
  needGo('P5', backend);
  const out = outOf('P5', backend);
  const p2 = readJson(path.join(outOf('P2', backend), 'p2.json'), {});
  const res = { at: new Date().toISOString(), head: gitHead(), backend, styles: {} };
  const h = await Helper.start(path.join(out, 'helper'), backend);
  try {
    if (!helperAuthOk(h, backend)) throw Object.assign(new Error(`refusing P5: the helper's auth ${JSON.stringify(h.auth())}`), { code: 2 });
    for (const s of S2.P5_STYLES) {
      const files = s.refs.map((r) => path.join(REFS, `${r}.png`));
      if (!files.every((f) => fs.existsSync(f))) { res.styles[s.key] = { skipped: `references missing in ${REFS}` }; continue; }
      const blobs = [];
      for (const [i, f] of files.entries()) blobs.push({ blob: await h.image(f), label: `${s.refs[i]} (gpt-image-2)` });
      const sc = scnFile(s.scenario);
      res.styles[s.key] = await job(backend, { item: 'P5', step: `P5:style:${s.key}`, capUsd: S2.BUDGETS.P5.style, authSource: h.auth().authSource, minutes: 40 }, () => styleJob(h, { prompt: S2.briefOf(sc), name: `PAY ${s.key.toUpperCase()} Settlement R`, scope: 'settlement', budgetUsd: S2.BUDGETS.P5.style, ext: { [REF_EXT]: blobs } }));
      const bj = readJson(res.styles[s.key].file, {});
      res.styles[s.key].references = bj.references ?? null;
      writeJson(path.join(out, 'p5.json'), res);
    }
  } finally { await h.stop(); writeJson(path.join(out, 'p5.json'), res); }
  abSheet('P5', out, S2.P5_STYLES.filter((s) => res.styles[s.key]?.status === 'done' && p2.styles?.[s.key]?.status === 'done').map((s) => ({ pair: s.key, on: { img: res.styles[s.key].sheet }, off: { img: p2.styles[s.key].sheet } })), 'Style pick sheet', 'Two Styles per pair for the same place. For each pair, pick the one you prefer (A or B).');
  report2('P5', backend, res);
};

/** P6 (optional): one landmark past the cap as a Composite, on our own helper (sim: the kit's composite castle, sim:composite). */
subs.p6 = async () => {
  const backend = backendOf();
  needGo('P6', backend);
  const out = outOf('P6', backend);
  const res = { at: new Date().toISOString(), head: gitHead(), backend };
  const h = await Helper.start(path.join(out, 'helper'), backend);
  try {
    if (!helperAuthOk(h, backend)) throw Object.assign(new Error(`refusing P6: the helper's auth ${JSON.stringify(h.auth())}`), { code: 2 });
    const req = { ...S2.P6_REQUEST, budgetUsd: S2.BUDGETS.P6.design, ext: { ...S2.P6_REQUEST.ext, ...(backend === 'sim' ? { 'architect:sim': ['composite'] } : {}) } };
    res.design = await job(backend, { item: 'P6', step: 'P6:composite', capUsd: S2.BUDGETS.P6.design, authSource: h.auth().authSource, minutes: 60 }, async () => {
      const a = await h.send({ type: 'design.request', request: req });
      const t0 = Date.now();
      let d;
      for (;;) {
        d = h.designs?.get(a.designId);
        if (d && ['done', 'failed', 'cancelled'].includes(d.status)) break;
        if (Date.now() - t0 > 60 * 60_000) { d = { ...(d ?? {}), status: 'timeout' }; break; }
        await sleep(5000);
      }
      const entry = d.blueprintId ?? d.entryId ?? null;
      const bp = entry ? readJson(path.join(h.dir, 'library', entry, `${entry}.blueprint.json`), {}) : {};
      return { usd: d.cost?.usd ?? 0, status: d.status, ended: d.status !== 'timeout', ref: a.designId, error: d.error ?? undefined, data: { entryId: entry, composite: bp.ext?.['architect_mc:composite'] ?? bp.ext?.composite ?? null, size: bp.size ?? null } };
    });
  } finally { await h.stop(); writeJson(path.join(out, 'p6.json'), res); }
  report2('P6', backend, res);
};

/**
 * `p4-sheet` ($0): P4's blind sheet as pictures. Each pair's two plans (images on: P2's arm; off: P4's) planned through plan_v0 by the kit's
 * own check over the SAME land (P2's run's own plan survey) and Style, rendered by the kit's previews (siteplan, iso, top), sides
 * randomised, the key in its own file. Writes ab/ over the text sheet (the plans stay in p4.json).
 */
subs['p4-sheet'] = async () => {
  const backend = backendOf();
  const out = outOf('P4', backend);
  const p4 = readJson(path.join(out, 'p4.json'), null);
  const p2 = readJson(path.join(outOf('P2', backend), 'p2.json'), null);
  if (!p4 || !p2) throw new Error('p4-sheet needs P2\'s and P4\'s records');
  const { renderPlan } = await import('./lib/pay-render.mjs');
  const pairs = [];
  for (const [k, pr] of Object.entries(p4.pairs)) {
    if (!pr.on?.plan || !pr.off?.plan) continue;
    const planDir = path.join(p2.runs[k].data.out, 'raw', 'plan');
    const req = readJson(path.join(planDir, 'request.json'), {});
    const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
    const arms = {};
    for (const arm of ['on', 'off']) {
      const r = await renderPlan({ plan: pr[arm].plan, survey, claim: req.claim, bible: req.bible, roles: req.roles, outDir: path.join(out, 'render', `${k}-${arm}`) });
      const views = ['siteplan', 'iso', 'top'].flatMap((v) => (r.paths[v] ?? []).filter((f) => f.endsWith('.png')).slice(0, 1));
      arms[arm] = { imgs: views, overall: r.overall, lots: r.lots };
      log(`P4 sheet ${k} ${arm}: ${r.overall}, ${r.lots} lots; ${views.map((f) => path.basename(f)).join(', ')}`);
    }
    pairs.push({ pair: k, ...arms });
  }
  abSheet('P4', out, pairs, 'Plan pick sheet', 'Two plans per pair, each composed from the same brief for the same land, drawn the same way (the site plan, a bird\'s-eye view and the top view). For each pair, pick the one you prefer (A or B).');
};

/** R: the reserve is retries only: every item's command takes --retry (charged to R, one per item; the guard refuses a second). */
subs.r = async () => { console.log('R: no command of its own. Re-run an item\'s command with --retry (and --scn/--attempt where it takes them): its jobs are charged to R, at most one retry per item (tools/lib/pay-ledger.mjs guard).'); };

/** A blind A/B sheet: per pair, the two arms as A and B (sides randomised), the key in its own file (never on the sheet). */
function abSheet(item, out, pairs, title, intro) {
  const dir = path.join(out, 'ab');
  fs.mkdirSync(dir, { recursive: true });
  const key = {};
  const html = [`<!doctype html><meta charset="utf-8"><title>${title}</title>`, '<style>body{font:16px system-ui;margin:24px;max-width:1200px}.row{display:flex;gap:12px}figure{flex:1;margin:0}img{width:100%;border:1px solid #888}pre{white-space:pre-wrap;font-size:12px;border:1px solid #888;padding:8px;max-height:600px;overflow:auto}</style>', `<h1>${title}</h1><p>${intro}</p>`];
  pairs.forEach((p, i) => {
    const flip = crypto.randomBytes(1)[0] & 1;
    key[p.pair] = flip ? { A: 'off', B: 'on' } : { A: 'on', B: 'off' };
    const cell = (side) => { const arm = p[key[p.pair][side]];
      // (several pictures per arm: the same views in the same order on both sides)
      if (arm.imgs?.length) return `<figure>${arm.imgs.filter((f) => fs.existsSync(f)).map((f, j) => { const n = `pair-${i + 1}-${side}-${j + 1}${path.extname(f)}`; fs.copyFileSync(f, path.join(dir, n)); return `<img src="${n}">`; }).join('')}<figcaption>${side}</figcaption></figure>`;
      if (arm.img && fs.existsSync(arm.img)) { const f = `pair-${i + 1}-${side}${path.extname(arm.img)}`; fs.copyFileSync(arm.img, path.join(dir, f)); return `<figure><img src="${f}"><figcaption>${side}</figcaption></figure>`; } return `<figure><pre>${String(arm.text ?? '').replace(/</g, '&lt;')}</pre><figcaption>${side}</figcaption></figure>`; };
    html.push(`<h2>Pair ${i + 1}</h2><div class="row">${cell('A')}${cell('B')}</div><p>Pick: A / B</p>`);
  });
  fs.writeFileSync(path.join(dir, 'sheet.html'), `${html.join('\n')}\n`);
  writeJson(path.join(out, 'ab-key.json'), { at: new Date().toISOString(), note: `which arm each side shows (on = the references or images on; off = without). Not for Noah until his picks are recorded.`, key });
  log(`${item} A/B sheet: ${path.join(dir, 'sheet.html')} (${pairs.length} pair(s)); key ${path.join(out, 'ab-key.json')}`);
}
function report2(item, backend, res) {
  const L = P.readLedger(LEDGER);
  log(`${item} (${backend}) done; ${backend === 'claude' ? `${item} spent $${L.items[item].spentUsd} of its ceiling $${P.ceilingOf(item)}; ledger $${L.totalUsd}` : '$0 (sim)'}; ${path.join(outOf(item, backend), `${item.toLowerCase()}.json`)}`);
}

// ---- the entry --------------------------------------------------------------------------------------------------------------------

async function only(item) {
  if (item === 'P0') { await subs['p0-styles'](); await subs['p0-verdict'](); return; }
  if (item === 'P1') { await subs['p1-style'](); await subs['p1-compose'](); await subs.restate(); return; }
  // (stage 2) P2-P6 and R: --backend sim ($0) by default; --backend claude needs the coordinator's recorded go `<item>:go`
  const k = item.toLowerCase();
  if (subs[k] && /^(p[2-6]|r)$/.test(k)) { await subs[k](); return; }
  throw new Error(`--only P0|P1|P2|P3|P4|P5|P6|R (got ${item})`);
}

const sub = args[0];
try {
  if (args.includes('--plan')) await subs.plan();
  else if (opt('only')) await only(String(opt('only')));
  else if (subs[sub]) await subs[sub]();
  else { console.error('usage: node tools/gate7cpay.mjs --plan | --only P0|P1 | status | p0-styles | p0-compose | p0-verdict | p1-style | p1-compose | restate | answer'); process.exitCode = 64; }
} catch (e) {
  log(`stopped: ${e.stack ?? e.message}`);
  process.exitCode = e.code ?? 1;
}
// (the DevBridge client and the box watcher keep the event loop alive: a step ends when its work does)
process.exit(process.exitCode ?? 0);
