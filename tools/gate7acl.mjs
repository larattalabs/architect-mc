#!/usr/bin/env node
// Phase 7a slice CL gate (docs/CONTRACT.md "Phase 7a slice CL: climbs, stairs, switchbacks and ladders" §10) against the headless server
// of the CL run worktree (GATE6B_RUN, default `../architect-mc-CL-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no
// Claude). Ports 8896 (sidecar) / 8897 (DevBridge) by default. $0: no Claude call anywhere.
//
//   node tools/gate7acl.mjs <step>
//     start [world] | stop | base       the headless server (or client) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (cl-unit)               offline: item 1 (kit/test/cl.test.mjs: the profiles change only their edges, the post-check, rest
//                                       landings, the top gate, the face rule, every refusal with its evidence and wouldFit re-checked
//                                       alone, the broken variants, climbs_demo flat and natural by the kit's movers (the behavioural test's
//                                       kit half), KC's stair beside a fountain (item 9), the catalogue's three flips (item 12), 3 checks
//                                       identical (item 13)); the foundation's, P0's, K1's and T3's tests; the Java ApiCLTest; item 2 (byte
//                                       identity: every committed plan fixture as on the merge base but the named exceptions); item 3 (the
//                                       59 asks: fixtures/plan/cl/asks-gap-before.txt and -after.txt re-made here and on the merge base);
//                                       item 15 (api-compat, $0)
//     ingame    (cl-ingame)             items 4-10 on the flat base (headless): climbs_demo flat planned, realised, re-read from the dumps
//                                       (item 7: the climb rules over the realised world; realised == virtual), the kit movers across every
//                                       edge (item 5) and up and down every ladder (item 8, judged), vanilla dev.nav.villager both ways on
//                                       the stair and the switchback (item 5, the hard bar), the behavioural villager test (item 6, the hard
//                                       bar: the mesa's bed unreached by vanilla villagers in 3 tries while the bot climbs; the stair's
//                                       bed found both ways), dev.climb's physics probe (item 8, recorded), Regions.remove E-flat 0 (item
//                                       10); item 4's flat round: v7a_cl_ladder in plan v1's shape through Regions.checkPlan and
//                                       realiseApproved, realised == virtual, E-flat 0
//     natural   (cl-natural)            items 4, 5, 7, 10 on S3's pinned claim (a fresh copy of the seed world): climbs_demo natural (stair
//                                       and switchback), vanilla villagers both ways, E-normal classified; v7a_cl_stair in plan v1's shape
//                                       through Regions.checkPlan and realiseApproved
//     survival  (cl-survival)           item 11: a stair up a slope (cl/s01) in a survival world: treads and rails from the stockpile, the
//                                       cut free; the bills equal the check's; removal refunds once per key
//     look      (cl-look, client)       item 14 (recorded, Noah's call N-CL-1): climbs_demo flat in three bibles, cameras on the stair, the
//                                       switchback, the ladder with its landing and its top gate
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-cl/<step>.json in the main checkout (GATE7ACL_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { F7A_MOVED } from './lib/f7a-norm.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CL-run');
process.env.GATE6B_OUT = process.env.GATE7ACL_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-cl');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const OWNER = 'test:cl';
/** climbs_demo flat's claim on the flat base (240x176, clear of the other slices' claims). */
const FLAT_CLAIM = [7400, 7000, 7639, 7175];
/** S3's pinned claim (route_demo's, the golden's survey), on the seed world. */
const S3_CLAIM = [3604, -1036, 3795, -845];
/** The fixtures that move by name (item 2): the recorded plans whose climbs CL answers (§9). */
export const CL_MOVED = Object.freeze({
  'asks/old_new_town.json': 'CL: quarter_stair answers refused NO_CLIMB (was unsupported until 7a)',
  'asks/sky_monastery.json': 'CL: long_stair answers refused NO_CLIMB (was unsupported until 7a)',
  'asks/hidden_village.json': 'CL: cave_ladders answers blocked DEPENDENCY, its tower_1 unplaced in the zone (was unsupported until 7a)',
});

const B = await import('./lib/gate6chy-b.mjs');
const CORE = await import('./lib/gate6chy-core.mjs');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core: CORE, B };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CL is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B CL Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT] };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  // item 1 (and 9, 12, 13): the kit's CL tests, the foundation's, P0's, K1's and T3's
  out.kit = kitOnce(['kit/test/cl.test.mjs', 'kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 25, `items 1, 9, 12, 13 (kit): the profiles change only their edges; NO_CLIMB and the climb deviation; rest landings at every rest; the top gate; the face rule; every refusal (NO_CLIMB, MOVER, ANCHOR, SPAN, UNREACHABLE) with evidence and its wouldFit re-checked alone; the broken variants; climbs_demo flat and natural (the kit movers: the mesa's bed unreached by villagers, the stair's reached); a stair beside a fountain M25:clear 0; the catalogue's three flips; 3 checks identical; the foundation's, P0's, K1's and T3's tests: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  // the Java: the feature (ApiCLTest)
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', 'dev.larattalabs.architect.api.ApiCLTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'item 15 (Java): ApiCLTest (the feature climbConnectors from the sidecar\'s region.climbs; protocol 1 none)', out.java.tail);
  // item 2: byte identity against the merge base, the named exceptions aside
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'CL', except: CL_MOVED, landed: F7A_MOVED });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'cl-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // item 3: the 59 asks, re-made here and on the merge base, against the committed tables
  const before = await B.asksGap(path.join(path.resolve(root, '..', 'architect-mc-CL-main'), 'kit')), after = await B.asksGap(KIT);
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'cl');
  fs.writeFileSync(path.join(OUT, 'cl-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'cl-asks-after.txt'), after.text);
  const lines = (t) => new Map(t.split('\n').filter((l) => /^[a-z_0-9]+\/[a-z_0-9]+ /.test(l)).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k).filter((k) => !/mining_town\/rail_1/.test(k));
  out.asks = { moved, malformed: after.malformed, committedAfter: fs.readFileSync(path.join(F, 'asks-gap-after.txt'), 'utf8') === after.text };
  check(after.malformed === 0 && JSON.stringify(moved) === JSON.stringify(['hidden_village/cave_ladders', 'old_new_town/quarter_stair', 'sky_monastery/long_stair']) && out.asks.committedAfter,
    `item 3: the 59 asks on the merge base and on this head: 0 malformed; exactly the three climbs move (${moved.join(', ')}; the foundation's rail_1 aside); the after table equals fixtures/plan/cl/asks-gap-after.txt: ${out.asks.committedAfter}`);
  // item 15: api-compat ($0)
  const flag = process.env.GATE7ACL_APICOMPAT ?? '--gate7acl';
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', flag], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { flag, code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 15: api-compat ${flag} clean (CL adds a feature only: no record, method or enum value); $0.00`, out.apicompat.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep, vw };
}

/** Item 7 over the realised world: the climb rules (M10:climb, M8:climb, M5:climb), M3 0 in the climbs' parts. */
function item7(tag, R) {
  const c = R.rep.metrics.climbs;
  const per = c?.per ?? [];
  check(per.length === (R.meta.climbs ?? []).length && per.length >= 1, `item 7 (${tag}): ${per.length} climb(s) re-read from the realised world (${per.map((q) => `${q.part} ${q.kind}`).join(', ')})`);
  check(per.every((q) => q.flightBad === 0 && q.treadBad === 0), `item 7 (${tag}): every flight rises 1 a cell, at most 8, then 2 flat; every tread standable with 2 clear (${per.map((q) => `${q.part}: ${q.flights} flight(s), ${q.treads} tread(s)`).join('; ')})`);
  check(per.every((q) => q.m8Open === 0), `item 7 (${tag}): M8 0 on the stairs and landings (rails beside every drop over 3: ${per.map((q) => `${q.part} ${q.m8Edges - q.m8Open}/${q.m8Edges}`).join(', ')})`);
  check(per.every((q) => q.notLadder === 0 && q.faceBad === 0 && q.longFlights === 0 && q.landingBad === 0 && q.gate !== false), `item 7 (${tag}): every rung a ladder against a solid face, flights at most rest, every rest landing standable, the top gate in place (${per.filter((q) => q.rungs).map((q) => `${q.part}: ${q.rungs} rungs, ${q.landings} landing(s), gate ${q.gate}`).join('; ') || 'no ladder'})`);
  check(per.every((q) => q.dark === 0), `item 7 (${tag}): M5 0 dark walk, tread and landing cells of the climbs (${per.map((q) => `${q.part} ${q.dark}/${q.cells}`).join(', ')})`);
  const parts = new Set((R.ir.parts ?? []).map((p) => p.id).filter((id) => /^links_/.test(id)));
  const m3 = R.rep.findings.filter((f) => /^M3/.test(f.rule) && parts.has(f.part));
  check(!m3.length, `item 7 (${tag}): M3 0 in the climbs' fittings (${m3.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  const grade = R.rep.findings.filter((f) => f.rule === 'M2:grade');
  check(!grade.length, `item 7 (${tag}): walk windows within the grade (M2:grade 0 over ${R.rep.metrics.route?.grade?.windows ?? 0} windows)`);
  return { per, grade: R.rep.metrics.route?.grade ?? null };
}

/** Vanilla's villager path between two feet cells, there and back. */
async function navBoth(a, b) {
  const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 180_000);
  const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 180_000);
  return { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null], end: [ab.end ?? null, ba.end ?? null] };
}

/** The kit movers along a routed edge (feet cells of its ends), both ways. */
async function kitAcross(world, e) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const a = [e.path[0][0], e.path[0][1] + 1, e.path[0][2]], b = [e.path.at(-1)[0], e.path.at(-1)[1] + 1, e.path.at(-1)[2]];
  const m = (mv) => nodeReached(walkGraph(world, [a], { mover: mv }), b) && nodeReached(walkGraph(world, [b], { mover: mv }), a);
  return { player: m('player'), villager: (e.movers ?? []).includes('villager') ? m('villager') : null };
}

/** One climbs_demo run: plan, realise, re-read, the movers, vanilla villagers, the behavioural test, the probe, remove. */
async function demoRun(tag, claim, { flat }) {
  const out = { claim };
  await tp((claim[0] + claim[2]) / 2, flat ? 100 : 180, (claim[1] + claim[3]) / 2);
  let p = await L.plan('climbs_demo', claim, { params: { variant: flat ? 'flat' : 'natural' }, surveyLoad: 'bounded:256', check: flat, owner: OWNER });
  if (!flat) {
    await L.prepare(p.planId);
    await cmd('/tick freeze');
    try { p = await L.plan('climbs_demo', claim, { params: { variant: 'natural' }, surveyLoad: 'generated:64', check: true, owner: OWNER }); } finally { await cmd('/tick unfreeze'); }
  }
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId);
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const routed = (meta.route?.edges ?? []).filter((e) => e.ok);
  out.plan = { planId: p.planId, irSha: p.irSha, routed: routed.map((e) => e.id), climbs: (meta.climbs ?? []).map((c) => ({ id: c.id, kind: c.kind, flights: c.flights, hairpins: c.hairpins, ladders: c.ladders })) };
  check(routed.length === (flat ? 3 : 2), `${tag}: climbs_demo planned ${routed.map((e) => e.id).join(', ')} (${json(out.plan.climbs)})`);
  // item 13 (determinism): the plan's tile shas with 1 worker equal those with 4, shuffled
  {
    const { tileShas } = await import('./scenarios.mjs');
    const ts = await tileShas(planDir);
    out.tiles = { irSha: ts.irSha, workersSame: ts.workersSame, count: Object.keys(ts.tiles).length };
    check(ts.workersSame, `item 13 (${tag}): the tiles' shas with 1 worker equal those with 4 (${out.tiles.count} tiles, IR ${String(ts.irSha).slice(0, 12)})`);
  }
  // the box: the claim + 8 over the plan's written y span +- 8
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const irP = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const blobsP = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw: vP } = buildVirtual({ ir: irP, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs: blobsP });
  let y0 = Infinity, y1 = -Infinity;
  vP.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
  await tp((claim[0] + claim[2]) / 2, Math.min(319, y1 + 20), (claim[1] + claim[3]) / 2);
  await L.settle(flat ? 5000 : 60_000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  check(st.view.state === 'PLACED', `${tag}: realised (${st.view.state}, ${out.realise.cells} cells)`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item7 = item7(tag, R);
  // realised == virtual per writer kind (the climbs' fittings are route cells)
  {
    const RV = await import('./lib/realised-virtual.mjs');
    const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
    out.realisedVirtual = { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
    check(RV.realisedOk(rv, ['route'], { strict: !!flat }).pass, `item 4 (${tag}${flat ? ', strict' : ''}): realised == virtual per writer kind, ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  }
  // item 5 (kit movers, every edge) and item 8 (judged: the kit player up and down every ladder, landings included)
  out.kit = {};
  for (const e of routed) out.kit[e.id] = await kitAcross(R.world, e);
  check(Object.values(out.kit).every((v) => v.player), `items 5, 8 (${tag}): the kit player mover across every climb both ways, up and down every ladder (${json(out.kit)})`);
  check(Object.values(out.kit).every((v) => v.villager !== false), `item 5 (${tag}): the kit villager mover across every stair and switchback both ways`);
  // item 5, the hard bar: vanilla villagers both ways on every stair and switchback
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = {};
  for (const e of routed.filter((q) => (q.movers ?? []).includes('villager'))) {
    const a = [e.path[0][0], e.path[0][1] + 1, e.path[0][2]], b = [e.path.at(-1)[0], e.path.at(-1)[1] + 1, e.path.at(-1)[2]];
    out.nav[e.id] = await navBoth(a, b);
  }
  check(Object.keys(out.nav).length === 2 && Object.values(out.nav).every((v) => v.there && v.back), `item 5 (${tag}, the hard bar): vanilla dev.nav.villager up and down the stair and the switchback (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  if (flat) {
    // item 6, the behavioural villager test (the hard bar): the mesa's bed reached only by the ladder; the plateau's by the stair
    const A = R.ir.anchors;
    const beside = (b) => [b[0] + 1, b[1], b[2]];
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push(!!(await call('dev.nav.villager', { from: A.foot_ladder, to: beside(A.bed_ladder), range: 256 }, 180_000)).canReach);
    const stairBed = await navBoth(A.foot_stair, beside(A.bed_stair));
    const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
    const playerUp = nodeReached(walkGraph(R.world, [A.foot_ladder], { mover: 'player' }), beside(A.bed_ladder));
    out.behaviour = { ladderBedVanilla: tries, stairBed: [stairBed.there, stairBed.back], playerUp };
    check(tries.every((t) => !t) && playerUp, `item 6 (the hard bar): a bed reached only by the ladder: vanilla dev.nav.villager finds no path (${tries.filter((t) => t).length} of 3 tries) while the player climbs to it (the kit player mover over the realised world: ${playerUp})`);
    check(stairBed.there && stairBed.back, `item 6 (the hard bar): the same kind of bed reached by the stair route: vanilla villagers there and back (${stairBed.there}, ${stairBed.back})`);
    // item 8, shown (recorded): dev.climb's physics probe up the ladder, flight by flight, and the step off through the gate
    const d = (R.meta.climbs ?? []).find((c) => c.kind === 'ladder')?.detail?.[0];
    if (d) {
      const { faceDir } = await imp('lib/connectors/climbGeom.mjs');
      const pr = await call('dev.climb', { flights: d.flights.map((f) => ({ x: f.x, z: f.z, y0: f.y0, y1: f.y1 })), face: faceDir(d.facing), ...(d.top ? { exit: d.top } : {}) }, 180_000).catch((e) => ({ error: String(e.message ?? e) }));
      out.probe = pr;
      check(true, `item 8 (shown, recorded): dev.climb's physics probe: ${pr.error ? `harness gap (${pr.error.slice(0, 160)})` : `flights ${json((pr.flights ?? []).map((f) => [f.reached, f.ticks]))}, exited ${pr.exited ?? null}, ok ${pr.ok}`}`);
    }
  }
  // item 10: the removal by its owner
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const cells = (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, cells, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 10 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored)`);
  else {
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    check(rm.removed && none === 0, `item 10 (${tag}): the removal's E-normal classified: ${diff.mismatches} mismatches (${json(diff.classes ?? {})}), unclassified ${none}`);
  }
  return out;
}

/** A fixture's plan in plan v1's shape (Steward's Start: pending parts required false; every part keeps its ext). */
function planV1(plan) {
  const p = JSON.parse(JSON.stringify(plan));
  for (const c of p.connectors ?? []) { c.required = false; c.ext = { ...(c.ext ?? {}), 'steward_mc:part': c.id }; }
  return p;
}

/** Item 4: a fixture in plan v1's shape through Regions.checkPlan (READY), realiseApproved (PLACED); realised == virtual; removed exactly. */
async function stewardRound(tag, fx, { site = null, flat = true } = {}) {
  const out = {};
  let W;
  if (site) {
    await tp((site[0] + site[2]) / 2, 180, (site[1] + site[3]) / 2);
    await call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
    W = { claim: site, dx: 0, dz: 0, off: 0, minY: 60, maxY: 160 };
  } else {
    W = await B.buildTerrain(ctx, B.terrainOf(fx));
    W.minY = W.ground; W.maxY = W.ground + 60;
  }
  const wp = await B.worldPlan(ctx, { ...fx, plan: planV1(fx.plan) }, W);
  const ck = await call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: OWNER, anchors: wp.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, `${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  out.check = { overall: ck.check?.overall ?? null, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]) };
  check(ck.check?.overall === 'READY', `item 4 (${tag}): plan v1's shape through Regions.checkPlan: ${ck.check?.overall} ${json(out.check.parts)}`);
  if (ck.check?.overall !== 'READY') return out;
  const box = [W.claim[0] - 8, Math.max(-64, W.minY - 8), W.claim[1] - 8, W.claim[2] + 8, Math.min(319, W.maxY + 20), W.claim[3] + 8];
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const rr = await call('dev.region.realiseApproved', { sha: ck.check.artifactSha }, 300_000);
  if (!rr.region) { check(false, `item 4 (${tag}): realiseApproved refused (${json(rr.refused ?? rr)})`); return out; }
  const st = await L.waitRegion(rr.region, 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.state = st.view.state;
  check(st.view.state === 'PLACED', `item 4 (${tag}): realiseApproved from the approved artifact: ${st.view.state}`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId ?? st.view.planId);
  let R = null;
  if (fs.existsSync(planDir)) {
    const RV = await import('./lib/realised-virtual.mjs');
    const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
    out.realisedVirtual = { written: rv.written, differ: rv.differ, byKind: rv.byKind };
    check(RV.realisedOk(rv, ['route'], { strict: flat }).pass, `item 4 (${tag}): the realised world equals the virtual one: ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}`);
    R = await realisedOf(planDir, before, after);
    out.item7 = item7(tag, R);
  } else check(false, `item 4 (${tag}): the check's plan dir ${planDir} is missing`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  out.exact = { removed: rm.removed, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 20) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify({ ...out.exact, list: diff.list ?? [] }, null, 1)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 4 (${tag}): Regions.remove E-flat ${diff.mismatches}`);
  else {
    // a natural site's water and leaves keep settling over the whole claim (PLAN "A natural-site survey drifts"): the unclassified
    // mismatches at a cell the plan wrote are judged (the removal restores exactly those); the rest of the claim's are recorded as
    // the site's drift, with how many lie within 8 of a written cell
    const wrote = new Set(), near = new Set();
    R?.vw.eachWritten((x, y, z) => { wrote.add(`${x},${y},${z}`); near.add(`${x >> 3},${z >> 3}`); });
    const none = (diff.list ?? []).filter((m) => m.class === 'none');
    const at = none.filter((m) => wrote.has(String(m.pos)));
    const close = none.filter((m) => { const [x, , z] = String(m.pos).split(',').map(Number); return !wrote.has(String(m.pos)) && near.has(`${x >> 3},${z >> 3}`); });
    const listed = (diff.list ?? []).length >= diff.mismatches;
    out.exact.written = { cells: wrote.size, none: at.length, near: close.length, drift: none.length - at.length, listed };
    check(rm.removed && listed && wrote.size > 0 && at.length === 0, `item 4 (${tag}): Regions.remove E-normal classified: ${diff.mismatches} (${json(diff.classes ?? {})}); unclassified at the ${wrote.size} cells the plan wrote ${at.length}${at.length ? ` (${json(at.slice(0, 5))})` : ''}; elsewhere on the claim ${none.length - at.length}, ${close.length} of them near the plan (the site's drift, recorded: ${json(close.slice(0, 3))})`);
  }
  return out;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B CL Flat', FLAT);
  await L.setRules('exact');
  out.demo = await demoRun('flat', FLAT_CLAIM, { flat: true });
  await leaveWorld();
  await L.fresh('G6B CL Steward Flat', FLAT);
  await L.setRules('exact');
  out.steward = await stewardRound('v1-ladder', B.fixture(ctx, 'valid/v7a_cl_ladder.json'), { flat: true });
  await leaveWorld();
  // (every new kind through Regions.checkPlan then realiseApproved: the switchback's own round, on its slope)
  await L.fresh('G6B CL Steward Switch', FLAT);
  await L.setRules('exact');
  out.stewardSwitch = await stewardRound('v1-switch', B.fixture(ctx, 'valid/v7a_cl_switch.json'), { flat: true });
  await leaveWorld();
  spendZero();
  return out;
};

steps.natural = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B CL S3', BASE);
  await L.setRules('default');
  out.demo = await demoRun('natural', S3_CLAIM, { flat: false });
  await leaveWorld();
  await L.fresh('G6B CL Steward S3', BASE);
  await L.setRules('default');
  out.steward = await stewardRound('v1-stair', B.fixture(ctx, 'valid/v7a_cl_stair.json'), { site: S3_CLAIM, flat: false });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 11: survival

steps.survival = async () => {
  await ensure();
  const G = await import('./lib/gate6crs-game.mjs');
  const sctx = { ...ctx, check };
  const fx = B.fixture(ctx, 'cl/s01_stair_slope.json');
  const out = {};
  const s = await G.site(sctx, 'cl-s01', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(sctx, box, 'cl-s01-pre');
  const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, 'cl-s01-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.cost?.survival ?? null]) };
  check(ck.check?.survival === true && ck.check?.overall === 'READY', `item 11: Regions.checkPlan in survival: ${ck.check?.overall} ${json(out.check.parts.map((q) => q.slice(0, 2)))}`);
  if (ck.check?.overall !== 'READY') return out;
  const crateAt = await G.pile(sctx, s, 4);
  const region = await G.realise(sctx, ck.check.artifactSha, {});
  const f = await G.feed(sctx, region, { fraction: 1, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.build = { state: st.view.state, waves: f.waves, inserted: f.inserted, build: rs.build };
  check(st.view.state === 'PLACED' && rs.build?.done, `item 11: realised in survival and fed from the stockpile in ${f.waves} wave(s): ${st.view.state}, build ${json(rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent })}`);
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  const differ = Object.keys(bills.want).filter((p) => !G.same(bills.want[p], bills.got[p]));
  check(differ.length === 0, `item 11: the check's cost.survival.bom equals the bills put down (the treads and rails from the stockpile, the cut free): ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal'}`, bills);
  const rm = await G.remove(sctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(sctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  check(rm.removed && ef.length === 0, `item 11: Regions.remove refunds once per key (${json(rm.refund ?? null)}); E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 14: the look (client; recorded, not judged)

async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `cl_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

/** The look's bibles (K1's three: the default, infernal, coastal). */
const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];

steps.look = async () => {
  await ensure();
  const out = { shots: [], bibles: {} };
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.fresh(`G6B CL Look ${tag}`, FLAT);
    await L.setRules('exact');
    await cmd('/time set 6000');
    await cmd('/weather clear');
    if (bible) {
      const dst = path.join(L.GAME_DIR, 'architect', 'bibles', bible, 'versions', '1');
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${bible}.json`), path.join(dst, 'bible.json'));
    }
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 120, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const p = await L.plan('climbs_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER, ...(bible ? { bible } : {}) });
    const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'meta.json'), 'utf8'));
    const region = await L.realise(p.planId, {});
    const st = await L.waitRegion(region, 3_600_000);
    out.bibles[tag] = { planId: p.planId, state: st.view.state };
    const edges = Object.fromEntries((meta.route?.edges ?? []).filter((e) => e.ok).map((e) => [e.id, e]));
    check(st.view.state === 'PLACED' && ['stair', 'switch', 'ladder'].every((id) => edges[id]), `look (${tag}): climbs_demo flat realised with its stair, switchback and ladder (${st.view.state}; ${Object.keys(edges).join(', ')}; recorded, not judged: Noah's call, N-CL-1)`);
    for (const [id, e] of Object.entries(edges)) {
      const mid = e.path[e.path.length >> 1], top = e.path.at(-1);
      out.shots.push(await shot(`${tag}_${id}_side`, [mid[0] + 18.5, mid[1] + 6, mid[2] + 10.5], [mid[0] + 0.5, mid[1], mid[2] + 0.5]));
      if (id === 'ladder') {
        const d = (meta.climbs ?? []).find((c) => c.kind === 'ladder')?.detail?.[0];
        const lnd = d?.rest?.[0];
        if (lnd) out.shots.push(await shot(`${tag}_ladder_landing`, [lnd.deck[0][0] - 8.5, lnd.y + 3, lnd.deck[0][1] + 6.5], [lnd.deck[0][0] + 0.5, lnd.y, lnd.deck[0][1] + 0.5]));
        if (d?.top) out.shots.push(await shot(`${tag}_ladder_top`, [d.top[0] - 4.5, d.top[1] + 4, d.top[2] + 4.5], [d.top[0] + 0.5, d.top[1], d.top[2] + 0.5]));
      } else out.shots.push(await shot(`${tag}_${id}_down`, [top[0] + 0.5, top[1] + 3.6, top[2] + 0.5], [mid[0] + 0.5, mid[1] + 1, mid[2] + 0.5]));
    }
    await call('dev.release', {}).catch(() => null);
    await leaveWorld();
  }
  check(out.shots.length >= 3 * LOOK_BIBLES.length && out.shots.every((x) => fs.existsSync(x.file)), `look: ${out.shots.length} shots in ${path.join(OUT, 'look')} (the gallery's)`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'natural', 'survival', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-CL (climbs: stairs, switchbacks and ladders)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7acl.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
