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
  const A = process.env.GATE6DGR_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
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
  check(w1.r.state === 'PLACED' && gm1.frontage.length === 2 && gm1.extension === null && gm1.frontage.every((f) => f.side === freeSide || f.street !== 'street_w'), `item 3: both lots on free frontage (${json(gm1.frontage)}), no extension; the revision ${w1.r.state}`);
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
  const S3 = await cellsOf(BIG);

  // ---- item 7: a D3 district beside gr_town joins the extension's new end; undoRevision refuses joined, nothing written
  const ex = (X.road && road) ? road.points[1] : null;
  const B7 = [CLAIM[2] - 10, ex[2] - 40, CLAIM[2] + 80, ex[2] + 40];
  const p7 = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'east', size: [48, 48], lots: 2 }] } }, claim: B7, beside: region, check: false });
  const j7 = p7.refused ? null : planFiles(p7.planId).ir.graph.edges.find((e) => e.id === 'join_external');
  out.item7 = { plan: p7.refused ?? p7.planId, join: j7 };
  check(!p7.refused && String(j7?.to ?? '').includes(`${X.road}_end`), `item 7: a beside district planned east of the town joins the extension's new end (${j7?.to ?? p7.refused})`);
  let r7 = null;
  if (!p7.refused) {
    r7 = await L.realise(p7.planId, { lots: {} });
    const s7 = await L.waitRegion(r7, 3_600_000);
    check(s7.view.state === 'PLACED', `item 7: the district ${r7} ${s7.view.state}`);
    const hBefore = await hashOf(BIG);
    const u7 = await call('dev.rv.undo', { region, toPosition: (await rvState(region)).position - 1 }, 600_000);
    const hAfter = await hashOf(BIG);
    out.item7.undo = u7;
    check(String(u7.refused ?? '').startsWith('NOT_ALLOWED') && /joined/.test(u7.refused) && u7.refused.includes(r7) && hBefore === hAfter, `item 7: undoRevision of the growth refuses at preflight: ${u7.refused}; nothing written (hash)`);
    await removeRegion(r7);
    const dd = diff(S3, await cellsOf(BIG));
    check(dd.n === 0, `item 7: the district removed: the world as before it (${dd.n} cells differ)`, dd.first);
  }
  // ---- item 7b: a D3 district north of the extension joins its side by a T; refused joined; removed; then the undo is exact
  const B7b = [ex[0] - 40, CLAIM[1] - 80, Math.min(ex[0] + 6, CLAIM[2] + 40), CLAIM[1] + 4];
  const p7b = await planReq({ program: 'districts', params: { spec: { districts: [{ id: 'north', size: [40, 40], lots: 2 }] } }, claim: B7b, beside: region, check: false });
  const j7b = p7b.refused ? null : planFiles(p7b.planId).ir.graph.edges.find((e) => e.id === 'join_external');
  out.item7b = { plan: p7b.refused ?? p7b.planId, join: j7b };
  const sideOnExt = j7b?.junction?.kind === 'side' && String(j7b?.to ?? '').endsWith(`:${X.road}`);
  check(!p7b.refused && sideOnExt, `item 7b: a beside district north of the extension joins its side by a T (${json(j7b && { to: j7b.to, junction: j7b.junction })}${p7b.refused ? ` refused ${p7b.refused}` : ''})`);
  if (!p7b.refused) {
    const r7b = await L.realise(p7b.planId, { lots: {} });
    const s7b = await L.waitRegion(r7b, 3_600_000);
    check(s7b.view.state === 'PLACED', `item 7b: the district ${r7b} ${s7b.view.state}`);
    const hBefore = await hashOf(BIG);
    const u7b = await call('dev.rv.undo', { region, toPosition: (await rvState(region)).position - 1 }, 600_000);
    const hAfter = await hashOf(BIG);
    out.item7b.undo = u7b;
    check(!sideOnExt || (String(u7b.refused ?? '').startsWith('NOT_ALLOWED') && /joined/.test(u7b.refused) && hBefore === hAfter), `item 7b: undoRevision refuses joined at preflight: ${u7b.refused}; nothing written (hash)`);
    await removeRegion(r7b);
  }
  // the undo of the extension: the world before it
  const u2 = await call('dev.rv.undo', { region, toPosition: (await rvState(region)).position - 1 }, 4 * 3_600_000);
  const d2 = diff(S2, await cellsOf(BIG));
  out.undoExtension = { result: u2, diff: d2 };
  check(u2.removed === true && d2.n === 0, `items 7/7b: the districts removed, undoRevision of the extension: the world before it, cell for cell (${d2.n} differ)`, d2.first);
  // ---- item 9: every slot held: NO_ROOM {kind: held}, nothing planned
  const held = [];
  for (const run of T.runs) for (const s of [-1, 1]) for (let u = run.u0; u <= run.u1; u++) { const [x, z] = run.o === 'ew' ? [u, run.c + s * 4] : [run.c + s * 4, u]; held.push([x, gy + 1, z, 'minecraft:cobblestone']); }
  const hs = await call('dev.cells.place', { kind: 'steward:addition', cells: held, naturalOnly: false, owner: OWNER }, 900_000);
  const before9 = await rvState(region);
  const g9 = await growPlan(region, { lots: [{ id: 'held_1', type: 'house', size: [9, 9] }], extend: 'none' });
  const after9 = await rvState(region);
  out.item9 = { site: hs.siteId, refused: g9.refused, nextRid: [before9.nextRid, after9.nextRid] };
  check(String(g9.refused ?? '').startsWith('NO_ROOM') && /\[held\]/.test(g9.refused) && after9.nextRid === before9.nextRid, `item 9: with every frontage slot held (a Steward site along both sides of every street), a growth answers ${g9.refused}; nothing planned (nextRid ${before9.nextRid})`);
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
