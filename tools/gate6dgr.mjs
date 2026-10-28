#!/usr/bin/env node
// Slice 6d GR gate (growing a standing region; docs/CONTRACT.md "Phase 6d slice GR" §11, with Steward's GR review: its key scheme and asks)
// against the headless server of the GR run worktree (GATE6B_RUN, default `../architect-mc-GR-run`; the sim sidecar, no Claude). $0.
//
//   node tools/gate6dgr.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (gr-unit)              items 1, 2 and 6/12's kit halves offline: kit gr-a.test (frontage, ends, the extension, ids and the graph,
//                                      NO_ROOM, the broken variant, land v 2, plan/0's revision.grow, 300 seeded towns), gr-parity (land v 2's
//                                      kit/Java fixture), rv-a.test, the byte-identity suites; DistrictLandGrTest, DistrictLandTest, RevisionsTest;
//                                      api-compat against the 0.47.0 / 0.45.0 apitest jars and the 0.47.0 mod surface
//     town      (gr-town)              items 3, 4, 7, 7b, 8, 9 on gr_town (6 lots, 4 built; a Steward addition and a PT build by the street):
//                                      frontage, the extension (Ask 1: every site tagged), walkable, graph.cut []; a beside district joined at the
//                                      new end and one by a side T: undoRevision refused `joined`, nothing written; removed, the undo exact;
//                                      KC (an added pond kept clear) and NO_ROOM held; removal with growths and a district standing: E-flat 0
//     beside    (gr-beside)            items 5, 11, 12 with Steward's keys: a beside district (checkBeside, Regions.plan under
//                                      steward.<b>.vplan / .vrealise, ext steward_mc:district/build), building 3 then 4 as growths under the same
//                                      scheme, land v 2 (outside grows, every grown part's revision), undoRevision 4 then 3 (the world before
//                                      each; land.outside shrinks; the join and the town untouched); an outpost grown by 2 (its corridor unchanged)
//     plan0     (gr-plan0)             item 6: a revision plan whose zone gains 2 lots through checkPlan (fits standing grown) and realiseApproved,
//                                      one stale retry under a second key across a restart; undo exact; removal E-flat 0
//     survival  (gr-survival)          item 13: a survival town (checkPlan/realiseApproved, fed), a frontage growth checked in survival: its
//                                      bills equal the check's BOM per part; undo refused survival_building while it builds; built; undo refunds
//                                      once per key (Steward's RC rows 2, 3)
//     crash     (gr-crash)             the growth's kill points: realise (RV3, RV4, RG4+save mid-tile, IJ mid-road) and the undo of a growth with
//                                      a road (RVU1, RVU2, K6): each resumes, the world as the contract names it
//     look      (gr-look)              N-GR-1 and N-GR-2 in a client: a grown street and its new lots, shots for the gallery
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6d-gr/<step>.json in the main checkout (GATE6DGR_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
// Ports: 8960/8961 (the GR lane's range 8960-8969).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-GR-run');
process.env.GATE6B_OUT = process.env.GATE6DGR_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6d-gr');
process.env.GATE6B_SIDECAR_PORT ??= '8960';
process.env.GATE6B_DEV_PORT ??= '8961';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const OWNER = 'test:gr';
const FLAT = 'G6B Flat Base';
const CX = 11200, CZ = 11200;
/** gr_town's claim: 160 x 112 (room east of the street for an extension). */
const CLAIM = [CX, CZ, CX + 159, CZ + 111];
const LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] },
  { id: 'cottage_3', type: 'cottage', size: [9, 9] }, { id: 'smithy_1', type: 'smithy', size: [9, 9], villager: 'job' }, { id: 'farm_1', type: 'farm', size: [9, 9], villager: 'farm' }];
const STUB = 'g6a_stub_9';

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GR is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
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
function diff(a, b, max = 12) {
  const out = [];
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = norm(a.get(k) ?? 'minecraft:air'), y = norm(b.get(k) ?? 'minecraft:air');
    if (x !== y) { n++; if (out.length < max) out.push(`${k} expected ${x} got ${y}`); }
  }
  return { n, first: out };
}
async function groundY(x = CX + 150, z = CZ + 100) {
  const c = await cellsOf([x, -64, z, x, 255, z]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'air' && y > g) g = y; }
  return g;
}
async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await cmd('/op @s').catch(() => null);
  await L.tp(CX + 80, 60, CZ + 56);
}
const BOXOF = (claim, gy, pad = 8) => [claim[0] - pad, gy - 12, claim[1] - pad, claim[2] + pad, gy + 24, claim[3] + pad];

// ------------------------------------------------------------------ regions, revisions

const planFiles = (planId) => {
  const d = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  return { ir: JSON.parse(fs.readFileSync(path.join(d, 'ir.json'), 'utf8')), meta: fs.existsSync(path.join(d, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')) : null };
};
/** gr_town: flat_village over CLAIM, 4 of its 6 lots built (stubs), a Steward addition and a PT build by the street. */
async function grTown({ addition = true, pt = true, lots = null, claim = CLAIM, gy } = {}) {
  const p = await L.plan('flat_village', claim, { params: { lots: LOTS }, surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const ir = planFiles(p.planId).ir;
  const built = lots ?? Object.fromEntries(ir.lots.filter((l) => l.box.maxX - l.box.minX === 8 && l.box.maxZ - l.box.minZ === 8).slice(0, 4).map((l) => [l.id, STUB]));
  const region = await L.realise(p.planId, { load: 'bounded:512', lots: built });
  const st = await L.waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `gr_town ${region}: ${st.view.state}, ${st.view.cellsWritten} cells, lots ${json(st.view.lots.map((l) => [l.id, l.state]))}`);
  const { streetRuns } = await imp('lib/region/grow.mjs');
  const runs = streetRuns(ir);
  const out = { region, p, st, ir, runs, built, addition: null, pt: null };
  if (addition) {
    // a Steward addition (a cell site with Steward's ext) on the west street's lot-free side, 4 off its centre line (a growth routes around it)
    const w = runs.find((r) => r.road === 'street_w') ?? runs[0];
    const side = ir.lots.some((l) => l.ext?.['architect_mc:village']?.slot === 'street' && l.box.minZ > w.c && l.box.maxX >= w.u0 && l.box.minX <= w.u1) ? -1 : 1;
    const zz = w.c + side * 4, xx = w.u0 + 3;
    const r = await call('dev.cells.place', { kind: 'steward:addition', cells: [[xx, gy + 1, zz, 'minecraft:oak_fence'], [xx + 1, gy + 1, zz, 'minecraft:oak_fence']], naturalOnly: false, owner: OWNER }, 600_000);
    out.addition = { site: r.siteId ?? null, at: [xx, zz], placed: !!r.placed };
  }
  if (pt) {
    await call('dev.pt.rule', { name: 'graceMs', value: '600000' }).catch(() => null);
    const X = CX + 4, Y = gy + 1, Z = claim[3] - 10;
    const ops = [];
    for (let x = X; x <= X + 3; x++) for (let z = Z; z <= Z + 3; z++) ops.push({ item: 'minecraft:oak_log', at: [x, Y, z], placer: 'GRAlex' });
    const r = await call('dev.pt.uses', { ops }, 900_000).catch((e) => ({ error: String(e) }));
    await L.settle(4000);
    out.pt = { box: [X, Y, Z, X + 3, Y, Z + 3], result: r?.error ? r.error : 'ok' };
  }
  return out;
}

async function rvPlan(region, o) {
  const r = await call('dev.rv.plan', { region, ...o }, 900_000);
  log(`  rv plan ${region}: ${r.refused ? `refused ${r.refused}` : `${r.planId} rid ${r.revisionOf?.rid} parent ${r.revisionOf?.parentRid}`}`);
  return r;
}
/** A growth: the region's own program with params {grow} (contract §9), opKey and ext optional. */
const growPlan = (region, grow, { program = 'flat_village', opKey, ext } = {}) => rvPlan(region, { program, params: { grow }, ...(opKey ? { opKey } : {}), ...(ext ? { ext } : {}) });
const rvState = (region) => call('dev.rv.state', { region }, 60_000);
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
async function rvRealise(region, p, opts = {}) {
  const r = await call('dev.region.realise', { planId: p.planId, ...opts }, 300_000);
  if (r.refused) throw new Error(`realise refused: ${r.refused}`);
  return rvWait(region, p.revisionOf.rid);
}
const rvIr = async (region, rid) => (await call('dev.rv.ir', { region, rid }, 60_000)).ir;
/** The head's effective IR, read from the world's save (effective/<head>.json), or the base IR at head 0. */
function effectiveOf(world, region, head, baseIr) {
  if (!head) return baseIr;
  return JSON.parse(fs.readFileSync(path.join(L.SAVES, world, 'architect-regions', region, 'effective', `${head}.json`), 'utf8'));
}
/** Ask 1: every site of the revision carries architect_mc:revision {region, rid}; the kinds (cell sites, the road infra, lot sites). */
function tagged(st, rv, region) {
  const ext = st.siteExt ?? {};
  const kinds = {};
  for (const s of rv.sites) kinds[st.siteCaller?.[s]?.kind ?? '?'] = (kinds[st.siteCaller?.[s]?.kind ?? '?'] ?? 0) + 1;
  const bad = rv.sites.filter((s) => !(ext[s] && ext[s].region === region && ext[s].rid === rv.rid));
  return { sites: rv.sites.length, kinds, bad };
}
async function walkable(lots, bell) {
  const out = {};
  for (const l of lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 320 }, 120_000).catch((x) => ({ error: String(x) }));
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 320 }, 120_000).catch((x) => ({ error: String(x) }));
    out[l.id] = [!!there.canReach, !!back.canReach];
  }
  return out;
}
const planReq = (o) => call('dev.region.plan', { surveyLoad: 'bounded:256', owner: OWNER, ...o }, 900_000);
async function removeRegion(region, requester = OWNER) {
  const r = await call('dev.region.remove', { region, requester }, 4 * 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await sleep(500);
  }
  await L.settle(2000);
  return r;
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B GR Lobby', { backend: 'sim' });
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

// ------------------------------------------------------------------ offline (items 1, 2; 6 and 12's kit halves; api-compat)

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
/** The archived apitest jars and mod surface api-compat checks against (RV's: GATE6DGR_JARS, default artifacts/gate6d-rv/jars). */
function apiJars() {
  const A = process.env.GATE6DGR_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
  return { jars: [path.join(A, 'architect_apitest-0.47.0.jar'), path.join(A, 'architect_apitest-0.45.0.jar')], surface: path.join(A, 'architect_mc-0.47.0.jar') };
}

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/gr-a.test.mjs', 'kit/test/gr-parity.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `items 1, 6 and 12 (kit gr-a, gr-parity): frontage slots (the lot-free side nearest the square, lane contact, never a verge or road cell written), extendable ends (held, beside, short), the extension (the street's look, joined end to end, flagged, its new end terminal, graded), ids and the graph (no standing node or edge changed, graph.cut []), NO_ROOM held, the broken variant caught by M29, beside districts and outposts (never town land), land v 2 and its parity fixture, plan/0's revision.grow, determinism, 300 seeded towns: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.rv = nodeTest(['kit/test/rv-a.test.mjs']);
  check(out.rv.code === 0 && out.rv.fail === 0, `RV's kit suite unchanged (rv-a.test): ${out.rv.pass} pass, ${out.rv.fail} fail`, out.rv.failing);
  out.identity = nodeTest(['kit/test/scenario-goldens.test.mjs', 'kit/test/region-golden.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/districts-d3-parity.test.mjs', 'kit/test/rp.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/coa.test.mjs']);
  check(out.identity.code === 0 && out.identity.fail === 0, `item 2 (byte identity): the scenario and region goldens, the plan fixtures, the 59 asks, D3's parity, RP, the catalogue (revision.grow supported): ${out.identity.pass} pass, ${out.identity.fail} fail`, out.identity.failing);
  out.java = await javaTests(['*DistrictLandGrTest*', '*DistrictLandTest*', '*RevisionsTest*', '*ApiDTest*', '*PlanCatalogueTest*', '*LedgerLintTest*', '*RegionFluidsLintTest*'], 15);
  check(out.java.ok, `DistrictLandGrTest (land v 2 equals the kit's), DistrictLandTest, RevisionsTest, ApiDTest, PlanCatalogueTest, p3-lint: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  const J = apiJars();
  out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
    const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
    return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
  });
  check(out.apicompat.every((a) => a.code === 0), 'item 14: api-compat binary compatible with the 0.47.0 and 0.45.0 apitest jars and the 0.47.0 mod surface (Reason gains NO_ROOM at the end; RevisionRequest gains a trailing ext, its RV constructor kept)', out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-town: items 3, 4, 7, 7b, 8, 9 (and Ask 1)

steps.town = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GR Town';
  await freshFlat(world);
  const gy = await groundY();
  check(gy > -64 && gy < 200, `the flat world's ground: y ${gy}`);
  // the compared box: the town's claim and the beside districts' claims east and north, + 8
  const BIG = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 90, CLAIM[2] + 100, gy + 24, CLAIM[3] + 8];
  const B0 = await cellsOf(BIG);
  const T = await grTown({ gy });
  const region = T.region;
  const bell = T.ir.anchors.bell;
  out.town = { region, built: T.built, addition: T.addition, pt: T.pt, runs: T.runs.map((r) => [r.road, r.o, r.c, r.u0, r.u1]) };
  check(T.addition?.placed, `gr_town: a Steward addition by the street (${json(T.addition)}), a PT build (${json(T.pt)})`);
  const S0 = await cellsOf(BIG);

  // ---- item 9 (KC): an added pond (RV) by the square's frontage first: the growth keeps clear of its hard and watch cells
  const w = T.runs.find((r) => r.road === 'street_w') ?? T.runs[0];
  const freeSide = T.ir.lots.some((l) => l.ext?.['architect_mc:village']?.slot === 'street' && l.box.minZ > w.c && l.box.maxX >= w.u0 && l.box.minX <= w.u1) ? -1 : 1;
  const pz0 = freeSide > 0 ? w.c + 9 : w.c - 15, pz1 = pz0 + 6;
  const pond = await rvPlan(region, { spec: { parts: [{ id: 'pond', call: { fn: 'pond', rect: [w.u1 - 14, pz0, w.u1 - 8, pz1], depth: 2 } }] } });
  check(!pond.refused, `item 9: an added pond on the lot-free frontage nearest the square (rid ${pond.revisionOf?.rid}): ${pond.refused ?? 'planned'}`);
  const wp = pond.refused ? null : await rvRealise(region, pond);
  check(wp?.r.state === 'PLACED', `the pond realised: ${wp?.r.state}`);
  const S1 = await cellsOf(BIG);
  // ---- item 3: frontage, 2 lots
  const st1 = await rvState(region);
  const streetBox = (run) => (run.o === 'ew' ? [run.u0, gy - 2, run.c - 2, run.u1, gy + 4, run.c + 2] : [run.c - 2, gy - 2, run.u0, run.c + 2, gy + 4, run.u1]);
  const streetsBefore = await Promise.all(T.runs.map((r) => hashOf(streetBox(r))));
  const g1 = await growPlan(region, { lots: [{ id: 'bakery', type: 'bakery', size: [9, 9], villager: 'job' }, { id: 'house_a', type: 'house', size: [9, 9], villager: 'dwelling' }] });
  check(!g1.refused, `item 3: the frontage growth planned (rid ${g1.revisionOf?.rid}, on head ${g1.revisionOf?.parentRid}): ${g1.refused ?? g1.planId}`);
  const w1 = await rvRealise(region, g1, { lots: { bakery: STUB, house_a: STUB } });
  const ir1 = await rvIr(region, g1.revisionOf.rid);
  const gm1 = ir1.revision.grow;
  out.frontage = { rid: g1.revisionOf.rid, grow: gm1, state: w1.r.state };
  const streetsAfter = await Promise.all(T.runs.map((r) => hashOf(streetBox(r))));
  check(w1.r.state === 'PLACED' && gm1.frontage.length === 2 && !gm1.extension && gm1.frontage.every((f) => f.side === freeSide || f.street !== 'street_w'), `item 3: both lots on free frontage (${json(gm1.frontage)}), no extension; the revision ${w1.r.state}`);
  check(json(streetsAfter) === json(streetsBefore), `item 3: every standing street's road and verge cells unchanged (hash over each run's 5-wide band)`);
  // KC: the lots keep clear of the pond's hard and watch columns
  const stand = await call('dev.rv.standing', { region }, 60_000);
  const bodyKeys = new Set([...(await imp('lib/region/beside.mjs')).runKeys([...(stand.standing.bodies?.hard ?? []), ...(stand.standing.bodies?.watch ?? [])])]);
  const inBody = ir1.lots.filter((l) => { for (let x = l.box.minX - 1; x <= l.box.maxX + 1; x++) for (let z = l.box.minZ - 1; z <= l.box.maxZ + 1; z++) if (bodyKeys.has(`${x},${z}`)) return true; return false; });
  check(bodyKeys.size > 0 && inBody.length === 0, `item 9 (KC): the grown lots keep clear of the pond (${bodyKeys.size} hard and watch columns; ${inBody.length} lot(s) within)`);
  // Ask 1: every site the growth wrote carries architect_mc:revision {region, rid}; the lots are listed with their revision
  const t1 = tagged(w1.st, w1.r, region);
  const lots1 = w1.st.view.lots.filter((l) => ['bakery', 'house_a'].includes(l.id));
  check(t1.bad.length === 0 && t1.sites >= 3 && lots1.every((l) => l.revision === g1.revisionOf.rid && l.state === 'placed' && w1.r.sites.includes(l.siteId)), `Ask 1: every site of growth ${g1.revisionOf.rid} tagged architect_mc:revision {region, rid} (${t1.sites} sites: ${json(t1.kinds)}; ${t1.bad.length} untagged); its lots ${json(lots1.map((l) => [l.id, l.state, l.revision]))}`);
  // the Steward addition and the PT build never written
  const d1 = diff(S1, await cellsOf(BIG));
  const touchedAdd = T.addition ? d1.first.filter((s) => s.startsWith(`${T.addition.at[0]},`) && s.includes(`,${T.addition.at[1]} `)) : [];
  check(touchedAdd.length === 0, `item 9: the Steward addition's cells unchanged by the growth`);
  // walkable and connected
  const eff1 = effectiveOf(world, region, (await rvState(region)).headRid, T.ir);
  const { graphCut } = await imp('lib/region/grow.mjs');
  const nav1 = await walkable(ir1.lots, bell);
  out.frontage.nav = nav1;
  check(Object.values(nav1).length === 2 && Object.values(nav1).every((v) => v[0] && v[1]) && graphCut(eff1).length === 0, `item 3: every new lot walkable to the bell and back (dev.nav.villager: ${json(nav1)}); graph.cut ${json(graphCut(eff1))} on the effective IR`);

  // ---- item 4: the extension (6 lots, prefer extend)
  const S2 = await cellsOf(BIG);
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `row_${i + 1}`, type: 'house', size: [9, 9], villager: 'dwelling' }));
  const g2 = await growPlan(region, { lots: six, prefer: 'extend' });
  check(!g2.refused, `item 4: the extension growth planned (rid ${g2.revisionOf?.rid}): ${g2.refused ?? g2.planId}`);
  const w2 = await rvRealise(region, g2, { lots: Object.fromEntries(six.slice(0, 2).map((l) => [l.id, STUB])) });
  const ir2 = await rvIr(region, g2.revisionOf.rid);
  const X = ir2.revision.grow.extension;
  const road = ir2.roads.find((r) => r.id === X?.road);
  const eff2 = effectiveOf(world, region, (await rvState(region)).headRid, T.ir);
  const deg = (id) => eff2.graph.edges.filter((e) => e.from.split('.')[0] === id || e.to.split('.')[0] === id).length;
  out.extension = { rid: g2.revisionOf.rid, grow: ir2.revision.grow, road, state: w2.r.state };
  check(w2.r.state === 'PLACED' && X && road && road.ext?.['architect_mc:street'] && deg(`${X.road}_end`) === 1 && deg(X.from) === 2, `item 4: one extension from ${X?.from}: road ${X?.road} ${json(road?.points)} flagged ${json(road?.ext?.['architect_mc:street'])}; the new end terminal (1 edge), the old end 2 edges; ${X?.lots?.length} lots on it`);
  const t2 = tagged(w2.st, w2.r, region);
  check(t2.bad.length === 0 && (t2.kinds.infra ?? 0) >= 1, `Ask 1: every site of growth ${g2.revisionOf.rid} tagged, the street piece too (${json(t2.kinds)}; ${t2.bad.length} untagged)`);
  const nav2 = await walkable(ir2.lots.filter((l) => X?.lots?.includes(l.id)), bell);
  out.extension.nav = nav2;
  check(Object.values(nav2).length >= 1 && Object.values(nav2).every((v) => v[0] && v[1]) && graphCut(eff2).length === 0, `item 4: the extension's lots walkable to the bell and back (${json(nav2)}); graph.cut ${json(graphCut(eff2))}`);
  // the 6-lot extension undone: the world before it, cell for cell
  const u2 = await call('dev.rv.undo', { region, toPosition: (await rvState(region)).position - 1 }, 4 * 3_600_000);
  const d2 = diff(S2, await cellsOf(BIG));
  out.undoExtension = { result: u2, diff: d2 };
  check(u2.removed === true && d2.n === 0, `item 4: undoRevision of the extension (its road, verges, lanes, pads, lamps and 2 built lots): the world before it, cell for cell (${d2.n} differ)`, d2.first);

  // ---- items 7, 7b: a 1-lot extension (its lot on one side: the other side of its street stays free for a T)
  const g4 = await growPlan(region, { lots: [{ id: 'end_1', type: 'house', size: [9, 9], villager: 'dwelling' }], prefer: 'extend' });
  const w4 = g4.refused ? null : await rvRealise(region, g4, { lots: {} });
  const ir4 = g4.refused ? null : await rvIr(region, g4.revisionOf.rid);
  const X4 = ir4?.revision?.grow?.extension;
  const road4 = ir4?.roads?.find((r) => r.id === X4?.road);
  check(w4?.r?.state === 'PLACED' && road4, `items 7/7b: a 1-lot extension ${X4?.road} ${json(road4?.points)} (rid ${g4.revisionOf?.rid}) ${w4?.r?.state ?? g4.refused}`);
  const S4 = await cellsOf(BIG);
  const pos4 = (await rvState(region)).position;
  const ex = road4.points[1];
  const lotSide = ir4.lots[0].box.minZ > ex[2] ? 1 : -1;
  // item 7: a district east of the town (its seam clear of the extension's road) joins the extension's new end
  const B7 = [Math.max(ex[0] + 4, CLAIM[2] - 14), ex[2] - 40, CLAIM[2] + 80, ex[2] + 40];
  const p7 = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 2 }] } }, claim: B7, beside: region, check: false });
  const j7 = p7.refused ? null : planFiles(p7.planId).ir.graph.edges.find((e) => e.id === 'join_external');
  out.item7 = { claim: B7, plan: p7.refused ?? p7.planId, join: j7 };
  check(!p7.refused && String(j7?.to ?? '').includes(`${X4.road}_end`), `item 7: a beside district planned east of the town joins the extension's new end (${j7?.to ?? p7.refused})`);
  if (!p7.refused) {
    const r7 = await L.realise(p7.planId, { lots: {} });
    const s7 = await L.waitRegion(r7, 3_600_000);
    check(s7.view.state === 'PLACED', `item 7: the district ${r7} ${s7.view.state}`);
    const hBefore = await hashOf(BIG);
    const u7 = await call('dev.rv.undo', { region, toPosition: pos4 - 1 }, 600_000);
    const hAfter = await hashOf(BIG);
    out.item7.undo = u7;
    check(String(u7.refused ?? '').startsWith('NOT_ALLOWED') && /joined/.test(u7.refused ?? '') && (u7.refused ?? '').includes(r7) && hBefore === hAfter, `item 7 (verifier re-runs): undoRevision of the growth refuses at preflight: ${u7.refused ?? json(u7)}; nothing written (hash)`);
    await removeRegion(r7);
    const dd = diff(S4, await cellsOf(BIG));
    check(dd.n === 0, `item 7: the district removed: the world as before it (${dd.n} cells differ)`, dd.first);
  }
  // item 7b: a district on the free side of the extension joins its side by a T (<region>:<roadId>)
  const B7b = lotSide > 0
    ? [ex[0] - 46, CLAIM[1] - 70, ex[0] + 14, CLAIM[1] + 6]
    : [ex[0] - 46, CLAIM[3] - 6, ex[0] + 14, CLAIM[3] + 70];
  const p7b = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'side', size: [32, 32], lots: 2 }] } }, claim: B7b, beside: region, check: false });
  const j7b = p7b.refused ? null : planFiles(p7b.planId).ir.graph.edges.find((e) => e.id === 'join_external');
  out.item7b = { claim: B7b, plan: p7b.refused ?? p7b.planId, join: j7b };
  const sideOnExt = j7b?.junction?.kind === 'side' && String(j7b?.to ?? '').endsWith(`:${X4.road}`);
  check(!p7b.refused && sideOnExt, `item 7b: a beside district on the extension's free side joins it by a T (${json(j7b && { to: j7b.to, junction: j7b.junction })}${p7b.refused ? ` refused ${p7b.refused}` : ''})`);
  if (!p7b.refused) {
    const r7b = await L.realise(p7b.planId, { lots: {} });
    const s7b = await L.waitRegion(r7b, 3_600_000);
    check(s7b.view.state === 'PLACED', `item 7b: the district ${r7b} ${s7b.view.state}`);
    if (sideOnExt) {
      const hBefore = await hashOf(BIG);
      const u7b = await call('dev.rv.undo', { region, toPosition: pos4 - 1 }, 600_000);
      const hAfter = await hashOf(BIG);
      out.item7b.undo = u7b;
      check(String(u7b.refused ?? '').startsWith('NOT_ALLOWED') && /joined/.test(u7b.refused ?? '') && hBefore === hAfter, `item 7b (verifier re-runs): undoRevision refuses joined at preflight: ${u7b.refused ?? json(u7b)}; nothing written (hash)`);
    }
    await removeRegion(r7b);
  }
  // both districts removed: the undo of the 1-lot extension is exact
  const u4 = await call('dev.rv.undo', { region, toPosition: pos4 - 1 }, 4 * 3_600_000);
  const d4 = diff(S2, await cellsOf(BIG));
  out.undoEnd = { result: u4, diff: d4 };
  check(u4.removed === true && d4.n === 0, `items 7/7b: the districts removed, undoRevision of the extension: the world before it, cell for cell (${d4.n} differ)`, d4.first);
  // ---- item 9: every slot held: NO_ROOM {kind: held}, nothing planned
  const held = [];
  for (const run of T.runs) for (const sd of [-1, 1]) for (let u = run.u0; u <= run.u1; u++) { const [x, z] = run.o === 'ew' ? [u, run.c + sd * 4] : [run.c + sd * 4, u]; held.push([x, gy + 1, z, 'minecraft:cobblestone']); }
  const hs = await call('dev.cells.place', { kind: 'steward:addition', cells: held, naturalOnly: false, overlap: 'LAYER', owner: OWNER }, 900_000);
  const before9 = await rvState(region);
  const g9 = await growPlan(region, { lots: [{ id: 'held_1', type: 'house', size: [9, 9] }], extend: 'none' });
  const after9 = await rvState(region);
  out.item9 = { site: hs.siteId, placed: hs.placed, refused: g9.refused, nextRid: [before9.nextRid, after9.nextRid] };
  check(hs.placed && String(g9.refused ?? '').startsWith('NO_ROOM') && /\[held\]/.test(g9.refused ?? '') && after9.nextRid === before9.nextRid, `item 9: with every frontage slot held (a Steward site along both sides of every street: ${hs.placed ? hs.siteId : json(hs)}), a growth answers ${g9.refused ?? 'a plan'}; nothing planned (nextRid ${before9.nextRid} -> ${after9.nextRid})`);
  if (!g9.refused && g9.planId) await call('dev.region.drop', { planId: g9.planId }, 60_000).catch(() => null);
  if (hs.siteId) await call('dev.rv.siteRemove', { site: hs.siteId, force: true }, 600_000);

  // ---- item 8: two growths and a beside district standing: D3's orders, then the town removed: E-flat 0 over the claims
  const g8 = await growPlan(region, { lots: six.slice(0, 3), prefer: 'extend' });
  if (g8.refused) check(false, `item 8: a second extension: ${g8.refused}`);
  else await rvRealise(region, g8, { lots: { row_1: STUB } });
  const ir8 = g8.refused ? null : await rvIr(region, g8.revisionOf.rid);
  const ex8 = ir8?.roads?.[0]?.points?.[1] ?? ex;
  const p8 = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 2 }] } }, claim: [CLAIM[2] - 10, ex8[2] - 40, CLAIM[2] + 80, ex8[2] + 40], beside: region, check: false });
  let r8 = null;
  if (!p8.refused) { r8 = await L.realise(p8.planId, { lots: {} }); await L.waitRegion(r8, 3_600_000); }
  const st8 = await rvState(region);
  out.item8 = { revisions: st8.revisions.map((r) => [r.rid, r.state]), district: r8 ?? p8.refused };
  // the town first (with its growths: the pond, the frontage, the extension), then the dangling district
  const rm = await removeRegion(region);
  if (r8) await removeRegion(r8);
  const d8 = diff(B0, await cellsOf(BIG));
  // (the Steward addition and the PT build are their owners': placed after B0, they stay; everything else is the world before the town)
  const others = d8.first.filter((s) => T.addition && s.startsWith(`${T.addition.at[0]},`) || T.addition && s.startsWith(`${T.addition.at[0] + 1},`));
  const left = [];
  const B1 = await cellsOf(BIG);
  for (const [k] of new Set([...B0, ...B1])) {
    const [x, , z] = k.split(',').map(Number);
    const own = (T.addition && z === T.addition.at[1] && (x === T.addition.at[0] || x === T.addition.at[0] + 1)) || (T.pt && x >= T.pt.box[0] && x <= T.pt.box[3] && z >= T.pt.box[2] && z <= T.pt.box[5]);
    if (own) continue;
    if (norm(B0.get(k) ?? 'minecraft:air') !== norm(B1.get(k) ?? 'minecraft:air')) left.push(`${k} ${B0.get(k)} -> ${B1.get(k)}`);
  }
  out.item8.left = left.slice(0, 12);
  void others;
  check(rm.removed !== false && left.length === 0, `item 8: Regions.remove of the town with ${st8.revisions.filter((r) => r.state === 'PLACED').length} revisions standing (the pond, the frontage, the extension) and a beside district (then removed, dangling): E-flat 0 over the claims + 8 but the Steward addition's and the PT build's own cells (${left.length} differ)`, left.slice(0, 12));
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-beside: items 5, 11, 12 with Steward's key scheme

const STEWARD = (b, d = 'east') => ({ 'steward_mc:district': d, 'steward_mc:build': b });
const landOf = (v) => v.ext?.['architect_mc:land'] ?? null;
const runKeysOf = async (runs) => (await imp('lib/region/beside.mjs')).runKeys(runs ?? []);
const stacksOver = async (runs) => (await call('dev.journal.columns', { runs }, 600_000)).cells ?? [];

steps.beside = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GR Beside';
  await freshFlat(world);
  const gy = await groundY();
  const T = await grTown({ gy, addition: false, pt: false });
  const A = CLAIM;
  // the reservation east of the town's east street end, plus the 16-column seam into the town's claim (Steward's claim, DISTRICTS.md §9)
  const e = T.runs.find((r) => r.road === 'street_e') ?? T.runs[0];
  const B = [A[2] - 15, e.c - 45, A[2] + 90, e.c + 45];
  const BOX = [A[0] - 8, gy - 12, B[1] - 8, B[2] + 8, gy + 24, Math.max(A[3], B[3]) + 8];
  const TOWN = [A[0], gy - 12, A[1], A[2], gy + 24, A[3]];
  const params = { spec: { districts: [{ id: 'east', size: [64, 56], lots: [{ id: 'east_1', type: 'house', size: [9, 9] }, { id: 'east_2', type: 'house', size: [9, 9] }] }] } };
  const verdict = await call('dev.region.checkBeside', { program: 'districts', params, claim: B, beside: T.region, surveyLoad: 'bounded:256', owner: OWNER, check: false }, 900_000);
  out.verdict = { fits: verdict.fits, join: verdict.join };
  check(verdict.fits, `item 5: checkBeside (Steward's dry check) beside ${T.region} over the reservation + 16: ${json(verdict.join ?? verdict.message)}`);
  // building 1: Regions.plan under steward.b1.vplan (ext steward_mc:district, steward_mc:build), realised under steward.b1.vrealise
  const p1 = await planReq({ program: 'districts', params, claim: B, beside: T.region, check: false, opKey: 'steward.b1.vplan', ext: STEWARD('b1') });
  if (p1.refused) throw new Error(`the district's first building refused: ${p1.refused}`);
  const ra = await call('dev.region.realise', { planId: p1.planId, lots: { east_1: STUB }, opKey: 'steward.b1.vrealise', ext: STEWARD('b1') }, 300_000);
  const D = ra.region;
  const s1 = await L.waitRegion(D, 3_600_000);
  const land0 = landOf(s1.view);
  out.district = { region: D, state: s1.view.state, land: land0 && { v: land0.v, outside: land0.outside.cells, inside: land0.inside.cells } };
  check(s1.view.state === 'PLACED' && land0?.v === 1, `item 5: the district ${D} PLACED beside ${T.region} (building 1 under Steward's keys), its land v ${land0?.v} (outside ${land0?.outside?.cells}, inside ${land0?.inside?.cells})`);
  const townHash0 = await hashOf(TOWN);
  const W0 = await cellsOf(BOX);
  // buildings 3 and 4: each one growth, an ordinary Steward build under its own keys
  const grow1 = (b, id) => growPlan(D, { district: 'east', lots: [{ id, type: 'house', size: [9, 9], villager: 'dwelling' }] }, { program: 'districts', opKey: `steward.${b}.vplan`, ext: STEWARD(b) });
  const g3 = await grow1('b3', 'east_3');
  check(!g3.refused, `item 5: building 3 planned as a growth (planRevision(district's program, {grow}) under steward.b3.vplan): rid ${g3.revisionOf?.rid} ${g3.refused ?? ''}`);
  const k3 = await call('dev.coa.planByKey', { owner: OWNER, opKey: 'steward.b3.vplan' }, 10_000).catch((x) => ({ error: String(x) }));
  check(k3.planId === g3.planId, `S-GR-3: planByKey(steward.b3.vplan) finds the growth's plan (${k3.planId})`);
  const w3 = await rvRealise(D, g3, { lots: { east_3: STUB }, opKey: 'steward.b3.vrealise', ext: STEWARD('b3') });
  const W3 = await cellsOf(BOX);
  const v3 = (await call('dev.region.state', { region: D }, 60_000)).view;
  const land3 = landOf(v3);
  const t3 = tagged(w3.st, w3.r, D);
  const callers3 = w3.r.sites.map((sid) => w3.st.siteCaller?.[sid]?.['steward_mc:build']);
  out.b3 = { rid: g3.revisionOf.rid, state: w3.r.state, land: land3 && { v: land3.v, outside: land3.outside.cells, parts: land3.parts.map((q) => [q.kind, q.id, q.revision]) }, tagged: t3, callers: callers3 };
  check(w3.r.state === 'PLACED' && t3.bad.length === 0 && callers3.every((b) => b === 'b3'), `Ask 1 / keys: building 3's growth ${w3.r.state}; every site it wrote tagged architect_mc:revision {${D}, ${g3.revisionOf.rid}} and carrying steward_mc:build b3 (${t3.sites} sites: ${json(t3.kinds)})`);
  const g3p = land3?.parts?.find((q) => q.kind === 'grown' && q.revision === g3.revisionOf.rid);
  check(land3?.v === 2 && g3p && g3p.insideCells === 0 && land3.outside.cells > land0.outside.cells && json(land3.inside) === json(land0.inside) && land3.parts.every((q) => Number.isInteger(q.revision)), `item 12: land v ${land3?.v}: the grown part ${json(g3p && [g3p.id, g3p.district, g3p.cells, g3p.insideCells])}, outside ${land0.outside.cells} -> ${land3?.outside?.cells}, inside unchanged, every part carries its revision`);
  const rk = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'steward.b3.vrealise' }, 10_000).catch((x) => ({ error: String(x) }));
  check(rk.region?.id === D, `S-GR-3: realiseByKey(steward.b3.vrealise) finds the district (${json(rk.region?.id ?? rk)})`);
  const g4 = await grow1('b4', 'east_4');
  if (g4.refused) throw new Error(`building 4's growth refused: ${g4.refused}`);
  const w4 = await rvRealise(D, g4, { lots: { east_4: STUB }, opKey: 'steward.b4.vrealise', ext: STEWARD('b4') });
  const v4 = (await call('dev.region.state', { region: D }, 60_000)).view;
  const land4 = landOf(v4);
  out.b4 = { rid: g4.revisionOf?.rid, state: w4.r.state, outside: land4?.outside?.cells };
  check(w4.r.state === 'PLACED' && land4.outside.cells > land3.outside.cells, `item 5: building 4's growth ${w4.r.state} (rid ${g4.revisionOf?.rid}); land.outside ${land3.outside.cells} -> ${land4.outside.cells}`);
  // item 12: every column the district holds in the journal lies in land.union
  const union = await runKeysOf(land4.union.runs);
  const rows = [];
  for (let z = B[1] - 4; z <= B[3] + 4; z++) rows.push([B[0] - 4, z, B[2] + 4, z]);
  const own = (await stacksOver(rows)).filter((c) => c.stack.some((q) => q.group === v4.groupId));
  const outU = own.filter((c) => !union.has(`${c.x},${c.z}`));
  check(own.length > 0 && outU.length === 0, `item 12: every column the district holds in the journal lies in land.union (${new Set(own.map((c) => `${c.x},${c.z}`)).size} columns; ${outU.length} outside: ${json(outU.slice(0, 4).map((c) => [c.x, c.z]))})`);
  // a restart: the keys still find both growths
  await L.leaveWorld();
  await L.openWorld(world);
  await L.tp(CX + 80, 60, CZ + 56);
  const rk4 = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'steward.b4.vrealise' }, 10_000).catch((x) => ({ error: String(x) }));
  const pk4 = await call('dev.coa.planByKey', { owner: OWNER, opKey: 'steward.b4.vplan' }, 10_000).catch((x) => ({ error: String(x) }));
  check(rk4.region?.id === D && pk4.planId === g4.planId, `S-GR-3: after a restart realiseByKey(steward.b4.vrealise) -> ${rk4.region?.id}, planByKey(steward.b4.vplan) -> ${pk4.planId}`);
  // undoRevision 4 then 3 (one building at a time): the world before each; land.outside shrinks (Ask 2); the join and the town untouched
  const u4 = await call('dev.rv.undo', { region: D, toPosition: 1, actor: 'steward' }, 4 * 3_600_000);
  const d4 = diff(W3, await cellsOf(BOX));
  const landU4 = landOf((await call('dev.region.state', { region: D }, 60_000)).view);
  out.undo4 = { result: u4, diff: d4.n, outside: landU4?.outside?.cells };
  check(u4.removed === true && d4.n === 0, `item 5 (verifier re-runs): undoRevision of building 4: the world before it, cell for cell (${d4.n} differ)`, d4.first);
  check(landU4?.v === 2 && landU4.outside.cells === land3.outside.cells && !landU4.parts.some((q) => q.revision === g4.revisionOf.rid), `Ask 2: land.outside shrinks after undoRevision: ${land4.outside.cells} -> ${landU4?.outside?.cells} (as after building 3: ${land3.outside.cells}); building 4's part gone; v stays 2`);
  const u3 = await call('dev.rv.undo', { region: D, toPosition: 0, actor: 'steward' }, 4 * 3_600_000);
  const d3 = diff(W0, await cellsOf(BOX));
  const landU3 = landOf((await call('dev.region.state', { region: D }, 60_000)).view);
  out.undo3 = { result: u3, diff: d3.n, outside: landU3?.outside?.cells };
  check(u3.removed === true && d3.n === 0, `item 5 (verifier re-runs): undoRevision of building 3: the world before it, cell for cell (${d3.n} differ)`, d3.first);
  check(landU3?.v === 2 && landU3.outside.cells === land0.outside.cells && json(landU3.union) === json(land0.union) && !landU3.parts.some((q) => q.kind === 'grown'), `Ask 2 / item 12: after both undos land.union equals the one before the growths (outside ${landU3?.outside?.cells} = ${land0.outside.cells}); no grown part; v ${landU3?.v}`);
  check((await hashOf(TOWN)) === townHash0, `item 5: the town untouched (its claim's hash) through both growths and both undos; the district's join stands (its cells inside the world before the growths, above)`);
  // ---- item 11: an outpost grown by 2; its corridor byte-identical
  await removeRegion(D);
  const O = [A[2] + 1, A[1] - 60, A[2] + 160, A[3] + 60];
  const po = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'camp', size: [40, 40], lots: 2, outpost: { gap: 40 } }] } }, claim: O, beside: T.region, check: false });
  if (po.refused) check(false, `item 11: the outpost's plan refused (${po.refused})`);
  else {
    const ro = await L.realise(po.planId, { lots: {} });
    const so = await L.waitRegion(ro, 3_600_000);
    const cor0 = json(planFiles(po.planId).ir.corridor);
    const corLand0 = json(landOf(so.view)?.parts?.find((q) => q.kind === 'corridor'));
    const go = await growPlan(ro, { district: 'camp', lots: 2 }, { program: 'districts' });
    const wo = go.refused ? null : await rvRealise(ro, go);
    const effO = effectiveOf(world, ro, (await rvState(ro)).headRid, planFiles(po.planId).ir);
    const vo = (await call('dev.region.state', { region: ro }, 60_000)).view;
    const corLand1 = landOf(vo)?.parts?.find((q) => q.kind === 'corridor');
    out.outpost = { region: ro, grow: go.refused ?? go.revisionOf?.rid, state: wo?.r?.state };
    check(wo?.r?.state === 'PLACED' && json(effO.corridor) === cor0 && json({ ...corLand1, revision: undefined }) === json({ ...JSON.parse(corLand0 ?? 'null'), revision: undefined }), `item 11: the outpost grown by 2 lots (${json(go.refused ?? (await rvIr(ro, go.revisionOf.rid))?.revision?.grow?.lots)}): ${wo?.r?.state}; architect_mc:corridor byte-identical (the effective IR's and the land's corridor part)`);
    const nav = go.refused ? {} : await walkable((await rvIr(ro, go.revisionOf.rid)).lots, T.ir.anchors.bell);
    check(Object.values(nav).length >= 1 && Object.values(nav).every((v) => v[0] && v[1]), `item 11: the outpost's new lots walkable to the town's bell and back (${json(nav)})`);
    await removeRegion(ro);
  }
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-along: item 10 (an along district grown: frontage, then its boundary)

steps.along = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GR Along';
  await freshFlat(world);
  const gy = await groundY();
  const T = await grTown({ gy, addition: false, pt: false, claim: [CX, CZ, CX + 111, CZ + 111] });
  const A = [CX, CZ, CX + 111, CZ + 111];
  // d3_shore (D3's fixture, longer): a water strip east of the town's claim, a shore district along it (a short band: room to grow along)
  // (the claim runs 150 north of the town: the band's free route end has shore to grow along)
  const B = [A[2] + 1, A[1] - 150, A[2] + 110, A[3] + 20];
  await cmd(`/fill ${A[2] + 70} ${gy - 3} ${A[1] - 145} ${A[2] + 80} ${gy} ${A[1] - 40} minecraft:water`);
  await cmd(`/fill ${A[2] + 70} ${gy - 3} ${A[1] - 39} ${A[2] + 80} ${gy} ${A[3] + 15} minecraft:water`);
  const shore = { spec: { districts: [{ id: 'quay', size: [48, 24], lots: 2, follow: { shore: {} } }] } };
  const p = await planReq({ program: 'districts', params: shore, claim: B, beside: T.region, check: false });
  if (p.refused) { check(false, `item 10: the shore district's plan refused (${p.refused})`); await L.leaveWorld(); return out; }
  const r = await L.realise(p.planId, { lots: {} });
  const s0 = await L.waitRegion(r, 3_600_000);
  check(s0.view.state === 'PLACED', `item 10: a shore district ${r} beside ${T.region} PLACED`);
  const BOX = [B[0] - 4, gy - 12, B[1] - 4, B[2] + 4, gy + 24, B[3] + 4];
  const W0 = await cellsOf(BOX);
  const land0 = landOf(s0.view);
  const g = await growPlan(r, { district: 'quay', lots: 3, prefer: 'frontage' }, { program: 'districts' });
  check(!g.refused, `item 10: the along district's growth (3 lots) planned: ${g.refused ?? `rid ${g.revisionOf?.rid}`}`);
  if (g.refused) { await L.leaveWorld(); return out; }
  const w = await rvRealise(r, g, { lots: {} });
  const ir = await rvIr(r, g.revisionOf.rid);
  const gm = ir.revision.grow;
  out.grow = gm;
  check(w.r.state === 'PLACED' && gm.lots.length === 3, `item 10: grown by ${gm.lots.length} lots: frontage ${json(gm.frontage.map((f) => f.lot))}, extension ${json(gm.extension && { kind: gm.extension.kind, lots: gm.extension.lots })}; ${w.r.state}`);
  // frontage first (S-GR-1); along the boundary only when the frontage is full
  check(gm.frontage.length >= 1 && (!gm.extension || gm.extension.kind === 'boundary'), `item 10: frontage first, then the boundary (${gm.frontage.length} on frontage)`);
  // walkable from every grown lot to the district's street end (its route end junction)
  const effA = effectiveOf(world, r, (await rvState(r)).headRid, planFiles(p.planId).ir);
  const endNode = effA.graph.nodes.find((n) => /^quay_s\d+$/.test(n.id));
  const nav = {};
  for (const l of ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e || !endNode) continue;
    const there = await call('dev.nav.villager', { from: e, to: endNode.at, range: 320 }, 120_000).catch((x) => ({ error: String(x) }));
    nav[l.id] = !!there.canReach;
  }
  out.nav = nav;
  check(Object.values(nav).length === 3 && Object.values(nav).every(Boolean), `item 10: every grown lot walkable to the district's street end ${endNode?.id} (${json(nav)})`);
  const { graphCut } = await imp('lib/region/grow.mjs');
  check(graphCut(effA, { from: endNode?.id }).length === 0, `item 10: graph.cut [] from the street end`);
  // the boundary growth's band in land v 2 (a district mask part with its revision); then the boundary ends inside the claim: a second
  // growth along it answers NO_ROOM [boundary], nothing planned (§5)
  const land1 = landOf((await call('dev.region.state', { region: r }, 60_000)).view);
  check(gm.extension?.kind === 'boundary' && land1?.v === 2 && land1.parts.some((q) => q.kind === 'district' && q.shape === 'mask' && q.revision === g.revisionOf.rid) && land1.outside.cells > land0.outside.cells, `item 10: land v ${land1?.v} holds the new band (a district mask part, revision ${g.revisionOf.rid}); outside ${land0?.outside?.cells} -> ${land1?.outside?.cells}`);
  const before2 = await rvState(r);
  const g2 = await growPlan(r, { district: 'quay', lots: 2, prefer: 'extend', extend: 'auto' }, { program: 'districts' });
  const after2 = await rvState(r);
  out.grow2 = g2.refused ?? g2.planId;
  check(/^NO_ROOM/.test(String(g2.refused ?? '')) && /\[(boundary|frontage)\]/.test(g2.refused) && after2.nextRid === before2.nextRid, `item 10: where the boundary ends inside the claim (the shore's end 13 spine cells past the band) a further growth answers ${g2.refused ?? 'a plan'}; nothing planned`);
  // both undone: the world before the growths; land.outside back
  const u = await call('dev.rv.undo', { region: r, toPosition: 0 }, 4 * 3_600_000);
  const d = diff(W0, await cellsOf(BOX));
  const landU = landOf((await call('dev.region.state', { region: r }, 60_000)).view);
  check(u.removed === true && d.n === 0 && landU?.outside?.cells === land0?.outside?.cells, `item 10: undoRevision to 0: the world before the growths (${d.n} differ); land.outside ${landU?.outside?.cells} = ${land0?.outside?.cells}`, d.first);
  await removeRegion(r);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-plan0: item 6 (plan/0's revision.grow through checkPlan and realiseApproved)

const P0_LOT = (id) => ({ id, type: 'house', size: [9, 9] });
const P0_TOWN = { schemaVersion: 'plan/0', planId: 'gr_town', zones: [{ id: 'town', program: { lots: [P0_LOT('h1'), P0_LOT('h2'), P0_LOT('h3')] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
const P0_CLAIM = [CX, CZ, CX + 159, CZ + 111];
async function checkPlan(plan, claim) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER }, 900_000);
  if (r.refused) { log(`  check refused: ${r.refused}`); return r; }
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'}`);
  return r.check;
}
const grownPlan = (parent, lots, n = 1) => ({ ...P0_TOWN, zones: [{ ...P0_TOWN.zones[0], program: { lots: [...P0_TOWN.zones[0].program.lots, ...lots] } }], revision: { n, parentArtifact: parent } });

steps.plan0 = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GR Plan0';
  await freshFlat(world);
  const gy = await groundY();
  const BOX = BOXOF(P0_CLAIM, gy);
  const B0 = await cellsOf(BOX);
  const c0 = await checkPlan(P0_TOWN, P0_CLAIM);
  check(c0.overall === 'READY', `the parent plan checked: ${c0.overall}`);
  const ra = await call('dev.region.realiseApproved', { sha: c0.artifactSha, lotEntries: { h1: STUB } }, 300_000);
  const region = ra.region;
  const st0 = await L.waitRegion(region, 3_600_000);
  check(st0.view.state === 'PLACED', `realiseApproved: region ${region} ${st0.view.state}`);
  const S0 = await cellsOf(BOX);
  // item 6: the zone gains 2 lots: fits standing, grown [h4, h5]; the artifact's $.lots are the 2 lots
  const c1 = await checkPlan(grownPlan(c0.artifactSha, [P0_LOT('h4'), P0_LOT('h5')]), P0_CLAIM);
  const t1 = c1.parts?.find((p) => p.part === 'town');
  const art1 = c1.artifactSha ? (await call('dev.region.artifact', { sha: c1.artifactSha, body: true }, 60_000)).artifact : null;
  out.check1 = { overall: c1.overall, town: t1, lots: art1?.body?.lots?.map((l) => l.id), revision: art1?.body?.revision };
  check(c1.overall === 'READY' && t1?.class === 'fits' && t1?.standing === true && json(t1?.grown) === json(['h4', 'h5']), `item 6: checkPlan of the grown zone: ${c1.overall}; town ${t1?.class} standing ${t1?.standing} grown ${json(t1?.grown)}`);
  check(json(art1?.body?.lots?.map((l) => l.id).sort()) === json(['h4', 'h5']) && json(art1?.body?.revision?.grow) === json(['town']) && art1?.body?.region?.revisionOf?.region === region, `item 6: the artifact: $.lots ${json(art1?.body?.lots?.map((l) => l.id))}, revision.grow ${json(art1?.body?.revision?.grow)}, revisionOf ${json(art1?.body?.region?.revisionOf)}`);
  // a competing growth on the same parent realised first: the head moves, so c1's realise is stale
  const c2 = await checkPlan(grownPlan(c0.artifactSha, [P0_LOT('h6')]), P0_CLAIM);
  const r2 = await call('dev.region.realiseApproved', { sha: c2.artifactSha, lotEntries: { h6: STUB }, opKey: 'gr.p0.first' }, 300_000);
  check(r2.region === region, `a competing growth realised first under gr.p0.first: ${json(r2)}`);
  const st2 = await rvState(region);
  await rvWait(region, st2.revisions.at(-1).rid);
  const S2 = await cellsOf(BOX);
  const rs = await call('dev.region.realiseApproved', { sha: c1.artifactSha, lotEntries: { h4: STUB }, opKey: 'gr.p0.k1' }, 300_000);
  check(/^(PLAN_STALE|ARTIFACT_STALE)/.test(String(rs.refused ?? '')), `item 6: the first growth's realiseApproved under gr.p0.k1 refuses stale (the head moved): ${rs.refused}`);
  // across a restart: the stale retry, checked again on the new head's artifact, realised under a second key
  await L.leaveWorld();
  await L.openWorld(world);
  await L.tp(CX + 80, 60, CZ + 56);
  const c3 = await checkPlan(grownPlan(c2.artifactSha, [P0_LOT('h4'), P0_LOT('h5')], 2), P0_CLAIM);
  void c3;
  // (the parent plan of the retry is the head's: the zone as c2 grew it, plus the two lots)
  const c3b = await checkPlan({ ...grownPlan(c2.artifactSha, [P0_LOT('h6'), P0_LOT('h4'), P0_LOT('h5')], 2) }, P0_CLAIM);
  const t3 = c3b.parts?.find((p) => p.part === 'town');
  check(c3b.overall === 'READY' && json(t3?.grown) === json(['h4', 'h5']), `item 6: after the restart the retry checked on the new head: ${c3b.overall}, grown ${json(t3?.grown)}`);
  const r3 = await call('dev.region.realiseApproved', { sha: c3b.artifactSha, lotEntries: { h4: STUB }, opKey: 'gr.p0.k2' }, 300_000);
  check(r3.region === region, `item 6: realiseApproved under the second key gr.p0.k2 answers the region: ${json(r3)}`);
  const st3 = await rvState(region);
  const w3 = await rvWait(region, st3.revisions.at(-1).rid);
  const lots3 = w3.st.view.lots.filter((l) => ['h4', 'h5'].includes(l.id));
  check(w3.r.state === 'PLACED' && w3.r.artifact === c3b.artifactSha && lots3.length === 2 && lots3.every((l) => l.revision === w3.r.rid), `item 6: the growth ${w3.r.state} (rid ${w3.r.rid}, artifact ${w3.r.artifact?.slice(0, 12)}); its lots ${json(lots3.map((l) => [l.id, l.state, l.revision]))}`);
  // undo both: the world before the growths; the artifacts tombstoned; removal E-flat 0
  const u = await call('dev.rv.undo', { region, toPosition: 1 }, 4 * 3_600_000);
  const d1 = diff(S2, await cellsOf(BOX));
  check(u.removed === true && d1.n === 0, `item 6: the retry's growth undone: the world before it (${d1.n} differ)`, d1.first);
  const u0 = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  const d0 = diff(S0, await cellsOf(BOX));
  const a3 = (await call('dev.region.artifact', { sha: c3b.artifactSha }, 60_000)).artifact;
  check(u0.removed === true && d0.n === 0 && a3?.removed === true, `item 6: both growths undone: the world before them (${d0.n} differ); the retry's artifact tombstoned (${a3?.removed})`, d0.first);
  const rm = await removeRegion(region);
  const df = diff(B0, await cellsOf(BOX));
  check(rm.removed !== false && df.n === 0, `the region removed: E-flat 0 (${df.n} differ)`, df.first);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-survival: item 13 (Steward's RC rows: a survival growth; survival_building)

const G = await import('./lib/gate6crs-game.mjs');
const plusB = (a, b) => G.plus(a, b);
/** Feed a survival region from its owner's stockpile until `until` holds (RS's waves: what the targets lack). */
async function feedUntil(region, until, { timeoutMs = 1_800_000 } = {}) {
  return G.feed({ L }, region, { fraction: 1, until, timeoutMs, every: 2500 });
}

steps.survival = async () => {
  await ensure();
  const out = {};
  const ctx = { L, OUT };
  const SW = 'G6B GR Survival';
  await G.survivalBase(ctx);
  await L.fresh(SW, G.SURV);
  await L.setRules('exact');
  await cmd('/weather clear');
  await L.tp(CX + 80, 80, CZ + 56);
  const gy = await groundY();
  const claim = P0_CLAIM;
  const BOX = BOXOF(claim, gy);
  // the stockpile's crates outside the claim (the RS owner's: G.feed books into it)
  const crates = [0, 1, 2, 3].map((k) => [claim[0] - 6 + 2 * k, gy + 1, claim[1] - 6]);
  const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
  check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
  const B0 = await cellsOf(BOX);
  // the town in survival: checked in survival, realised, fed until built
  const c0 = (await call('dev.region.checkPlan', { plan: P0_TOWN, claim, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
  check(c0?.survival === true && c0.overall === 'READY', `the town checked in survival: ${c0?.overall}, survival ${c0?.survival}`);
  const region = await G.realise(ctx, c0.artifactSha);
  const f0 = await feedUntil(region, (st, rs) => st.view.state === 'PLACED' && rs.build?.done);
  check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `the town built in survival: ${f0.last.st.view.state}, build ${json(f0.last.rs.build && { done: f0.last.rs.build.done, percent: f0.last.rs.build.percent })} (${f0.waves} waves)`);
  const targets0 = new Set((f0.last.rs.targets ?? []).map((t) => t.id));
  const S0 = await cellsOf(BOX);
  const ps0 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  // item 13: a frontage growth checked in survival: its whole bill is the check's; realised; while building, undo refuses survival_building
  const c1 = (await call('dev.region.checkPlan', { plan: grownPlan(c0.artifactSha, [P0_LOT('h4'), P0_LOT('h5')]), claim, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
  const t1 = c1?.parts?.find((p) => p.part === 'town');
  out.check = { overall: c1?.overall, survival: c1?.survival, town: t1 && { class: t1.class, grown: t1.grown, cost: t1.cost }, bom: c1?.cost?.bom, bomParts: c1?.cost?.bomParts };
  check(c1?.survival === true && c1.overall === 'READY' && t1?.class === 'fits' && json(t1?.grown) === json(['h4', 'h5']), `item 13: the growth checked in survival: ${c1?.overall}; town ${t1?.class} grown ${json(t1?.grown)}; its bill ${json(c1?.cost?.bom)}`);
  const r1 = await call('dev.region.realiseApproved', { sha: c1.artifactSha }, 300_000);
  check(r1.region === region, `item 13: realiseApproved of the survival growth answers the region: ${json(r1)}`);
  const stv = await rvState(region);
  const rid = stv.revisions.at(-1)?.rid;
  // the growth's targets put down and waiting for their items (nothing fed yet): undoRevision refuses survival_building
  let rsb = null;
  for (let i = 0; i < 60; i++) {
    rsb = await call('dev.rs.state', { region }, 120_000);
    if ((rsb.targets ?? []).some((t) => !targets0.has(t.id) && !t.done)) break;
    await sleep(2000);
  }
  out.beforeFeed = { build: rsb?.build && { done: rsb.build.done, percent: rsb.build.percent }, waiting: (rsb?.targets ?? []).filter((t) => !targets0.has(t.id)).map((t) => [t.id, t.done]) };
  const h0 = await hashOf(BOX);
  const ub = await call('dev.rv.undo', { region, toPosition: 0 }, 600_000);
  const h1 = await hashOf(BOX);
  out.building = { refused: ub.refused, same: h0 === h1 };
  check(String(ub.refused ?? '').startsWith('NOT_ALLOWED') && /survival_building/.test(ub.refused) && h0 === h1, `Steward RC row 3: undoRevision while the growth's targets build refuses ${ub.refused}; nothing written (hash)`);
  // fed until built: the growth's targets' bills equal the check's bill (the region's own cells; lots without entries are pads)
  const f1 = await feedUntil(region, (st, rs) => st.view.state === 'PLACED' && rs.build?.done);
  const rs1 = await call('dev.rs.state', { region }, 120_000);
  const newT = (rs1.targets ?? []).filter((t) => !targets0.has(t.id));
  let got = {};
  for (const t of newT) got = plusB(got, t.bom);
  const S1 = await cellsOf(BOX);
  const ps1 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  // the bill the growth paid: what the stockpile's ledger consumed for it, against the check's whole BOM (the growth's lots bind no entry:
  // their pads are terrain; the paid cells are the growth's lamps, lanes and pads' paid blocks)
  const paid = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
  const want = { ...(c1.cost?.bom ?? {}) };
  out.bills = { want, paid, targets: newT.map((t) => [t.id, t.part, t.done, t.bom]), targetsBom: got };
  check(rs1.build?.done && f1.last.st.view.state === 'PLACED', `item 13: the growth (rid ${rid}) built in survival: build ${json(rs1.build && { done: rs1.build.done, percent: rs1.build.percent })} (${f1.waves} waves)`);
  check(Object.keys(want).length >= 1 && G.same(want, paid) && (!newT.length || G.same(got, want)), `item 13 / Steward RC row 2: the growth's bills equal its BOM item for item: the check's cost.bom ${json(want)}, the stockpile paid ${json(paid)}${newT.length ? `, its targets' bills ${json(got)}` : ''}`, out.bills);
  // undoRevision: the refund once per key (what the growth consumed comes back once; a second undo has nothing to take)
  const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  const ps2 = (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const d = diff(S0, await cellsOf(BOX));
  const consumed = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
  out.undo = { result: u, consumed, refund: u.refund, stockBefore: ps1.stock, stockAfter: ps2.stock };
  const refundBack = G.minus(G.plus(ps2.stock ?? {}, ps2.ledger?.refundOverflow ?? {}), G.plus(ps1.stock ?? {}, ps1.ledger?.refundOverflow ?? {}));
  check(u.removed === true && d.n === 0, `item 13: undoRevision of the survival growth: the world before it (${d.n} differ)`, d.first);
  check(G.same(u.refund ?? {}, G.plus({}, u.refund ?? {})) && Object.values(u.refund ?? {}).every((n) => n > 0) && G.same(consumed, u.refund ?? {}), `item 13: the refund once per key: what the growth consumed ${json(consumed)} came back as ${json(u.refund)} (the stockpile's stock moved by ${json(refundBack)})`, out.undo);
  const u2 = await call('dev.rv.undo', { region, toPosition: 0 }, 60_000);
  check(String(u2.refused ?? '').startsWith('NOT_ALLOWED'), `item 13: a second undo has nothing left to refund (refused: ${u2.refused})`);
  const rm = await G.remove(ctx, region);
  const df = diff(B0, await cellsOf(BOX));
  const left = df.first.filter((m) => !crates.some((c) => m.startsWith(`${c[0]},${c[1]},${c[2]} `)));
  check(rm.removed !== false && left.length === 0, `the region removed: E-flat 0 but the stockpile's crates (${df.n} differ, ${left.length} not crates)`, left);
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-crash: the growth's kill points (realise and undo)

async function haltWait() {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const st = await call('dev.state', {}, 10_000).catch(() => null);
    if (st && st.inWorld === false) return true;
  }
  return false;
}
const SIX = Array.from({ length: 4 }, (_, i) => ({ id: `row_${i + 1}`, type: 'house', size: [9, 9], villager: 'dwelling' }));

steps.crash = async () => {
  await ensure();
  const out = {};
  // the realise half: kills while a growth (frontage and an extension: tiles and a road) is accepted, installed and written
  for (const point of ['RV3', 'RV4', 'RG4+save', 'RD3', 'RD3+save']) {
    const tag = point.replace('+', '_');
    const world = `G6B GR Crash ${tag}`;
    await freshFlat(world);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const T = await grTown({ gy, addition: false, pt: false });
    const S0 = await cellsOf(BOX);
    const p = await growPlan(T.region, { lots: SIX, prefer: 'extend' });
    if (p.refused) { check(false, `${point}: the growth's plan refused (${p.refused})`); await L.leaveWorld(); continue; }
    const rid = p.revisionOf.rid;
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.region.realise', { planId: p.planId, lots: { row_1: STUB } }, 300_000).catch(() => null);
    const down = await haltWait();
    check(down, `${point}: the kill point halted the server during the growth's realise`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
    await L.openWorld(world);
    await L.tp(CX + 80, 60, CZ + 56);
    await sleep(3000);
    const w = await rvWait(T.region, rid);
    const items = w.st.items[String(rid)] ?? {};
    const batches = new Set(w.st.revisions.map((r) => r.batchId).filter(Boolean));
    const o = { revision: w.r.state, items };
    check(w.r.state === 'PLACED' && Object.values(items).every((x) => x.startsWith('PLACED')) && batches.size === 1 && Object.keys(items).some((k) => k.startsWith('road:')), `${point}: after the restart the growth ${w.r.state}; its items ${json(Object.entries(items).map(([k, x]) => [k.split(':')[0], x.split('@')[0]]))} each once (one batch; its street piece among them)`);
    const t = tagged(w.st, w.r, T.region);
    const placedSites = [...new Set(Object.values(items).map((x) => x.split('@')[1]).filter(Boolean))].sort();
    const listed = [...w.r.sites].sort();
    check(t.bad.length === 0 && json(listed) === json(placedSites), `${point}: every site of the growth listed in RevisionView.sites and tagged after the recovery (${json(t.kinds)}; ${listed.length} listed, ${placedSites.length} placed by its items)`);
    const u = await call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000);
    const d = diff(S0, await cellsOf(BOX));
    o.undo = { removed: u.removed, diff: d };
    // (RG4+save: RV's finding, main's behaviour: the halted tile's first written cell may stay after an undo (RP §6's PLACING leftover))
    const asMain = point.endsWith('+save') && d.n <= 1;
    check(u.removed === true && (d.n === 0 || asMain), `${point}: then undoRevision: the world before the growth (${d.n} differ${asMain && d.n ? ': main\'s +save leftover, RV\'s recorded finding' : ''})`, d.first);
    out[tag] = o;
    await removeRegion(T.region);
    await L.leaveWorld();
  }
  // the undo half: a growth with a road undone, killed at the commit (RVU1), after the drain (RVU2) and at a stage undo's commit (K6)
  for (const point of ['RVU1', 'RVU2', 'K6']) {
    const world = `G6B GR UndoCrash ${point}`;
    await freshFlat(world);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const T = await grTown({ gy, addition: false, pt: false });
    const S0 = await cellsOf(BOX);
    const p = await growPlan(T.region, { lots: SIX, prefer: 'extend' });
    if (p.refused) { check(false, `${point}: the growth's plan refused (${p.refused})`); await L.leaveWorld(); continue; }
    await rvRealise(T.region, p, { lots: { row_1: STUB } });
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
    const down = await haltWait();
    check(down, `${point}: the kill point halted the server during the growth's undo`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
    await L.openWorld(world);
    await L.tp(CX + 80, 60, CZ + 56);
    let st;
    const t0 = Date.now();
    for (; Date.now() - t0 < 1_800_000;) { st = await rvState(T.region); if (st.busy === null) break; await sleep(L.pollDelayMs(Date.now() - t0)); }
    const d = diff(S0, await cellsOf(BOX));
    out[point] = { after: { busy: st.busy, position: st.position, states: st.revisions.map((r) => [r.rid, r.state]) }, diff: d };
    check(st.busy === null && st.position === 0 && st.revisions.every((r) => r.state === 'UNDONE') && d.n === 0, `${point}: after the restart the undo resumed and finished: position ${st.position}, ${json(st.revisions.map((r) => [r.rid, r.state]))}; the world before the growth (its road and lots gone): ${d.n} differ`, d.first);
    await removeRegion(T.region);
    await L.leaveWorld();
  }
  spendZero();
  return out;
};

// ------------------------------------------------------------------ gr-look: N-GR-1 and N-GR-2 (a client; shots for the gallery)

steps.look = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GR Look';
  await freshFlat(world);
  const gy = await groundY();
  const T = await grTown({ gy, addition: false, pt: false });
  const shot = async (name, at, yaw, pitch) => {
    await L.tp(at[0], at[1], at[2], yaw, pitch);
    await L.settle(2500);
    const f = path.join(OUT, 'shots', `${name}.png`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const r = await call('dev.screenshot', { name: `gr_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000).catch((e) => ({ error: String(e) }));
    if (r.path && fs.existsSync(r.path)) fs.copyFileSync(r.path, f);
    out.shots ??= {};
    out.shots[name] = { file: f, ok: !r.error && fs.existsSync(f), at, yaw, pitch, error: r.error };
    return r;
  };
  await cmd('/time set day');
  await cmd('/gamerule doDaylightCycle false').catch(() => null);
  const mid = [CX + 80, gy + 70, CZ + 56];
  await shot('before', mid, 0, 90);
  const g1 = await growPlan(T.region, { lots: [{ id: 'bakery', type: 'bakery', size: [9, 9] }, { id: 'house_a', type: 'house', size: [9, 9] }] });
  await rvRealise(T.region, g1, { lots: { bakery: STUB, house_a: STUB } });
  await shot('frontage', mid, 0, 90);
  const g2 = await growPlan(T.region, { lots: SIX, prefer: 'extend' });
  await rvRealise(T.region, g2, { lots: { row_1: STUB, row_2: STUB } });
  const ir2 = await rvIr(T.region, g2.revisionOf.rid);
  const road = ir2.roads[0];
  await shot('extension_top', [Math.round((road.points[0][0] + road.points[1][0]) / 2), gy + 60, road.points[0][2]], 0, 90);
  await shot('extension_street', [road.points[0][0] - 10, gy + 6, road.points[0][2]], -90, 15);
  await shot('town_grown', [CX + 40, gy + 45, CZ + 130], 200, 35);
  out.frontage = (await rvIr(T.region, g1.revisionOf.rid)).revision.grow;
  out.extension = ir2.revision.grow;
  const shots = Object.values(out.shots ?? {});
  check(shots.length === 5 && shots.every((v) => v.ok), `N-GR-1 / N-GR-2: ${shots.filter((v) => v.ok).length}/${shots.length} shots of the grown town (before, the frontage, the extension from above and along its street, the whole)`, out.shots);
  await L.leaveWorld();
  return out;
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6dgr.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
