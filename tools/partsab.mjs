#!/usr/bin/env node
// Built-in parts A/B (PLAN "After U4" item 3; PAID, Noah's claude login only, hard cap $15, approved 2026-10-24; run after the
// built-ins got parts, tools/builtin-parts.mjs): for a built-in Style WITH its own parts now, is the hybrid default (A:
// `DesignRequest.palette = {bible: {id, version, roles}}`, materials-only plus the Style's look as guidance, U5a) or the Style's
// own parts (B: `bible: <id>`, set mode: its components.mjs, the bible section, --restraint; the editor's "Use this style's parts"
// on) better?
//
//   node tools/partsab.mjs plan                      the runs, the per-run cap, the spend so far; runs nothing
//   node tools/partsab.mjs run [--backend sim] [--port 8903] [--only R1A,R1B]
//   node tools/partsab.mjs metrics                   objective numbers per run (component calls, block shares, similarity)
//   node tools/partsab.mjs blind [--seed N]          shuffled, relabelled renders for the judge (no arm, no design files)
//
// As tools/u4ab.mjs (U4): one design at a time, in pairs (R1A R1B R2A R2B ...), so a stop at the cap leaves whole pairs; every
// run is the SMALL pass (effort small: Opus at medium effort, 40 turns, 2 rounds, a $1.50 cap), identical in both arms. The kit is
// this checkout's (the promoted libraries). Spend: <out>/spend.json part2 (shared with builtin-parts' part1; the total never
// above $40). <out> is ../architect-mc/artifacts/gate-runs-parts/ab (the sim backend: <out>/sim).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseNbt, plain } from '../kit/lib/nbt.mjs';
import { Conn, readSpend, startSidecar, stopSidecar, TOTAL_CAP, writeSpend } from './builtin-parts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BACKEND = opt('backend', 'claude');
const BASE = process.env.PARTS_OUT ? path.resolve(process.env.PARTS_OUT) : path.join(MAIN, 'artifacts', 'gate-runs-parts');
const OUT = BACKEND === 'sim' ? path.join(BASE, 'sim', 'ab') : path.join(BASE, 'ab');
const WORK = path.join(OUT, 'helper');
const PORT = Number(opt('port', 8903));
const CAP = 15;
const RUN_CAP = 1.5;
const MARGIN = 0.1;
const HOLD_MAX_MS = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
fs.mkdirSync(OUT, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'partsab.log'), `${line}\n`);
};

// ---- the six requests: six built-ins with parts now, six types, sizes from a cottage to a tower ----------

export const REQUESTS = [
  { key: 'R1', style: 'japanese', type: 'cottage', name: 'Tea house', maxSize: { x: 11, y: 11, z: 11 }, features: ['garden'], notes: 'A small tea house: one room with a veranda along the front, a little garden beside it.' },
  { key: 'R2', style: 'modern', type: 'shop', name: 'Corner gallery', maxSize: { x: 17, y: 12, z: 13 }, features: ['big_windows'], notes: 'A gallery shop: a tall open ground floor behind a glass front, a small office above.' },
  { key: 'R3', style: 'nordic', type: 'tavern', name: 'Longhouse inn', maxSize: { x: 21, y: 15, z: 13 }, features: ['chimney'], notes: 'A long inn for travellers: a hall with a central hearth and benches, sleeping lofts at the ends.' },
  { key: 'R4', style: 'desert', type: 'house', name: 'Courtyard house', maxSize: { x: 15, y: 12, z: 15 }, features: ['courtyard'], notes: 'A family house around a small open courtyard, shaded rooms on three sides, a roof terrace.' },
  { key: 'R5', style: 'fantasy', type: 'tower', name: 'Alchemist tower', maxSize: { x: 11, y: 24, z: 11 }, features: ['balcony'], notes: "An alchemist's tower: a workshop at the base, a library in the middle, an observatory at the top." },
  { key: 'R6', style: 'brick', type: 'smithy', name: 'Town forge', maxSize: { x: 13, y: 12, z: 11 }, features: ['chimney'], notes: 'A town blacksmith: an open-fronted forge with an anvil and a quenching trough, a storeroom at the back.' },
];
export const RUNS = REQUESTS.flatMap((r) => [
  { ...r, run: `${r.key}A`, arm: 'A' },
  { ...r, run: `${r.key}B`, arm: 'B' },
]);

function builtins() {
  const r = spawnSync(process.execPath, [path.join(root, 'kit', 'tools', 'bible.mjs'), 'builtin'], { cwd: path.join(root, 'kit'), encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').pop()).bibles;
}

/** The design.request of one run. A: the hybrid (the Style's roles inline; its look as guidance). B: the Style's own parts (set mode). */
export function requestOf(run, bibles) {
  const b = bibles.find((x) => x.id === run.style);
  if (!b) throw new Error(`no built-in Style ${run.style}`);
  if (!b.componentsFile) throw new Error(`${run.style} has no parts in this kit (promote them first)`);
  const base = { type: run.type, style: run.style, name: `${run.name} ${run.run}`, features: run.features, maxSize: run.maxSize, notes: run.notes, owner: 'bench:partsab', effort: 'small', budgetUsd: RUN_CAP };
  return run.arm === 'A' ? { ...base, palette: { bible: { id: b.id, version: b.version ?? 1, roles: b.roles } } } : { ...base, bible: b.id, bibleVersion: b.version ?? 1 };
}

// ---- spend (part2 of the shared spend.json) ---------------------------------------------------------------

function beforePaid(name, estimate, auth) {
  const s = readSpend();
  const spent = s.part2.runs.reduce((a, x) => a + (x.usd ?? 0), 0);
  log(`run ${name}: cap $${RUN_CAP}, estimate ${estimate?.usdLow !== undefined ? `$${estimate.usdLow}-${estimate.usdHigh}` : '-'}, part 2 spent $${spent.toFixed(4)}, auth ${JSON.stringify(auth)}`);
  if (BACKEND !== 'sim' && (!/claude login/i.test(auth?.authSource ?? '') || /api key|bedrock|vertex/i.test(auth?.authSource ?? '') || auth?.auth !== 'ok')) throw new Error(`refusing ${name}: the helper is not on the claude login (${JSON.stringify(auth)})`);
  if (spent + RUN_CAP + MARGIN > CAP + 1e-9) throw Object.assign(new Error(`stopping before ${name}: part 2 spent $${spent.toFixed(2)} + its cap $${RUN_CAP} + $${MARGIN} would pass the $${CAP} cap`), { cap: true });
  if ((s.totalUsd ?? 0) + RUN_CAP + MARGIN > TOTAL_CAP + 1e-9) throw Object.assign(new Error(`stopping before ${name}: the total would pass $${TOTAL_CAP}`), { cap: true });
  s.part2.capUsd = CAP;
  s.part2.runs.push({ name, capUsd: RUN_CAP, estimate: estimate ?? null, startedAt: new Date().toISOString(), usd: 0, auth: auth?.authSource ?? BACKEND });
  writeSpend(s);
}
function recordPaid(name, usd, extra = {}) {
  const s = readSpend();
  const st = [...s.part2.runs].reverse().find((x) => x.name === name);
  st.usd = r6(usd);
  Object.assign(st, extra);
  writeSpend(s);
}

// ---- one run ------------------------------------------------------------------------------------------

function findBrief(data, designId) {
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
  if (brief) {
    fs.copyFileSync(brief, path.join(dir, 'BRIEF.md'));
    const comp = path.join(path.dirname(brief), 'bible', 'components.mjs');
    if (fs.existsSync(comp)) fs.copyFileSync(comp, path.join(dir, 'scratch-bible-components.mjs'));
  }
  if (d.status === 'done' && d.blueprintId) {
    const src = path.join(WORK, 'library', d.blueprintId);
    for (const f of fs.readdirSync(src)) if (fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    if (fs.existsSync(path.join(src, 'bible', 'components.mjs'))) fs.copyFileSync(path.join(src, 'bible', 'components.mjs'), path.join(dir, 'entry-bible-components.mjs'));
    fs.writeFileSync(path.join(dir, 'entry.txt'), `${d.blueprintId}\n`);
  }
  log(`${name}: ${d.status} $${(d.cost?.usd ?? 0).toFixed(4)} in ${(ms / 60000).toFixed(1)} min${d.error ? ` (${d.error})` : ''}`);
  return d;
}

async function run() {
  const only = opt('only', null)?.split(',');
  const bibles = builtins();
  for (const r of RUNS) requestOf(r, bibles); // every Style has its parts in this kit
  const data = await startSidecar(WORK, PORT, BACKEND, log);
  try {
    const c = await Conn.open(PORT, data, 'partsab');
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
    log(`done: part 2 spent $${readSpend().part2.totalUsd}`);
  } catch (e) {
    log(`stopped: ${e.message}`);
    process.exitCode = e.held ? 4 : e.cap ? 3 : 1;
  } finally {
    await stopSidecar();
  }
}

// ---- objective metrics (as u4ab) ------------------------------------------------------------------------

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

async function metrics() {
  const bibles = builtins();
  const { traceRole } = await import('../kit/lib/connectors/style.mjs');
  const { fixtureFor } = await import('../kit/lib/region/fixtures.mjs');
  const out = { runs: {}, arms: {} };
  for (const r of RUNS) {
    const dir = path.join(OUT, 'runs', r.run);
    if (!fs.existsSync(path.join(dir, 'entry.txt'))) continue;
    const entry = fs.readFileSync(path.join(dir, 'entry.txt'), 'utf8').trim();
    const src = fs.readFileSync(path.join(dir, `${entry}.mjs`), 'utf8');
    const callNames = [...src.matchAll(/\bC\.([a-z][a-z0-9_]*)\(/g)].map((m) => m[1]);
    const calls = {};
    for (const n of callNames) calls[n] = (calls[n] ?? 0) + 1;
    const h = histogram(path.join(dir, `${entry}.nbt`));
    const bp = JSON.parse(fs.readFileSync(path.join(dir, `${entry}.blueprint.json`), 'utf8'));
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'design.json'), 'utf8'));
    const total = Object.values(h).reduce((a, n) => a + n, 0);
    const roles = bibles.find((b) => b.id === r.style).roles;
    const light = roles.light ? fixtureFor(roles.light, roles.rail).light : null;
    let off = 0;
    for (const [k, n] of Object.entries(h)) if (!traceRole(k, roles, { lightFixture: light })) off += n;
    const brief = fs.existsSync(path.join(dir, 'BRIEF.md')) ? fs.readFileSync(path.join(dir, 'BRIEF.md'), 'utf8') : '';
    out.runs[r.run] = {
      arm: r.arm,
      style: r.style,
      type: r.type,
      entry,
      size: bp.size,
      blocks: total,
      distinctBlocks: Object.keys(h).length,
      componentCalls: calls,
      componentCallsTotal: callNames.length,
      importsBibleComponents: /bible\/components\.mjs/.test(src),
      briefHasGuidance: /\(guidance\)/.test(brief),
      briefHasBibleSection: /components\.mjs/.test(brief),
      offRoleShare: r6(total ? off / total : 0),
      usd: d.cost?.usd ?? 0,
      check: d.check?.ok ?? null,
      warnings: d.check?.warnings ?? d.warnings ?? null,
      sourceLines: src.split('\n').length,
      histogram: h,
    };
  }
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
    const mean = (f) => (rs.length ? r6(rs.reduce((a, [, v]) => a + f(v), 0) / rs.length) : null);
    out.arms[arm] = { n: rs.length, meanShapeSimilarity: pairs.length ? r6(pairs.reduce((a, x) => a + x, 0) / pairs.length) : null, componentCallsTotal: rs.reduce((a, [, v]) => a + v.componentCallsTotal, 0), meanUsd: mean((v) => v.usd), meanOffRoleShare: mean((v) => v.offRoleShare), meanDistinctBlocks: mean((v) => v.distinctBlocks) };
  }
  for (const v of Object.values(out.runs)) delete v.histogram;
  fs.writeFileSync(path.join(OUT, 'metrics.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.arms, null, 2));
}

// ---- blinding (as u4ab) -----------------------------------------------------------------------------------

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
  const flip = rnd() < 0.5;
  key.sets = { P: flip ? 'B' : 'A', Q: flip ? 'A' : 'B' };
  const inv = Object.fromEntries(Object.entries(key.sets).map(([s, a]) => [a, s]));
  const set = (s) => Object.entries(key.labels).filter(([, run]) => inv[run.slice(-1)] === s).map(([l]) => l);
  lines.push('', `Set P: ${set('P').join(', ')}`, `Set Q: ${set('Q').join(', ')}`, '', 'Each request appears once in P and once in Q.');
  fs.writeFileSync(path.join(dir, 'README.md'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'blind-key.json'), `${JSON.stringify(key, null, 2)}\n`);
  console.log(`blind/ written: ${shuffled.length} designs; key in blind-key.json (seed ${seed0})`);
}

const cmd = args[0];
if (cmd === 'plan') {
  const bibles = builtins();
  console.log(JSON.stringify({ capUsd: CAP, runCapUsd: RUN_CAP, marginUsd: MARGIN, spent: readSpend().part2.totalUsd, runs: RUNS.map((r) => ({ run: r.run, arm: r.arm, style: r.style, type: r.type, request: requestOf(r, bibles) })) }, null, 2));
} else if (cmd === 'run') await run();
else if (cmd === 'metrics') await metrics();
else if (cmd === 'blind') blind();
else {
  console.error('usage: node tools/partsab.mjs plan|run|metrics|blind [--backend sim] [--port N] [--only R1A,R1B] [--seed N]');
  process.exitCode = 2;
}
