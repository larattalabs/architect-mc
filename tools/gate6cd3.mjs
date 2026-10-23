#!/usr/bin/env node
// Phase 6c slice D3 gate (docs/CONTRACT.md "Phase 6c slice D3: districts beside a standing region town" §14) against the headless server
// (or a dev client) of the D3 run worktree (`../architect-mc-D3-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no
// Claude). Ports 8916 (sidecar) / 8917 (DevBridge) by default. $0: no Claude call anywhere; spend.json $0.00.
//
//   node tools/gate6cd3.mjs <step>
//     start [world] | stop | base      the client (or server) and the base worlds
//     unit                              items 1, 2 and 17's kit half: the kit's D3 tests (geometry, candidates, the choice, held and body
//                                       columns, 300 seeded synthetic towns, M28:beside and the broken variants, the land, plan/0's reach,
//                                       §9, the pinned seam joins), the parity fixture, D1/D2's tests and the goldens that must not move,
//                                       the plan fixtures and Steward's asks (P0), the Java parity tests (DistrictLandTest, ApiRulesTest),
//                                       the sidecar's tests; item 18's api-compat
//     ingame                            items 3, 7, 8, 9, 10, 12 (its plan-time cases), 14 on d3_town (a pad-filled 8-lot flat_village,
//                                       partly built, with a Steward-style addition and a PT build): the reach at a street end, removal in
//                                       both orders, the journal stacks over the reach, the town removed mid-realise
//     side                              item 4 on d3_gap_town: a T into a lot gap; the verge and road unchanged (hash)
//     refusals                          items 11 and 12: apart, walled (NO_JOIN [wall]), a busy town (OVERLAP_BUSY), a site on the join's
//                                       path (OVERLAP), a C17 area over the reach (PROTECTED), each with 0 changed cells; checkBeside's
//                                       verdict equals the plan's; nothing kept by the dry check
//     steward                           item 6: checkBeside with a placeholder lot, Regions.plan under an opKey, Regions.realise under an
//                                       opKey, realiseByKey after a restart, the land; a partial town (one lot failed) taken as a beside town;
//                                       plan/0's endpoint.region reach through checkPlan then realiseApproved, a stale retry across a restart
//     along                             item 5: a shore district and an outpost (gap 40), each joined through the town's claim
//     kc                                item 13: a second district beside the same town keeps off the first's join
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-d3/<step>.json in the main checkout (GATE6CD3_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

import { srcGradle } from './lib/src-gradle.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-D3-run');
process.env.GATE6B_OUT = process.env.GATE6CD3_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-d3');
process.env.GATE6B_SIDECAR_PORT ??= '8916';
process.env.GATE6B_DEV_PORT ??= '8917';
const L = await import('./lib/run6b.mjs');
const { OUT, bar, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp, sleep } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:d3';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o) ?? 'undefined').replaceAll(' ', '');
const STUB = 'g6a_stub_9';
/** d3_town's lots: a hall and seven cottages (on a 160 claim its street ends lie 27 and 36 columns inside). */
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, ...Array.from({ length: 7 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [9, 9] }))];
const TOWN_SIZE = 160;
const ONE = (id, extra = {}) => ({ spec: { districts: [{ id, size: [48, 48], lots: 4, ...extra }] } });

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
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice D3 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B D3 Lobby', { backend: 'sim' });
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

// ------------------------------------------------------------------ offline: unit, api-compat

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), comments: t.split('\n').filter((l) => /^# /.test(l)).slice(0, 40) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.d3 = nodeTest(['kit/test/districts-d3.test.mjs', 'kit/test/districts-d3-parity.test.mjs']);
  check(out.d3.code === 0 && out.d3.fail === 0 && out.d3.pass >= 14, `items 1, 2, 17 (kit): §3's geometry row by row, the candidates and the choice (thinning, the prune, the 48 cap), held and body columns hard, 300 seeded synthetic towns, M28:beside and M25:clear's foreign bodies with the four broken variants caught, the land, plan/0's endpoint.region reach, §9, the pinned seam joins, the IR sha over 3 plans, the parity fixture: ${out.d3.pass} pass, ${out.d3.fail} fail`, out.d3.failing);
  out.d = kitOnce(['kit/test/districts-d.test.mjs', 'kit/test/districts-d2.test.mjs']);
  check(out.d.code === 0 && out.d.fail === 0, `item 2 / 18: D1's and D2's kit tests unchanged (districts_demo's IR sha and golden, the beside fixture, the outpost and boundary districts): ${out.d.pass} pass, ${out.d.fail} fail`, out.d.failing);
  out.p0 = kitOnce(['kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-det-1.test.mjs', 'kit/test/plan-p0-det-2.test.mjs', 'kit/test/plan-p0-det-3.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/plan-ops.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `item 2: the plan fixtures (valid/v17-v23 among them) and Steward's 59 asks answer as before: ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/village.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 2: the tile goldens (S1, S2, S7, mega_bench) and every committed scenario golden unchanged; the realise lint: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  const g = srcGradle(root, () => spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*DistrictLandTest', '--tests', '*ApiRulesTest', '--tests', '*ApiDTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, timeout: 1_800_000 }));
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAILED|tests completed|error/.test(l)).slice(0, 10) };
  check(g.status === 0, `item 1: DistrictLand.java equals land.mjs and BesideReach.standing equals besideStanding on every parity fixture; the features (besideReach, besideCheck, districtLand): gradle exit ${g.status}`, out.java.tail);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/regions-village.test.ts', 'test/plan-check.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  out.sidecar = { code: sc.status, summary: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§2.4, §7 (sidecar): region.plan besideReach and dry: ${out.sidecar.summary}`);
  spendZero();
  return out;
};

steps.apicompat = async () => {
  srcGradle(root, () => execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' }));
  // the three previous tags' apitest jars and the last tag's mod surface (archived by earlier gates in the main checkout's artifacts)
  const arts = path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts');
  const env = { ...process.env, JAVA_HOME };
  const out = {};
  let ok = true;
  // (0.42.0's: built from the tag by the D3 builder, artifacts/gate6c-d3/v0420/SOURCE.txt)
  for (const [dir, ver] of [['gate6c-d3/v0420', '0.42.0'], ['gate6c-coa/v0410', '0.41.0'], ['gate6c-batch/v0401', '0.40.1'], ['gate6c-fl/v0400', '0.40.0']]) {
    const jar = path.join(arts, dir, `architect_apitest-${ver}.jar`);
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), jar], { cwd: root, encoding: 'utf8', env, timeout: 900_000 });
    out[ver] = `${r.stdout}${r.stderr}`.trim().split('\n').pop();
    ok &&= r.status === 0 && fs.existsSync(jar);
  }
  const sj = path.join(arts, 'gate6c-d3', 'v0420', 'architect_mc-0.42.0.jar');
  const sr = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--surface', sj], { cwd: root, encoding: 'utf8', env, timeout: 900_000 });
  out.surface = `${sr.stdout}${sr.stderr}`.trim().split('\n').pop();
  ok &&= sr.status === 0 && fs.existsSync(sj);
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), JSON.stringify(out, null, 2));
  check(ok, `item 18: api-compat clean against the archived 0.42.0, 0.41.0, 0.40.1 and 0.40.0 apitest jars and 0.42.0's surface (Regions.checkBeside a default that throws; BesideVerdict, BesideJoin new): ${json(out)}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in-game helpers

const planReq = (o) => call('dev.region.plan', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
const checkBeside = (o) => call('dev.region.checkBeside', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
const planFiles = (planId) => {
  const d = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  return { ir: JSON.parse(fs.readFileSync(path.join(d, 'ir.json'), 'utf8')), meta: JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')), report: fs.existsSync(path.join(d, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'report.json'), 'utf8')) : null };
};
async function undo(region) {
  const r = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return r;
    if (s === 'PARTIAL' || s === 'FAILED') throw new Error(`undo of ${region} ended ${s}: ${json(r)}`);
    await sleep(250);
  }
  throw new Error(`undo of ${region} did not finish`);
}
const hash = async (box) => (await call('dev.region.hash', { box }, 3_600_000)).sha256;
const view = async (region) => (await call('dev.region.state', { region }, 60_000)).view;
const kill = () => cmd('/kill @e[type=!minecraft:player]');
async function dump(box, name) {
  const f = path.join(OUT, `${name}.arwd.gz`);
  await call('dev.region.dump', { box, file: f, light: false }, 1_800_000);
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  return decodeArwd(fs.readFileSync(f));
}
/** The cells two dumps differ in over rect columns, optionally skipping columns (a Set of "x,z"). */
function diffCols(a, b, rects, skip = null) {
  const bx = a.box;
  let n = 0;
  const sample = [];
  for (const [x0, z0, x1, z1] of rects) for (let x = Math.max(x0, bx.minX); x <= Math.min(x1, bx.maxX); x++) for (let z = Math.max(z0, bx.minZ); z <= Math.min(z1, bx.maxZ); z++) {
    if (skip && skip.has(`${x},${z}`)) continue;
    for (let y = bx.minY; y <= bx.maxY; y++) if (a.palette[a.cells[a.at(x, y, z)]] !== b.palette[b.cells[b.at(x, y, z)]]) { n++; if (sample.length < 10) sample.push([x, y, z]); }
  }
  return { cells: n, sample };
}
/** Ground y at a column (a 3x3 survey). */
async function groundAt(x, z) {
  const sf = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: sf }, 300_000);
  return (await imp('lib/region/pack.mjs')).decodeColumns(fs.readFileSync(sf)).ground[4];
}
/** The standing town's street network (kit): its ends and runs. */
async function streetsOf(id, claim, ir) {
  const { besideStanding } = await imp('lib/region/beside.mjs');
  const { streetNetwork } = await imp('lib/region/reach.mjs');
  return streetNetwork(besideStanding(id, claim, ir), ir.graph);
}
const runKeysOf = async (runs) => (await imp('lib/region/beside.mjs')).runKeys(runs);
const rectsOfRuns = (runs) => runs.map((q) => [q[0], q[1], q[2], q[3]]);

/**
 * d3_town (§14): a flat_village with 8 street lots on a 160 claim at (X, Z), its street ends 27 and 36 columns inside. Before it is planned
 * for good, a 4-deep dip is dug under its east street end's contact columns (the first plan finds the end), so the end lot's pad fills
 * them. Realised partly built: the 4 cottages with stubs, the hall and 3 cottages empty pads; W's lanterns (the street's); the apron lamps
 * off (none stands on the contact columns). A Steward-style addition (a cell site with Steward's ext) on the west street's lot-free side
 * and a PT player build (a cabin) in the claim. Returns {A, planId, region, ir, east, world0} (world0: the dump of A + 120 before the town).
 */
/**
 * A town claim's chunks generated before its realise: prepare covers claim + 2 chunks, and an edge tile's window off the 64-grid
 * reaches a third (it waits NOT_GENERATED otherwise, main's behaviour), so a throwaway plan over the claim grown by 16 is prepared.
 */
async function generateFor(A, params) {
  const g = await planReq({ program: 'flat_village', params, claim: [A[0] - 16, A[1] - 16, A[2] + 16, A[3] + 16], check: false });
  if (g.refused) { L.log?.(`  (the generating plan over ${json(A)} refused: ${String(g.refused).slice(0, 100)}; its chunks left to the realise)`); return; }
  await L.prepare(g.planId);
}

async function d3Town(X, Z, { addition = true, cabin = true, dip = true, partial = false } = {}) {
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const params = { lots: TOWN_LOTS, apronLamps: false };
  await generateFor(A, params);
  const g = await groundAt(X + 80, Z + 80);
  let east = null;
  if (dip) {
    const p0 = await planReq({ program: 'flat_village', params, claim: A, check: false });
    if (p0.refused) throw new Error(`d3_town's first plan: ${p0.refused}`);
    const net = await streetsOf('t', A, planFiles(p0.planId).ir);
    east = net.ends.find((e) => e.dir[0] === 1) ?? net.ends[0];
    const [ex, ez] = east.end;
    await cmd(`/fill ${ex} ${g - 3} ${ez - 1} ${ex + 3} ${g} ${ez + 1} minecraft:air`);
  }
  const all = [A[0] - 120, -64, A[1] - 120, A[2] + 120, 160, A[3] + 120];
  const world0 = await dump(all, `world0-${X}`);
  const pa = await planReq({ program: 'flat_village', params, claim: A, check: false });
  if (pa.refused) throw new Error(`d3_town's plan: ${pa.refused}`);
  const ir = planFiles(pa.planId).ir;
  const net = await streetsOf('t', A, ir);
  const east2 = net.ends.find((e) => e.dir[0] === 1) ?? net.ends[0];
  const cottages = ir.lots.filter((l) => l.id.startsWith('cottage_')).slice(0, 4).map((l) => l.id);
  const lots = Object.fromEntries(cottages.map((id) => [id, STUB]));
  if (partial) lots[ir.lots.find((l) => !cottages.includes(l.id) && l.id.startsWith('cottage_'))?.id ?? 'hall_1'] = 'd3_no_such_design';
  await kill();
  const region = await L.realise(pa.planId, { lots });
  const st = await L.waitRegion(region, 3_600_000);
  let additionSite = null, cabinBox = null, additionCells = [];
  if (addition) {
    // on the west street's lot-free side, 5 off its centre line (outside the verge): a 3-cell fence run
    const w = net.runs.find((r) => r.axis === 'x') ?? net.runs[0];
    const lotSide = ir.lots.some((l) => l.box.minZ > w.c) ? -1 : 1;
    const zz = w.c + lotSide * 6, xx = w.u0 + 8;
    additionCells = [[xx, g + 1, zz, 'minecraft:oak_fence'], [xx + 1, g + 1, zz, 'minecraft:oak_fence'], [xx + 2, g + 1, zz, 'minecraft:oak_fence']];
    const r = await call('dev.cells.place', { kind: 'steward:addition', cells: additionCells, naturalOnly: false, owner: OWNER }, 600_000);
    additionSite = r.siteId ?? null;
  }
  if (cabin) {
    const cx = A[0] + 6, cz = A[3] - 16;
    const { cabinOps } = await cabinTools();
    await call('dev.pt.uses', { ops: cabinOps(cx, g + 1, cz) }, 900_000);
    await L.settle(6000);
    cabinBox = [cx, g + 1, cz, cx + 8, g + 7, cz + 8];
  }
  // the columns other owners' sites hold (the addition, the cabin): theirs, not the town's or the district's
  const otherCols = new Set();
  if (additionSite) for (const c of additionCells) otherCols.add(`${c[0]},${c[2]}`);
  if (cabinBox) for (let x = cabinBox[0]; x <= cabinBox[3]; x++) for (let z = cabinBox[2]; z <= cabinBox[5]; z++) otherCols.add(`${x},${z}`);
  return { A, planId: pa.planId, region, ir, east: east2, eastFirst: east, state: st.view.state, world0, all, g, additionSite, cabinBox, net, otherCols };
}
async function cabinTools() {
  return {
    cabinOps: (X, Y, Z, placer = 'D3Alex') => {
      const ops = [];
      for (let y = Y; y < Y + 6; y++) for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) {
        if (!(x === X || x === X + 8 || z === Z || z === Z + 8)) continue;
        if (x === X + 4 && z === Z && (y === Y || y === Y + 1)) continue;
        ops.push({ item: 'minecraft:oak_log', at: [x, y, z], placer });
      }
      for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) ops.push({ item: 'minecraft:oak_log', at: [x, Y + 6, z], placer });
      ops.push({ item: 'minecraft:oak_door', at: [X + 4, Y, Z], placer, yaw: 0 });
      return ops;
    },
  };
}
/** A district plan beside a town (its checkBeside verdict first, item 12's parity) -> {plan, files, verdict, parity}. */
async function besidePlan(town, claim, params, { opKey } = {}) {
  const verdict = await checkBeside({ program: 'districts', params, claim, beside: town, check: true });
  const plan = await planReq({ program: 'districts', params, claim, beside: town, check: true, ...(opKey ? { opKey } : {}) });
  const files = plan.refused ? null : planFiles(plan.planId);
  const j = files?.meta?.districts?.join ?? null;
  const parity = plan.refused ? !verdict.fits && String(plan.refused).includes(String(verdict.message).split(' (the request')[0].slice(0, 60))
    : verdict.fits && verdict.join && verdict.join.kind === (j?.junction?.kind ?? 'end') && verdict.join.step === (j?.step ?? 'seam') && json(verdict.join.at) === json(j?.junction?.at ?? j?.at);
  return { plan, files, verdict, parity };
}
/** The district's journal columns: every active cell over runs, with its stack. */
const stacksOver = async (runs) => (await call('dev.journal.columns', { runs }, 600_000)).cells ?? [];

// ------------------------------------------------------------------ items 3, 7, 8, 9, 10, 12, 14 on d3_town

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Ingame', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  await call('dev.pt.rule', { name: 'graceMs', value: '600000' }).catch(() => null);
  const X = 20000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z);
  out.town = { region: T.region, state: T.state, east: T.east, eastFirst: T.eastFirst, addition: T.additionSite, cabin: T.cabinBox };
  check(T.state === 'PLACED', `d3_town ${T.region} PLACED: 8 street lots, 4 with stubs, its street ends ${json(T.net.ends.map((e) => e.end))} (27 and 36 inside the claim)`);
  check(json(T.east.end) === json(T.eastFirst?.end), `d3_town: the dip under the east end kept the layout (its end ${json(T.east.end)})`);
  // ---- item 3: a plain district east of the town, beside it (touching its claim): the reach at the street end
  const A = T.A;
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const before = await dump([A[0] - 8, -64, A[1] - 8, B[2] + 8, 160, A[3] + 8], 'before-district');
  const p = await besidePlan(T.region, B, ONE('east'));
  if (p.plan.refused) throw new Error(`the district's plan was refused: ${p.plan.refused}`);
  const d = p.files.meta.districts, ir = p.files.ir;
  out.plan = { planId: p.plan.planId, join: d.join, reach: ir.reach ? { cells: ir.reach.cells, rect: ir.reach.rect, hold: ir.reach.hold } : null, verdict: p.verdict };
  check(d.join?.step === 'reach' && d.join?.junction?.kind === 'end' && d.join?.node === T.east.node, `item 3: Regions.plan beside ${T.region}: the join reaches into its claim at the street end ${d.join?.node} (${json(d.join?.junction?.at)}; ${ir.reach?.cells} reach cells)`);
  const jp = p.files.meta.route.edges.find((e) => e.id === 'join').path;
  const tail = jp.slice(-4).map((q) => [q[0], q[2]]);
  const [ex, ez] = T.east.end, [dx, dz] = T.east.dir;
  check(json(tail) === json([3, 2, 1, 0].map((t) => [ex + dx * t, ez + dz * t])), `item 3: the join continues the street's line for 3 cells into its end (${json(tail)})`);
  check((ir.reach?.hold ?? []).length > 0, `§3.4: the end lot's pad fill holds contact columns: ${json(ir.reach?.hold)} held (the hold op)`);
  check(p.parity, `item 12: checkBeside's verdict equals Regions.plan's (fits, the end, the reach step, the junction): ${json(p.verdict.join)}`);
  const je = p.files.report?.metrics?.route?.edges?.find((e) => e.id === 'join');
  check(je && je.player && je.villager, `item 3 (kit): the join walkable by the player and villager movers (${json(je ? { player: je.player, villager: je.villager } : null)})`);
  const m28 = p.files.report?.findings?.filter((f) => f.rule === 'M28:beside') ?? [];
  check(m28.length === 0, `§5.3: M28:beside clean on the plan (${m28.length} findings)`);
  const m5r = p.files.report?.metrics?.M28?.M5reach ?? null;
  check(m5r && m5r.walkCells > 0 && m5r.darkSpawnable === 0 && (ir.reach.lamps ?? []).length >= 0, `ruling B: the join lit inside the town: M5 over its in-town walk cells ${json(m5r)} (${(ir.reach.lamps ?? []).length} lamp column(s) on the reach)`);
  await kill();
  const rb = await L.realise(p.plan.planId, { lots: {} });
  const sb = await L.waitRegion(rb, 3_600_000);
  const vb = sb.view;
  out.district = { region: rb, state: vb.state, cells: vb.cellsWritten, land: vb.ext?.['architect_mc:land'] ? { outside: vb.ext['architect_mc:land'].outside.cells, inside: vb.ext['architect_mc:land'].inside.cells } : null };
  check(vb.state === 'PLACED' && vb.beside === T.region, `item 3: Regions.realise: the district ${rb} PLACED (${vb.cellsWritten} cells) beside ${vb.beside}`);
  // villager paths: every district lot's entrance to the town's bell and back
  await tp(Math.floor((A[0] + B[2]) / 2), 0, Math.floor((A[1] + A[3]) / 2));
  await kill();
  const bell = T.ir.anchors.bell ?? T.ir.anchors.entrance;
  out.nav = {};
  for (const l of ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 320 }, 120_000);
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 320 }, 120_000);
    out.nav[l.id] = [!!there.canReach, !!back.canReach];
  }
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v[0] && v[1]), `item 3: dev.nav.villager from every district lot to the town's bell and back (${json(out.nav)})`);
  // ---- item 9: ownership over the reach
  const vt = await view(T.region);
  const reachRuns = ir.reach.runs, holdKeys = await runKeysOf(ir.reach.hold), contactKeys = await runKeysOf(ir.reach.contact);
  const cells = await stacksOver(reachRuns);
  let outsideDepth1 = 0, outsideBad = [], contactOk = 0, contactBad = [];
  for (const c of cells) {
    const k = `${c.x},${c.z}`, top = c.stack[c.stack.length - 1];
    const groups = c.stack.map((e) => e.group);
    if (!contactKeys.has(k)) { if (c.stack.length === 1 && groups[0] === vb.groupId) outsideDepth1++; else if (outsideBad.length < 10) outsideBad.push({ ...c, stack: groups }); continue; }
    if (!groups.includes(vt.groupId) || top.group === vb.groupId) contactOk++; else if (contactBad.length < 10) contactBad.push({ ...c, stack: groups });
  }
  out.ownership = { cells: cells.length, outsideDepth1, outsideBad, contactOk, contactBad, holdColumns: holdKeys.size };
  check(outsideBad.length === 0 && outsideDepth1 > 0, `item 9: journal stack depth 1 (the district's) on every reach cell outside the contact columns (${outsideDepth1} cells; ${outsideBad.length} not)`);
  check(contactBad.length === 0 && cells.some((c) => holdKeys.has(`${c.x},${c.z}`) && c.stack.length >= 2), `item 9: in each contact column every town cell has the district's cell over it (${contactOk} cells; ${contactBad.length} not)`);
  // ---- item 14: the land
  const land = vb.ext?.['architect_mc:land'];
  const union = await runKeysOf(land?.union?.runs ?? []);
  const claimCols = [];
  for (let z = B[1] - 4; z <= B[3] + 4; z++) claimCols.push([B[0] - 4, z, B[2] + 4, z]);
  const own = (await stacksOver([...claimCols, ...reachRuns])).filter((c) => c.stack.some((e) => e.group === vb.groupId));
  const outsideUnion = own.filter((c) => !union.has(`${c.x},${c.z}`));
  const inTown = (k) => { const [x, z] = k.split(',').map(Number); return x >= A[0] && x <= A[2] && z >= A[1] && z <= A[3]; };
  const outsideKeys = await runKeysOf(land?.outside?.runs ?? []), insideKeys = await runKeysOf(land?.inside?.runs ?? []);
  const reachKeys = await runKeysOf(reachRuns);
  out.land = { v: land?.v, outside: land?.outside?.cells, inside: land?.inside?.cells, ownCols: new Set(own.map((c) => `${c.x},${c.z}`)).size, outsideUnion: outsideUnion.slice(0, 5) };
  check(land?.v === 1 && outsideUnion.length === 0, `item 14: every column the district holds in the journal lies in architect_mc:land's union (${out.land.ownCols} columns; ${outsideUnion.length} outside)`);
  check([...outsideKeys].every((k) => !inTown(k)) && [...reachKeys].every((k) => insideKeys.has(k)), `item 14: land.outside misses the town's claim; land.inside holds the reach (${insideKeys.size} inside, ${reachKeys.size} reach)`);
  // ---- item 7: the district removed first
  await kill();
  await undo(rb);
  await L.settle(3000);
  const after7 = await dump([A[0] - 8, -64, A[1] - 8, B[2] + 8, 160, A[3] + 8], 'after-district-removed');
  out.item7 = { town: diffCols(before, after7, [A]), district: diffCols(before, after7, [[B[0] - 8, B[1] - 8, B[2] + 8, B[3] + 8], ...rectsOfRuns(reachRuns)]) };
  check(out.item7.town.cells === 0, `item 7 (verifier re-runs): the district removed first: 0 changed cells over the town's claim (ARWD diff; the join's columns equal the world before the district) (${out.item7.town.cells}; ${json(out.item7.town.sample)})`);
  check(out.item7.district.cells === 0, `item 7: E-flat 0 over the district's claim (+8) and its reach (${out.item7.district.cells}; ${json(out.item7.district.sample)})`);
  // ---- item 8: the town removed first, on the pad-filled town
  await kill();
  const p2 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  if (p2.refused) throw new Error(`the district's second plan was refused: ${p2.refused}`);
  const ir2 = planFiles(p2.planId).ir;
  const rb2 = await L.realise(p2.planId, { lots: {} });
  const sb2 = await L.waitRegion(rb2, 3_600_000);
  check(sb2.view.state === 'PLACED', `item 8: the district ${rb2} PLACED again beside ${T.region}`);
  const world2 = await dump(T.all, 'world2');
  const holdCols = await runKeysOf(ir2.reach.hold);
  const own2 = (await stacksOver([...claimCols, ...ir2.reach.runs])).filter((c) => c.stack.some((e) => e.group === sb2.view.groupId));
  const districtCols = new Set(own2.map((c) => `${c.x},${c.z}`));
  await kill();
  await undo(T.region);
  await L.settle(3000);
  const world3 = await dump(T.all, 'world3');
  const heldRects = [...districtCols].map((k) => { const [x, z] = k.split(',').map(Number); return [x, z, x, z]; });
  // (the Steward addition's and the PT cabin's columns are their owners', placed after world0: left out of the E-flat over the town)
  const others = new Set(districtCols);
  for (const k of T.otherCols) others.add(k);
  out.item8 = {
    townMinusHeld: diffCols(T.world0, world3, [A], others),
    heldEqualAfterDistrict: diffCols(world2, world3, heldRects),
    contactFill: diffCols(world2, world3, [...holdCols].map((k) => { const [x, z] = k.split(',').map(Number); return [x, z, x, z]; })),
  };
  const v8 = await view(rb2);
  out.item8.ext = { beside: v8.ext?.['architect_mc:beside'], standingRemoved: v8.ext?.['architect_mc:land']?.standingRemoved ?? null };
  check(out.item8.townMinusHeld.cells === 0, `item 8 (verifier re-runs): the town removed first: E-flat 0 over its claim minus every column the district holds, against the world before the town (${out.item8.townMinusHeld.cells}; ${json(out.item8.townMinusHeld.sample)})`);
  check(out.item8.heldEqualAfterDistrict.cells === 0 && out.item8.contactFill.cells === 0 && holdCols.size > 0, `item 8: the district's columns unchanged, the contact columns' fill still standing (${out.item8.heldEqualAfterDistrict.cells}, ${out.item8.contactFill.cells}; ${holdCols.size} hold columns)`);
  check(out.item8.ext.beside?.dangling === true && Number.isInteger(out.item8.ext.standingRemoved), `item 8: dangling and land.standingRemoved set (${json(out.item8.ext)})`);
  const jat = ir2.reach && planFiles(p2.planId).meta.districts.join.junction.at;
  const lot0 = ir2.lots.find((l) => l.ext?.['architect_mc:village']?.entrance);
  if (jat && lot0) {
    const nv = await call('dev.nav.villager', { from: lot0.ext['architect_mc:village'].entrance, to: jat, range: 320 }, 120_000);
    out.item8.walk = !!nv.canReach;
    check(out.item8.walk, `item 8: the join walkable from a district lot to its junction cell ${json(jat)} after the town's removal`);
  }
  await kill();
  await undo(rb2);
  await L.settle(3000);
  const world4 = await dump(T.all, 'world4');
  out.item8.final = diffCols(T.world0, world4, [[T.all[0], T.all[2], T.all[3], T.all[5]]], T.otherCols);
  check(out.item8.final.cells === 0, `item 8: then the district: E-flat 0 over both claims and the reach (the world before the town; the Steward addition and the PT cabin are their owners') (${out.item8.final.cells}; ${json(out.item8.final.sample)})`);
  // ---- item 10: the town removed while the district is PLACING its routes; a save, leave and reopen; then the district
  await kill();
  const pa3 = await planReq({ program: 'flat_village', params: { lots: TOWN_LOTS, apronLamps: false }, claim: A, check: false });
  const rt3 = await L.realise(pa3.planId, { lots: {} });
  await L.waitRegion(rt3, 3_600_000);
  const p3 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: rt3, check: false });
  if (p3.refused) throw new Error(`item 10's district plan refused: ${p3.refused}`);
  await call('dev.placement.slow', { on: true });
  const rb3 = await L.realise(p3.planId, { lots: {} });
  let removed = false;
  for (let i = 0; i < 2400 && !removed; i++) {
    const v = await view(rb3);
    const routes = v.stages.find((s) => s.name === 'routes');
    if (v.state === 'PLACING' && routes && routes.tilesDone >= 0 && v.stages.slice(0, v.stages.indexOf(routes)).every((s) => s.tilesDone === s.tilesTotal)) {
      await call('dev.region.remove', { region: rt3, requester: OWNER }, 3_600_000);
      removed = true;
    } else if (v.state !== 'PLACING') break;
    else await sleep(250);
  }
  await call('dev.placement.slow', { on: false });
  const s3 = await L.waitRegion(rb3, 3_600_000);
  for (let i = 0; i < 2400; i++) { const v = await call('dev.region.state', { region: rt3 }, 60_000).catch(() => null); if (!v?.view || v.view.state === 'REMOVED') break; await sleep(250); }
  out.item10 = { removedWhilePlacing: removed, district: s3.view.state };
  check(removed && s3.view.state === 'PLACED', `item 10 (verifier re-runs): the town removed while the district was PLACING its routes; both finished (${json(out.item10)})`);
  const v10 = await view(rb3);
  check(v10.ext?.['architect_mc:beside']?.dangling === true, 'item 10: the district\'s join dangling once the town\'s removal finished');
  await leaveWorld();
  await L.openWorld('G6B D3 Ingame');
  await kill();
  await undo(rb3);
  await L.settle(3000);
  const world5 = await dump(T.all, 'world5');
  out.item10.final = diffCols(T.world0, world5, [[T.all[0], T.all[2], T.all[3], T.all[5]]], T.otherCols);
  check(out.item10.final.cells === 0, `item 10: after a save, leave and reopen, the district removed: E-flat 0 over both claims (${out.item10.final.cells}; ${json(out.item10.final.sample)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 4 on d3_gap_town

steps.side = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Side', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 24000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  // d3_gap_town: a C17 area beside the street's north side while the town plans (a lot gap of 7 or more there), removed after it realises
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const p0 = await planReq({ program: 'flat_village', params: { lots: TOWN_LOTS, apronLamps: false }, claim: A, check: false });
  const net0 = await streetsOf('t', A, planFiles(p0.planId).ir);
  const run = net0.runs.find((r) => r.axis === 'x') ?? net0.runs[0];
  const api = async (a) => { const x = await cmd(`/apitest ${a}`); return (x.messages ?? []).find((mm) => mm.startsWith('{')) ?? null; };
  const mid = Math.floor((run.u0 + run.u1) / 2);
  await api(`protect ${json({ owner: OWNER, id: 'd3gap', x0: mid - 5, z0: run.c - 16, x1: mid + 5, z1: run.c - 3, label: 'D3_gap' })}`);
  const pa = await planReq({ program: 'flat_village', params: { lots: TOWN_LOTS, apronLamps: false }, claim: A, check: false });
  if (pa.refused) throw new Error(`d3_gap_town's plan: ${pa.refused}`);
  const ir = planFiles(pa.planId).ir;
  const rt = await L.realise(pa.planId, { lots: {} });
  const st = await L.waitRegion(rt, 3_600_000);
  await api('unprotect test:d3 d3gap').catch(() => null);
  check(st.view.state === 'PLACED', `d3_gap_town ${rt} PLACED, the area removed after`);
  const net = await streetsOf('t', A, ir);
  // the district north of the town (touching its claim)
  const B = [A[0] + 10, A[1] - 90, A[2] - 10, A[1] - 1];
  const street = net.runs.find((r) => r.axis === 'x') ?? net.runs[0];
  const verge = [street.u0, street.c - street.hw, street.u1, street.c + street.hw];
  const hv = await hash([verge[0], -64, verge[1], verge[2], 160, verge[3]]);
  const p = await besidePlan(rt, B, ONE('north'));
  if (p.plan.refused) throw new Error(`item 4's plan refused: ${p.plan.refused}`);
  const d = p.files.meta.districts;
  out.join = d.join;
  check(d.join?.step === 'reach' && d.join?.junction?.kind === 'side', `item 4: the join is a T at the street's side (${json(d.join?.junction)})`);
  check(p.parity, `item 12: checkBeside's verdict equals the plan's (a side T): ${json(p.verdict.join)}`);
  const rb = await L.realise(p.plan.planId, { lots: {} });
  const sb = await L.waitRegion(rb, 3_600_000);
  check(sb.view.state === 'PLACED', `item 4: the district ${rb} PLACED`);
  check(await hash([verge[0], -64, verge[1], verge[2], 160, verge[3]]) === hv, 'item 4: the verge and road cells unchanged (hash over the street and its verges)');
  await tp(Math.floor((B[0] + B[2]) / 2), 0, A[1]);
  await kill();
  const bell = ir.anchors.bell ?? ir.anchors.entrance;
  out.nav = {};
  for (const l of p.files.ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 320 }, 120_000);
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 320 }, 120_000);
    out.nav[l.id] = [!!there.canReach, !!back.canReach];
  }
  check(Object.values(out.nav).every((v) => v[0] && v[1]) && Object.keys(out.nav).length > 0, `item 4: walkable as item 3 (${json(out.nav)})`);
  await kill();
  await undo(rb);
  await undo(rt);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 11 and 12: refusals, nothing written; the dry check keeps nothing

const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
steps.refusals = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Refusals', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 28000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z, { dip: false, cabin: false, addition: false });
  const A = T.A;
  const area = [A[0] - 200, -64, A[1] - 200, A[2] + 200, 160, A[3] + 200];
  const worldDir = path.join(L.SAVES, 'G6B D3 Refusals', 'architect-regions', 'plans');
  const sidecarPlans = path.join(L.SIDECAR_DATA, 'regions', 'plans');
  // ---- item 12: the dry check keeps nothing
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const files0 = { mod: listDir(worldDir), sidecar: listDir(sidecarPlans), dry: listDir(path.join(L.SIDECAR_DATA, 'regions', 'dry')) };
  const h0 = await hash(area);
  const v = await checkBeside({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, opKey: 'd3-dry-key' });
  const files1 = { mod: listDir(worldDir), sidecar: listDir(sidecarPlans), dry: listDir(path.join(L.SIDECAR_DATA, 'regions', 'dry')) };
  const byKey = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'd3-dry-key' }).catch(() => null);
  out.dry = { fits: v.fits, join: v.join, ms: v.ms, before: files0, after: files1 };
  check(v.fits && v.join?.step === 'reach', `item 12: checkBeside fits beside ${T.region} (${json(v.join)}, ${v.ms} ms)`);
  check(json(files0) === json(files1), `item 12 (verifier re-runs): the mod's plans/ and the sidecar's plan directory listed before and after: no new file (${files0.mod.length} / ${files0.sidecar.length})`);
  check(!byKey?.region && (await hash(area)) === h0, 'item 12: no opKey entry, no region; the world hash unchanged');
  // ---- item 11: apart
  const far = [A[2] + 300, A[1], A[2] + 380, A[1] + 80];
  const ap = await besidePlan(T.region, far, ONE('east'));
  check(/NO_JOIN: \[apart\]/.test(ap.plan.refused ?? ''), `item 11: claims apart: NO_JOIN [apart] (${String(ap.plan.refused).slice(0, 120)})`);
  check(!ap.verdict.fits && /NO_JOIN \[apart\]/.test(ap.verdict.code ?? ''), `item 12: checkBeside answers the same refusal (${ap.verdict.code})`);
  // ---- a C17 area over the reach: PROTECTED at realise, nothing written
  const p = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  if (p.refused) throw new Error(`item 11's plan refused: ${p.refused}`);
  const ir = planFiles(p.planId).ir;
  // the area sits on a reach column (the reach's rect corner need not be one)
  const k0 = ir.reach.runs.find((q) => !ir.reach.contact.some((c) => c[1] === q[1] && c[0] <= q[0] && q[0] <= c[2]));
  const api = async (a) => { const x = await cmd(`/apitest ${a}`); return (x.messages ?? []).find((mm) => mm.startsWith('{')) ?? null; };
  await api(`protect ${json({ owner: OWNER, id: 'd3reach', x0: k0[0], z0: k0[1], x1: k0[0], z1: k0[1], label: 'D3_reach' })}`);
  const h1 = await hash(area);
  const pr = await call('dev.region.realise', { planId: p.planId, lots: {} }, 300_000);
  await api('unprotect test:d3 d3reach').catch(() => null);
  out.protected = pr.refused ?? null;
  if (!pr.refused && pr.region) await undo(pr.region).catch(() => null);
  check(/PROTECTED/.test(json(pr.refused ?? '')) && (await hash(area)) === h1, `item 11: a C17 area over the reach: PROTECTED, 0 changed cells (${json(pr.refused).slice(0, 160)})`);
  // ---- a site placed on the join's path after the plan: OVERLAP naming it
  const sx = k0[0], sz = k0[1];
  const site = await call('dev.cells.place', { kind: 'steward:addition', cells: [[sx, T.g + 1, sz, 'minecraft:oak_fence']], naturalOnly: false, owner: OWNER }, 600_000);
  const h2 = await hash(area);
  const ov = await call('dev.region.realise', { planId: p.planId, lots: {} }, 300_000);
  out.overlap = ov.refused ?? null;
  check(/OVERLAP/.test(json(ov.refused ?? '')) && /held since the plan/.test(String(JSON.stringify(ov.refused ?? ''))) && (await hash(area)) === h2, `item 11: a site placed on the join's path after the plan: OVERLAP naming it (${json(ov.refused).slice(0, 200)}), 0 changed cells`);
  await call('dev.sites.remove', { siteId: site.siteId }).catch(() => null);
  // ---- a town in flight (PLACING): a plan beside it refuses OVERLAP_BUSY (Steward's finding), and so does the realise of a plan made
  // beside it before (its re-check, §4.4); nothing written
  const A2 = [A[0], A[1] + 400, A[2], A[3] + 400], B2 = [B[0], B[1] + 400, B[2], B[3] + 400];
  await generateFor(A2, { lots: TOWN_LOTS, apronLamps: false }); // off the spawn area
  const pA2 = await planReq({ program: 'flat_village', params: { lots: TOWN_LOTS, apronLamps: false }, claim: A2, check: false });
  const rt2 = await L.realise(pA2.planId, { lots: {} });
  await L.waitRegion(rt2, 3_600_000);
  await cmd(`/forceload add ${A2[0]} ${A2[1]} ${A2[2]} ${A2[3]}`); // (§4 Survey: loaded chunks only; the player is 400 away)
  await L.settle(4000);
  const pOld = await planReq({ program: 'districts', params: ONE('east'), claim: B2, beside: rt2, check: false });
  check(!pOld.refused, `item 11: a reach plan beside the town before its removal (${String(pOld.refused ?? 'fits').slice(0, 160)})`);
  // the town again, now slowly: its retry (a fresh realise of its plan) is PLACING while we ask
  await kill();
  await undo(rt2);
  await call('dev.placement.slow', { on: true });
  const rt3 = await L.realise(pA2.planId, { lots: {} });
  const hB2 = await hash([B2[0] - 8, -64, B2[1] - 8, B2[2] + 8, 160, B2[3] + 8]);
  const busyPlan = await planReq({ program: 'districts', params: ONE('east'), claim: B2, beside: rt3, check: false });
  await call('dev.placement.slow', { on: false });
  out.busy = { plan: busyPlan.refused ?? null, removedTownPlan: pOld.refused ?? null };
  check(/OVERLAP_BUSY/.test(json(busyPlan.refused ?? '')) && (await hash([B2[0] - 8, -64, B2[1] - 8, B2[2] + 8, 160, B2[3] + 8])) === hB2, `item 11: a town PLACING: OVERLAP_BUSY, nothing written (${json(busyPlan.refused).slice(0, 120)})`);
  if (!pOld.refused) {
    const gone = await call('dev.region.realise', { planId: pOld.planId, lots: {} }, 300_000);
    out.busy.townRemoved = gone.refused ?? null;
    check(/was removed; re-plan/.test(String(JSON.stringify(gone.refused ?? ''))), `§4.2: a reach plan whose town went before its realise: OTHER, re-plan (${json(gone.refused).slice(0, 120)})`);
  }
  await L.waitRegion(rt3, 3_600_000);
  await cmd(`/forceload remove ${A2[0]} ${A2[1]} ${A2[2]} ${A2[3]}`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 6: Steward's shapes

steps.steward = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Steward', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 32000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z, { dip: false, cabin: false, addition: false });
  const A = T.A;
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  // Steward's placeholder district: one 9x9 lot (DISTRICTS.md §2), checkBeside
  const placeholder = { spec: { districts: [{ id: 'quarter', size: [48, 48], lots: [{ id: 'q_first', type: 'house', size: [9, 9] }] }] } };
  const v = await checkBeside({ program: 'districts', params: placeholder, claim: B, beside: T.region });
  out.reservation = { fits: v.fits, join: v.join, land: v.land ? { outside: v.land.outside.cells, inside: v.land.inside.cells } : null };
  check(v.fits && v.land?.v === 1, `item 6: checkBeside with one placeholder lot fits (${json(out.reservation)})`);
  // the real first building: Regions.plan under an opKey, Regions.realise with a stub under another, realiseByKey after a restart
  const first = { spec: { districts: [{ id: 'quarter', size: [48, 48], lots: [{ id: 'q_first', type: 'house', size: [9, 9] }] }] } };
  const p = await planReq({ program: 'districts', params: first, claim: B, beside: T.region, opKey: 'dplan-1' });
  if (p.refused) throw new Error(`item 6's plan refused: ${p.refused}`);
  const again = await planReq({ program: 'districts', params: first, claim: B, beside: T.region, opKey: 'dplan-1' });
  check(again.planId === p.planId, `item 6: the same plan under its opKey (${p.planId})`);
  const rr = await call('dev.region.realise', { planId: p.planId, lots: { q_first: STUB }, opKey: 'drealise-1' }, 300_000);
  if (rr.refused) throw new Error(`item 6's realise refused: ${json(rr.refused)}`);
  const sr = await L.waitRegion(rr.region, 3_600_000);
  await leaveWorld();
  await L.openWorld('G6B D3 Steward');
  const byKey = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'drealise-1' });
  const land = (await view(rr.region)).ext?.['architect_mc:land'];
  out.real = { region: rr.region, state: sr.view.state, byKey: byKey.region?.id ?? null, land: land ? { outside: land.outside.cells, inside: land.inside.cells, v: land.v } : null };
  check(sr.view.state === 'PLACED' && byKey.region?.id === rr.region && land?.v === 1, `item 6: Regions.realise under its opKey PLACED, realiseByKey after a restart finds it, the land read (${json(out.real)})`);
  // a partial town (one lot failed) is a valid beside town (Steward's finding)
  const P = await d3Town(X, Z + 400, { dip: false, cabin: false, addition: false, partial: true });
  out.partial = { region: P.region, state: P.state };
  await generateFor([P.A[2] + 1, P.A[1] + 30, P.A[2] + 90, P.A[3] - 30], { lots: TOWN_LOTS, apronLamps: false });
  // (§4 Survey: the town's survey reads loaded chunks only; the player is 400 away, so the town's claim is force-loaded for the plan and the realise)
  await cmd(`/forceload add ${P.A[0]} ${P.A[1]} ${P.A[2]} ${P.A[3]}`);
  await L.settle(4000);
  const pp = await planReq({ program: 'districts', params: ONE('east'), claim: [P.A[2] + 1, P.A[1] + 30, P.A[2] + 90, P.A[3] - 30], beside: P.region, check: false });
  const rp = pp.refused ? null : await L.realise(pp.planId, { lots: {} });
  const sp = rp ? await L.waitRegion(rp, 3_600_000) : null;
  await cmd(`/forceload remove ${P.A[0]} ${P.A[1]} ${P.A[2]} ${P.A[3]}`);
  out.partial.district = sp?.view?.state ?? pp.refused;
  check(P.state === 'PARTIAL' && sp?.view?.state === 'PLACED', `Steward's finding: a partial town (one lot failed) is a beside town: a district realised beside it (${json(out.partial)})`);
  // plan/0's endpoint.region reach: checkPlan, then realiseApproved; a stale retry under a second key across a restart
  const C = [A[2] + 1, A[1] + 30, A[2] + 120, A[3] - 30];
  // (v7x_d3_endpoint_reach in Steward's plan v1 shape: a street zone, ew, rotate off, lot ext; a road from it to the town by
  // endpoint.region; a pending part `required: false`)
  const lotsV1 = [1, 2].map((i) => ({ id: `q${i}`, type: 'cottage', size: [9, 9], ext: { 'steward_mc:settlement': 's1', 'steward_mc:lot': `q${i}`, 'steward_mc:role': 'home' } }));
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'quarter', kind: 'standard', required: true, program: { lots: lotsV1, layout: 'street', orientation: 'ew' }, tolerance: { rotate: { allowed: false } }, where: { near: { anchor: 'gate', within: 16 } } }],
    connectors: [{ id: 'to_town', kind: 'road', from: { part: 'quarter' }, to: { region: T.region } }, { id: 'lift', kind: 'lift', required: false, from: { anchor: 'gate' }, to: { part: 'quarter' } }] };
  const gy = await groundAt(C[2] - 8, Math.floor((C[1] + C[3]) / 2));
  const anchors = { gate: [C[2] - 30, gy + 1, Math.floor((C[1] + C[3]) / 2)] };
  const ck = await call('dev.region.checkPlan', { plan, claim: C, anchors, owner: OWNER }, 900_000);
  const part = ck.check?.parts?.find((x) => x.part === 'to_town');
  out.checkPlan = { overall: ck.check?.overall, class: part?.class, notes: part?.notes, junction: part?.geometry?.legs?.[0]?.junction ?? null };
  const lift = ck.check?.parts?.find((x) => x.part === 'lift');
  out.checkPlan.lift = lift?.class ?? null;
  check(['READY', 'NEEDS_REPAIR'].includes(ck.check?.overall) && part?.class === 'fits' && (part?.notes ?? []).some((n) => /reach: true/.test(n)) && !!ck.check?.artifactSha, `item 6: checkPlan (Steward's plan v1 shape, a pending part required: false) answers the road fits with reach: true (${json(out.checkPlan)})`);
  const ra = await call('dev.region.realiseApproved', { sha: ck.check?.artifactSha, opKey: 'dapprove-1' }, 300_000);
  const sa = ra.region ? await L.waitRegion(ra.region, 3_600_000) : null;
  out.approved = { region: ra.region ?? null, refused: ra.refused ?? null, state: sa?.view?.state ?? null };
  check(sa?.view?.state === 'PLACED', `item 6: realiseApproved PLACED the leg into the town's claim (${json(out.approved)})`);
  // stale: a site on the leg's reach after the check, a restart, then a retry under a second key answers ARTIFACT_STALE
  if (ra.region) { await kill(); await undo(ra.region); }
  const ck2 = await call('dev.region.checkPlan', { plan, claim: C, anchors, owner: OWNER }, 900_000);
  out.stale = { overall: ck2.check?.overall };
  if (ck2.check?.artifactSha) {
    const art = await call('dev.region.artifact', { sha: ck2.check.artifactSha }).catch(() => null);
    const reach = art?.artifact?.planId ? planFiles(art.artifact.planId).ir.reach ?? null : null;
    if (reach) {
      const q = reach.runs.find((r) => !(reach.contact ?? []).some((c) => c[1] === r[1] && c[0] <= r[0] && r[0] <= c[2]));
      await call('dev.cells.place', { kind: 'steward:addition', cells: [[q[0], gy + 1, q[1], 'minecraft:oak_fence']], naturalOnly: false, owner: OWNER }, 600_000);
    }
    await leaveWorld();
    await L.openWorld('G6B D3 Steward');
    const st = await call('dev.region.realiseApproved', { sha: ck2.check.artifactSha, opKey: 'dapprove-2' }, 300_000);
    out.stale.refused = st.refused ?? null;
    check(/ARTIFACT_STALE/.test(json(st.refused ?? '')) && !!reach, `item 6: a stale retry under a second key across a restart: ARTIFACT_STALE (${json(st.refused).slice(0, 200)})`);
  } else check(false, `item 6: the second check made no artifact (${ck2.check?.overall})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 5: along and outpost

steps.along = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Along', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 36000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z, { dip: false, cabin: false, addition: false });
  const A = T.A;
  // d3_shore: a placed water strip east of the town's claim (outside it), a shore district along it
  const B = [A[2] + 1, A[1], A[2] + 110, A[3]];
  await cmd(`/fill ${A[2] + 70} ${T.g - 3} ${A[1] + 10} ${A[2] + 80} ${T.g} ${A[3] - 10} minecraft:water`);
  const shore = { spec: { districts: [{ id: 'quay', size: [96, 24], lots: 3, follow: { shore: {} } }] } };
  const p = await planReq({ program: 'districts', params: shore, claim: B, beside: T.region, check: false });
  out.shore = { refused: p.refused ?? null };
  if (!p.refused) {
    const f = planFiles(p.planId);
    const r = await L.realise(p.planId, { lots: {} });
    const s = await L.waitRegion(r, 3_600_000);
    const land = s.view.ext?.['architect_mc:land'];
    const join = land?.parts?.find((x) => x.kind === 'join');
    const outside = await runKeysOf(land?.outside?.runs ?? []);
    const joinOut = [...await runKeysOf(join?.runs ?? [])].filter((k) => { const [x, z] = k.split(',').map(Number); return !(x >= A[0] && x <= A[2] && z >= A[1] && z <= A[3]); });
    out.shore = { region: r, state: s.view.state, step: f.meta.districts.join?.step, joinOutside: joinOut.length };
    check(s.view.state === 'PLACED' && f.meta.districts.join?.step === 'reach' && joinOut.every((k) => outside.has(k)), `item 5: a shore district joined through the town's claim; land.outside holds its join's cells outside the town (${json(out.shore)})`);
    await kill();
    await undo(r);
  } else check(false, `item 5: the shore district's plan refused (${p.refused})`);
  // an outpost (gap 40) joined through the town's claim; its corridor equals architect_mc:corridor
  const O = [A[2] + 1, A[1] - 60, A[2] + 160, A[3] + 60];
  const po = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 40 } }] } }, claim: O, beside: T.region, check: false });
  out.outpost = { refused: po.refused ?? null };
  if (!po.refused) {
    const r = await L.realise(po.planId, { lots: {} });
    const s = await L.waitRegion(r, 3_600_000);
    const land = s.view.ext?.['architect_mc:land'];
    const cor = s.view.ext?.['architect_mc:corridor']?.camp;
    const part = land?.parts?.find((x) => x.kind === 'corridor');
    out.outpost = { region: r, state: s.view.state, step: planFiles(po.planId).meta.districts.join?.step, corridorEqual: json(part?.runs) === json(cor?.runs) };
    check(s.view.state === 'PLACED' && out.outpost.corridorEqual, `item 5: an outpost with gap 40 joined through the town's claim; its land corridor part equals architect_mc:corridor (${json(out.outpost)})`);
    await kill();
    await undo(r);
  } else check(false, `item 5: the outpost's plan refused (${po.refused})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 13: a second district beside the same town

steps.kc = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 KC', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 40000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z, { dip: false, cabin: false, addition: false });
  const A = T.A;
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const p1 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  const r1 = await L.realise(p1.planId, { lots: {} });
  await L.waitRegion(r1, 3_600_000);
  const ir1 = planFiles(p1.planId).ir;
  const B2 = [A[0] + 10, A[3] + 1, A[2] - 10, A[3] + 90];
  const p2 = await planReq({ program: 'districts', params: ONE('south'), claim: B2, beside: T.region, check: false });
  out.second = { refused: p2.refused ?? null };
  if (!p2.refused) {
    const ir2 = planFiles(p2.planId).ir;
    const first = await runKeysOf(ir1.reach?.runs ?? []);
    const hit = [...await runKeysOf(ir2.reach?.runs ?? [])].filter((k) => first.has(k));
    out.second = { step: planFiles(p2.planId).meta.districts.join?.step, shared: hit.length };
    check(hit.length === 0, `item 13: a second district beside the same town: its join avoids the first's (${hit.length} shared columns)`);
  } else check(false, `item 13: the second district's plan refused (${p2.refused})`);
  await kill();
  await undo(r1);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 11 (walled) and 13 (C38's wall round a town with a district)

/** A wall round a standing region through plan/0 (Regions.checkPlan of wall.around {feature: {region}}): {check, part, region?}. */
async function wallRound(town, A, { gates = null, realise = true } = {}) {
  const C = [A[0] - 24, A[1] - 24, A[2] + 24, A[3] + 24];
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'ring', kind: 'wall', where: { around: { feature: { region: town }, ring: [4, 12] } }, height: 5, ...(gates !== null ? { gates } : {}) }] };
  const ck = await call('dev.region.checkPlan', { plan, claim: C, anchors: { stone: [Math.floor((A[0] + A[2]) / 2), 65, Math.floor((A[1] + A[3]) / 2)] }, owner: OWNER }, 900_000);
  const part = ck.check?.parts?.find((x) => x.part === 'ring') ?? null;
  let region = null;
  if (realise && ck.check?.artifactSha && part?.class === 'fits') {
    const ra = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
    region = ra.region ?? null;
    if (region) await L.waitRegion(region, 3_600_000);
  }
  return { check: ck.check, part, region };
}

steps.walled = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Walled', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 44000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await d3Town(X, Z, { dip: false, cabin: false, addition: false });
  const A = T.A;
  const B = [A[2] + 30, A[1] + 30, A[2] + 120, A[3] - 30];
  // ---- d3_walled: a sealed wall round the town (gates 0); a district beside it: NO_JOIN [wall], nothing written
  const w = await wallRound(T.region, A, { gates: 0 });
  out.wall = { overall: w.check?.overall, part: w.part?.class, region: w.region };
  check(!!w.region, `d3_walled: a sealed wall round ${T.region} realised through checkPlan and realiseApproved (${json(out.wall)})`);
  const h = await hash([A[0] - 30, -64, A[1] - 30, B[2] + 8, 160, A[3] + 30]);
  const p = await besidePlan(T.region, [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30], ONE('east'));
  out.walled = { refused: p.plan.refused ?? null, code: p.verdict.code };
  check(/NO_JOIN: \[wall\]/.test(p.plan.refused ?? '') && /NO_JOIN \[wall\]/.test(p.verdict.code ?? ''), `item 11: a district beside a walled town: NO_JOIN [wall] (S-D3-5), checkBeside the same (${String(p.plan.refused).slice(0, 120)})`);
  check((await hash([A[0] - 30, -64, A[1] - 30, B[2] + 8, 160, A[3] + 30])) === h, 'item 11: nothing written');
  if (w.region) { await kill(); await undo(w.region); }
  // ---- item 13: a district beside the town, then C38's offer round the town: the ring keeps off the join (NO_ROOM {kind: region}
  // or a ring past it), never gating it
  const pd = await planReq({ program: 'districts', params: ONE('east'), claim: [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30], beside: T.region, check: false });
  if (pd.refused) throw new Error(`item 13's district refused: ${pd.refused}`);
  const ird = planFiles(pd.planId).ir;
  const rd = await L.realise(pd.planId, { lots: {} });
  await L.waitRegion(rd, 3_600_000);
  const w2 = await wallRound(T.region, A);
  let onJoin = 0;
  if (w2.region) {
    const vw = await view(w2.region);
    onJoin = (await stacksOver(ird.reach.runs)).filter((c) => c.stack.some((e) => e.group === vw.groupId)).length;
  }
  out.c38 = { part: w2.part?.class, reasons: w2.part?.reasons?.map((r) => [r.code, r.evidence?.kind]) ?? [], region: w2.region, onJoin };
  check((w2.part?.class === 'refused' && w2.part.reasons.some((r) => r.code === 'NO_ROOM' && r.evidence?.kind === 'region')) || (w2.region && onJoin === 0), `item 13 (S-D3-6): C38's offer round the town with a standing district: its ring keeps off the join (${json(out.c38)})`);
  await kill();
  if (w2.region) await undo(w2.region);
  await undo(rd);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 13: d3_pond_town (a farm pond and a fountain where the join would pass)

steps.pond = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Pond', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 48000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const g = await groundAt(X + 80, Z + 80);
  // the town as plan/0: a street zone with a farm pond and a fountain by its east side (where a district east of it would join)
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'town', farmPond: true, program: { lots: [{ id: 'f1', type: 'farm', size: [13, 11], villager: 'farm' }, ...TOWN_LOTS.slice(1, 6)], layout: 'street', orientation: 'ew' }, where: { near: { anchor: 'stone', within: 16 } } }],
    forms: [{ id: 'fount', kind: 'fountain', basin: 5, spout: 3, where: { near: { anchor: 'east', within: 8 } } }] };
  const ck = await call('dev.region.checkPlan', { plan, claim: A, anchors: { stone: [X + 70, g + 1, Z + 80], east: [X + 140, g + 1, Z + 80] }, owner: OWNER }, 900_000);
  out.town = { overall: ck.check?.overall, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class]) };
  if (!ck.check?.artifactSha) { check(false, `d3_pond_town's check made no artifact (${json(out.town)})`); await leaveWorld(); return out; }
  const ra = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
  const st = ra.region ? await L.waitRegion(ra.region, 3_600_000) : null;
  check(st?.view?.state === 'PLACED', `d3_pond_town ${ra.region} PLACED: ${json(out.town)}`);
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const p = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: ra.region, check: true });
  if (p.refused) { check(false, `item 13: the district beside the pond town refused (${p.refused})`); await leaveWorld(); return out; }
  const f = planFiles(p.planId);
  const clear = (f.report?.findings ?? []).filter((x) => x.rule === 'M25:clear');
  out.district = { join: f.meta.districts.join, clear: clear.length, m28: f.report?.metrics?.M28 ?? null };
  check(clear.length === 0 && (f.report?.metrics?.M28?.bodies ?? 0) === 0, `item 13 (KC): the join keeps clear of the town's bodies (M25:clear ${clear.length}; reach cells in a body ${f.report?.metrics?.M28?.bodies ?? '?'})`);
  const rd = await L.realise(p.planId, { lots: {} });
  const sd = await L.waitRegion(rd, 3_600_000);
  await L.settle(10_000);
  const census = await call('dev.fluid.census', { box: [A[0], g - 16, A[1], A[2], g + 16, A[3]] }, 300_000).catch((e) => ({ error: String(e) }));
  out.census = { fluids: census.fluids?.length ?? null, ticks: census.ticks?.length ?? null, error: census.error ?? null };
  check(sd.view.state === 'PLACED' && !census.error && (census.ticks?.length ?? 1) === 0, `item 13: the district PLACED; every town body settled after (no scheduled fluid tick in the town: ${json(out.census)})`);
  await kill();
  await undo(rd);
  await undo(ra.region);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 15: the natural round on S3's pinned claim

steps.natural = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B D3 Natural', await L.seedBase('2026100906'));
  await cmd('/op @s');
  // S3's pinned claim [3604, -1036, 3795, -845]: a V town in its south-west, a shore district east of it along the river, joined
  // through the town's claim
  const A = [3604, -956, 3699, -861];
  const all = [A[0] - 8, -64, A[1] - 8, 3795 + 8, 260, -845 + 8];
  await tp(3700, 140, -900);
  await cmd('/tick freeze');
  await kill();
  const snap0 = path.join(OUT, 'natural-snap0.gz');
  await call('dev.region.hash', { box: all, mode: 'snap', file: snap0 }, 3_600_000);
  const lots = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, ...TOWN_LOTS.slice(1, 4)];
  const pa = await planReq({ program: 'flat_village', params: { lots }, claim: A, check: false, surveyLoad: 'bounded:256' });
  if (pa.refused) throw new Error(`the natural town refused: ${pa.refused}`);
  const rt = await L.realise(pa.planId, { lots: {} });
  await L.waitRegion(rt, 3_600_000);
  const B = [3700, -930, 3795, -845];
  // (D2's quay round on this claim: 64 x 24, minArea 64, two 7 x 7 cottages)
  const quay = { id: 'quay', size: [64, 24], follow: { shore: { minArea: 64 } }, lots: [1, 2].map((i) => ({ id: `quay_${i}`, type: 'cottage', size: [7, 7] })) };
  const p = await planReq({ program: 'districts', params: { spec: { districts: [quay] } }, claim: B, beside: rt, check: false });
  if (p.refused) throw new Error(`item 15's shore district refused: ${p.refused}`);
  const f = planFiles(p.planId);
  out.join = f.meta.districts.join;
  out.shore = { street: (f.meta.districts.follow?.quay?.street ?? []).length };
  check(f.meta.districts.join?.step === 'reach' && out.shore.street > 0, `item 15: a shore district beside the natural town, joined through its claim (${json(out.join?.junction)}; its shore street ${out.shore.street} cells)`);
  const rd = await L.realise(p.planId, { lots: {} });
  const sd = await L.waitRegion(rd, 3_600_000);
  check(sd.view.state === 'PLACED', `item 15: the district ${rd} PLACED`);
  await cmd('/save-all flush');
  await leaveWorld();
  await L.openWorld('G6B D3 Natural');
  await cmd('/tick freeze');
  // removal: the district first, then the town; E-normal over both claims against the world before the town
  await kill();
  await undo(rd);
  await undo(rt);
  await L.settle(3000);
  const diff = await call('dev.region.hash', { box: all, mode: 'diff', file: snap0 }, 3_600_000);
  const fluidRe = /^minecraft:(water|lava)\b/;
  const unclassified = (diff.list ?? []).filter((m) => m.class === 'none' && !fluidRe.test(m.now ?? '') && !fluidRe.test(m.was ?? '') && !(/_leaves\[.*persistent=false/.test(m.was ?? '') && /^minecraft:air$/.test(m.now ?? '')));
  out.enormal = { mismatches: diff.mismatches, classes: diff.classes, unclassified: unclassified.length, sample: unclassified.slice(0, 10) };
  check(unclassified.length === 0, `item 15: after a save, leave and reopen, removal (district, then town): E-normal 0 unclassified (flow and decay classed as D2's) (${json(out.enormal).slice(0, 300)})`);
  // the other order: the town first
  await kill();
  const pa2 = await planReq({ program: 'flat_village', params: { lots }, claim: A, check: false });
  const rt2 = await L.realise(pa2.planId, { lots: {} });
  await L.waitRegion(rt2, 3_600_000);
  const p2 = await planReq({ program: 'districts', params: f.ir.params, claim: B, beside: rt2, check: false });
  if (!p2.refused) {
    const rd2 = await L.realise(p2.planId, { lots: {} });
    await L.waitRegion(rd2, 3_600_000);
    await kill();
    await undo(rt2);
    await undo(rd2);
    await L.settle(3000);
    const d2 = await call('dev.region.hash', { box: all, mode: 'diff', file: snap0 }, 3_600_000);
    const u2 = (d2.list ?? []).filter((m) => m.class === 'none' && !fluidRe.test(m.now ?? '') && !fluidRe.test(m.was ?? '') && !(/_leaves\[.*persistent=false/.test(m.was ?? '') && /^minecraft:air$/.test(m.now ?? '')));
    out.enormal2 = { mismatches: d2.mismatches, unclassified: u2.length, sample: u2.slice(0, 10) };
    check(u2.length === 0, `item 15: the town removed first, then the district: E-normal 0 unclassified (${json(out.enormal2).slice(0, 300)})`);
  } else check(false, `item 15: the second district refused (${p2.refused})`);
  await cmd('/tick unfreeze').catch(() => null);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 16: survival (RS merged first)

steps.survival = async () => {
  await ensure();
  const out = {};
  const G = await import('./lib/gate6crs-game.mjs');
  const base = await G.survivalBase({ L });
  await L.fresh('G6B D3 Survival', base);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 0, Z = 0;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const g = await groundAt(X + 80, Z + 80);
  const crates = Array.from({ length: 4 }, (_, k) => [X - 20 + 2 * k, g + 1, Z - 20]);
  const cr = await call('dev.stockpile.create', { owner: OWNER, crates }, 120_000);
  check(!cr.refused, `item 16: the stockpile (${json(cr.refused ?? crates)})`);
  const feed = async (region, timeoutMs = 2_400_000) => {
    const end = Date.now() + timeoutMs;
    let st;
    while (Date.now() < end) {
      st = await call('dev.region.state', { region }, 60_000);
      const rs = await call('dev.rs.state', { region }, 120_000);
      if (st.view.state === 'PLACED' && rs.build?.done) return { st, rs };
      if (['FAILED', 'PARTIAL'].includes(st.view.state)) return { st, rs };
      const ps = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
      if (Object.keys(need).length) await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: need, exact: true }, 120_000);
      await sleep(3000);
    }
    throw new Error(`${region} was not fed to done`);
  };
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const pa = await planReq({ program: 'flat_village', params: { lots: TOWN_LOTS, apronLamps: false }, claim: A, check: false });
  if (pa.refused) throw new Error(`the survival town refused: ${pa.refused}`);
  const rt = await L.realise(pa.planId, { lots: {} });
  const ft = await feed(rt);
  check(ft.st.view.state === 'PLACED', `item 16: the town ${rt} built in survival (fed)`);
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const round = async (tag, townFirst) => {
    const p = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: rt, check: false });
    if (p.refused) throw new Error(`${tag}: the district refused: ${p.refused}`);
    const rd = await L.realise(p.planId, { lots: {} });
    const fd = await feed(rd);
    const rs = await call('dev.rs.state', { region: rd }, 120_000);
    const joinTarget = JSON.stringify(rs).includes('route_join');
    const before = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
    return { p, rd, fd, joinTarget, before };
  };
  const r1 = await round('district first', false);
  out.district = { state: r1.fd.st.view.state, joinTarget: r1.joinTarget };
  check(r1.fd.st.view.state === 'PLACED' && r1.joinTarget, `item 16: the district beside it, its join a route target fed from the stockpile (${json(out.district)})`);
  await kill();
  await undo(r1.rd);
  const after1 = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
  const refund = (a, b) => Object.values(G.minus(a.stock ?? {}, b.stock ?? {})).reduce((x, y) => x + y, 0);
  out.refund1 = refund(after1, r1.before);
  await call('dev.region.remove', { region: r1.rd, requester: OWNER }, 600_000).catch(() => null);
  const again = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
  out.refundAgain = refund(again, after1);
  check(out.refund1 > 0 && out.refundAgain === 0, `item 16: the district removed first refunds its paid cells standing (${out.refund1} items), once per key (a second remove: ${out.refundAgain})`);
  const r2 = await round('town first', true);
  await kill();
  await undo(rt);
  const afterT = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
  await undo(r2.rd);
  const afterD = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
  out.refund2 = { town: refund(afterT, r2.before), district: refund(afterD, afterT) };
  check(out.refund2.town > 0 && out.refund2.district > 0, `item 16: the town removed first, then the district: each refunds its own paid cells standing (${json(out.refund2)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'apicompat', 'ingame', 'side', 'refusals', 'steward', 'along', 'kc', 'walled', 'pond', 'natural', 'survival']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  const md = `# Gate 6c-D3 (districts beside a standing region town)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cd3.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
