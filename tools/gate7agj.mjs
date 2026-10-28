#!/usr/bin/env node
// Phase 7a slice GJ gate (docs/CONTRACT.md "Phase 7a slice GJ: a district joins a walled town through a standing gate" §11) against the
// headless server (or a dev client) of the GJ run worktree (`../architect-mc-GJ-run` by default; the sim sidecar, no Claude). Ports 8914
// (sidecar) / 8915 (DevBridge) by default. $0: no Claude call anywhere; spend.json $0.00.
//
//   node tools/gate7agj.mjs <step>
//     start [world] | stop | base      the client (or server) and the base worlds
//     unit                              items 1, 2, 10 and 11's kit half: gj.test (the third step, the gates and their cells, the traverse,
//                                       the broken variant, narrowing, the refusal's list, 100 seeded walled towns, plan/0's
//                                       v7a_gj_endpoint, the IR sha over 3 plans), D3's parity and the plan fixtures (byte identity), the
//                                       Java parity (GateJoinTest, DistrictLandTest, ApiGJTest); item 11's api-compat
//     ingame                            items 3, 4, 6, 7 and 9 on d3_walled (D3's town with a GATED C38 ring round it, gates.min's gate facing
//                                       its street end): checkBeside then Regions.plan through the gate, realise, the gate's cells unchanged,
//                                       villagers from every district lot to the bell and back; the district removed first (0 changed cells
//                                       over the town's and the wall region's claims); the wall region removed first (the gate gone, E-flat 0
//                                       over its claim but the district's columns, the runs standing, dangling), then the district (E-flat 0)
//     town                              items 3, 4, 7 and 10 on gj_town_wall (a plan/0 town with its own K1 wall, a wooden-door gate, and a
//                                       fountain inside the ring by the gate): through the door, villagers both ways, the fountain kept clear
//                                       (M25:clear 0); the town removed first (its wall and gate with it, dangling), then the district
//     refusals                          items 8 and 9: gj_sealed (gates 0) NO_JOIN [wall]; gj_fence (the only gate a fence gate) NO_JOIN
//                                       [wall] naming it; the gate walled up after the plan: realise ARTIFACT_STALE naming it; 0 changed cells
//                                       each; checkBeside equals Regions.plan; the dry check keeps no file, opKey or PlanRec
//     steward                           item 5: checkBeside then the real plan under steward.<b>.vplan / .vrealise (ext steward_mc:district,
//                                       steward_mc:build), a stale re-check (the gate walled up) then .vrealise2, realiseByKey after a
//                                       restart; v7a_gj_endpoint through checkPlan then realiseApproved
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-gj/<step>.json in the main checkout (GATE7AGJ_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { srcGradle } from './lib/src-gradle.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-GJ-run');
process.env.GATE6B_OUT = process.env.GATE7AGJ_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-gj');
process.env.GATE6B_SIDECAR_PORT ??= '8914';
process.env.GATE6B_DEV_PORT ??= '8915';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp, sleep } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:gj';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o) ?? 'undefined').replaceAll(' ', '');
const STUB = 'g6a_stub_9';
/** The town's lots (D3's d3_town: a hall and seven cottages on a 160 claim). */
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, ...Array.from({ length: 7 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [9, 9] }))];
const TOWN_SIZE = 160;
const ONE = (id, extra = {}) => ({ spec: { districts: [{ id, size: [48, 48], lots: 4, ...extra }] } });
const STEWARD = (b, d = 'east') => ({ 'steward_mc:district': d, 'steward_mc:build': b });

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice GJ is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B GJ Lobby', { backend: 'sim' });
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
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.gj = nodeTest(['kit/test/gj.test.mjs']);
  check(out.gj.code === 0 && out.gj.fail === 0 && out.gj.pass >= 12, `items 1, 2, 5 (plan/0), 10, 11 (kit): the third step only on [wall], the gates and their cells (besideGates = K1a's meta), two legs and the traverse never written or held, M28:beside on the broken variant, a narrow gate and a double door, the refusal's list (sealed, a fence gate, a gate walled up), 100 seeded walled towns, v7a_gj_endpoint through the gate, the IR sha over 3 plans, the fountain kept clear: ${out.gj.pass} pass, ${out.gj.fail} fail`, out.gj.failing);
  out.bytes = nodeTest(['kit/test/districts-d3-parity.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/districts-d.test.mjs']);
  check(out.bytes.code === 0 && out.bytes.fail === 0, `item 2: D3's parity fixture, the plan fixtures (v17-v23, v7x_d3_*) and D1's districts unchanged (D3's own suites are d3-unit's): ${out.bytes.pass} pass, ${out.bytes.fail} fail`, out.bytes.failing);
  const g = srcGradle(root, () => spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*GateJoinTest', '--tests', '*DistrictLandTest', '--tests', '*ApiGJTest', '--tests', '*ApiRulesTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, timeout: 1_800_000 }));
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAILED|tests completed|error/.test(l)).slice(0, 10) };
  check(g.status === 0, `item 1 (Java): GateJoin.gates equals besideGates on every wall of the parity fixture, DistrictLand equals land.mjs through a gate (via, the then junction), the feature gateJoins: gradle exit ${g.status}`, out.java.tail);
  spendZero();
  return out;
};

steps.apicompat = async () => {
  srcGradle(root, () => execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' }));
  const arts = path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts');
  const jars = [];
  // every archived apitest jar, newest three (any gate's archive in the main checkout's artifacts)
  const walk = (d, depth = 0) => { if (depth > 3 || !fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (/^architect_apitest-\d+\.\d+\.\d+\.jar$/.test(f)) jars.push(p); else if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } };
  walk(arts);
  const ver = (p) => /(\d+)\.(\d+)\.(\d+)\.jar$/.exec(p).slice(1).map(Number);
  const byVer = new Map();
  for (const j of jars) { const k = ver(j).join('.'); if (!byVer.has(k)) byVer.set(k, j); }
  const pick = [...byVer.entries()].sort((a, b) => { const p = a[0].split('.').map(Number), q = b[0].split('.').map(Number); return q[0] - p[0] || q[1] - p[1] || q[2] - p[2]; }).slice(0, 3);
  const out = {};
  let ok = pick.length >= 3;
  for (const [v, jar] of pick) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), jar], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME }, timeout: 900_000 });
    out[v] = `${r.stdout}${r.stderr}`.trim().split('\n').pop();
    ok &&= r.status === 0;
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), JSON.stringify(out, null, 2));
  check(ok, `item 11: api-compat clean against the newest three archived apitest jars (no new record, method or reason; the feature gateJoins): ${json(out)}`);
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
async function undo(region, requester = OWNER) {
  const r = await call('dev.region.remove', { region, requester }, 3_600_000);
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
async function groundAt(x, z) {
  const sf = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: sf }, 300_000);
  return (await imp('lib/region/pack.mjs')).decodeColumns(fs.readFileSync(sf)).ground[4];
}
const runKeysOf = async (runs) => (await imp('lib/region/beside.mjs')).runKeys(runs);
const stacksOver = async (runs) => (await call('dev.journal.columns', { runs }, 600_000)).cells ?? [];
const listDir = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

/** A town claim's chunks generated before its realise (D3's generateFor: a throwaway plan over the claim grown by 16, prepared). */
async function generateFor(A, params) {
  const g = await planReq({ program: 'flat_village', params, claim: [A[0] - 16, A[1] - 16, A[2] + 16, A[3] + 16], check: false });
  if (g.refused) return;
  await L.prepare(g.planId);
}

/** D3's d3_town, plainly: a flat_village of 8 lots on a 160 claim at (X, Z), 4 cottages with stubs. {A, region, ir, world0, all, g}. */
async function town(X, Z) {
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  const params = { lots: TOWN_LOTS, apronLamps: false };
  await generateFor(A, params);
  const g = await groundAt(X + 80, Z + 80);
  const all = [A[0] - 40, -64, A[1] - 40, A[2] + 120, 160, A[3] + 40];
  const world0 = await dump(all, `world0-${X}`);
  const pa = await planReq({ program: 'flat_village', params, claim: A, check: false });
  if (pa.refused) throw new Error(`the town's plan: ${pa.refused}`);
  const ir = planFiles(pa.planId).ir;
  const lots = Object.fromEntries(ir.lots.filter((l) => l.id.startsWith('cottage_')).slice(0, 4).map((l) => [l.id, STUB]));
  await kill();
  const region = await L.realise(pa.planId, { lots });
  const st = await L.waitRegion(region, 3_600_000);
  return { A, region, ir, world0, all, g, state: st.view.state };
}

/** A C38 wall round a standing region through plan/0 (checkPlan of wall.around {feature: {region}}, then realiseApproved). */
async function wallRound(townId, A, { gates = null, extra = [], anchors = {} } = {}) {
  const C = [A[0] - 24, A[1] - 24, A[2] + 24, A[3] + 24];
  const plan = { schemaVersion: 'plan/0', connectors: [{ id: 'ring', kind: 'wall', where: { around: { feature: { region: townId }, ring: [4, 12] } }, height: 5, ...(gates !== null ? { gates } : {}) }, ...extra] };
  const ck = await call('dev.region.checkPlan', { plan, claim: C, anchors: { stone: [Math.floor((A[0] + A[2]) / 2), 65, Math.floor((A[1] + A[3]) / 2)], ...anchors }, owner: OWNER }, 900_000);
  const part = ck.check?.parts?.find((x) => x.part === 'ring') ?? null;
  let region = null;
  if (ck.check?.artifactSha && part?.class === 'fits') {
    const ra = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
    region = ra.region ?? null;
    if (region) await L.waitRegion(region, 3_600_000);
  }
  return { C, check: ck.check, part, region, geometry: part?.geometry ?? null, ir: ck.check?.checkId ? checkIr(ck.check.checkId) : null };
}

/** A plan check's IR (its sidecar plan directory, by the check's id). */
const checkIr = (checkId) => JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId, 'ir.json'), 'utf8'));
/** The gates of a standing region as the reach step reads them (the kit's besideGates over its IR). */
async function gatesOf(regionId, ir) {
  return (await imp('lib/region/beside.mjs')).besideGates(regionId, ir);
}
/** A refusal's text (the realise answer's `refused`, an object or a string). */
const refusedText = (r) => (r == null ? '' : typeof r === 'string' ? r : JSON.stringify(r));

/** A district plan beside a town (its checkBeside verdict first, item 9's parity) -> {plan, files, verdict, parity}. */
async function besidePlan(townId, claim, params, { opKey, ext } = {}) {
  const verdict = await checkBeside({ program: 'districts', params, claim, beside: townId, check: true });
  const plan = await planReq({ program: 'districts', params, claim, beside: townId, check: true, ...(opKey ? { opKey } : {}), ...(ext ? { ext } : {}) });
  const files = plan.refused ? null : planFiles(plan.planId);
  const j = files?.meta?.districts?.join ?? null;
  const parity = plan.refused ? !verdict.fits && String(plan.refused).includes(String(verdict.message).split(' (the request')[0].slice(0, 60))
    : verdict.fits && verdict.join && verdict.join.kind === (j?.junction?.kind ?? 'end') && verdict.join.step === (j?.step ?? 'seam') && json(verdict.join.at) === json(j?.junction?.at ?? j?.at)
      && (verdict.land?.parts ?? []).find((p) => p.kind === 'join')?.via === j?.via;
  return { plan, files, verdict, parity };
}
/** The gate's box: its opening's columns from its walk up past its lintel. */
const gateBox = (g) => { const xs = g.cells.flatMap((q) => [q[0], q[2]]), zs = g.cells.flatMap((q) => [q[1], q[3]]); return [Math.min(...xs), g.y - 1, Math.min(...zs), Math.max(...xs), g.y + g.h + 2, Math.max(...zs)]; };
/** Villager paths from every district lot's entrance to the bell and back: {lot: [there, back]}. */
async function villagers(ir, bell) {
  const out = {};
  for (const l of ir.lots) {
    const e = l.ext?.['architect_mc:village']?.entrance;
    if (!e) continue;
    const there = await call('dev.nav.villager', { from: e, to: bell, range: 320 }, 120_000);
    const back = await call('dev.nav.villager', { from: bell, to: e, range: 320 }, 120_000);
    out[l.id] = [!!there.canReach, !!back.canReach];
  }
  return out;
}
/** The columns a region holds in the journal over rects and runs. */
async function heldBy(groupId, runs) {
  return new Set((await stacksOver(runs)).filter((c) => c.stack.some((e) => e.group === groupId)).map((c) => `${c.x},${c.z}`));
}
const rowsOf = (r) => { const out = []; for (let z = r[1]; z <= r[3]; z++) out.push([r[0], z, r[2], z]); return out; };

// ------------------------------------------------------------------ items 3, 4, 6, 7, 9 on d3_walled (a gated C38 ring round D3's town)

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B GJ Walled', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 60000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await town(X, Z);
  const A = T.A;
  check(T.state === 'PLACED', `d3_walled's town ${T.region} PLACED`);
  const worldT = await dump(T.all, 'walled-after-town');
  const w = await wallRound(T.region, A);
  out.wall = { region: w.region, part: w.part?.class, gates: w.geometry?.gates ?? null };
  check(!!w.region && (w.geometry?.gates ?? []).length >= 1, `d3_walled: a C38 ring round ${T.region} with gates.min's gate(s) realised through checkPlan and realiseApproved (${json(out.wall)})`);
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const before = await dump(T.all, 'walled-before-district');
  // ---- items 3 and 9: checkBeside, then Regions.plan beside the town: through the ring's gate
  const p = await besidePlan(T.region, B, ONE('east'));
  if (p.plan.refused) throw new Error(`the district's plan was refused: ${p.plan.refused}`);
  const ir = p.files.ir, d = p.files.meta.districts;
  const g = ir.reach?.gate;
  out.plan = { planId: p.plan.planId, join: d.join, gate: g, verdict: p.verdict };
  check(!!g && g.region === w.region && d.join?.via === `${w.region}:${g.id}`, `item 3: Regions.plan beside ${T.region} joins through gate ${g?.id} of ${g?.region} (the wall region; ${json(d.join?.junction)})`);
  check(p.parity, `item 9 (verifier re-runs): checkBeside's verdict equals Regions.plan's (fits, the junction, the gate in its land's via): ${json(p.verdict.join)}`);
  const ext = ir.graph.edges.find((e) => e.id === 'join_external');
  check(ext?.via === d.join.via && ext?.junction?.kind === 'gate' && ext?.crossing?.type === 'gate' && ext?.type === 'road', `§5: join_external typed with the gate it crosses (${json({ via: ext?.via, junction: ext?.junction?.kind, crossing: ext?.crossing })})`);
  const m28 = p.files.report?.findings?.filter((f) => f.rule === 'M28:beside') ?? [];
  check(m28.length === 0 && (p.files.report?.metrics?.M28?.gate ?? -1) === 0, `§3: M28:beside clean, no gate cell written (${m28.length} findings, ${p.files.report?.metrics?.M28?.gate} gate cells)`);
  const gb = gateBox(g);
  const gh0 = await hash(gb);
  await kill();
  const rb = await L.realise(p.plan.planId, { lots: {} });
  const sb = await L.waitRegion(rb, 3_600_000);
  check(sb.view.state === 'PLACED', `item 3: Regions.realise: the district ${rb} PLACED`);
  check((await hash(gb)) === gh0, `item 3: the gate's cells unchanged by the district (hash over ${json(gb)})`);
  // ---- item 4: villagers through the gate
  await tp(Math.floor((A[0] + B[2]) / 2), 0, Math.floor((A[1] + A[3]) / 2));
  await kill();
  out.nav = await villagers(ir, T.ir.anchors.bell ?? T.ir.anchors.entrance);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v[0] && v[1]), `item 4 (hard bar): vanilla dev.nav.villager from every district lot to the town's bell and back, through the gate: ${json(out.nav)}`);
  const kitMovers = (p.files.report?.metrics?.route?.edges ?? []).filter((e) => e.id === 'join' || e.id === 'join_in');
  check(kitMovers.length === 2 && kitMovers.every((e) => e.player && e.villager), `item 4: the kit's movers on both legs (${json(kitMovers.map((e) => [e.id, e.player, e.villager]))})`);
  // ---- item 6: the district removed first
  await kill();
  await undo(rb);
  await L.settle(3000);
  const after6 = await dump(T.all, 'walled-after-district-removed');
  out.item6 = { townAndWall: diffCols(before, after6, [w.C]), district: diffCols(before, after6, [[B[0] - 8, B[1] - 8, B[2] + 8, B[3] + 8]]) };
  check(out.item6.townAndWall.cells === 0, `item 6 (verifier re-runs): the district removed first: 0 changed cells over the town's and the wall region's claims (the join's columns as before the district) (${out.item6.townAndWall.cells}; ${json(out.item6.townAndWall.sample)})`);
  check(out.item6.district.cells === 0, `item 6: E-flat 0 over the district's claim (+8) (${out.item6.district.cells}; ${json(out.item6.district.sample)})`);
  check((await hash(gb)) === gh0, 'item 6: the gate untouched');
  // ---- item 7: the wall region removed first
  const p2 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  if (p2.refused) throw new Error(`the district's second plan was refused: ${p2.refused}`);
  const ir2 = planFiles(p2.planId).ir;
  await kill();
  const rb2 = await L.realise(p2.planId, { lots: {} });
  const sb2 = await L.waitRegion(rb2, 3_600_000);
  check(sb2.view.state === 'PLACED' && !!ir2.reach?.gate, `item 7: the district ${rb2} PLACED again through gate ${ir2.reach?.gate?.id}`);
  const world2 = await dump(T.all, 'walled-world2');
  const dcols = await heldBy(sb2.view.groupId, [...rowsOf([B[0] - 4, B[1] - 4, B[2] + 4, B[3] + 4]), ...ir2.reach.runs]);
  await kill();
  await undo(w.region);
  await L.settle(3000);
  const world3 = await dump(T.all, 'walled-world3');
  const dRects = [...dcols].map((k) => { const [x, z] = k.split(',').map(Number); return [x, z, x, z]; });
  out.item7 = { wallMinusDistrict: diffCols(worldT, world3, [w.C], dcols), runsStanding: diffCols(world2, world3, dRects) };
  const v7 = await view(rb2);
  out.item7.ext = { beside: v7.ext?.['architect_mc:beside'], standingRemoved: v7.ext?.['architect_mc:land']?.standingRemoved ?? null };
  check(out.item7.wallMinusDistrict.cells === 0, `item 7 (verifier re-runs): the wall region removed first: its ring and gate gone, E-flat 0 over its claim minus the district's columns, against the world before the wall (${out.item7.wallMinusDistrict.cells}; ${json(out.item7.wallMinusDistrict.sample)})`);
  check(out.item7.runsStanding.cells === 0, `item 7: the join's runs standing (the district's columns unchanged) (${out.item7.runsStanding.cells}; ${json(out.item7.runsStanding.sample)})`);
  check(out.item7.ext.beside?.dangling === true && out.item7.ext.beside?.gateRemoved === w.region && Number.isInteger(out.item7.ext.standingRemoved), `item 7: dangling set, gateRemoved ${w.region}, land.standingRemoved set (${json(out.item7.ext)})`);
  // the gap's ground is the wall's restore: walkable across it or not, recorded
  const jat = planFiles(p2.planId).meta.districts.join.junction.at, lot0 = ir2.lots.find((l) => l.ext?.['architect_mc:village']?.entrance);
  if (lot0) out.item7.walkAcross = !!(await call('dev.nav.villager', { from: lot0.ext['architect_mc:village'].entrance, to: jat, range: 320 }, 120_000)).canReach;
  await kill();
  await undo(rb2);
  await L.settle(3000);
  const world4 = await dump(T.all, 'walled-world4');
  out.item7.final = diffCols(worldT, world4, [[T.all[0], T.all[2], T.all[3], T.all[5]]]);
  check(out.item7.final.cells === 0, `item 7: then the district: E-flat 0 over every claim (the world before the wall and the district) (${out.item7.final.cells}; ${json(out.item7.final.sample)})`);
  await kill();
  await undo(T.region);
  await L.settle(3000);
  const world5 = await dump(T.all, 'walled-world5');
  out.final = diffCols(T.world0, world5, [[T.all[0], T.all[2], T.all[3], T.all[5]]]);
  check(out.final.cells === 0, `then the town: the world before it (${out.final.cells}; ${json(out.final.sample)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 3, 4, 7, 10 on gj_town_wall (a town with its own wall and a door)

/** gj_town_wall's plan/0: a street town zone, its own K1 ring with a wooden-door gate at `east`, `fount` a fountain near `inner`. */
const townWallPlan = (fount) => ({ schemaVersion: 'plan/0',
  zones: [{ id: 'town', program: { lots: TOWN_LOTS, layout: 'street', orientation: 'ew' }, where: { near: { anchor: 'stone', within: 16 } } }],
  connectors: [{ id: 'town_wall', kind: 'wall', where: { around: { feature: { part: 'town' }, ring: [4, 8] } }, height: 5 }, { id: 'tg', kind: 'gate', wall: 'town_wall', door: 'door', width: 3, at: { anchor: 'east' } }],
  ...(fount ? { forms: [{ id: 'fount', kind: 'fountain', basin: 5, spout: 3, where: { near: { anchor: 'inner', within: 4 } } }] } : {}) });

steps.town = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B GJ Town Wall', FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 64000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const A = [X, Z, X + TOWN_SIZE - 1, Z + TOWN_SIZE - 1];
  await generateFor(A, { lots: TOWN_LOTS, apronLamps: false });
  const g0 = await groundAt(X + 80, Z + 80);
  const anchors = { stone: [X + 80, g0 + 1, Z + 80], east: [A[2] - 6, g0 + 1, Z + 80] };
  // the gate's position first (the ring without the fountain), then the fountain just inside it, on the join's cheapest inner run
  const ck0 = await call('dev.region.checkPlan', { plan: townWallPlan(false), claim: A, anchors, owner: OWNER }, 900_000);
  const gat = ck0.check?.parts?.find((x) => x.part === 'tg')?.geometry?.at;
  out.firstCheck = { overall: ck0.check?.overall, gate: gat ?? null };
  if (!gat) { check(false, `gj_town_wall's gate placed (${json(out.firstCheck)})`); await leaveWorld(); return out; }
  anchors.inner = [gat[0] - 8, g0 + 1, gat[2]];
  const all = [A[0] - 40, -64, A[1] - 40, A[2] + 120, 160, A[3] + 40];
  const world0 = await dump(all, 'townwall-world0');
  const ck = await call('dev.region.checkPlan', { plan: townWallPlan(true), claim: A, anchors, owner: OWNER }, 900_000);
  out.town = { overall: ck.check?.overall, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class]) };
  if (!ck.check?.artifactSha) { check(false, `gj_town_wall's check made no artifact (${json(out.town)})`); await leaveWorld(); return out; }
  const ra = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
  const st = ra.region ? await L.waitRegion(ra.region, 3_600_000) : null;
  check(st?.view?.state === 'PLACED' && out.town.parts.every(([, c]) => c === 'fits'), `gj_town_wall ${ra.region} PLACED: a town zone, its own ring and a wooden-door gate, a fountain inside the ring (${json(out.town)})`);
  const TR = ra.region;
  const gs = await gatesOf(TR, checkIr(ck.check.checkId));
  out.gates = gs.map((q) => [q.id, q.door, q.doorBlock, q.width]);
  check(gs.some((q) => q.door === 'door'), `gj_town_wall: its gate a door (${json(out.gates)})`);
  const B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const before = await dump(all, 'townwall-before-district');
  const p = await besidePlan(TR, B, ONE('east'));
  if (p.plan.refused) throw new Error(`the district's plan was refused: ${p.plan.refused}`);
  const ir = p.files.ir, gt = ir.reach?.gate;
  out.plan = { join: p.files.meta.districts.join, gate: gt };
  check(gt?.region === TR && gt?.door === 'door', `item 3: the district beside gj_town_wall joins through its own wall's door gate ${gt?.id} (${json(p.files.meta.districts.join?.via)})`);
  check(p.parity, `item 9: checkBeside equals Regions.plan (${json(p.verdict.join)})`);
  const clear = (p.files.report?.findings ?? []).filter((f) => f.rule === 'M25:clear');
  check(clear.length === 0 && (p.files.report?.metrics?.M28?.bodies ?? 0) === 0, `item 10 (KC): the fountain inside the ring kept clear (M25:clear ${clear.length}; reach cells in a body ${p.files.report?.metrics?.M28?.bodies ?? '?'})`);
  const gb = gateBox(gt);
  const gh0 = await hash(gb);
  await kill();
  const rb = await L.realise(p.plan.planId, { lots: {} });
  const sb = await L.waitRegion(rb, 3_600_000);
  check(sb.view.state === 'PLACED' && (await hash(gb)) === gh0, `item 3: the district ${rb} PLACED; the gate's cells unchanged (hash)`);
  await tp(Math.floor((A[0] + B[2]) / 2), 0, Math.floor((A[1] + A[3]) / 2));
  await kill();
  const tir = checkIr(ck.check.checkId);
  out.nav = await villagers(ir, tir.anchors?.bell ?? tir.anchors?.entrance);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v[0] && v[1]), `item 4 (hard bar): villagers from every district lot to the town's bell and back through the door (opened by them): ${json(out.nav)}`);
  // ---- item 7: the town (its own wall and gate with it) removed first
  const world2 = await dump(all, 'townwall-world2');
  const dcols = await heldBy(sb.view.groupId, [...rowsOf([B[0] - 4, B[1] - 4, B[2] + 4, B[3] + 4]), ...ir.reach.runs]);
  await kill();
  await undo(TR);
  await L.settle(3000);
  const world3 = await dump(all, 'townwall-world3');
  const dRects = [...dcols].map((k) => { const [x, z] = k.split(',').map(Number); return [x, z, x, z]; });
  out.item7 = { townMinusDistrict: diffCols(world0, world3, [A], dcols), runsStanding: diffCols(world2, world3, dRects) };
  const v7 = await view(rb);
  out.item7.ext = { beside: v7.ext?.['architect_mc:beside'], standingRemoved: v7.ext?.['architect_mc:land']?.standingRemoved ?? null };
  check(out.item7.townMinusDistrict.cells === 0, `item 7 (verifier re-runs): the town removed first, its wall and gate with it: E-flat 0 over its claim minus the district's columns (${out.item7.townMinusDistrict.cells}; ${json(out.item7.townMinusDistrict.sample)})`);
  check(out.item7.runsStanding.cells === 0 && out.item7.ext.beside?.dangling === true && Number.isInteger(out.item7.ext.standingRemoved), `item 7: the runs standing, dangling and standingRemoved set (${out.item7.runsStanding.cells}; ${json(out.item7.ext)})`);
  await kill();
  await undo(rb);
  await L.settle(3000);
  const world4 = await dump(all, 'townwall-world4');
  out.item7.final = diffCols(world0, world4, [[all[0], all[2], all[3], all[5]]]);
  check(out.item7.final.cells === 0, `item 7: then the district: E-flat 0 over every claim (the world before the town) (${out.item7.final.cells}; ${json(out.item7.final.sample)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 8 and 9: refusals, nothing written; the dry check keeps nothing

steps.refusals = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GJ Refusals';
  await L.fresh(world, FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 68000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await town(X, Z);
  const A = T.A, B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const area = [A[0] - 30, -64, A[1] - 30, B[2] + 8, 160, A[3] + 30];
  // ---- gj_sealed: gates 0
  const sw = await wallRound(T.region, A, { gates: 0 });
  check(!!sw.region, `gj_sealed: a sealed ring (gates 0) round ${T.region} realised`);
  let h = await hash(area);
  const ps = await besidePlan(T.region, B, ONE('east'));
  out.sealed = { refused: ps.plan.refused ?? null, code: ps.verdict.code };
  check(/NO_JOIN: \[wall\].*no gate \(sealed\)/.test(ps.plan.refused ?? '') && /NO_JOIN \[wall\]/.test(ps.verdict.code ?? '') && ps.parity, `item 8: gj_sealed: NO_JOIN [wall] (no gate), checkBeside the same (${String(ps.plan.refused).slice(0, 160)})`);
  check((await hash(area)) === h, 'item 8: gj_sealed: 0 changed cells');
  await kill();
  await undo(sw.region);
  // ---- gj_fence: the only gate a fence gate
  const gy = await groundAt(A[2] + 12, Math.floor((A[1] + A[3]) / 2));
  const fw = await wallRound(T.region, A, { extra: [{ id: 'gf', kind: 'gate', wall: 'ring', door: 'fence_gate', width: 3, at: { anchor: 'e' } }], anchors: { e: [A[2] + 12, gy + 1, Math.floor((A[1] + A[3]) / 2)] } });
  check(!!fw.region, `gj_fence: a ring whose only gate is a fence gate realised (${json(fw.geometry?.gates)})`);
  h = await hash(area);
  const pf = await besidePlan(T.region, B, ONE('east'));
  out.fence = { refused: pf.plan.refused ?? null };
  check(/NO_JOIN: \[wall\].*:gf fence gate/.test(pf.plan.refused ?? '') && pf.parity, `item 8: gj_fence with a villager join: NO_JOIN [wall] naming the fence gate (${String(pf.plan.refused).slice(0, 200)})`);
  check((await hash(area)) === h, 'item 8: gj_fence: 0 changed cells');
  await kill();
  await undo(fw.region);
  // ---- the gate walled up after the plan: ARTIFACT_STALE naming it, nothing written
  const ow = await wallRound(T.region, A);
  const worldDir = path.join(L.SAVES, world, 'architect-regions', 'plans');
  const sidecarPlans = path.join(L.SIDECAR_DATA, 'regions', 'plans');
  const files0 = { mod: listDir(worldDir), sidecar: listDir(sidecarPlans), dry: listDir(path.join(L.SIDECAR_DATA, 'regions', 'dry')) };
  const h0 = await hash(area);
  const v = await checkBeside({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, opKey: 'gj-dry-key' });
  const files1 = { mod: listDir(worldDir), sidecar: listDir(sidecarPlans), dry: listDir(path.join(L.SIDECAR_DATA, 'regions', 'dry')) };
  const byKey = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'gj-dry-key' }).catch(() => null);
  out.dry = { fits: v.fits, via: (v.land?.parts ?? []).find((q) => q.kind === 'join')?.via ?? null, before: files0, after: files1 };
  check(v.fits && out.dry.via === `${ow.region}:${(await gatesOf(ow.region, ow.ir))[0]?.id}`, `item 9: checkBeside fits through the gate (${json(out.dry.via)})`);
  check(json(files0) === json(files1) && !byKey?.region && (await hash(area)) === h0, `item 9 (verifier re-runs): the dry check keeps nothing: no plan file, no opKey entry or region, the world hash unchanged (${files0.mod.length} / ${files0.sidecar.length})`);
  const pg = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  if (pg.refused) throw new Error(`the gate plan was refused: ${pg.refused}`);
  const gt = planFiles(pg.planId).ir.reach.gate;
  // a player walls the opening up (cobblestone across its walk's feet)
  const [bx0, , bz0, bx1, , bz1] = gateBox(gt);
  await cmd(`/fill ${bx0} ${gt.y + 1} ${bz0} ${bx1} ${gt.y + 2} ${bz1} minecraft:cobblestone`);
  h = await hash(area);
  const rs = await call('dev.region.realise', { planId: pg.planId, lots: {} }, 300_000).catch((e) => ({ refused: String(e) }));
  out.stale = { refused: rs.refused ?? null, region: rs.region ?? null };
  check(!rs.region && /ARTIFACT_STALE/.test(refusedText(rs.refused)) && refusedText(rs.refused).includes(`gate ${gt.id}`), `item 8: the gate walled up after the plan: realise ARTIFACT_STALE naming gate ${gt.id} (${json(out.stale)})`);
  check((await hash(area)) === h, 'item 8: the stale realise wrote nothing');
  await cmd(`/fill ${bx0} ${gt.y + 1} ${bz0} ${bx1} ${gt.y + 2} ${bz1} minecraft:air`);
  await kill();
  await undo(ow.region);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 5: Steward's shapes

steps.steward = async () => {
  await ensure();
  const out = {};
  const world = 'G6B GJ Steward';
  await L.fresh(world, FLAT);
  await L.setRules('exact');
  await cmd('/op @s');
  const X = 72000, Z = 20000;
  await tp(X + 80, 40, Z + 80);
  await kill();
  const T = await town(X, Z);
  const A = T.A, B = [A[2] + 1, A[1] + 30, A[2] + 90, A[3] - 30];
  const w = await wallRound(T.region, A);
  check(!!w.region, `the walled town: ${T.region} with a gated ring ${w.region}`);
  // checkBeside, then the real plan under Steward's keys
  const verdict = await checkBeside({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false });
  out.verdict = { fits: verdict.fits, join: verdict.join, via: (verdict.land?.parts ?? []).find((q) => q.kind === 'join')?.via ?? null };
  check(verdict.fits && !!out.verdict.via, `item 5: checkBeside through the gate (${json(out.verdict)})`);
  const p1 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false, opKey: 'steward.b1.vplan', ext: STEWARD('b1') });
  if (p1.refused) throw new Error(`the district's plan under steward.b1.vplan refused: ${p1.refused}`);
  const gt = planFiles(p1.planId).ir.reach.gate;
  // a stale re-check: the gate walled up between the plan and the realise
  const [bx0, , bz0, bx1, , bz1] = gateBox(gt);
  await cmd(`/fill ${bx0} ${gt.y + 1} ${bz0} ${bx1} ${gt.y + 2} ${bz1} minecraft:cobblestone`);
  const r1 = await call('dev.region.realise', { planId: p1.planId, lots: {}, opKey: 'steward.b1.vrealise', ext: STEWARD('b1') }, 300_000).catch((e) => ({ refused: String(e) }));
  out.stale = { refused: r1.refused ?? null, region: r1.region ?? null };
  check(!r1.region && /ARTIFACT_STALE/.test(refusedText(r1.refused)) && refusedText(r1.refused).includes(`gate ${gt.id}`), `item 5: the realise under steward.b1.vrealise refused ARTIFACT_STALE, naming the gate (${refusedText(r1.refused).slice(0, 160)})`);
  await cmd(`/fill ${bx0} ${gt.y + 1} ${bz0} ${bx1} ${gt.y + 2} ${bz1} minecraft:air`);
  const p2 = await planReq({ program: 'districts', params: ONE('east'), claim: B, beside: T.region, check: false, opKey: 'steward.b1.vplan2', ext: STEWARD('b1') });
  if (p2.refused) throw new Error(`the re-plan refused: ${p2.refused}`);
  await kill();
  const r2 = await call('dev.region.realise', { planId: p2.planId, lots: {}, opKey: 'steward.b1.vrealise2', ext: STEWARD('b1') }, 300_000);
  const D = r2.region;
  const s2 = D ? await L.waitRegion(D, 3_600_000) : null;
  check(s2?.view?.state === 'PLACED' && s2.view.ext?.['steward_mc:build'] === 'b1', `item 5: the re-plan realised under steward.b1.vrealise2: ${D} PLACED through the gate, its ext Steward's (${json({ district: s2?.view?.ext?.['steward_mc:district'], build: s2?.view?.ext?.['steward_mc:build'] })})`);
  await leaveWorld();
  await L.openWorld(world);
  const rk = await call('dev.region.realiseByKey', { owner: OWNER, opKey: 'steward.b1.vrealise2' }, 10_000).catch((x) => ({ error: String(x) }));
  check(rk.region?.id === D, `item 5: after a restart realiseByKey(steward.b1.vrealise2) finds the district (${json(rk.region?.id ?? rk)})`);
  await kill();
  await undo(D);
  // v7a_gj_endpoint through checkPlan then realiseApproved
  const C = [A[2] + 1, A[1] + 30, A[2] + 120, A[3] - 30];
  const lotsV1 = [1, 2].map((i) => ({ id: `q${i}`, type: 'cottage', size: [9, 9], ext: { 'steward_mc:settlement': 's1', 'steward_mc:lot': `q${i}`, 'steward_mc:role': 'home' } }));
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'quarter', kind: 'standard', required: true, program: { lots: lotsV1, layout: 'street', orientation: 'ew' }, tolerance: { rotate: { allowed: false } }, where: { near: { anchor: 'gate', within: 16 } } }],
    connectors: [{ id: 'to_town', kind: 'road', from: { part: 'quarter' }, to: { region: T.region } }] };
  const gy = await groundAt(C[2] - 30, Math.floor((C[1] + C[3]) / 2));
  const ck = await call('dev.region.checkPlan', { plan, claim: C, anchors: { gate: [C[2] - 30, gy + 1, Math.floor((C[1] + C[3]) / 2)] }, owner: OWNER }, 900_000);
  const part = ck.check?.parts?.find((x) => x.part === 'to_town');
  out.endpoint = { overall: ck.check?.overall, class: part?.class, notes: part?.notes };
  check(part?.class === 'fits' && !!ck.check?.artifactSha, `item 5: v7a_gj_endpoint: checkPlan's endpoint.region road fits through the gate (${json(out.endpoint)})`);
  const ra = await call('dev.region.realiseApproved', { sha: ck.check?.artifactSha, opKey: 'gj-approve-1' }, 300_000);
  const sa = ra.region ? await L.waitRegion(ra.region, 3_600_000) : null;
  const air = ck.check?.checkId ? checkIr(ck.check.checkId) : null;
  check(sa?.view?.state === 'PLACED' && !!air?.reach?.gate, `item 5: realiseApproved PLACED the road through gate ${air?.reach?.gate?.id}`);
  if (ra.region) { await kill(); await undo(ra.region); }
  await kill();
  await undo(w.region);
  await leaveWorld();
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'apicompat', 'ingame', 'town', 'refusals', 'steward']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-GJ (a district joins a walled town through a standing gate)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7agj.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
