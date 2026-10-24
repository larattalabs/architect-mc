#!/usr/bin/env node
// Style unification U4: the materials-only vs bible set-mode A/B (PAID, Noah's claude login only, hard cap $20; approved
// 2026-10-24). docs/STYLE-UNIFY.md question 1: should built-in and hand-made Styles reach the designer materials-only
// (A: `DesignRequest.palette = {bible: {id, version, roles}}`) or as a full bible (B: `bible: <id>`, set mode: the shared
// components, "follow it over your own taste", --restraint)?
//
//   node tools/u4ab.mjs plan                      the runs, the per-run cap, the spend so far; runs nothing
//   node tools/u4ab.mjs run [--backend sim] [--port 8899] [--only R1A,R1B]
//   node tools/u4ab.mjs metrics                   objective numbers per run (component calls, block histograms, similarity)
//   node tools/u4ab.mjs blind [--seed N]          shuffled, relabelled renders for the judge (no arm, no design files)
//
// Runs one design at a time, in pairs (R1A R1B R2A R2B ...), wall-defined Styles first, so a stop at the cap leaves whole
// pairs. Every run is the SMALL pass (effort small: Opus at medium effort, 40 turns, 2 rounds, $1.50), identical in both arms;
// 12 standard passes ($2.2-3.6 each in the 0b bench) do not fit the cap.
//
// Safety (as tools/bench6c0b.mjs): refuses to start with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN /
// AWS_BEARER_TOKEN_BEDROCK set, scrubs ANTHROPIC_* and CLAUDE* from the sidecar's env, and before each paid run checks that the
// helper is on the claude login and that spent (actual, spend.json) + the run's cap + a margin stays <= $20. A failed run is
// retried at most once. A usage-limit hold over 30 minutes stops the run (exit 4).
//
// Evidence: <out>/spend.json, <out>/runs/<key>/ (the entry's .mjs, blueprint, nbt, previews, the design record, BRIEF.md),
// <out>/u4ab.log; metrics.json; blind/ (the judge's tree) and blind-key.json (outside it). <out> is
// ../architect-mc/artifacts/gate-runs-U4 (U4_OUT overrides; the sim backend writes to <out>/sim).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseNbt, plain } from '../kit/lib/nbt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BACKEND = opt('backend', 'claude');
const BASE = process.env.U4_OUT ? path.resolve(process.env.U4_OUT) : path.join(MAIN, 'artifacts', 'gate-runs-U4');
const OUT = BACKEND === 'sim' ? path.join(BASE, 'sim') : BASE;
const WORK = path.join(OUT, 'helper');
const PORT = Number(opt('port', 8899));
const CAP = 20;
const RUN_CAP = 1.5; // the SMALL pass's own cap; budgetUsd is set to it too
const MARGIN = 0.1;
const HOLD_MAX_MS = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'u4ab.log'), `${line}\n`);
};

// ---- the six requests ------------------------------------------------------------------------------

/** Wall-defined Styles (medieval, japanese, modern) first. Same type, size, features and notes in both arms. */
export const REQUESTS = [
  { key: 'R1', style: 'medieval', type: 'house', name: 'Merchant house', maxSize: { x: 15, y: 16, z: 13 }, features: ['chimney'], notes: 'A two-storey townhouse for a merchant family: a workroom on the ground floor, bedrooms above.' },
  { key: 'R2', style: 'japanese', type: 'chapel', name: 'Hillside shrine', maxSize: { x: 13, y: 15, z: 17 }, features: [], notes: 'A small shrine-like chapel for quiet prayer: a covered entrance and a single hall.' },
  { key: 'R3', style: 'modern', type: 'shop', name: 'Workshop', maxSize: { x: 17, y: 12, z: 13 }, features: ['big_windows'], notes: "A craftsman's workshop: a large open work floor, a wide street-facing opening and a small office." },
  { key: 'R4', style: 'nordic', type: 'tavern', name: 'Mead hall tavern', maxSize: { x: 17, y: 16, z: 15 }, features: ['chimney'], notes: 'A tavern for travellers: a long common room with a hearth, rooms to rent upstairs.' },
  { key: 'R5', style: 'fantasy', type: 'tower', name: "Wizard's tower", maxSize: { x: 11, y: 26, z: 11 }, features: ['balcony'], notes: "A wizard's tower: a study at the top with a lookout, a stair winding up through the floors." },
  { key: 'R6', style: 'fortress', type: 'gatehouse', name: 'Town gatehouse', maxSize: { x: 17, y: 18, z: 11 }, features: [], notes: 'The gatehouse of a walled town: a passage through for carts, a guard room above it, a walk on top.' },
];
export const RUNS = REQUESTS.flatMap((r) => [
  { ...r, run: `${r.key}A`, arm: 'A' },
  { ...r, run: `${r.key}B`, arm: 'B' },
]);

function builtins() {
  const r = spawnSync(process.execPath, [path.join(root, 'kit', 'tools', 'bible.mjs'), 'builtin'], { cwd: path.join(root, 'kit'), encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').pop()).bibles;
}

/** The design.request of one run. A: the Style's roles inline, materials only. B: the built-in bible, set mode. */
export function requestOf(run, bibles) {
  const b = bibles.find((x) => x.id === run.style);
  if (!b) throw new Error(`no built-in Style ${run.style}`);
  const base = {
    type: run.type,
    style: run.style,
    name: `${run.name} ${run.run}`,
    features: run.features,
    maxSize: run.maxSize,
    notes: run.notes,
    owner: 'bench:u4ab',
    effort: 'small',
    budgetUsd: RUN_CAP,
  };
  return run.arm === 'A' ? { ...base, palette: { bible: { id: b.id, version: b.version ?? 1, roles: b.roles } } } : { ...base, bible: b.id, bibleVersion: b.version ?? 1 };
}

// ---- spend.json --------------------------------------------------------------------------------------

const SPEND = path.join(OUT, 'spend.json');
const spend = () => (fs.existsSync(SPEND) ? JSON.parse(fs.readFileSync(SPEND, 'utf8')) : { capUsd: CAP, totalUsd: 0, runs: [] });
const saveSpend = (s) => {
  s.totalUsd = r6(s.runs.reduce((a, x) => a + (x.usd ?? 0), 0));
  s.capUsd = CAP;
  s.backend = BACKEND;
  fs.writeFileSync(SPEND, `${JSON.stringify(s, null, 2)}\n`);
};
function beforePaid(name, estimate, auth) {
  const s = spend();
  const spent = s.runs.reduce((a, x) => a + (x.usd ?? 0), 0);
  log(`run ${name}: cap $${RUN_CAP}, estimate ${estimate ? `$${estimate.usdLow}-${estimate.usdHigh}` : '-'}, spent $${spent.toFixed(4)}, auth ${JSON.stringify(auth)}`);
  if (BACKEND !== 'sim' && (!/claude login/i.test(auth?.authSource ?? '') || /api key|bedrock|vertex/i.test(auth?.authSource ?? '') || auth?.auth !== 'ok')) throw new Error(`refusing ${name}: the helper is not on the claude login (${JSON.stringify(auth)})`);
  if (spent + RUN_CAP + MARGIN > CAP + 1e-9) throw Object.assign(new Error(`stopping before ${name}: spent $${spent.toFixed(2)} + its cap $${RUN_CAP} + $${MARGIN} would pass the $${CAP} cap`), { cap: true });
  s.runs.push({ name, capUsd: RUN_CAP, estimate: estimate ?? null, startedAt: new Date().toISOString(), usd: 0, auth: auth?.authSource ?? BACKEND });
  saveSpend(s);
}
function recordPaid(name, usd, extra = {}) {
  const s = spend();
  const st = [...s.runs].reverse().find((x) => x.name === name);
  st.usd = r6(usd);
  Object.assign(st, extra);
  saveSpend(s);
}

// ---- the sidecar (as tools/bench6c0b.mjs) ------------------------------------------------------------

let proc;
async function startSidecar() {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) if (process.env[k]) throw new Error(`refusing: ${k} is set (U4 runs on the claude login only)`);
  const data = path.join(WORK, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.rmSync(path.join(data, 'client.token'), { force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE)/.test(k)));
  const out = fs.openSync(path.join(WORK, 'sidecar.log'), 'a');
  const a = ['--import', 'tsx', 'src/main.ts', '--port', String(PORT), '--data', data, '--library', path.join(WORK, 'library'), '--kit', path.join(root, 'kit'), '--bibles', path.join(WORK, 'bibles'), '--massings', path.join(WORK, 'massings')];
  if (BACKEND === 'sim') a.push('--backend', 'sim');
  else a.push('--use-claude-login');
  proc = spawn(process.execPath, a, { cwd: path.join(root, 'sidecar'), env, stdio: ['ignore', out, out] });
  log(`sidecar pid ${proc.pid} on ${PORT} (${BACKEND})`);
  fs.writeFileSync(path.join(WORK, 'sidecar.pid'), String(proc.pid));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'client.token')); i++) await sleep(200);
  return data;
}
async function stopSidecar() {
  if (!proc || proc.exitCode !== null) return;
  const done = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM'); // our own child, by its handle
  await Promise.race([done, sleep(20_000)]);
}

class Conn {
  static async open(port, dataDir) {
    const token = fs.readFileSync(path.join(dataDir, 'client.token'), 'utf8').trim();
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.msgs = [];
    c.n = 0;
    c.designs = new Map();
    c.status = null;
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'design.upsert') c.designs.set(m.design.id, m.design);
      else if (m.type === 'status') c.status = m.status;
      else if (m.type === 'snapshot') {
        c.status = m.status ?? c.status;
        for (const d of m.designs ?? []) c.designs.set(d.id, d);
      } else c.msgs.push(m);
    };
    await new Promise((res, rej) => ((c.ws.onopen = res), (c.ws.onerror = rej)));
    c.ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'u4ab', token, protocols: [2] }));
    for (let i = 0; i < 100 && !c.status; i++) await sleep(100);
    return c;
  }
  async send(o) {
    const id = `u${++this.n}`;
    this.ws.send(JSON.stringify({ v: 1, id, ...o }));
    for (let i = 0; i < 600; i++) {
      const a = this.msgs.find((m) => m.type === 'ack' && m.re === id);
      if (a) {
        if (!a.ok) throw new Error(`${o.type}: ${a.error}`);
        return a.result ?? {};
      }
      await sleep(100);
    }
    throw new Error(`no ack for ${o.type}`);
  }
  auth() {
    return { auth: this.status?.auth, authSource: this.status?.authSource };
  }
}

// ---- one run -----------------------------------------------------------------------------------------

function findBrief(data, designId) {
  // the design's scratch work dir keeps BRIEF.md; look for it by the design id
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'BRIEF.md' && p.includes(designId)) hits.push(p);
    }
  };
  walk(data, 0);
  return hits[0];
}

async function runOne(c, data, run, bibles, attempt) {
  const name = attempt > 1 ? `${run.run}#${attempt}` : run.run;
  const req = requestOf(run, bibles);
  const est = await c.send({ type: 'design.estimate', request: req }).catch((e) => ({ error: e.message }));
  beforePaid(name, est, c.auth());
  const t0 = Date.now();
  const r = await c.send({ type: 'design.request', request: req });
  log(`${name}: design ${r.designId} (${run.arm}, ${run.style} ${run.type})`);
  let d;
  let heldSince;
  for (;;) {
    d = c.designs.get(r.designId);
    if (d && ['done', 'failed', 'cancelled'].includes(d.status)) break;
    if (c.status?.limitUntil && c.status.limitUntil > Date.now()) {
      heldSince ??= Date.now();
      if (Date.now() - heldSince > HOLD_MAX_MS) {
        recordPaid(name, d?.cost?.usd ?? 0, { status: 'held' });
        throw Object.assign(new Error(`${name}: usage-limit hold over 30 min`), { held: true });
      }
    } else heldSince = undefined;
    recordPaid(name, d?.cost?.usd ?? 0);
    await sleep(5000);
  }
  const ms = Date.now() - t0;
  recordPaid(name, d.cost?.usd ?? 0, { status: d.status, endedAt: new Date().toISOString(), ms, designId: d.id, entryId: d.blueprintId ?? null, error: d.error ?? null });
  const dir = path.join(OUT, 'runs', run.run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `design${attempt > 1 ? `-${attempt}` : ''}.json`), `${JSON.stringify(d, null, 2)}\n`);
  const brief = findBrief(data, d.id);
  if (brief) fs.copyFileSync(brief, path.join(dir, 'BRIEF.md'));
  if (d.status === 'done' && d.blueprintId) {
    const src = path.join(WORK, 'library', d.blueprintId);
    for (const f of fs.readdirSync(src)) if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'entry.txt'), `${d.blueprintId}\n`);
  }
  log(`${name}: ${d.status} $${(d.cost?.usd ?? 0).toFixed(4)} in ${(ms / 60000).toFixed(1)} min${d.error ? ` (${d.error})` : ''}`);
  return d;
}

async function run() {
  const only = opt('only', null)?.split(',');
  const bibles = builtins();
  const data = await startSidecar();
  try {
    const c = await Conn.open(PORT, data);
    for (let i = 0; i < 120 && c.status?.auth === 'checking'; i++) await sleep(1000);
    log(`auth: ${JSON.stringify(c.auth())}`);
    for (const r of RUNS) {
      if (only && !only.includes(r.run)) continue;
      if (fs.existsSync(path.join(OUT, 'runs', r.run, 'entry.txt'))) {
        log(`${r.run}: already done, skipped`);
        continue;
      }
      let d = await runOne(c, data, r, bibles, 1);
      if (d.status !== 'done') {
        log(`${r.run}: ${d.status}, one retry`);
        d = await runOne(c, data, r, bibles, 2);
      }
    }
    log(`done: spent $${spend().totalUsd}`);
  } catch (e) {
    log(`stopped: ${e.message}`);
    process.exitCode = e.held ? 4 : e.cap ? 3 : 1;
  } finally {
    await stopSidecar();
  }
}

// ---- objective metrics ------------------------------------------------------------------------------

const COMPONENTS = ['window', 'door_surround', 'lantern_post', 'roof_trim', 'chimney'];
function histogram(nbtFile) {
  const t = plain(parseNbt(fs.readFileSync(nbtFile)));
  const pal = t.palette.map((p) => p.Name ?? p.id);
  const h = {};
  for (const b of t.blocks) {
    const n = pal[b.state];
    if (n === 'minecraft:air' || n === 'minecraft:structure_void') continue;
    h[n] = (h[n] ?? 0) + 1;
  }
  return h;
}
/** Collapse shape variants to their family (oak_stairs -> oak), so similarity reads materials and not shapes. */
const cosine = (a, b) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (const k of keys) {
    ab += (a[k] ?? 0) * (b[k] ?? 0);
    aa += (a[k] ?? 0) ** 2;
    bb += (b[k] ?? 0) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};
/** The blocks no role names (decor, functional, Claude's own picks), as a share of all blocks. */
function offRoles(h, roles) {
  const fam = (s) => s.replace(/^minecraft:/, '').replace(/_(stairs|slab|wall|fence_gate|fence|pane|door|trapdoor|button|pressure_plate)$/, '').replace(/s$/, '').replace(/_planks?$|_log$|_wood$|^stripped_/g, '');
  const roleFams = new Set(Object.values(roles).map(fam));
  let off = 0;
  let all = 0;
  for (const [k, n] of Object.entries(h)) {
    all += n;
    if (!roleFams.has(fam(k))) off += n;
  }
  return all ? off / all : 0;
}

function metrics() {
  const bibles = builtins();
  const out = { runs: {}, arms: {} };
  for (const r of RUNS) {
    const dir = path.join(OUT, 'runs', r.run);
    if (!fs.existsSync(path.join(dir, 'entry.txt'))) continue;
    const entry = fs.readFileSync(path.join(dir, 'entry.txt'), 'utf8').trim();
    const src = fs.readFileSync(path.join(dir, `${entry}.mjs`), 'utf8');
    const calls = Object.fromEntries(COMPONENTS.map((k) => [k, (src.match(new RegExp(`\\bC\\.${k}\\(`, 'g')) ?? []).length]));
    const h = histogram(path.join(dir, `${entry}.nbt`));
    const bp = JSON.parse(fs.readFileSync(path.join(dir, `${entry}.blueprint.json`), 'utf8'));
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
    const total = Object.values(h).reduce((a, n) => a + n, 0);
    const roles = bibles.find((b) => b.id === r.style).roles;
    const wallShare = Object.entries(h).filter(([k]) => k === roles.wall).reduce((a, [, n]) => a + n, 0) / (total || 1);
    out.runs[r.run] = {
      arm: r.arm,
      style: r.style,
      type: r.type,
      entry,
      size: bp.size,
      blocks: total,
      distinctBlocks: Object.keys(h).length,
      componentCalls: calls,
      componentCallsTotal: Object.values(calls).reduce((a, n) => a + n, 0),
      importsBibleComponents: /bible\/components\.mjs/.test(src),
      wallRoleShare: r6(wallShare),
      offRoleShare: r6(offRoles(h, roles)),
      usd: d.cost?.usd ?? 0,
      sourceLines: src.split('\n').length,
      materials: Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ block: k.replace(/^minecraft:/, ''), n })),
      histogram: h,
    };
  }
  // within each arm: mean pairwise cosine of the block-SHAPE profile (each block's family stripped, its shape kept), which is
  // what the shared components would make alike regardless of the Style's materials
  const shape = (h) => {
    const s = {};
    for (const [k, n] of Object.entries(h)) {
      const m = k.replace(/^minecraft:/, '').match(/_(stairs|slab|wall|fence_gate|fence|pane|door|trapdoor|button|lantern|campfire|log|planks|glass)$|^(lantern|campfire|glass_pane|ladder|torch|wall_torch)$/);
      const key = m ? (m[1] ?? m[2]) : 'full';
      s[key] = (s[key] ?? 0) + n;
    }
    return s;
  };
  for (const arm of ['A', 'B']) {
    const rs = Object.entries(out.runs).filter(([, v]) => v.arm === arm);
    const pairs = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) pairs.push(cosine(shape(rs[i][1].histogram), shape(rs[j][1].histogram)));
    out.arms[arm] = {
      n: rs.length,
      meanShapeSimilarity: pairs.length ? r6(pairs.reduce((a, x) => a + x, 0) / pairs.length) : null,
      componentCallsTotal: rs.reduce((a, [, v]) => a + v.componentCallsTotal, 0),
      meanUsd: rs.length ? r6(rs.reduce((a, [, v]) => a + v.usd, 0) / rs.length) : null,
      meanOffRoleShare: rs.length ? r6(rs.reduce((a, [, v]) => a + v.offRoleShare, 0) / rs.length) : null,
      meanDistinctBlocks: rs.length ? r6(rs.reduce((a, [, v]) => a + v.distinctBlocks, 0) / rs.length) : null,
    };
  }
  for (const v of Object.values(out.runs)) delete v.histogram;
  fs.writeFileSync(path.join(OUT, 'metrics.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.arms, null, 2));
}

// ---- blinding ---------------------------------------------------------------------------------------

function blind() {
  const seed0 = Number(opt('seed', Date.now() % 100000));
  let seed = seed0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const done = RUNS.filter((r) => fs.existsSync(path.join(OUT, 'runs', r.run, 'entry.txt')));
  const shuffled = [...done].sort(() => rnd() - 0.5);
  const dir = path.join(OUT, 'blind');
  fs.mkdirSync(dir, { recursive: true });
  const key = { seed: seed0, labels: {}, sets: {} };
  const lines = ['# Blind set', '', 'Each X-label is one building design, rendered iso, front and top. Requested Style and request below.', ''];
  shuffled.forEach((r, i) => {
    const label = `X${String(i + 1).padStart(2, '0')}`;
    const entry = fs.readFileSync(path.join(OUT, 'runs', r.run, 'entry.txt'), 'utf8').trim();
    for (const v of ['iso', 'front', 'top']) {
      const f = path.join(OUT, 'runs', r.run, `${entry}.preview-${v}.png`);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, `${label}-${v}.png`));
    }
    key.labels[label] = r.run;
    lines.push(`- ${label}: Style "${r.style}", a ${r.type} ("${r.notes}")`);
  });
  // the two arms as unlabelled sets P and Q, randomly mapped
  const flip = rnd() < 0.5;
  key.sets = { P: flip ? 'B' : 'A', Q: flip ? 'A' : 'B' };
  const inv = Object.fromEntries(Object.entries(key.sets).map(([s, a]) => [a, s]));
  const set = (s) => Object.entries(key.labels).filter(([, run]) => inv[run.slice(-1)] === s).map(([l]) => l);
  lines.push('', `Set P: ${set('P').join(', ')}`, `Set Q: ${set('Q').join(', ')}`, '', 'Each request appears once in P and once in Q.');
  fs.writeFileSync(path.join(dir, 'README.md'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'blind-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  console.log(`blind/ written: ${shuffled.length} designs; key in blind-key.json (seed ${seed0})`);
}

// ---- main -------------------------------------------------------------------------------------------

const cmd = args[0];
if (cmd === 'plan') {
  const bibles = builtins();
  console.log(JSON.stringify({ capUsd: CAP, runCapUsd: RUN_CAP, marginUsd: MARGIN, spent: spend().totalUsd, runs: RUNS.map((r) => ({ run: r.run, arm: r.arm, style: r.style, type: r.type, request: requestOf(r, bibles) })) }, null, 2));
} else if (cmd === 'run') await run();
else if (cmd === 'metrics') metrics();
else if (cmd === 'blind') blind();
else {
  console.error('usage: node tools/u4ab.mjs plan|run|metrics|blind [--backend sim] [--port N] [--only R1A,R1B] [--seed N]');
  process.exitCode = 2;
}
