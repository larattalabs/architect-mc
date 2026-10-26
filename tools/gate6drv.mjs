#!/usr/bin/env node
// Slice 6d RV gate (additive revisions; docs/CONTRACT.md "Phase 6d slice RV" §14, lanes RV-a and RV-b) against the headless server of the RV
// run worktree (GATE6B_RUN, default `../architect-mc-RV-run`; the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6drv.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (rv-unit)              items 1, 2, 17 offline: the kit's rv-a.test (reviseIR, the guard and M29:revision per class and broken
//                                      variant, the effective-IR merge, historySha, 300 seeded revisions, plan/0's revision mode and artifact,
//                                      determinism with 1 and 4 workers), the kit's byte-identity suites (goldens, plan fixtures, the asks),
//                                      RevisionsTest and RealisedTest (the mod's merge equals the kit's; names; the record), api-compat
//                                      against the 0.47.0, 0.45.0 and 0.44.0 apitest jars and the 0.47.0 mod surface
//     ingame    (rv-ingame)            items 3, 6, 11, 20 in game on a flat town (flat_village, pads): every refusal before anything is written
//                                      (lot COVERED, street OVERLAP, a site's cells OVERLAP held, a non-additive edit, a theme, a refill, an
//                                      added body until RV-c); an added mound and a rock spire realised as revision 1 over the whole-world
//                                      oracle (claim + 8, every cell); the head, the states, the region's own state again, the layer's
//                                      records; two candidates on one parent (the second PLAN_STALE parent_moved, nothing written); a site
//                                      placed after a plan on its cell refusing that tile at its check; a block set between a tile's capture
//                                      and its write RACED, not written; Regions.remove with two revisions standing: E-flat 0
//     crash     (rv-crash)             item 10's realise half: kills at RV1 (the manifest), RV2 (the effective snapshot, before region.json),
//                                      RV3 (accepted, nothing installed), RV4 (installed, nothing written) and RG4+save (a revision tile mid-
//                                      write): after each restart the state the manifest names, one batch, the revision PLACED (or never
//                                      accepted for RV1/RV2, then realised again), and Regions.remove E-flat 0
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6d-rv/<step>.json in the main checkout (GATE6DRV_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
// Ports: 8960/8961 (the RV lane's own range 8960-8969).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-RV-run');
process.env.GATE6B_OUT = process.env.GATE6DRV_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6d-rv');
process.env.GATE6B_SIDECAR_PORT ??= '8960';
process.env.GATE6B_DEV_PORT ??= '8961';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const OWNER = 'test:rv';
const FLAT = 'G6B Flat Base';
const CX = 11200, CZ = 11200;
/** The town's claim: 112 x 112 (D3's flat_village fixture shape), its lots pads (no entries). */
const CLAIM = [CX, CZ, CX + 111, CZ + 111];
const LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RV is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
/** A dev.box.hash cell line's state as "minecraft:x[k=v,...]" (props sorted): its `Block{...}[...]` form or its NBT form. */
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return norm(props.length ? `${n}[${props.join(',')}]` : n);
}
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;

async function groundY() {
  const c = await cellsOf([CX + 100, -64, CZ + 100, CX + 100, 255, CZ + 100]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'air' && y > g) g = y; }
  return g;
}

async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(CX + 56, 60, CZ + 56);
}

/** The town: flat_village over CLAIM, its lots pads; realised and PLACED. */
async function town(lots = null) {
  const p = await L.plan('flat_village', CLAIM, { params: { lots: LOTS }, surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const region = await L.realise(p.planId, { load: 'bounded:512', ...(lots ? { lots } : {}) });
  const st = await L.waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `the town ${region}: ${st.view.state}, ${st.view.cellsWritten} cells, lots ${json(st.view.lots.map((l) => [l.id, l.state]))}`);
  return { region, p, st };
}

async function rvPlan(region, spec, opts = {}) {
  const r = await call('dev.rv.plan', { region, spec, ...opts }, 900_000);
  log(`  rv plan ${region}: ${r.refused ? `refused ${r.refused}` : `${r.planId} rid ${r.revisionOf?.rid} parent ${r.revisionOf?.parentRid} stages ${json(r.stages)}`}`);
  return r;
}
const rvState = (region) => call('dev.rv.state', { region }, 60_000);
/** Waits for a region's revision to end: busy cleared and the revision past PLACING. */
async function rvWait(region, rid, timeoutMs = 1_800_000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeoutMs) {
    st = await rvState(region);
    const r = st.revisions.find((x) => x.rid === rid);
    if (st.busy === null && r && !['ACCEPTED', 'PLACING'].includes(r.state)) return { st, r };
    await sleep(L.pollDelayMs(Date.now() - t0));
  }
  throw new Error(`revision ${rid} of ${region} did not end (${json(st?.revisions?.map((x) => [x.rid, x.state]))}, busy ${st?.busy})`);
}

// a free spot of the town (east of its lots and street; the D3 fixture's town keeps x >= 88 free on a flat world)
const MOUND = (rid) => ({ id: `mound${rid}`, call: { fn: 'columns', cols: [CX + 96, CZ + 92, 0, 1, 0, CX + 97, CZ + 92, 0, 2, 0, CX + 98, CZ + 93, 0, 0, 0], from: { surface: 1 }, to: { surface: 1 }, materials: ['rock'], cond: 0 } });
/** A rock spire on the ground (rockSpire's `at` y is the plan ground). */
const SPIRE = (gy) => ({ id: 'spire', call: { fn: 'form', generator: 'rockSpire', params: { at: [CX + 100, gy, CZ + 20], height: [10, 12] } } });

// ------------------------------------------------------------------ the oracle (§14): the expected world, independent of the revision code

/**
 * The expected world after a revision: the snapshot with the revision IR's tiles applied, evaluated by the kit (evalTile) on the frozen
 * heights (a flat world: ground `gy` everywhere), stage by stage and set by set against the evolving expected world, each cell's condition
 * tested as the virtual world does (vworld.mjs's rule: IF_NATURAL a natural cell, IF_SOLID natural solid, IF_AIR_OR_FLUID air or fluid,
 * ALWAYS_OURS ours or natural), a no-op skipped. No held or protected cell is in a clean revision's way (the refusals are their own items).
 */
async function oracle(ir, snapshot, gy) {
  const R = await imp('lib/realise.mjs');
  const { unpack } = await imp('lib/region/pack.mjs');
  const { synthColumns } = await imp('lib/region/synth.mjs');
  const { Palette } = await imp('lib/region/vworld.mjs');
  const pal = new Palette();
  const exp = new Map(snapshot);
  const ours = new Set();
  const air = 'minecraft:air';
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const [tx, tz] = key.split(',').map(Number);
    const win = synthColumns({ minX: tx * 64 - 8, minZ: tz * 64 - 8, width: 80, depth: 80, world: () => ({ g: gy, h: gy, f: gy, flags: 0 }) });
    const e = R.evalTile(ir, key, win, { stage, set });
    for (const c of unpack(e.payload).cells) {
      const k = `${c.x},${c.y},${c.z}`;
      const cur = pal.of(exp.get(k) ?? air);
      let ok;
      switch (c.cond) {
        case 1: ok = pal.natural[cur] && !pal.air[cur] && !pal.fluid[cur] && pal.solid[cur]; break;
        case 2: ok = pal.air[cur] || pal.fluid[cur]; break;
        case 3: ok = ours.has(k) || pal.natural[cur]; break;
        default: ok = pal.natural[cur];
      }
      if (!ok || norm(exp.get(k) ?? air) === norm(c.state)) continue;
      exp.set(k, norm(c.state));
      ours.add(k);
    }
  }
  return exp;
}
/** The revision IR's intended cells (every stage and set, conditions aside) against a box: how many, and how many outside. */
async function intendedInBox(ir, gy, box) {
  const R = await imp('lib/realise.mjs');
  const { unpack } = await imp('lib/region/pack.mjs');
  const { synthColumns } = await imp('lib/region/synth.mjs');
  let cells = 0, out = 0, minY = Infinity, maxY = -Infinity;
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const [tx, tz] = key.split(',').map(Number);
    const win = synthColumns({ minX: tx * 64 - 8, minZ: tz * 64 - 8, width: 80, depth: 80, world: () => ({ g: gy, h: gy, f: gy, flags: 0 }) });
    for (const c of unpack(R.evalTile(ir, key, win, { stage, set }).payload).cells) {
      cells++;
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      if (c.x < box[0] || c.x > box[3] || c.y < box[1] || c.y > box[4] || c.z < box[2] || c.z > box[5]) out++;
    }
  }
  return { cells, out, minY, maxY };
}

function diff(a, b, max = 12) {
  const out = [];
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = norm(a.get(k) ?? 'minecraft:air'), y = norm(b.get(k) ?? 'minecraft:air');
    if (x !== y) { n++; if (out.length < max) out.push(`${k} expected ${x} got ${y}`); }
  }
  return { n, first: out };
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B RV Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

// ------------------------------------------------------------------ offline (items 1, 2, 17; api-compat)

async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}
function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

/** The archived apitest jars and mod surface api-compat checks against (built from their tags: GATE6DRV_JARS, default artifacts/gate6d-rv/jars). */
export function apiJars() {
  const A = process.env.GATE6DRV_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
  const R44 = path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts', 'release-0440', 'v0440');
  return { jars: [path.join(A, 'architect_apitest-0.47.0.jar'), path.join(A, 'architect_apitest-0.45.0.jar'), path.join(R44, 'architect_apitest-0.44.0.jar')], surface: path.join(A, 'architect_mc-0.47.0.jar') };
}

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/rv-a.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `items 1 and 17 (kit rv-a.test): reviseIR's additions, ids, stages and seed; the guard per class and M29:revision per broken variant; the effective-IR merge; historySha; 300 seeded synthetic revisions (deterministic, nothing standing named, no write where the standing region forbids); plan/0's revision mode (keep, add, refill, grow, change) and its artifact; the revision IR over 3 plans and its tile shas with 1 and 4 workers; the catalogue's revision.* entries; the mod's parity fixture: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.identity = nodeTest(['kit/test/scenario-goldens.test.mjs', 'kit/test/region-golden.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/districts-d3-parity.test.mjs', 'kit/test/rp.test.mjs', 'kit/test/plan-p0.test.mjs']);
  check(out.identity.code === 0 && out.identity.fail === 0, `item 2 (byte identity): the scenario and region goldens, the plan fixtures valid/*, the 59 asks, D3's parity fixture, RP's writers and the catalogue: ${out.identity.pass} pass, ${out.identity.fail} fail`, out.identity.failing);
  out.java = await javaTests(['*RevisionsTest*', '*RealisedTest*', '*ApiDTest*', '*PredicatePathsTest*', '*LedgerLintTest*', '*RegionFluidsLintTest*'], 20);
  check(out.java.ok, `RevisionsTest (the mod's merge equals the kit's mergeEffective; stage names; the record round trip; an unrevised region's record unchanged), RealisedTest, ApiDTest, PredicatePathsTest and p3-lint's LedgerLintTest and RegionFluidsLintTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  const J = apiJars();
  out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
    const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
    return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
  });
  check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the 0.47.0, 0.45.0 and 0.44.0 apitest jars and the 0.47.0 mod surface', out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game (items 3, 6, 11, 20; removal)

steps.ingame = async () => {
  await ensure();
  const out = {};
  await freshFlat('G6B RV Town');
  const gy = await groundY();
  out.gy = gy;
  check(gy > -64 && gy < 200, `the flat world's ground: y ${gy}`);
  const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8]; // (a rock spire's footing goes 8 under the ground)
  const before = await hashOf(BOX);
  const T = await town();
  const region = T.region;
  const lot = T.st.view.lots[0];
  const ir0 = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', T.p.planId, 'ir.json'), 'utf8'));
  const hall = ir0.lots.find((l) => l.id === 'hall_1').box;
  const road = ir0.roads[0];

  // ---- item 6: refusals, nothing written (the world's hash and the head unchanged)
  const h0 = await hashOf(BOX);
  const col = (id, x, z) => ({ id, call: { fn: 'columns', cols: [x, z, 0, 0, 0], from: { surface: 1 }, to: { surface: 1 }, materials: ['structure'], cond: 0 } });
  const refusals = {
    lot: await rvPlan(region, { parts: [col('a', hall.minX + 2, hall.minZ + 2)] }),
    street: await rvPlan(region, { parts: [col('a', road.points[0][0] + 2, road.points[0][2])] }),
    theme: await rvPlan(region, { parts: [{ id: 'oak', call: { fn: 'columns', cols: [CX + 100, CZ + 100, 0, 0, 0], from: { surface: 1 }, to: { surface: 1 }, materials: ['minecraft:oak_planks'] } }] }),
    refillPlaced: await rvPlan(region, { parts: [], refill: ['nolot'] }),
    nothing: await rvPlan(region, { parts: [] }),
  };
  // another site's cells (a Steward addition's shape: a cell site) on a free spot: held, refused OVERLAP
  const site = await call('dev.cells.place', { kind: 'test:rv_steward', cells: [[CX + 104, gy + 1, CZ + 104, 'minecraft:cobblestone']], naturalOnly: false, owner: 'steward_mc:test' }, 300_000);
  refusals.held = await rvPlan(region, { parts: [col('a', CX + 104, CZ + 104)] });
  // an added body: the kit plans it, the mod refuses it at realise (RV-c brings added bodies), nothing written
  const pond = await rvPlan(region, { parts: [{ id: 'pond', call: { fn: 'pond', rect: [CX + 90, CZ + 40, CX + 96, CZ + 46] } }] });
  refusals.pondRealise = pond.refused ? { refused: pond.refused } : await call('dev.region.realise', { planId: pond.planId }, 300_000);
  out.refusals = refusals;
  const code = (r) => String(r?.refused ?? '').split(':')[0];
  check(code(refusals.lot) === 'COVERED', `a write in a standing lot box refuses COVERED: ${refusals.lot.refused}`);
  check(code(refusals.street) === 'OVERLAP', `a write on the street refuses OVERLAP {kind: road|path}: ${refusals.street.refused}`);
  check(code(refusals.held) === 'OVERLAP' && /held/.test(refusals.held.refused), `a write on another site's cell (${site.siteId}) refuses OVERLAP {kind: held}: ${refusals.held.refused}`);
  check(code(refusals.theme) === 'NOT_ALLOWED' && /theme/.test(refusals.theme.refused), `a raw oak block refuses NOT_ALLOWED [theme] (everything generated is themed): ${refusals.theme.refused}`);
  check(code(refusals.refillPlaced) === 'NOT_ALLOWED', `a refill of a lot that isn't the region's refuses NOT_ALLOWED: ${refusals.refillPlaced.refused}`);
  check(code(refusals.nothing) === 'NOT_ALLOWED', `a revision adding nothing refuses NOT_ALLOWED: ${refusals.nothing.refused}`);
  check(String(refusals.pondRealise.refused ?? '').startsWith('NOT_ALLOWED'), `an added body is planned by the kit and refused at realise until RV-c (NOT_ALLOWED): ${json(refusals.pondRealise)}`);
  let s0 = await rvState(region);
  const h1 = await hashOf(BOX);
  check(h1 !== h0 && s0.headRid === 0 && s0.position === 0 && s0.busy === null && s0.revisions.length === 0, `nothing written by any refusal: the head 0, no revision record, busy null (the claim's hash moved only by the test's own site: ${h0 !== h1})`);
  check(s0.nextRid >= 2, `every plan took a rid (monotonic, never reused): nextRid ${s0.nextRid}`);

  // ---- item 3: an added mound and spire, realised as the region's next layers, against the whole-world oracle
  const snap = await cellsOf(BOX);
  const p1 = await rvPlan(region, { parts: [MOUND(1), SPIRE(gy)] });
  check(!p1.refused && p1.revisionOf?.parentRid === 0 && p1.revisionOf?.position === 1, `revision planned: ${p1.planId} rid ${p1.revisionOf?.rid} on head 0, position 1`);
  s0 = await rvState(region);
  check(s0.headRid === 0 && s0.position === 0, 'a candidate never moves the head');
  const rir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p1.planId, 'ir.json'), 'utf8'));
  const r1 = await L.realise(p1.planId);
  check(r1 === region, `the realise of a revision answers its region: ${r1}`);
  const w1 = await rvWait(region, p1.revisionOf.rid);
  const got = await cellsOf(BOX);
  const exp = await oracle(rir, snap, gy);
  const d1 = diff(new Map([...exp].filter(([k]) => { const [x, y, z] = k.split(',').map(Number); return x >= BOX[0] && x <= BOX[3] && y >= BOX[1] && y <= BOX[4] && z >= BOX[2] && z <= BOX[5]; })), got);
  // every cell the revision IR intends lies inside the compared box (an out-of-box write would make the oracle blind to it)
  const yr = [...exp.keys()].filter((k) => !snap.has(k) || norm(snap.get(k)) !== norm(exp.get(k))).map((k) => Number(k.split(',')[1]));
  const inBox = await intendedInBox(rir, gy, BOX);
  check(inBox.out === 0 && inBox.cells > 0, `the revision IR's ${inBox.cells} intended cells all inside the compared box (y ${inBox.minY}..${inBox.maxY} within ${BOX[1]}..${BOX[4]}; ${inBox.out} outside); ${yr.length} cells expected to change`);
  out.add = { rid: p1.revisionOf.rid, revision: w1.r, diff: d1, cells: w1.r.cells };
  check(w1.r.state === 'PLACED' && d1.n === 0, `item 3: revision ${p1.revisionOf.rid} ${w1.r.state} (${w1.r.cells} cells); the whole claim + 8 against the oracle (the kit's own evaluation of the revision IR on the frozen heights, stage by stage, over the snapshot): ${d1.n} cells differ`, d1.first);
  check(w1.st.headRid === p1.revisionOf.rid && w1.st.position === 1 && w1.st.state === 'PLACED' && w1.st.busy === null, `the head ${w1.st.headRid} at position ${w1.st.position}; the region reads PLACED again (its own state), busy cleared`);
  check(w1.st.effectiveHead === p1.revisionOf.rid && w1.st.effectiveParts.some((x) => x.startsWith(`rv${p1.revisionOf.rid}_`)) && w1.st.effectiveFiles.includes(`${p1.revisionOf.rid}.json`), `the effective IR: head ${w1.st.effectiveHead}, ${w1.st.effectiveParts.length} parts (the revision's among them), snapshot ${json(w1.st.effectiveFiles)}`);
  check(w1.r.sites.length >= 1 && w1.r.stages.every((x) => x.startsWith(`rv${p1.revisionOf.rid}:`)), `the revision's sites ${json(w1.r.sites)} and journal stages ${json(w1.r.stages)} (Steward's ask: one revision, its sites)`);
  const sx = w1.st.siteExt ?? {};
  check(w1.r.sites.every((sid) => sx[sid]?.rid === p1.revisionOf.rid && sx[sid]?.region === region), `every site the revision wrote carries ext architect_mc:revision {region, rid} on its record: ${json(Object.fromEntries(w1.r.sites.map((sid) => [sid, sx[sid] ?? null])))}`);
  const rec1 = await call('dev.region.realised', { region, layer: p1.revisionOf.rid, verify: false }, 600_000);
  check((rec1.tiles ?? []).length >= 1 && rec1.tiles.every((t) => t.status === 'committed'), `the revision's realised records at layer ${p1.revisionOf.rid}: ${(rec1.tiles ?? []).length}, all committed`, (rec1.tiles ?? []).map((t) => [t.stage, t.set, t.key, t.status]));
  const view = w1.st.view;
  check(view.position === 1 && view.revisions?.length === 1 && view.revisions[0].state === 'PLACED', `RegionView: position ${view.position}, revisions ${json(view.revisions?.map((r) => [r.rid, r.state]))}`);

  // ---- item 11: two candidates on one parent; the second PLAN_STALE parent_moved, nothing written
  const ca = await rvPlan(region, { parts: [MOUND(2)] });
  const cb = await rvPlan(region, { parts: [{ ...MOUND(3), call: { ...MOUND(3).call, cols: [CX + 96, CZ + 98, 0, 1, 0] } }] });
  check(!ca.refused && !cb.refused && ca.revisionOf.parentRid === p1.revisionOf.rid && cb.revisionOf.parentRid === p1.revisionOf.rid, `two candidates on head ${p1.revisionOf.rid}: rids ${ca.revisionOf?.rid}, ${cb.revisionOf?.rid}`);
  await L.realise(ca.planId);
  const wa = await rvWait(region, ca.revisionOf.rid);
  const hb = await hashOf(BOX);
  const rb = await call('dev.region.realise', { planId: cb.planId }, 300_000);
  const hb2 = await hashOf(BOX);
  out.heads = { a: wa.r, b: rb };
  check(wa.r.state === 'PLACED' && String(rb.refused ?? '').startsWith('PLAN_STALE') && /parent_moved/.test(rb.refused) && hb === hb2, `the first candidate accepted (${wa.r.state}, head ${wa.st.headRid}); the second refuses ${rb.refused}; nothing written (${hb === hb2})`);

  // ---- §3.2: a site placed after the plan on a target cell: the tile refuses at its check, the revision ends with nothing of that tile
  const pc = await rvPlan(region, { parts: [col('late', CX + 60, CZ + 100)] });
  const late = await call('dev.cells.place', { kind: 'test:rv_late', cells: [[CX + 60, gy + 1, CZ + 100, 'minecraft:mossy_cobblestone']], naturalOnly: false, owner: 'steward_mc:test' }, 300_000);
  const hl = await hashOf(BOX);
  await L.realise(pc.planId);
  const wl = await rvWait(region, pc.revisionOf.rid);
  const hl2 = await hashOf(BOX);
  out.lateSite = { revision: wl.r, site: late.siteId };
  check(wl.r.state === 'FAILED' && /OVERLAP|COVERED/.test(wl.r.waiting ?? '') && hl === hl2 && wl.st.state === 'PLACED', `a site placed on a target cell after the plan (${late.siteId}): the tile refuses at its check (${wl.r.waiting}); the revision ${wl.r.state}, nothing written (${hl === hl2}), the region PLACED`);

  // ---- item 20: a player's block set between a tile's capture and its write: RACED, not written; the rest written
  const pr = await rvPlan(region, { parts: [{ id: 'race', call: { fn: 'columns', cols: [CX + 70, CZ + 100, 0, 0, 0, CX + 71, CZ + 100, 0, 0, 0, CX + 72, CZ + 100, 0, 0, 0], from: { surface: 1 }, to: { surface: 1 }, materials: ['rock'], cond: 0 } }] });
  await call('dev.rv.race', { at: [CX + 71, gy + 1, CZ + 100], state: 'minecraft:glowstone' }, 10_000);
  await L.realise(pr.planId);
  const wr = await rvWait(region, pr.revisionOf.rid);
  const rc = await cellsOf([CX + 70, gy + 1, CZ + 100, CX + 72, gy + 1, CZ + 100]);
  out.race = { revision: wr.r, cells: Object.fromEntries(rc) };
  const racedCell = rc.get(`${CX + 71},${gy + 1},${CZ + 100}`);
  const others = [rc.get(`${CX + 70},${gy + 1},${CZ + 100}`), rc.get(`${CX + 72},${gy + 1},${CZ + 100}`)];
  check(wr.r.state === 'PLACED' && idOf(racedCell) === 'glowstone' && others.every((s) => idOf(s) !== 'air' && idOf(s) !== 'glowstone'), `item 20 (a player's block): the raced cell keeps the player's glowstone (${racedCell}), unwritten; the tile's other cells written (${json(others)}); the revision ${wr.r.state}`);
  await call('dev.rv.race', { at: null }, 10_000);

  // ---- Regions.remove with the revisions standing: the group takes them all, last placed first: E-flat 0 against the world before the town
  const rem = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await sleep(2000);
  check(rem.removed !== false, `Regions.remove with ${wr.st.revisions.length} revisions standing: removed ${rem.removed}`);
  // the cells that are not the region's stay: the test's two sites (a Steward addition's shape) and the player's raced block (kept by
  // policy); each set back to the air that stood there before the town, then the whole claim + 8 compared with the world before it
  const keep = [[CX + 104, gy + 1, CZ + 104], [CX + 60, gy + 1, CZ + 100], [CX + 71, gy + 1, CZ + 100]];
  const kept = [];
  for (const [x, y, z] of keep) { kept.push([...(await cellsOf([x, y, z, x, y, z])).values()][0]); await cmd(`/setblock ${x} ${y} ${z} minecraft:air`); }
  const after2 = await hashOf(BOX);
  out.remove = { result: rem, kept, flat: after2 === before };
  check(after2 === before && idOf(kept[2]) === 'glowstone', `E-flat 0 over the claim + 8 after the removal (the cells that were not the region's kept: ${json(kept)}, then cleared for the comparison)`);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ RV-c and RV-d in game: undo, fluids, refills (items 7, 8, 14, 16, 19; 12's land)

const STUB = 'g6a_stub_9';
/** A pond in a free corner of the town (east of its lots). */
const POND = (rid) => ({ id: `pond${rid}`, call: { fn: 'pond', rect: [CX + 88, CZ + 30, CX + 94, CZ + 36], depth: 2 } });
/** An added lot (a 9 x 9 box south-east), its id in the revision rv<rid>_shed. */
const SHED = { id: 'shed', call: { fn: 'lot', at: [CX + 96, CZ + 70], size: [9, 9] } };
const at3 = (k) => k.split(',').map(Number);

/** Realise a revision plan and wait for it. */
async function rvRealise(region, p, opts = {}) {
  const r = await call('dev.region.realise', { planId: p.planId, ...opts }, 300_000);
  if (r.refused) throw new Error(`realise refused: ${r.refused}`);
  return rvWait(region, p.revisionOf.rid);
}
/** The cells of `a` that differ from `b` over the box, but the listed exceptions ("x,y,z" -> the state expected there). */
function diffExcept(want, got, except = new Map()) {
  const w = new Map(want);
  for (const [k, v] of except) w.set(k, v);
  return diff(w, got);
}

steps.undo = async () => {
  await ensure();
  const out = {};
  await freshFlat('G6B RV Undo');
  const gy = await groundY();
  check(gy > -64 && gy < 200, `the flat world's ground: y ${gy}`);
  const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8];
  const before = await hashOf(BOX);
  const B0 = await cellsOf(BOX);
  const T = await town({ cottage_1: STUB, cottage_2: STUB });
  const region = T.region;
  const S0 = await cellsOf(BOX);
  // three revisions: a mound and a spire; a pond (an added body); a lot with a building
  const p1 = await rvPlan(region, { parts: [MOUND(1), SPIRE(gy)] });
  const w1 = await rvRealise(region, p1);
  const S1 = await cellsOf(BOX);
  const p2 = await rvPlan(region, { parts: [POND(2)] });
  const w2 = await rvRealise(region, p2);
  const fl = await call('dev.fluid.state', { region }, 60_000).catch((e) => ({ error: String(e) }));
  const rows = (w2.st.view.ext?.['architect_mc:fluids'] ?? []).filter((r) => r.rid === p2.revisionOf.rid);
  const S2 = await cellsOf(BOX);
  const water2 = [...S2].filter(([k, v]) => idOf(v) === 'water' && idOf(S1.get(k) ?? 'air') !== 'water').length;
  out.pond = { revision: w2.r, rows, water: water2, fluid: fl };
  check(w2.r.state === 'PLACED' && rows.length >= 1 && rows.every((r) => r.state === 'settled') && water2 > 0, `item 19 (added body): revision ${p2.revisionOf.rid} ${w2.r.state}, its body rows ${json(rows.map((r) => [r.body, r.state, r.sources]))} (rid ${p2.revisionOf.rid}), ${water2} water cells`);
  const p3 = await rvPlan(region, { parts: [SHED] });
  const shedId = `rv${p3.revisionOf?.rid}_shed`;
  const w3 = await rvRealise(region, p3, { lots: { [shedId]: STUB } });
  const S3 = await cellsOf(BOX);
  const shed = w3.st.view.lots.find((l) => l.id === shedId);
  check(w3.r.state === 'PLACED' && shed?.state === 'placed' && shed.revision === p3.revisionOf.rid && w3.r.sites.includes(shed.siteId), `an added lot built: ${json(shed)}, the revision's sites ${json(w3.r.sites)}`);
  // ---- item 7, row 1: the head undone: the world just before it, cell for cell
  const u1 = await call('dev.rv.undo', { region, toPosition: 2 }, 4 * 3_600_000);
  let st = await rvState(region);
  const d1 = diff(S2, await cellsOf(BOX));
  out.undoHead = { result: u1, diff: d1, head: st.headRid, position: st.position };
  check(u1.removed === true && d1.n === 0 && st.position === 2 && st.headRid === p2.revisionOf.rid && st.busy === null && !st.view.lots.some((l) => l.id === shedId), `item 7 (the head undone): ${json(u1)}; the world just before it over claim + 8: ${d1.n} cells differ; the head ${st.headRid} at position ${st.position}; the lot gone`, d1.first);
  check(st.revisions.find((r) => r.rid === p3.revisionOf.rid)?.state === 'UNDONE', `revision ${p3.revisionOf.rid} UNDONE`);
  // ---- the refusals: toPosition not below the head; then a Steward site over a revision cell, a waterlogged stair over a pond source, a
  // player's block on the spire: undo to 0 in one operation
  const r0 = await call('dev.rv.undo', { region, toPosition: 2 }, 60_000);
  check(String(r0.refused ?? '').startsWith('NOT_ALLOWED'), `an undo to the head's own position refuses NOT_ALLOWED: ${r0.refused}`);
  const mound = [...S1].filter(([k, v]) => idOf(v) !== idOf(S0.get(k) ?? 'minecraft:air') && at3(k)[0] === CX + 97).map(([k]) => at3(k)).sort((a, b) => b[1] - a[1])[0];
  const source = [...S2].filter(([k, v]) => idOf(v) === 'water' && idOf(S1.get(k) ?? 'air') !== 'water').map(([k]) => at3(k)).sort((a, b) => b[1] - a[1])[0];
  const spireCell = [...S1].filter(([k, v]) => idOf(v) !== 'air' && idOf(S0.get(k) ?? 'minecraft:air') === 'air' && at3(k)[0] >= CX + 96 && at3(k)[2] <= CZ + 30).map(([k]) => at3(k)).sort((a, b) => b[1] - a[1])[0];
  const steward = await call('dev.cells.place', { kind: 'test:rv_steward', cells: [[mound[0], mound[1], mound[2], 'minecraft:mossy_cobblestone']], naturalOnly: false, overlap: 'LAYER', owner: OWNER }, 300_000);
  const stair = await call('dev.cells.place', { kind: 'test:rv_stair', cells: [[source[0], source[1], source[2], 'minecraft:stone_brick_stairs[facing=north,half=bottom,shape=straight,waterlogged=true]']], naturalOnly: false, overlap: 'LAYER', owner: OWNER }, 300_000);
  await cmd(`/setblock ${spireCell[0]} ${spireCell[1]} ${spireCell[2]} minecraft:glowstone`);
  out.over = { steward, stair, mound, source, spireCell };
  if (!steward.placed || !stair.placed) log(`  the Steward sites: ${json(steward)} ${json(stair)}`);
  check(steward.placed && stair.placed, `a Steward site over a revision cell (${steward.siteId} at ${json(mound)}), a waterlogged stair over a pond source (${stair.siteId} at ${json(source)}), a player's glowstone on the spire (${json(spireCell)})`);
  const u2 = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  st = await rvState(region);
  const got2 = await cellsOf(BOX);
  const k = (q) => `${q[0]},${q[1]},${q[2]}`;
  const ex = new Map([[k(mound), 'minecraft:mossy_cobblestone'], [k(source), got2.get(k(source))], [k(spireCell), 'minecraft:glowstone']]);
  const d2 = diffExcept(S0, got2, ex);
  const water = [...got2].filter(([q, v]) => /water/.test(v) && !/water/.test(S0.get(q) ?? '')).length;
  out.undoAll = { result: u2, diff: d2, head: st.headRid, water, stairNow: got2.get(k(source)) };
  check(u2.removed === true && st.position === 0 && st.headRid === 0 && d2.n === 0, `item 7 (undo to 0 after 2 revisions, one operation): ${json({ removed: u2.removed, kept: u2.kept, handedDown: u2.handedDown })}; the world before revision 1 over claim + 8 but the three cells not the region's: ${d2.n} cells differ`, d2.first);
  check(/stairs/.test(got2.get(k(source)) ?? '') && /waterlogged=true/.test(got2.get(k(source)) ?? '') && water === 1, `item 19 (holder-aware drain): the Steward's waterlogged stair over the pond source kept its water (${got2.get(k(source))}); every other pond cell drained (${water} water cell(s) left, the stair's)`);
  check(u2.kept >= 1 && Object.keys(u2.handedDown ?? {}).length >= 1, `the player's glowstone kept and reported (kept ${u2.kept}); the Steward sites' cells handed down (${json(u2.handedDown)})`);
  // the Steward's sites removed after: their cells come back to the land before the revisions (the befores handed down)
  for (const sid of [steward.siteId, stair.siteId]) await call('dev.rv.siteRemove', { site: sid, force: true }, 600_000);
  await sleep(1500);
  await cmd(`/setblock ${spireCell[0]} ${spireCell[1]} ${spireCell[2]} ${S0.get(k(spireCell)) ?? 'minecraft:air'}`);
  const d3 = diff(S0, await cellsOf(BOX));
  check(d3.n === 0, `item 7 (a Steward site over a revision cell, the undo, then the site removed): the world before revision 1 over claim + 8: ${d3.n} cells differ`, d3.first);
  // ---- undo, then a new revision: a new rid at the freed position, its files apart, its undo exact
  const p4 = await rvPlan(region, { parts: [MOUND(4)] });
  check(p4.revisionOf?.position === 1 && p4.revisionOf.rid > p3.revisionOf.rid, `a new revision after the undo: rid ${p4.revisionOf?.rid} (never reused) at position ${p4.revisionOf?.position}`);
  await rvRealise(region, p4);
  const u4 = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  const d4 = diff(S0, await cellsOf(BOX));
  check(u4.removed === true && d4.n === 0, `its undo exact: ${d4.n} cells differ`, d4.first);
  // ---- item 14: a lot removed alone reads removed; refilled; the refill undone (the state and the old site id back)
  st = await rvState(region);
  const cot = st.view.lots.find((l) => l.id === 'cottage_1');
  const rm = await call('dev.rv.siteRemove', { site: cot.siteId, force: true, requester: OWNER }, 600_000);
  await sleep(1500);
  st = await rvState(region);
  const removed = st.view.lots.find((l) => l.id === 'cottage_1');
  check(rm.removed && removed.state === 'removed' && removed.siteId === cot.siteId, `item 14: cottage_1's site ${cot.siteId} removed alone: the lot reads ${removed.state} with its old site id`);
  const Sr = await cellsOf(BOX);
  const p5 = await rvPlan(region, { parts: [], refill: ['cottage_1'] });
  const w5 = await rvRealise(region, p5, { lots: { cottage_1: STUB } });
  const refilled = w5.st.view.lots.find((l) => l.id === 'cottage_1');
  check(w5.r.state === 'PLACED' && refilled.state === 'placed' && refilled.siteId !== cot.siteId && refilled.revision === p5.revisionOf.rid && w5.r.lotsRefilled.includes('cottage_1'), `the refill: ${json(refilled)}, revision ${json([w5.r.rid, w5.r.state, w5.r.lotsRefilled])}`);
  const p5b = await rvPlan(region, { parts: [], refill: ['cottage_2'] });
  check(String(p5b.refused ?? '').startsWith('NOT_ALLOWED'), `a refill of a lot that stands refuses: ${p5b.refused}`);
  const u5 = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  st = await rvState(region);
  const back = st.view.lots.find((l) => l.id === 'cottage_1');
  const d5 = diff(Sr, await cellsOf(BOX));
  check(u5.removed && back.state === 'removed' && back.siteId === cot.siteId && back.revision === 0 && d5.n === 0, `the refill undone: the lot ${json(back)} (removed, its old site id); the world as before the refill: ${d5.n} cells differ`, d5.first);
  // ---- item 16: an undo that cannot finish stays UNDOING with its reason; the region busy; a same-target call resumes it
  const p6 = await rvPlan(region, { parts: [MOUND(6)] });
  await rvRealise(region, p6);
  await call('dev.rv.undoFail', { region, on: true }, 10_000);
  const u6 = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  st = await rvState(region);
  const busyPlan = await rvPlan(region, { parts: [MOUND(7)] });
  const other = await call('dev.rv.undo', { region, toPosition: 1 }, 60_000);
  out.waiting = { u6, busy: st.busy, rev: st.revisions.find((r) => r.rid === p6.revisionOf.rid), busyPlan, other };
  check(u6.removed === false && /^undoing /.test(st.busy ?? '') && st.revisions.find((r) => r.rid === p6.revisionOf.rid)?.state === 'UNDOING', `item 16: an undo that stops (TEST) answers removed false (${json(u6.blockers)}) and stays UNDOING; the region busy (${st.busy})`);
  check(String(busyPlan.refused ?? '').startsWith('OVERLAP_BUSY') && String(other.refused ?? '').startsWith('OVERLAP_BUSY'), `while busy: a revision refuses ${busyPlan.refused}; an undo to another target refuses ${other.refused}`);
  const u6b = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  st = await rvState(region);
  check(u6b.removed === true && st.busy === null && st.position === 0, `the same-target call resumes it: removed ${u6b.removed}, busy ${st.busy}, position ${st.position}`);
  // ---- item 8: Regions.remove with three revisions standing (a mound, a pond, a lot): E-flat 0 against the world before the town
  const pa = await rvPlan(region, { parts: [MOUND(8)] });
  await rvRealise(region, pa);
  const pb = await rvPlan(region, { parts: [POND(9)] });
  await rvRealise(region, pb);
  const pc = await rvPlan(region, { parts: [SHED] });
  await rvRealise(region, pc, { lots: { [`rv${pc.revisionOf.rid}_shed`]: STUB } });
  const rem = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await sleep(2000);
  // (cottage_1's building was removed alone and never refilled after: the region's removal takes the rest)
  const after = await hashOf(BOX);
  const dd = after === before ? null : diff(B0, await cellsOf(BOX));
  out.remove = { result: rem, flat: after === before, diff: dd };
  check(rem.removed !== false && after === before, `item 8: Regions.remove with 3 revisions standing (a mound, a pond, a lot): E-flat 0 over claim + 8 (${after === before})${dd ? `: ${dd.n} cells differ ${json(dd.first.slice(0, 8))} (${json(rem)})` : ''}`);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ RV-d in game: plan/0's revision mode through checkPlan and realiseApproved (items 4, 12)

const P0_TOWN = { schemaVersion: 'plan/0', planId: 'rv_town', zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'house', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
const P0_POND = { id: 'pond', kind: 'pond', where: { near: { anchor: 'claim_center', within: 48 } }, size: { w: 7, d: 7 }, depth: 2 };
async function checkPlan(plan, claim) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER }, 900_000);
  if (r.refused) { log(`  check refused: ${r.refused}`); return r; }
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'}`);
  return r.check;
}

steps.plan0 = async () => {
  await ensure();
  const out = {};
  await freshFlat('G6B RV Plan0');
  const gy = await groundY();
  const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8];
  const before = await hashOf(BOX);
  const B0 = await cellsOf(BOX);
  const c0 = await checkPlan(P0_TOWN, CLAIM);
  check(c0.overall === 'READY' && /^[0-9a-f]{64}$/.test(c0.artifactSha ?? ''), `the parent plan checked: ${c0.overall}, artifact ${c0.artifactSha?.slice(0, 12)}`);
  const ra = await call('dev.region.realiseApproved', { sha: c0.artifactSha, lotEntries: { h1: STUB } }, 300_000);
  const region = ra.region;
  const st0 = await L.waitRegion(region, 3_600_000);
  check(st0.view.state === 'PLACED', `realiseApproved: region ${region} ${st0.view.state}`);
  const S0 = await cellsOf(BOX);
  // the revision plan: the town kept (the same canonical JSON), a pond added
  const rev = (body, parent) => ({ ...P0_TOWN, ...body, revision: { n: 1, parentArtifact: parent } });
  const c1 = await checkPlan(rev({ forms: [P0_POND] }, c0.artifactSha), CLAIM);
  const town1 = c1.parts?.find((p) => p.part === 'town'), pond1 = c1.parts?.find((p) => p.part === 'pond');
  const art1 = (await call('dev.region.artifact', { sha: c1.artifactSha, body: true }, 60_000)).artifact;
  out.check1 = { overall: c1.overall, town: town1, pond: pond1, revisionOf: art1?.body?.region?.revisionOf, dirty: art1?.body?.dirty, historySha: art1?.body?.historySha };
  check(c1.overall === 'READY' && town1?.class === 'fits' && pond1 && ['fits', 'adjusted'].includes(pond1.class), `item 4: the revision plan checked: ${c1.overall}; the town ${town1?.class} (standing), the pond ${pond1?.class}`);
  check(art1?.body?.region?.revisionOf?.region === region && art1.body.dirty?.length >= 1 && Object.keys(art1.body.historySha ?? {}).length === art1.body.dirty.length, `the revision artifact: revisionOf ${json(art1?.body?.region?.revisionOf)}, dirty ${json(art1?.body?.dirty)}, historySha per dirty key`);
  const ra1 = await call('dev.region.realiseApproved', { sha: c1.artifactSha }, 300_000);
  check(ra1.region === region, `realiseApproved of the revision artifact answers its region: ${json(ra1)}`);
  const st1 = await rvState(region);
  const rid1 = st1.revisions.at(-1)?.rid;
  const w1 = await rvWait(region, rid1);
  const water = [...(await cellsOf(BOX))].filter(([k, v]) => idOf(v) === 'water' && idOf(S0.get(k) ?? 'air') !== 'water').length;
  check(w1.r.state === 'PLACED' && w1.r.artifact === c1.artifactSha && water > 0 && w1.st.state === 'PLACED', `the revision ${rid1} ${w1.r.state} (its artifact ${w1.r.artifact?.slice(0, 12)}), ${water} water cells; the region PLACED`);
  // a check on the old parent: the head moved (parent_moved)
  const cs = await checkPlan(rev({ forms: [{ ...P0_POND, id: 'pond2' }] }, c0.artifactSha), CLAIM);
  check(String(cs.refused ?? '').startsWith('PLAN_STALE') && /parent_moved/.test(cs.refused), `a revision plan on the old parent: ${cs.refused}`);
  // a changed standing part answers unsupported revision.change (RV2)
  const z2 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z2.program.lots[0].size = [11, 9];
  const cc = await checkPlan({ ...P0_TOWN, zones: [z2], forms: [P0_POND], revision: { n: 2, parentArtifact: c1.artifactSha } }, CLAIM);
  const tc = cc.parts?.find((p) => p.part === 'town');
  check(tc?.class === 'unsupported' && tc.reasons?.[0]?.block === 'revision.change' && cc.parts.find((p) => p.part === 'pond')?.class === 'fits', `item 4: a changed zone answers ${tc?.class} ${tc?.reasons?.[0]?.block}; the kept pond fits (standing)`);
  // undo: the artifact tombstoned; the world as before the revision
  const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  const a1 = (await call('dev.region.artifact', { sha: c1.artifactSha }, 60_000)).artifact;
  const d = diff(S0, await cellsOf(BOX));
  check(u.removed === true && a1?.removed === true && d.n === 0, `the revision undone: the world as before it (${d.n} cells differ); its artifact tombstoned (${a1?.removed})`, d.first);
  const rem = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await sleep(2000);
  const flat = (await hashOf(BOX)) === before;
  const dflat = flat ? null : diff(B0, await cellsOf(BOX));
  check(rem.removed !== false && flat, `the region removed: E-flat 0${dflat ? `: ${dflat.n} cells differ ${json(dflat.first.slice(0, 8))} (${json(rem)})` : ''}`, dflat?.first);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ crash, the undo half (item 10: §4.4 steps 2, 3, K6, mid-R4, after 4)

steps.undoCrash = async () => {
  await ensure();
  const out = {};
  for (const point of ['RVU1', 'RVU2', 'K6', 'GW', 'RVU3']) {
    const world = `G6B RV UndoCrash ${point}`;
    await freshFlat(world);
    const gy = await groundY();
    const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8];
    const T = await town();
    const S0 = await cellsOf(BOX);
    const p1 = await rvPlan(T.region, { parts: [MOUND(1), SPIRE(gy)] });
    await rvRealise(T.region, p1);
    const p2 = await rvPlan(T.region, { parts: [POND(2)] });
    await rvRealise(T.region, p2);
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
    let down = false;
    for (let i = 0; i < 180 && !down; i++) {
      await sleep(2000);
      const st = await call('dev.state', {}, 10_000).catch(() => null);
      down = !!st && st.inWorld === false;
    }
    check(down, `${point}: the kill point halted the server during the undo`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
    const rdir = path.join(L.SAVES, world, 'architect-regions', T.region);
    const rec = JSON.parse(fs.readFileSync(path.join(rdir, 'region.json'), 'utf8')).revisions;
    const ops = fs.existsSync(path.join(rdir, 'rev')) ? fs.readdirSync(path.join(rdir, 'rev')).filter((f) => f.startsWith('op-')) : [];
    const manifest = ops.length ? JSON.parse(fs.readFileSync(path.join(rdir, 'rev', ops[0]), 'utf8')) : null;
    await L.openWorld(world);
    await L.tp(CX + 56, 60, CZ + 56);
    // the undo resumes by itself at the first tick (the driver), from the phase its manifest names
    let st;
    const t0 = Date.now();
    for (; Date.now() - t0 < 1_800_000; ) {
      st = await rvState(T.region);
      if (st.busy === null) break;
      await sleep(L.pollDelayMs(Date.now() - t0));
    }
    const d = diff(S0, await cellsOf(BOX));
    out[point] = { atHalt: { busy: rec?.busy ?? null, phase: manifest?.phase ?? null }, after: { busy: st.busy, position: st.position, states: st.revisions.map((r) => [r.rid, r.state]) }, diff: d };
    check(rec?.busy?.startsWith('undoing ') && manifest && st.busy === null && st.position === 0 && st.revisions.every((r) => r.state === 'UNDONE') && d.n === 0, `${point}: halted with the undo committed (busy ${rec?.busy}, phase ${manifest?.phase}); after the restart it resumed and finished: position ${st.position}, ${json(st.revisions.map((r) => [r.rid, r.state]))}; the world before revision 1: ${d.n} cells differ`, d.first);
    const rem = await call('dev.region.remove', { region: T.region, requester: OWNER }, 4 * 3_600_000);
    check(rem.removed !== false, `${point}: then the region removed (${rem.removed})`);
    await L.leaveWorld();
  }
  spendZero();
  return out;
};

// ------------------------------------------------------------------ crash (item 10, the realise half)

steps.crash = async () => {
  await ensure();
  const out = {};
  let control = null;
  // (the control row `town:RG4+save`: the same kill during the town's own realise, no revision: main's behaviour to compare with)
  for (const point of ['RV1', 'RV2', 'RV3', 'RV4', 'town:RG4+save', 'RG4+save']) {
    const tag = point.replace('+', '_').replace(':', '_');
    const world = `G6B RV Crash ${tag}`;
    await freshFlat(world);
    const gy = await groundY();
    if (point.startsWith('town:')) {
      const BOXc = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8];
      const pre = await cellsOf(BOXc);
      const p = await L.plan('flat_village', CLAIM, { params: { lots: LOTS }, surveyLoad: 'bounded:256', check: false, owner: OWNER });
      await call('dev.journal.killAt', { point: point.slice(5) }, 10_000);
      let region = null;
      L.realise(p.planId, { load: 'bounded:512' }).then((r) => { region = r; }).catch(() => null);
      let down = false;
      for (let i = 0; i < 180 && !down; i++) { await sleep(2000); const s = await call('dev.state', {}, 10_000).catch(() => null); down = !!s && s.inWorld === false; }
      check(down, `${point}: the kill point halted the server`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
      await L.openWorld(world);
      await L.tp(CX + 56, 60, CZ + 56);
      const rid0 = region ?? 'rg1';
      const st = await L.waitRegion(rid0, 3_600_000);
      await call('dev.region.remove', { region: rid0, requester: OWNER }, 4 * 3_600_000);
      await sleep(2000);
      const d = diff(pre, await cellsOf(BOXc));
      out[tag] = { state: st.view.state, diff: d };
      control = d;
      // recorded, not judged: main's behaviour after a kill mid-tile with a save (RP §6: the PLACING leftover)
      check(true, `${point} (control, recorded): the town ${st.view.state}, then removed: ${d.n} cell(s) differ from the world before it ${json(d.first.slice(0, 4))}`);
      await L.leaveWorld();
      continue;
    }
    const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8]; // (a rock spire's footing goes 8 under the ground)
    const before = await hashOf(BOX);
    const preCells = point === 'RG4+save' ? await cellsOf(BOX) : null;
    const T = await town();
    const p = await rvPlan(T.region, { parts: [MOUND(1), SPIRE(gy)] });
    const rid = p.revisionOf.rid;
    await call('dev.journal.killAt', { point }, 10_000);
    L.realise(p.planId).catch(() => null);
    let down = false;
    for (let i = 0; i < 180 && !down; i++) {
      await sleep(2000);
      const s = await call('dev.state', {}, 10_000).catch(() => null);
      down = !!s && s.inWorld === false;
    }
    check(down, `${point}: the kill point halted the server`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
    const rdir = path.join(L.SAVES, world, 'architect-regions', T.region);
    const atHalt = { manifest: fs.existsSync(path.join(rdir, 'rev', String(rid), 'op.json')), effective: fs.existsSync(path.join(rdir, 'effective', `${rid}.json`)), record: JSON.parse(fs.readFileSync(path.join(rdir, 'region.json'), 'utf8')).revisions ?? null };
    await L.openWorld(world);
    await L.tp(CX + 56, 60, CZ + 56);
    await sleep(3000);
    let st = await rvState(T.region);
    const accepted = !!st.revisions.find((r) => r.rid === rid);
    const o = { atHalt, acceptedAfterRestart: accepted, headAfterRestart: st.headRid };
    if (point === 'RV1' || point === 'RV2') {
      check(!accepted && st.headRid === 0 && st.busy === null && atHalt.manifest && (point === 'RV1' || atHalt.effective), `${point}: halted with the manifest${point === 'RV2' ? ' and the effective snapshot' : ''} on disk and region.json not renamed: after the restart nothing accepted (head ${st.headRid}), the snapshot an orphan never read (effective head ${st.effectiveHead})`);
      await L.realise(p.planId);
    } else {
      check(accepted && st.headRid === rid, `${point}: accepted before the halt (region.json renamed): after the restart the head is ${st.headRid}`);
    }
    const w = await rvWait(T.region, rid);
    st = w.st;
    const items = st.items[String(rid)] ?? {};
    const batches = new Set(st.revisions.map((r) => r.batchId).filter(Boolean));
    o.revision = w.r;
    o.items = items;
    check(w.r.state === 'PLACED' && Object.values(items).every((s) => s.startsWith('PLACED')) && batches.size === 1, `${point}: the revision ${w.r.state}, its items ${json(Object.values(items).map((s) => s.split('@')[0]))} (each key once), one batch`);
    const rem = await call('dev.region.remove', { region: T.region, requester: OWNER }, 4 * 3_600_000);
    await sleep(2000);
    const after = await hashOf(BOX);
    o.flat = after === before;
    if (preCells && after !== before) o.diff = diff(preCells, await cellsOf(BOX));
    o.journal = after === before ? null : await call('dev.rv.state', { region: T.region }, 60_000).catch(() => null);
    // (RG4+save: main's behaviour leaves the halted tile's first written cell after a removal (the control row, a plain realise, shows the
    // same: RP §6's PLACING leftover, which the group removal does not undo); judged against the control, recorded for the coordinator)
    const asMain = point === 'RG4+save' && o.diff && control && o.diff.n === control.n && control.n <= 1;
    check(rem.removed !== false && (after === before || asMain), `${point}: Regions.remove E-flat 0 over the claim + 8 (${after === before})${o.diff ? `: ${o.diff.n} cells differ ${json(o.diff.first.slice(0, 6))}${asMain ? ` - as the control's ${control.n} (main's behaviour after a kill mid-tile with a save, not the revision's)` : ''}` : ''}`);
    out[tag] = o;
    await L.leaveWorld();
  }
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|ingame|crash|undo|plan0|undoCrash)\.json$/.test(f));
  const lines = ['# Gate slice 6d RV (RV-a, RV-b)', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6drv.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
