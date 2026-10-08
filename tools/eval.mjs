#!/usr/bin/env node
// Architect's eval harness (docs/CONTRACT.md "Phase 5a contract", "The eval harness (R8)").
//
//   node tools/eval.mjs run --tier sim|smoke|full [--label <name>] [--briefs 1,3] [--max-usd N] [--models opus-subset]
//                           [--resume <runId>] [--out <dir>] [--ledger <spend.json> --total-cap 120 --reserve N] [--port N]
//   node tools/eval.mjs rescore <runId> [--out <dir>]          recompute every deterministic metric from the stored files ($0)
//   node tools/eval.mjs rejudge <runId> [--briefs 1,3] [--out <dir>] [--ledger ...]   the blind judge again (judge cost only)
//   node tools/eval.mjs compare <runA> <runB> [--judge] [--out <dir>]   A = before, B = after: deltas and a verdict
//
// A run starts its own sidecar (no game) on a free port in 8890-8895 with fresh data, library and bibles dirs under
// <out>/<runId>/sidecar/, `--backend sim` for the sim tier, else `--backend claude --use-claude-login`, and drives it
// over WebSocket protocol 2. Each brief is submitted with critique `loop`: round 0 is the no-critique design, so one run
// gives the pair round 0 vs final. A blind pairwise judge (Opus) compares them twice with the order swapped.
//
// Guards: a real tier refuses to start when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (or any *_API_KEY of a Claude
// provider) is set; gate and eval runs use the claude login only. A spend guard stops submitting when the cumulative SDK
// cost estimate plus the next brief's seeded high would pass the cap (--max-usd, default the tier's; and, with --ledger,
// what is left of --total-cap after the ledger's entries and --reserve). Usage-limit holds are waited out.
//
// Output: <out>/<runId>/ (local: rounds, renders, verdicts, judge answers, logs) and eval/results/<label>/summary.json
// (committed: metrics per brief, aggregates, versions and hashes; no PNGs). summary.json is a pure function of the stored
// files, so `rescore` reproduces it byte for byte.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BRIEFS_DIR = path.join(REPO, 'eval', 'briefs', 'v1');
const BRIEF_SET = 'v1';
const FIXTURE_BIBLES = path.join(REPO, 'eval', 'fixtures', 'bibles');
const KIT = path.join(REPO, 'kit');
/** the sidecar bundle (ARCHITECT_EVAL_SIDECAR overrides: a test's own copy) */
const SIDECAR = process.env.ARCHITECT_EVAL_SIDECAR ? path.resolve(process.env.ARCHITECT_EVAL_SIDECAR) : path.join(REPO, 'sidecar', 'dist', 'main.mjs');
const PORTS = [8890, 8891, 8892, 8893, 8894, 8895];
const MIN = 60_000;

export const TIERS = {
  sim: { briefs: null, maxRevisions: 2, capUsd: Infinity },
  smoke: { briefs: [1, 3, 10, 13], maxRevisions: 1, capUsd: 12 },
  full: { briefs: null, maxRevisions: 2, capUsd: 85 },
};
export const OPUS_SUBSET = { briefs: [5, 8, 10, 14], model: 'claude-opus-5-5', capUsd: 26 };
export const JUDGE_MODEL = 'claude-opus-5-5';
export const JUDGE_EFFORT = 'medium';
/** the judge sees 4 views of each set (8 images, the job.images limit): the exterior read */
export const JUDGE_VIEWS = ['iso', 'iso_back', 'front', 'top'];
/** a judge call's seeded high */
const JUDGE_HIGH = 0.15;
const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];

export const JUDGE_SYSTEM = [
  'You are a blind judge of Minecraft building designs. You see two versions of one building, A and B, each as the same fixed flat-colour renders (one colour per block): iso (front-left), iso_back (back-right), front (elevation) and top (from above, north at the top).',
  'You are told only what was asked for. Judge which version a player would rather have, on silhouette (massing and roof read as the type), legibility (doors, windows, entrance readable, no noise), craft (no floating or stray blocks, finished corners), materials (a coherent palette used with restraint) and the brief.',
  'Say "tie" only when you truly cannot prefer one. Answer with your structured output only.',
].join('\n');

export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['preferred', 'margin', 'dimensions', 'reasons'],
  properties: {
    preferred: { type: 'string', enum: ['A', 'B', 'tie'] },
    margin: { type: 'string', enum: ['slight', 'clear', 'strong'] },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['silhouette', 'legibility', 'craft', 'materials', 'brief'],
      properties: Object.fromEntries(['silhouette', 'legibility', 'craft', 'materials', 'brief'].map((d) => [d, { type: 'string', enum: ['A', 'B', 'tie'] }])),
    },
    reasons: { type: 'string', maxLength: 400 },
  },
};

export function judgePrompt(brief) {
  const r = brief.request;
  return [
    `The request: a ${r.type}${r.profile ? ` (an open type: ${r.profile.join(', ')})` : ''}, style "${r.style}", at most ${r.maxSize.x}x${r.maxSize.y}x${r.maxSize.z}.`,
    r.features?.length ? `Features: ${r.features.join(', ')}.` : '',
    r.notes ? `Notes: ${r.notes}` : '',
    r.critique?.extraCriteria?.length ? `Also judge: ${r.critique.extraCriteria.join('; ')}.` : '',
    '',
    `The images: ${JUDGE_VIEWS.map((v) => `A_${v}`).join(', ')}, then ${JUDGE_VIEWS.map((v) => `B_${v}`).join(', ')}. Which version is better?`,
  ].filter((l) => l !== '').join('\n');
}

// ---- small utils ----------------------------------------------------------------------------------------

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const readJson = (f, d = undefined) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`);
  fs.renameSync(tmp, f);
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** A deterministic RNG from a string (the judge's A/B order). */
export function rngFrom(s) {
  let h = parseInt(sha(s).slice(0, 8), 16);
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 2 ** 32;
  };
}

/** One-sided sign test: P(X >= wins) for X ~ Binomial(n, 0.5). */
export function signTestP(wins, n) {
  if (n <= 0) return 1;
  let p = 0;
  const c = (k) => {
    let v = 1;
    for (let i = 1; i <= k; i++) v = (v * (n - k + i)) / i;
    return v;
  };
  for (let k = wins; k <= n; k++) p += c(k) / 2 ** n;
  return p;
}

export function loadBriefs(ids) {
  const files = fs.readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.json')).sort();
  const all = files.map((f) => ({ ...readJson(path.join(BRIEFS_DIR, f)), file: f }));
  return ids ? all.filter((b) => ids.includes(b.n)) : all;
}

function hashFiles(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(path.relative(REPO, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

function walk(dir, skip = /(^|\/)(node_modules|out|\.git)(\/|$)/) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (skip.test(path.relative(REPO, p))) continue;
    if (e.isDirectory()) out.push(...walk(p, skip));
    else out.push(p);
  }
  return out;
}

/** What a result records about versions and inputs (reproducibility). */
export function provenance() {
  const pkg = readJson(path.join(REPO, 'sidecar', 'package.json'), {});
  const gradle = fs.existsSync(path.join(REPO, 'mod', 'gradle.properties')) ? fs.readFileSync(path.join(REPO, 'mod', 'gradle.properties'), 'utf8') : '';
  const src = (f) => path.join(REPO, 'sidecar', 'src', f);
  return {
    sidecarVersion: pkg.version ?? '?',
    modVersion: /mod_version=(.*)/.exec(gradle)?.[1]?.trim() ?? '?',
    briefSet: BRIEF_SET,
    hashes: {
      briefs: hashFiles(fs.readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(BRIEFS_DIR, f))),
      kit: hashFiles(walk(KIT).filter((f) => !f.includes(`${path.sep}test${path.sep}`))),
      designPrompts: hashFiles([src('claude/brief.ts')]),
      critic: hashFiles([src('critic.ts')]),
      judge: sha(JSON.stringify({ JUDGE_SYSTEM, JUDGE_SCHEMA, views: JUDGE_VIEWS, prompt: judgePrompt.toString() })),
    },
    models: { critic: 'claude-sonnet-5-5 (medium)', judge: `${JUDGE_MODEL} (${JUDGE_EFFORT})` },
  };
}

// ---- the spend ledger ------------------------------------------------------------------------------------

export function ledgerTotal(file) {
  const l = readJson(file, { entries: [] });
  return r4((l.entries ?? []).reduce((a, e) => a + (e.usd ?? 0), 0));
}

/** Put (replace by `what`) an entry into the ledger and recompute its total. */
export function ledgerPut(file, what, usd, note) {
  if (!file) return;
  const l = readJson(file, { capUsd: 120, entries: [] });
  l.entries = (l.entries ?? []).filter((e) => e.what !== what);
  l.entries.push({ what, usd: r4(usd), ...(note ? { note } : {}) });
  l.totalUsd = r4(l.entries.reduce((a, e) => a + (e.usd ?? 0), 0));
  writeJson(file, l);
}

// ---- the sidecar and its WebSocket --------------------------------------------------------------------------

async function freePort(prefer) {
  for (const p of prefer ? [prefer] : PORTS) {
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => s.close(() => res(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port in ${PORTS.join(', ')}`);
}

/** Start a sidecar for a run: its own data, library, bibles and massings dirs; the sim or the claude login. */
async function startSidecar(runDir, tier, port) {
  const sd = path.join(runDir, 'sidecar');
  const dirs = { data: path.join(sd, 'data'), library: path.join(sd, 'library'), bibles: path.join(sd, 'bibles'), massings: path.join(sd, 'massings') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // the sim's notional costs: a round 0 of $0.45 (3 steps), a critic call $0.01, a revision $0.45
  if (tier === 'sim' && !fs.existsSync(path.join(dirs.data, 'config.json'))) writeJson(path.join(dirs.data, 'config.json'), { simStepMs: 20, simDesignUsd: 0.15, simJobStepUsd: 0.01, simLimitMs: 500 });
  if (!fs.existsSync(SIDECAR)) throw new Error(`no ${SIDECAR}: cd sidecar && npm run build`);
  const env = { ...process.env };
  for (const k of [...KEY_VARS, 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];
  const args = [SIDECAR, '--port', String(port), '--data', dirs.data, '--library', dirs.library, '--kit', KIT, '--bibles', dirs.bibles, '--massings', dirs.massings, '--parent-pid', String(process.pid), ...(tier === 'sim' ? ['--backend', 'sim'] : ['--backend', 'claude', '--use-claude-login'])];
  const out = fs.openSync(path.join(runDir, 'sidecar.log'), 'a');
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', out, out] });
  const tokenFile = path.join(dirs.data, 'client.token');
  const end = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the sidecar exited (${child.exitCode}); see ${path.join(runDir, 'sidecar.log')}`);
    const sj = readJson(path.join(dirs.data, 'sidecar.json'));
    if (sj?.pid === child.pid && fs.existsSync(tokenFile)) break;
    if (Date.now() > end) throw new Error('the sidecar did not start in 60 s');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, dirs, token: fs.readFileSync(tokenFile, 'utf8').trim() };
}

class Client {
  constructor(port, token) {
    this.port = port;
    this.token = token;
    this.designs = new Map();
    this.jobs = new Map();
    this.groups = new Map();
    this.status = undefined;
    this.waiters = new Map();
    this.seq = 0;
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('cannot connect to the sidecar'));
    });
    this.ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)));
    this.ws.onclose = () => {
      this.closed = true;
    };
    const snap = new Promise((res) => (this.onSnapshot = res));
    this.send({ type: 'hello', client: 'eval', version: 'eval.mjs', token: this.token, protocols: [2] });
    await snap;
  }

  onMessage(m) {
    if (m.type === 'snapshot') {
      for (const d of m.designs ?? []) this.designs.set(d.id, d);
      for (const j of m.jobs ?? []) this.jobs.set(j.id, j);
      for (const g of m.groups ?? []) this.groups.set(g.id, g);
      this.status = m.status;
      this.features = m.features;
      this.onSnapshot?.(m);
    } else if (m.type === 'design.upsert') this.designs.set(m.design.id, m.design);
    else if (m.type === 'job.upsert') this.jobs.set(m.job.id, m.job);
    else if (m.type === 'group.upsert') this.groups.set(m.group.id, m.group);
    else if (m.type === 'status') this.status = m.status;
    else if (m.type === 'ack') {
      const w = this.waiters.get(m.re);
      if (w) {
        this.waiters.delete(m.re);
        if (m.ok) w.res(m.result ?? {});
        else w.rej(new Error(m.error ?? 'refused'));
      }
    }
  }

  send(m) {
    this.ws.send(JSON.stringify({ v: 1, ...m }));
  }

  call(m) {
    // (bible.revise / bible.delete / bible.archive carry the bible id in `id`, which is also the correlation id)
    const id = m.id ?? `e${++this.seq}`;
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      this.send({ ...m, id });
    });
  }

  async putPng(file) {
    const buf = fs.readFileSync(file);
    const step = 700 * 1024;
    let blobId;
    for (let off = 0; off < buf.length || off === 0; off += step) {
      const part = buf.subarray(off, off + step);
      const more = off + step < buf.length;
      const r = await this.call({ type: 'blob.put', ...(blobId ? { blobId } : { kind: 'eval.image', owner: 'eval', ext: 'png' }), chunks: [part.toString('base64')], ...(more ? { more: true } : {}) });
      blobId = r.blobId;
      if (!more) break;
    }
    return blobId;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(['done', 'failed', 'cancelled']);

// ---- running ----------------------------------------------------------------------------------------------

function authGuard(tier) {
  const present = Object.fromEntries(AUTH_VARS.map((k) => [k, !!process.env[k]?.trim()]));
  const keys = Object.keys(process.env).filter((k) => KEY_VARS.includes(k) && process.env[k]?.trim());
  if (tier !== 'sim' && keys.length) throw new Error(`refused: ${keys.join(', ')} is set. Real eval tiers run on the claude login only, never an API key: unset it and run again.`);
  return present;
}

/** The sim tier's scripted critic and judge (the harness is what is tested). */
function simScript(b) {
  const scripts = ['8', '5/8', '6/7.5', '5/5/7', '6/4', '5?part/8', '5/6/6', '6/8', '7/8', '5/7', '4/6/8', '6/7', '5/8', '6/7/7', '5/6', 'fail', '6/8', '5/7/8'];
  return `sim:critique=${scripts[(b.n - 1) % scripts.length]}`;
}
function simJudge(b, order) {
  const prefer = b.n % 6 === 0 ? (order.A === 'final' || order.B === 'final' ? 'round0' : 'before') : order.A === 'final' || order.B === 'final' ? 'final' : 'after';
  const pick = prefer === order.A ? 'A' : 'B';
  return { preferred: pick, margin: 'clear', dimensions: { silhouette: pick, legibility: pick, craft: 'tie', materials: pick, brief: pick }, reasons: `simulated judge for brief ${b.n}` };
}

/**
 * Install a fixture bible (eval/fixtures/bibles/<id>/: its files are v1; versions/<n>/ holds later versions, e.g. the
 * format 2 revision made in the 5a gate) into a run's bibles dir. The latest version is copied to the top, as the
 * sidecar installs them.
 */
function installFixtureBible(biblesDir, id) {
  const src = path.join(FIXTURE_BIBLES, id);
  const versions = [[1, src], ...(fs.existsSync(path.join(src, 'versions')) ? fs.readdirSync(path.join(src, 'versions')).filter((v) => /^\d+$/.test(v)).map((v) => [Number(v), path.join(src, 'versions', v)]) : [])].sort((a, b) => a[0] - b[0]);
  for (const [n, from] of versions) {
    const v = path.join(biblesDir, id, 'versions', String(n));
    if (fs.existsSync(v)) continue;
    fs.mkdirSync(v, { recursive: true });
    for (const f of fs.readdirSync(from).filter((x) => fs.statSync(path.join(from, x)).isFile())) {
      if (f === 'bible.json') fs.writeFileSync(path.join(v, f), `${JSON.stringify({ ...readJson(path.join(from, f)), id, version: n }, null, 2)}\n`);
      else fs.copyFileSync(path.join(from, f), path.join(v, f));
    }
  }
  const latest = path.join(biblesDir, id, 'versions', String(versions.at(-1)[0]));
  for (const f of fs.readdirSync(latest)) fs.copyFileSync(path.join(latest, f), path.join(biblesDir, id, f));
}

async function cmdRun(o) {
  const tier = o.tier;
  if (!TIERS[tier]) throw new Error(`--tier must be sim, smoke or full`);
  const authVars = authGuard(tier);
  const outDir = path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval'));
  let runId = o.resume;
  let runDir;
  let run;
  if (runId) {
    runDir = path.join(outDir, runId);
    run = readJson(path.join(runDir, 'run.json'));
    if (!run) throw new Error(`no run ${runId} in ${outDir}`);
    authGuard(run.tier);
  } else {
    const label = o.label ?? `${tier}${o.models ? `-${o.models}` : ''}`;
    runId = `${label}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
    runDir = path.join(outDir, runId);
    const t = TIERS[tier];
    const ids = o.briefs ?? (o.models === 'opus-subset' ? OPUS_SUBSET.briefs : t.briefs);
    const cap = o.maxUsd ?? (o.models === 'opus-subset' ? OPUS_SUBSET.capUsd : t.capUsd);
    run = { runId, label, tier, models: o.models ?? null, briefs: loadBriefs(ids).map((b) => b.n), maxRevisions: o.maxRevisions ?? t.maxRevisions, capUsd: Number.isFinite(cap) ? cap : null, ledger: o.ledger ?? null, totalCapUsd: o.totalCap ?? null, reserveUsd: o.reserve ?? 0, startedAt: Date.now(), seed: runId, authVars, provenance: provenance(), state: {} };
    fs.mkdirSync(runDir, { recursive: true });
    writeJson(path.join(runDir, 'run.json'), run);
  }
  log(`run ${runId}: tier ${run.tier}, briefs ${run.briefs.join(',')}, cap ${run.capUsd ?? 'none'}${run.ledger ? `, ledger ${run.ledger} (total cap ${run.totalCapUsd}, reserve ${run.reserveUsd})` : ''}`);
  const save = () => writeJson(path.join(runDir, 'run.json'), run);
  const port = await freePort(o.port);
  const sc = await startSidecar(runDir, run.tier, port);
  run.pids = [...(run.pids ?? []), sc.child.pid];
  save();
  log(`sidecar pid ${sc.child.pid} on port ${port}`);
  const stop = () => {
    try {
      sc.child.kill('SIGTERM');
    } catch {
      /* gone */
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  const client = new Client(port, sc.token);
  try {
    await client.connect();
    for (const id of fs.readdirSync(FIXTURE_BIBLES)) installFixtureBible(sc.dirs.bibles, id);
    await drive(run, runDir, client, save);
  } finally {
    client.close();
    stop();
    await sleep(500);
  }
  const summary = summarize(runDir);
  writeJson(path.join(runDir, 'summary.json'), summary);
  if (!o.noResults) writeJson(path.join(REPO, 'eval', 'results', run.label, 'summary.json'), summary);
  log(`done: ${runId}; summary in ${path.join(runDir, 'summary.json')}${o.noResults ? '' : ` and eval/results/${run.label}/summary.json`}`);
  printAggregates(summary);
  return { runId, runDir, summary };
}

/** Submit the briefs under the spend guard, wait for them (holds included), judge them, store each result. */
async function drive(run, runDir, client, save) {
  const briefs = loadBriefs(run.briefs);
  const st = run.state;
  const effectiveCap = () => {
    let cap = run.capUsd ?? Infinity;
    if (run.ledger && run.totalCapUsd) cap = Math.min(cap, run.totalCapUsd - run.reserveUsd - (ledgerTotal(run.ledger) - runSpendSoFar(run, client)));
    return cap;
  };
  const designCost = (id) => client.designs.get(id)?.cost?.usd ?? 0;
  const committed = () => {
    let c = 0;
    for (const b of briefs) {
      const s = st[b.id];
      if (!s?.submitted) continue;
      const spent = (s.designIds ?? []).reduce((a, id) => a + Math.max(designCost(id), s.spent?.[id] ?? 0), 0) + (s.judgeUsd ?? 0);
      c += s.done ? spent : Math.max(spent, s.high ?? 0);
    }
    return c;
  };
  const record = (b) => {
    const s = st[b.id];
    for (const id of s.designIds ?? []) s.spent = { ...(s.spent ?? {}), [id]: Math.max(designCost(id), s.spent?.[id] ?? 0) };
  };
  const groups = new Map();
  for (const b of briefs) if (b.group) groups.set(b.group.id, [...(groups.get(b.group.id) ?? []), b]);
  const units = [];
  for (const b of briefs) if (!b.group) units.push([b]);
  for (const g of groups.values()) units.push(g);
  let stopReason;
  let lastPrint = 0;
  for (;;) {
    // submit what fits
    for (const unit of units) {
      if (unit.every((b) => st[b.id]?.submitted)) continue;
      if (stopReason) break;
      const est = await estimate(client, run, unit);
      const high = est.total;
      const cap = effectiveCap();
      if (committed() + high > cap + 1e-9) {
        const running = units.some((u) => u.some((b) => st[b.id]?.submitted && !st[b.id]?.done));
        if (!running) stopReason = `the spend guard stopped submitting: $${r2(committed())} committed + $${r2(high)} (next high) > cap $${r2(cap)}`;
        break;
      }
      await submit(client, run, unit, est, cap - committed());
      save();
    }
    // progress
    for (const b of briefs) {
      const s = st[b.id];
      if (!s?.submitted || s.done) continue;
      record(b);
      const ds = (s.designIds ?? []).map((id) => client.designs.get(id));
      if (ds.length && ds.every((d) => d && FINAL.has(d.status))) {
        s.done = true;
        s.endedAt = Date.now();
        for (const d of ds) writeJson(path.join(runDir, 'briefs', b.id, `design-${d.id}.json`), d);
        await judgeBrief(client, run, runDir, b, () => effectiveCap() - committed());
        record(b);
        writeJson(path.join(runDir, 'briefs', b.id, 'result.json'), { brief: b.id, n: b.n, designIds: s.designIds, estimate: s.estimate, submittedAt: s.submittedAt, endedAt: s.endedAt, judge: s.judge ?? null, judgeUsd: s.judgeUsd ?? 0 });
        const usd = (s.designIds ?? []).reduce((a, id) => a + (s.spent?.[id] ?? 0), 0) + (s.judgeUsd ?? 0);
        ledgerPut(run.ledger, `${run.runId}:${b.id}`, usd);
        log(`brief ${b.n} ${b.id}: ${ds.map((d) => `${d.status} ${d.critique?.end ?? ''} best ${d.critique?.best ?? '-'} (${d.critique?.overall ?? '-'})`).join('; ')}, $${r2(usd)}${s.judge ? `, judge ${s.judge.outcome}` : ''}`);
        save();
      }
    }
    const all = briefs.every((b) => st[b.id]?.done || (stopReason && !st[b.id]?.submitted));
    if (all) break;
    if (client.closed) throw new Error('the sidecar connection closed');
    if (Date.now() - lastPrint > 60_000) {
      lastPrint = Date.now();
      const held = client.status?.usageLimitUntil ? `, usage limit until ${new Date(client.status.usageLimitUntil).toISOString().slice(11, 16)}Z` : '';
      log(`progress: ${briefs.filter((b) => st[b.id]?.done).length}/${briefs.length} done, committed $${r2(committed())} of cap $${r2(effectiveCap())}${held}`);
    }
    await sleep(1000);
  }
  if (stopReason) {
    run.stopReason = stopReason;
    log(stopReason);
  }
  run.endedAt = Date.now();
  save();
}

/** What the run has already put into the ledger (so a resume does not count it twice against the total cap). */
function runSpendSoFar(run, client) {
  if (!run.ledger) return 0;
  const l = readJson(run.ledger, { entries: [] });
  return (l.entries ?? []).filter((e) => e.what.startsWith(`${run.runId}:`)).reduce((a, e) => a + e.usd, 0);
}

function requestOf(run, b) {
  const r = structuredClone(b.request);
  r.model = run.models === 'opus-subset' ? OPUS_SUBSET.model : b.model;
  r.critique = { mode: 'loop', maxRevisions: run.maxRevisions, ...(b.critique ?? {}) };
  if (run.tier === 'sim') {
    r.notes = `${r.notes ?? ''} ${simScript(b)}`.trim();
    // the sim installs kit examples: room for them (the harness is what the sim tier tests)
    r.maxSize = { x: Math.max(r.maxSize.x, 24), y: Math.max(r.maxSize.y, 24), z: Math.max(r.maxSize.z, 24) };
    if (r.plot) r.plot = { ...r.plot, dx: r.maxSize.x, dz: r.maxSize.z };
  }
  return r;
}

async function estimate(client, run, unit) {
  if (unit[0].group) {
    const r = await client.call({ type: 'design.estimate', group: groupRequest(run, unit) });
    return { raw: r, total: (r.usdHigh ?? 0) + (r.critiqueUsdHigh ?? 0) + 2 * JUDGE_HIGH * unit.length };
  }
  const r = await client.call({ type: 'design.estimate', request: requestOf(run, unit[0]) });
  return { raw: r, total: (r.usdHigh ?? 0) + (r.critiqueUsdHigh ?? 0) + 2 * JUDGE_HIGH };
}

function groupRequest(run, unit) {
  const g = unit[0].group;
  return {
    name: g.name,
    bible: g.bible,
    owner: 'eval',
    concurrency: g.concurrency ?? 3,
    items: unit.map((b) => {
      const { group: _g, owner: _o, ...req } = requestOf(run, b);
      return { ...req, itemKey: b.group.itemKey, role: b.group.role, ...(b.group.anchor ? { anchor: true } : {}) };
    }),
  };
}

async function submit(client, run, unit, est, left) {
  const st = run.state;
  const now = Date.now();
  if (unit[0].group) {
    const g = groupRequest(run, unit);
    if (Number.isFinite(left)) g.budgetUsd = Math.max(0.5, r2(Math.min(1000, left)));
    const r = await client.call({ type: 'design.group', group: g });
    unit.forEach((b, i) => {
      st[b.id] = { submitted: true, submittedAt: now, designIds: [r.designIds[i]], groupId: r.groupId, high: est.total / unit.length, estimate: est.raw.items?.[i] ? { ...est.raw.items[i], groupBasis: est.raw.basis, groupMinutesLow: est.raw.minutesLow, groupMinutesHigh: est.raw.minutesHigh, groupCritiqueMinutesLow: est.raw.critiqueMinutesLow, groupCritiqueMinutesHigh: est.raw.critiqueMinutesHigh } : est.raw };
    });
    log(`group ${r.groupId}: ${unit.map((b) => b.id).join(', ')} submitted (high $${r2(est.total)})`);
    return;
  }
  const b = unit[0];
  const req = requestOf(run, b);
  if (Number.isFinite(left)) req.budgetUsd = Math.max(0.5, r2(Math.min(1000, left)));
  const r = await client.call({ type: 'design.request', request: req });
  st[b.id] = { submitted: true, submittedAt: now, designIds: [r.designId], high: est.total, estimate: est.raw };
  log(`brief ${b.n} ${b.id}: design ${r.designId} submitted (high $${r2(est.total)}, ${est.raw.basis ? est.raw.basis.slice(0, 120) : ''})`);
}

/** The PNGs of a round the judge sees: the critic's renders (1000 px), else the round's previews. */
function roundImages(scratch, bp, n) {
  const out = {};
  for (const v of JUDGE_VIEWS) {
    for (const f of [path.join(scratch, 'critique', String(n), `${bp}.preview-${v}.png`), path.join(scratch, 'rounds', String(n), 'previews', `${bp}.preview-${v}.png`)]) {
      if (fs.existsSync(f)) {
        out[v] = f;
        break;
      }
    }
  }
  return out;
}

/** The blind pairwise judge for one brief: round 0 vs the installed round, twice with the order swapped. */
async function judgeBrief(client, run, runDir, b, left, force = false) {
  const s = run.state[b.id];
  if (s.judge && !force) return;
  const d = client.designs.get(s.designIds[0]) ?? readJson(path.join(runDir, 'briefs', b.id, `design-${s.designIds[0]}.json`));
  const c = d?.critique;
  const revisions = c ? c.rounds.filter((r) => r.n > 0).length : 0;
  if (!d || d.status !== 'done' || !c || revisions === 0) {
    s.judge = { outcome: 'none', revisions, calls: [] };
    return;
  }
  if (!c.best) {
    s.judge = { outcome: 'identical', revisions, calls: [] };
    return;
  }
  if (left() < 2 * JUDGE_HIGH) {
    s.judge = { outcome: 'skipped_budget', revisions, calls: [] };
    log(`brief ${b.id}: judge skipped (budget)`);
    return;
  }
  const scratch = path.join(runDir, 'sidecar', 'data', 'designs', d.id);
  const bp = readJson(path.join(runDir, 'sidecar', 'data', 'state.json'))?.work?.[d.id]?.critique?.bp ?? d.blueprintId;
  const imgs = { round0: roundImages(scratch, bp, 0), final: roundImages(scratch, bp, c.best) };
  const views = JUDGE_VIEWS.filter((v) => imgs.round0[v] && imgs.final[v]);
  if (!views.length) {
    s.judge = { outcome: 'none', revisions, calls: [], error: 'no renders to judge' };
    return;
  }
  const rng = rngFrom(`${run.seed}:${b.id}:${force ? `re${Date.now()}` : ''}`);
  const j = await pairJudge(client, { b, request: requestOf(run, b), imgs: { final: imgs.final, round0: imgs.round0 }, views, firstXIsA: rng() < 0.5, x: 'final', y: 'round0', tag: `${run.runId} ${b.id}`, sim: run.tier === 'sim' });
  const outcome = j.outcome === 'final' ? 'win' : j.outcome === 'round0' ? 'loss' : 'tie';
  s.judge = { outcome, revisions, best: c.best, views, calls: j.calls };
  s.judgeUsd = r4((s.judgeUsd ?? 0) + j.usd);
}

/**
 * Two blind judge calls on the sets x and y (named A and B in a random order, then swapped). `outcome` is x or y when
 * both calls prefer it, else tie.
 */
async function pairJudge(client, o) {
  const blobs = { [o.x]: {}, [o.y]: {} };
  for (const k of [o.x, o.y]) for (const v of o.views) blobs[k][v] = await client.putPng(o.imgs[k][v]);
  const calls = [];
  let usd = 0;
  for (const xIsA of [o.firstXIsA, !o.firstXIsA]) {
    const order = xIsA ? { A: o.x, B: o.y } : { A: o.y, B: o.x };
    const images = [...o.views.map((v) => ({ blob: blobs[order.A][v], label: `A_${v}.png` })), ...o.views.map((v) => ({ blob: blobs[order.B][v], label: `B_${v}.png` }))];
    const spec = { kind: 'structured', prompt: judgePrompt({ request: o.request }), system: JUDGE_SYSTEM, model: JUDGE_MODEL, effort: JUDGE_EFFORT, schema: JUDGE_SCHEMA, maxTurns: 3, budgetUsd: 0.5, images, owner: 'eval:judge', tag: o.tag, ...(o.sim ? { ext: { 'architect:simAnswer': simJudge(o.b, order) } } : {}) };
    let job;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await client.call({ type: 'job.run', job: spec });
      for (;;) {
        const jj = client.jobs.get(r.jobId);
        if (jj && FINAL.has(jj.status)) {
          job = jj;
          break;
        }
        await sleep(500);
      }
      usd += job.cost?.usd ?? 0;
      if (job.status === 'done') break;
      log(`${o.tag}: judge call failed (${job.error ?? job.status})${attempt === 0 ? ', once more' : ''}`);
    }
    const a = job.status === 'done' ? job.result : null;
    calls.push({ order, ...(a ? { preferred: a.preferred, margin: a.margin, dimensions: a.dimensions, reasons: a.reasons, winner: a.preferred === 'tie' ? 'tie' : order[a.preferred] } : { error: job.error ?? job.status }), usd: r4(job.cost?.usd ?? 0) });
  }
  const w = calls.map((x) => x.winner);
  return { outcome: w.every((x) => x === o.x) ? o.x : w.every((x) => x === o.y) ? o.y : 'tie', calls, usd: r4(usd) };
}

// ---- summary (a pure function of the stored files) -------------------------------------------------------------

/** The kit's check of a stored round (warnings by rule, errors, metrics), deterministic. */
function kitCheck(nbt, json, type, restraint) {
  const args = [path.join(KIT, 'check.mjs'), nbt, json, '--json', ...(restraint && fs.existsSync(restraint) ? ['--restraint', restraint] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{'));
  const j = line ? JSON.parse(line) : { ok: false, errors: ['check produced no JSON'], warnings: [] };
  const byRule = {};
  for (const w of j.warnings ?? []) {
    const rule = /^([a-z_ ]+):/.exec(w)?.[1]?.trim().replace(/ /g, '_') ?? 'other';
    byRule[rule] = (byRule[rule] ?? 0) + 1;
  }
  const m = j.metrics ?? {};
  return { errors: (j.errors ?? []).length, warnings: (j.warnings ?? []).length, byRule, metrics: { accentShare: m.accentShare ?? null, detailNoise: m.detailNoise ?? null, windowsMin: m.windowsMin ?? null, paletteAdherence: m.paletteAdherence ?? null, parts: m.parts ?? null, cellsOutsideParts: m.cellsOutsideParts ?? null, blocks: m.blocks ?? null } };
}

export function summarize(runDir) {
  const run = readJson(path.join(runDir, 'run.json'));
  const state = readJson(path.join(runDir, 'sidecar', 'data', 'state.json'), {});
  const briefs = loadBriefs(run.briefs);
  const out = [];
  for (const b of briefs) {
    const s = run.state[b.id];
    if (!s?.done) {
      out.push({ id: b.id, n: b.n, status: s?.submitted ? 'unfinished' : 'not_run' });
      continue;
    }
    const d = readJson(path.join(runDir, 'briefs', b.id, `design-${s.designIds[0]}.json`));
    const c = d.critique;
    const scratch = path.join(runDir, 'sidecar', 'data', 'designs', d.id);
    const bp = state.work?.[d.id]?.critique?.bp;
    const restraint = fs.existsSync(path.join(scratch, 'bible', 'bible.json')) ? path.join(scratch, 'bible', 'bible.json') : undefined;
    const roundCheck = (n) => {
      const dir = path.join(scratch, 'rounds', String(n));
      return bp && fs.existsSync(path.join(dir, `${bp}.nbt`)) ? kitCheck(path.join(dir, `${bp}.nbt`), path.join(dir, `${bp}.blueprint.json`), b.request.type, restraint) : null;
    };
    const rounds = (c?.rounds ?? []).map((r) => ({
      n: r.n,
      kept: r.kept,
      overall: r.overall,
      scores: r.scores,
      ship: r.ship,
      modelVerdict: r.verdict,
      issues: { P0: r.issues.filter((i) => i.priority === 'P0').length, P1: r.issues.filter((i) => i.priority === 'P1').length, P2: r.issues.filter((i) => i.priority === 'P2').length },
      issueParts: r.issues.length,
      unknownParts: r.unknownParts ?? 0,
      cost: r.cost,
      ms: r.ms,
      ...(r.error ? { error: r.error.slice(0, 120) } : {}),
    }));
    const best = c?.best ?? 0;
    const critic = c?.cost?.critic?.usd ?? 0;
    const revise = c?.cost?.revise?.usd ?? 0;
    const total = d.cost?.usd ?? 0;
    const round0 = r4(total - critic - revise);
    const loopMs = (c?.rounds ?? []).reduce((a, r) => a + (r.ms ?? 0), 0);
    const e = s.estimate ?? {};
    const estMid = (((e.usdLow ?? 0) + (e.critiqueUsdLow ?? 0)) + ((e.usdHigh ?? 0) + (e.critiqueUsdHigh ?? 0))) / 2;
    const scored = rounds.filter((r) => r.overall !== null);
    const disagreements = scored.filter((r) => r.modelVerdict && (r.modelVerdict === 'ship') !== r.ship).length;
    const issues = scored.reduce((a, r) => a + r.issueParts, 0);
    const unknown = scored.reduce((a, r) => a + r.unknownParts, 0);
    out.push({
      id: b.id,
      n: b.n,
      title: b.title,
      type: b.request.type,
      model: d.request.model,
      status: d.status,
      ...(d.error ? { error: d.error.slice(0, 200) } : {}),
      end: c?.end ?? null,
      best,
      revisions: rounds.filter((r) => r.n > 0).length,
      rounds,
      round0: roundCheck(0),
      final: roundCheck(best),
      critic: { calls: scored.length, disagreements, issues, unknownParts: unknown, partGrounding: issues ? r3(1 - unknown / issues) : null },
      judge: s.judge ?? null,
      cost: { total: r4(total), round0, critic: r4(critic), revise: r4(revise), loop: r4(critic + revise), loopCap: c?.mode === 'loop' ? r4(d.request.critique?.budgetUsd ?? round0) : null, judge: r4(s.judgeUsd ?? 0), cacheReadTokens: d.cost?.cacheReadTokens ?? 0 },
      ms: { total: d.updatedAt - d.createdAt, loop: loopMs },
      estimate: { usdLow: e.usdLow ?? null, usdHigh: e.usdHigh ?? null, critiqueUsdLow: e.critiqueUsdLow ?? null, critiqueUsdHigh: e.critiqueUsdHigh ?? null, minutesLow: e.minutesLow ?? null, minutesHigh: e.minutesHigh ?? null, critiqueMinutesLow: e.critiqueMinutesLow ?? null, critiqueMinutesHigh: e.critiqueMinutesHigh ?? null, midUsd: r4(estMid), errorPct: estMid ? r2((100 * (total - estMid)) / estMid) : null },
    });
  }
  return { runId: run.runId, label: run.label, tier: run.tier, models: run.models, maxRevisions: run.maxRevisions, capUsd: run.capUsd, authVars: run.authVars, provenance: run.provenance, stopReason: run.stopReason ?? null, briefs: out, aggregates: aggregates(out) };
}

/** G1-G4 (docs/CONTRACT.md "Phase 5a gate" item 4) and the recorded numbers. */
export function aggregates(out) {
  const done = out.filter((x) => x.status === 'done');
  const revised = done.filter((x) => x.revisions > 0);
  const judged = revised.map((x) => x.judge?.outcome);
  const wins = judged.filter((o) => o === 'win').length;
  const losses = judged.filter((o) => o === 'loss').length;
  const ties = revised.length - wins - losses;
  const p = signTestP(wins, wins + losses);
  const r0 = done.filter((x) => x.rounds[0]?.overall != null);
  const meanR0 = mean(r0.map((x) => x.rounds[0].overall));
  const meanBest = mean(r0.map((x) => x.rounds.find((r) => r.n === x.best)?.overall ?? x.rounds[0].overall));
  const p0Zero = done.filter((x) => (x.rounds.find((r) => r.n === x.best)?.issues.P0 ?? 0) === 0).length;
  const withChecks = done.filter((x) => x.round0 && x.final);
  const errorsFinal = withChecks.reduce((a, x) => a + x.final.errors, 0);
  const warnOk = withChecks.filter((x) => x.final.warnings <= x.round0.warnings).length;
  const warnTotal0 = withChecks.reduce((a, x) => a + x.round0.warnings, 0);
  const warnTotalF = withChecks.reduce((a, x) => a + x.final.warnings, 0);
  const pa0 = mean(withChecks.map((x) => x.round0.metrics.paletteAdherence).filter((v) => v !== null));
  const paF = mean(withChecks.map((x) => x.final.metrics.paletteAdherence).filter((v) => v !== null));
  const partsOk = withChecks.filter((x) => (x.final.metrics.parts ?? 0) >= 2).length;
  const inCap = done.filter((x) => x.cost.loopCap === null || x.cost.loop <= x.cost.loopCap + 1e-6).length;
  const meanLoop = mean(done.map((x) => x.cost.loop));
  const meanR0Cost = mean(done.map((x) => x.cost.round0));
  const meanAddedMin = mean(done.map((x) => x.ms.loop / MIN));
  const estOk = done.filter((x) => x.estimate.errorPct !== null && Math.abs(x.estimate.errorPct) <= 50).length;
  const estTotalMid = done.reduce((a, x) => a + x.estimate.midUsd, 0);
  const measuredTotal = done.reduce((a, x) => a + x.cost.total, 0);
  const estTotalPct = estTotalMid ? r2((100 * (measuredTotal - estTotalMid)) / estTotalMid) : null;
  const metricMean = (k, which) => {
    const v = withChecks.map((x) => x[which].metrics[k]).filter((y) => y !== null);
    return v.length ? r3(mean(v)) : null;
  };
  // round 2 vs round 1 (recorded: does the second revision add value, by the critic)
  const r2s = done.filter((x) => x.rounds.some((r) => r.n === 2 && r.overall != null) && x.rounds.some((r) => r.n === 1 && r.overall != null));
  const totals = { usd: r4(done.reduce((a, x) => a + x.cost.total + x.cost.judge, 0)), judge: r4(done.reduce((a, x) => a + x.cost.judge, 0)) };
  const n = done.length;
  const thresholds = { 18: 13, 16: 12, 14: 11, 12: 10 };
  return {
    briefs: out.length,
    done: n,
    failed: out.filter((x) => x.status === 'failed').length,
    ends: Object.fromEntries([...new Set(done.map((x) => x.end))].map((e) => [e, done.filter((x) => x.end === e).length])),
    G1: { withRevision: revised.length, wins, losses, ties, p: r4(p), significant: p < 0.05, pass: revised.length >= 12 && p < 0.05 && losses <= 3, note: `n=18 -> 13 wins needed; thresholds ${JSON.stringify(thresholds)}` },
    G2: { meanOverallRound0: meanR0 === null ? null : r2(meanR0), meanOverallInstalled: meanBest === null ? null : r2(meanBest), rise: meanR0 === null ? null : r2(meanBest - meanR0), p0ZeroAtInstall: p0Zero, pass: meanR0 !== null && meanBest - meanR0 >= 1.0 && p0Zero >= Math.min(16, n) },
    G3: { checkerErrorsInFinals: errorsFinal, warningsNotWorse: warnOk, warningsTotal: { round0: warnTotal0, final: warnTotalF }, paletteAdherence: { round0: pa0 === null ? null : r3(pa0), final: paF === null ? null : r3(paF), dropPoints: pa0 === null ? null : r2(100 * (pa0 - paF)) }, finalsWith2Parts: partsOk, pass: errorsFinal === 0 && warnOk >= Math.min(16, withChecks.length) && warnTotalF <= warnTotal0 && (pa0 === null || 100 * (pa0 - paF) <= 2) && partsOk === withChecks.length },
    G4: { loopWithinCap: inCap, of: n, meanLoopUsd: meanLoop === null ? null : r4(meanLoop), meanRound0Usd: meanR0Cost === null ? null : r4(meanR0Cost), loopShare: meanR0Cost ? r3(meanLoop / meanR0Cost) : null, meanAddedMinutes: meanAddedMin === null ? null : r2(meanAddedMin), estimateWithin50: estOk, estimateTotalErrorPct: estTotalPct, pass: inCap === n && meanR0Cost !== null && meanLoop <= 0.6 * meanR0Cost && meanAddedMin <= 8 && estOk >= Math.min(15, n) && estTotalPct !== null && Math.abs(estTotalPct) <= 50 },
    metrics: { round0: { accentShare: metricMean('accentShare', 'round0'), detailNoise: metricMean('detailNoise', 'round0'), windowsMin: metricMean('windowsMin', 'round0'), paletteAdherence: metricMean('paletteAdherence', 'round0') }, final: { accentShare: metricMean('accentShare', 'final'), detailNoise: metricMean('detailNoise', 'final'), windowsMin: metricMean('windowsMin', 'final'), paletteAdherence: metricMean('paletteAdherence', 'final') } },
    critic: { calls: done.reduce((a, x) => a + x.critic.calls, 0), disagreements: done.reduce((a, x) => a + x.critic.disagreements, 0), partGrounding: (() => { const i = done.reduce((a, x) => a + x.critic.issues, 0); const u = done.reduce((a, x) => a + x.critic.unknownParts, 0); return i ? r3(1 - u / i) : null; })() },
    round2: { briefs: r2s.length, better: r2s.filter((x) => x.rounds.find((r) => r.n === 2).overall > x.rounds.find((r) => r.n === 1).overall).length, worse: r2s.filter((x) => x.rounds.find((r) => r.n === 2).overall < x.rounds.find((r) => r.n === 1).overall).length },
    cost: totals,
  };
}

function printAggregates(s) {
  const a = s.aggregates;
  console.log(JSON.stringify({ done: a.done, ends: a.ends, G1: a.G1, G2: a.G2, G3: { pass: a.G3.pass, errors: a.G3.checkerErrorsInFinals, warningsNotWorse: a.G3.warningsNotWorse }, G4: a.G4, cost: a.cost }, null, 2));
}

// ---- rescore, rejudge, compare ------------------------------------------------------------------------------

function runDirOf(o, runId) {
  const d = path.join(path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval')), runId);
  if (!fs.existsSync(path.join(d, 'run.json'))) throw new Error(`no run ${runId} in ${path.dirname(d)}`);
  return d;
}

function cmdRescore(o) {
  const dir = runDirOf(o, o._[1]);
  const s = summarize(dir);
  const text = `${JSON.stringify(s, null, 2)}\n`;
  const prev = fs.existsSync(path.join(dir, 'summary.json')) ? fs.readFileSync(path.join(dir, 'summary.json'), 'utf8') : null;
  fs.writeFileSync(path.join(dir, 'summary.rescored.json'), text);
  const same = prev === text;
  log(`rescore ${o._[1]}: ${same ? 'byte-identical to the stored summary' : 'DIFFERS from the stored summary'} (summary.rescored.json)`);
  return { same };
}

async function cmdRejudge(o) {
  const dir = runDirOf(o, o._[1]);
  const run = readJson(path.join(dir, 'run.json'));
  authGuard(run.tier);
  const ids = o.briefs ? loadBriefs(o.briefs).map((b) => b.n) : run.briefs;
  const port = await freePort(o.port);
  const sc = await startSidecar(dir, run.tier, port);
  const client = new Client(port, sc.token);
  const results = {};
  try {
    await client.connect();
    for (const b of loadBriefs(ids)) {
      const s = run.state[b.id];
      if (!s?.done) continue;
      const before = s.judge;
      const copy = { ...run, state: { [b.id]: { ...s, judge: undefined, judgeUsd: 0 } } };
      await judgeBrief(client, copy, dir, b, () => Infinity, true);
      const again = copy.state[b.id];
      results[b.id] = { first: before?.outcome ?? null, again: again.judge.outcome, agree: before?.outcome === again.judge.outcome, calls: again.judge.calls, usd: again.judgeUsd };
      if (run.ledger) ledgerPut(run.ledger, `${run.runId}:rejudge:${b.id}`, again.judgeUsd ?? 0);
      log(`rejudge ${b.id}: first ${before?.outcome}, again ${again.judge.outcome}`);
    }
  } finally {
    client.close();
    sc.child.kill('SIGTERM');
  }
  const agree = Object.values(results).filter((r) => r.agree).length;
  const out = { runId: run.runId, briefs: Object.keys(results).length, agree, results };
  writeJson(path.join(dir, 'rejudge.json'), out);
  log(`rejudge: ${agree} of ${out.briefs} agree with the first judging`);
  return out;
}

/** compare <A> <B>: A is before, B after. Regressed: A's finals beat B's (cross-run judge, sign test), or a hard metric got worse. */
async function cmdCompare(o) {
  const [a, b] = [o._[1], o._[2]].map((id) => readJson(path.join(runDirOf(o, id), 'summary.json')));
  const byId = (s) => new Map(s.briefs.filter((x) => x.status === 'done').map((x) => [x.id, x]));
  const A = byId(a);
  const B = byId(b);
  const ids = [...A.keys()].filter((k) => B.has(k)).sort();
  const per = ids.map((k) => {
    const x = A.get(k);
    const y = B.get(k);
    return { id: k, overall: [x.rounds.find((r) => r.n === x.best)?.overall ?? null, y.rounds.find((r) => r.n === y.best)?.overall ?? null], warnings: [x.final?.warnings ?? null, y.final?.warnings ?? null], errors: [x.final?.errors ?? 0, y.final?.errors ?? 0], cost: [x.cost.total, y.cost.total], minutes: [r2(x.ms.total / MIN), r2(y.ms.total / MIN)], paletteAdherence: [x.final?.metrics.paletteAdherence ?? null, y.final?.metrics.paletteAdherence ?? null] };
  });
  const m = (f, i) => mean(per.map((p) => p[f][i]).filter((v) => v !== null)) ?? 0;
  const hard = [];
  if (per.some((p) => p.errors[1] > 0)) hard.push('a checker error in a final');
  if (m('warnings', 1) > 1.25 * m('warnings', 0) + 1e-9) hard.push(`mean warnings +${r2(100 * (m('warnings', 1) / (m('warnings', 0) || 1) - 1))}%`);
  if (m('cost', 1) > 1.3 * m('cost', 0)) hard.push(`mean cost +${r2(100 * (m('cost', 1) / m('cost', 0) - 1))}%`);
  if (m('minutes', 1) > 1.3 * m('minutes', 0)) hard.push(`mean time +${r2(100 * (m('minutes', 1) / m('minutes', 0) - 1))}%`);
  if (100 * (m('paletteAdherence', 0) - m('paletteAdherence', 1)) > 5) hard.push('mean paletteAdherence -5 points');
  let judge = null;
  if (o.judge) judge = await crossJudge(o, a, b, ids);
  if (judge?.regressed) hard.push(`A's finals beat B's in the blind judge (${judge.before} to ${judge.after}, p ${judge.p})`);
  const out = { a: a.runId, b: b.runId, briefs: ids.length, per, means: { overall: [r2(m('overall', 0)), r2(m('overall', 1))], warnings: [r2(m('warnings', 0)), r2(m('warnings', 1))], cost: [r4(m('cost', 0)), r4(m('cost', 1))], minutes: [r2(m('minutes', 0)), r2(m('minutes', 1))], paletteAdherence: [r3(m('paletteAdherence', 0)), r3(m('paletteAdherence', 1))] }, hardRegressions: hard, judge, verdict: hard.length ? 'regressed' : 'no regression' };
  const dir = path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval'));
  writeJson(path.join(dir, `compare-${a.runId}-vs-${b.runId}.json`), out);
  log(`compare ${a.runId} -> ${b.runId}: ${out.verdict}${hard.length ? ` (${hard.join('; ')})` : ''}`);
  return out;
}

/** compare --judge: a blind pairwise judge of the two runs' finals (judge cost only), on a sidecar of its own. */
async function crossJudge(o, a, b, ids) {
  const out = path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval'));
  const dir = path.join(out, `cmp-${a.runId}-vs-${b.runId}`);
  fs.mkdirSync(dir, { recursive: true });
  const tier = a.tier === 'sim' && b.tier === 'sim' ? 'sim' : 'smoke';
  authGuard(tier);
  if (!fs.existsSync(path.join(dir, 'run.json'))) writeJson(path.join(dir, 'run.json'), { runId: path.basename(dir), tier, briefs: [], state: {} });
  const port = await freePort(o.port);
  const sc = await startSidecar(dir, tier, port);
  const client = new Client(port, sc.token);
  const finalImgs = (runId, x) => {
    const rd = path.join(out, runId);
    const st = readJson(path.join(rd, 'sidecar', 'data', 'state.json'), {});
    const did = readJson(path.join(rd, 'run.json')).state[x.id].designIds[0];
    return roundImages(path.join(rd, 'sidecar', 'data', 'designs', did), st.work?.[did]?.critique?.bp, x.best);
  };
  const results = {};
  let usd = 0;
  try {
    await client.connect();
    for (const id of ids) {
      const x = a.briefs.find((q) => q.id === id);
      const y = b.briefs.find((q) => q.id === id);
      const brief = loadBriefs().find((q) => q.id === id);
      const imgs = { before: finalImgs(a.runId, x), after: finalImgs(b.runId, y) };
      const views = JUDGE_VIEWS.filter((v) => imgs.before[v] && imgs.after[v]);
      if (!views.length) continue;
      const j = await pairJudge(client, { b: brief, request: brief.request, imgs, views, firstXIsA: rngFrom(`${a.runId}:${b.runId}:${id}`)() < 0.5, x: 'after', y: 'before', tag: `compare ${id}`, sim: tier === 'sim' });
      results[id] = j;
      usd += j.usd;
    }
  } finally {
    client.close();
    sc.child.kill('SIGTERM');
  }
  const after = Object.values(results).filter((r) => r.outcome === 'after').length;
  const before = Object.values(results).filter((r) => r.outcome === 'before').length;
  const p = signTestP(before, before + after);
  return { pairs: Object.keys(results).length, before, after, ties: Object.keys(results).length - before - after, p: r4(p), regressed: p < 0.05, usd: r4(usd), results };
}

/**
 * clutter <runId> --against <dir> --map item=entry,...: the blind pairwise judge of a run's group items (their finals) against
 * stored renders of an older set (<dir>/<entry>.preview-<view>.png), e.g. the 4b Mosswater set rebuilt from its sources.
 * Judge cost only. A new item wins on a dimension when both calls prefer it there.
 */
async function cmdClutter(o) {
  const out = path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval'));
  const runDir = path.join(out, o._[1]);
  const run = readJson(path.join(runDir, 'run.json'));
  const map = Object.fromEntries((o.map ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  const tier = run.tier === 'sim' ? 'sim' : 'smoke';
  authGuard(tier);
  const port = await freePort(o.port);
  const dir = path.join(out, `clutter-${run.runId}`);
  writeJson(path.join(dir, 'run.json'), { runId: path.basename(dir), tier, briefs: [], state: {} });
  const sc = await startSidecar(dir, tier, port);
  const client = new Client(port, sc.token);
  const st = readJson(path.join(runDir, 'sidecar', 'data', 'state.json'), {});
  const results = {};
  let usd = 0;
  try {
    await client.connect();
    for (const b of loadBriefs(run.briefs).filter((x) => x.group && map[x.group.itemKey])) {
      const s = run.state[b.id];
      const d = readJson(path.join(runDir, 'briefs', b.id, `design-${s.designIds[0]}.json`));
      const finalImgs = roundImages(path.join(runDir, 'sidecar', 'data', 'designs', d.id), st.work?.[d.id]?.critique?.bp, d.critique?.best ?? 0);
      const entry = map[b.group.itemKey];
      const old = Object.fromEntries(JUDGE_VIEWS.map((v) => [v, path.join(path.resolve(o.against), `${entry}.preview-${v}.png`)]).filter(([, f]) => fs.existsSync(f)));
      const views = JUDGE_VIEWS.filter((v) => finalImgs[v] && old[v]);
      const j = await pairJudge(client, { b, request: b.request, imgs: { new: finalImgs, old }, views, firstXIsA: rngFrom(`clutter:${run.runId}:${b.id}`)() < 0.5, x: 'new', y: 'old', tag: `clutter ${b.id}`, sim: tier === 'sim' });
      const dims = {};
      for (const dim of ['silhouette', 'legibility', 'craft', 'materials', 'brief']) {
        const w = j.calls.map((c) => (c.dimensions ? (c.dimensions[dim] === 'tie' ? 'tie' : c.order[c.dimensions[dim]]) : 'error'));
        dims[dim] = w.every((x) => x === 'new') ? 'new' : w.every((x) => x === 'old') ? 'old' : 'tie';
      }
      results[b.id] = { against: entry, outcome: j.outcome, dims, calls: j.calls, usd: j.usd };
      usd += j.usd;
      log(`clutter ${b.id} vs ${entry}: ${j.outcome}; legibility ${dims.legibility}`);
    }
  } finally {
    client.close();
    sc.child.kill('SIGTERM');
  }
  if (o.ledger) ledgerPut(o.ledger, `${run.runId}:clutter-judge`, usd);
  const legWins = Object.values(results).filter((r) => r.dims.legibility === 'new').length;
  const res = { runId: run.runId, against: o.against, items: Object.keys(results).length, legibilityWins: legWins, pass: legWins >= 2, usd: r4(usd), results };
  writeJson(path.join(runDir, 'clutter.json'), res);
  log(`clutter: the new items win on legibility ${legWins} of ${res.items}`);
  return res;
}

/**
 * revise-bible <id> --notes "...": a real bible.revise (with the sheet critique) of a fixture bible, on a sidecar of its own;
 * the new version is copied into eval/fixtures/bibles/<id>/versions/<v>/ (the 5a gate's format-2 Mosswater).
 */
async function cmdReviseBible(o) {
  const id = o._[1];
  if (!id || !o.notes) throw new Error('revise-bible <id> --notes "..."');
  authGuard(o.tier ?? 'smoke');
  const out = path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval'));
  const dir = path.join(out, `bible-${id}-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`);
  const tier = o.tier === 'sim' ? 'sim' : 'smoke';
  writeJson(path.join(dir, 'run.json'), { runId: path.basename(dir), tier, briefs: [], state: {} });
  const port = await freePort(o.port);
  const sc = await startSidecar(dir, tier, port);
  const client = new Client(port, sc.token);
  let usd = 0;
  try {
    await client.connect();
    installFixtureBible(sc.dirs.bibles, id);
    const jobs = new Map();
    client.onMessage = ((orig) => (m) => {
      if (m.type === 'bible.upsert') jobs.set(m.bible.id, m.bible);
      orig.call(client, m);
    })(client.onMessage);
    const r = await client.call({ type: 'bible.revise', id, notes: o.notes, critique: { mode: 'report' }, ...(o.maxUsd ? { budgetUsd: o.maxUsd } : {}) });
    log(`bible job ${r.jobId}: ${id} -> v${r.version}`);
    let j;
    for (;;) {
      j = jobs.get(r.jobId);
      if (j && FINAL.has(j.status)) break;
      await sleep(2000);
    }
    usd = j.cost?.usd ?? 0;
    log(`bible job ${r.jobId}: ${j.status} ${j.step} ($${r4(usd)})`);
    if (o.ledger) ledgerPut(o.ledger, `${path.basename(dir)}:bible.revise`, usd);
    if (j.status !== 'done') throw new Error(`the revision ${j.status}: ${j.error ?? ''}`);
    const vdir = path.join(sc.dirs.bibles, id, 'versions', String(r.version));
    const dst = path.join(FIXTURE_BIBLES, id, 'versions', String(r.version));
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(vdir)) fs.copyFileSync(path.join(vdir, f), path.join(dst, f));
    writeJson(path.join(dir, 'bible-job.json'), j);
    log(`installed into ${path.relative(REPO, dst)}`);
  } finally {
    client.close();
    sc.child.kill('SIGTERM');
  }
}

// ---- CLI ------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--tier') o.tier = val();
    else if (a === '--label') o.label = val();
    else if (a === '--briefs') o.briefs = val().split(',').map(Number);
    else if (a === '--max-usd') o.maxUsd = Number(val());
    else if (a === '--models') o.models = val();
    else if (a === '--resume') o.resume = val();
    else if (a === '--out') o.out = val();
    else if (a === '--ledger') o.ledger = path.resolve(val());
    else if (a === '--total-cap') o.totalCap = Number(val());
    else if (a === '--reserve') o.reserve = Number(val());
    else if (a === '--port') o.port = Number(val());
    else if (a === '--max-revisions') o.maxRevisions = Number(val());
    else if (a === '--no-results') o.noResults = true;
    else if (a === '--judge') o.judge = true;
    else if (a === '--notes') o.notes = val();
    else if (a === '--against') o.against = val();
    else if (a === '--map') o.map = val();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'run') {
    if (!o.tier && !o.resume) throw new Error('run needs --tier or --resume');
    if (o.resume && !o.tier) o.tier = readJson(path.join(path.resolve(o.out ?? path.join(REPO, 'artifacts', 'eval')), o.resume, 'run.json'))?.tier;
    await cmdRun(o);
  } else if (cmd === 'rescore') cmdRescore(o);
  else if (cmd === 'rejudge') await cmdRejudge(o);
  else if (cmd === 'compare') await cmdCompare(o);
  else if (cmd === 'revise-bible') await cmdReviseBible(o);
  else if (cmd === 'clutter') await cmdClutter(o);
  else {
    console.log('usage: node tools/eval.mjs run --tier sim|smoke|full [...] | rescore <runId> | rejudge <runId> | compare <runA> <runB>');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.error(`eval: ${e.message}`);
      process.exit(1);
    },
  );
}
