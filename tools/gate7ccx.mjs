#!/usr/bin/env node
// Slice CX gate (7c one connector; docs/CONTRACT.md "Phase 7c" §3 row 11, "Slice CX as built"): Sites.placeConnector, a single 7a connector
// between two marked points, as a one-part plan checked and realised as one region. Against the run worktree's client or headless server
// (GATE6B_RUN, default `../architect-mc-CX-run`; the sim sidecar, no Claude). Ports 8906 (sidecar) / 8907 (DevBridge) by default
// (GATE6B_SIDECAR_PORT / GATE6B_DEV_PORT override: the verifier's 8908/8909). $0.
//
//   node tools/gate7ccx.mjs <step>
//     unit      (cx-unit)      offline: kit/test/cx.test.mjs (the one-part plan writes only the link, between the points; survival one target;
//                              the other kinds' typed refusals) and the ST/7cF tests it touches; the Java ApiCXTest, Api7cFTest, ApiSTTest
//     ingame    (cx-ingame)    a dev client, creative, the flat base with fixtures/plan/cx/cx01_ravine.json's ravine built: the Build a link
//                              key starts the plot marker's connector mode; a rock stair marked on the flat lips is refused on the second end
//                              (NO_LINK: NO_CLIMB, nothing written); the rope bridge marked between the two points: placed (the region),
//                              PLACED, the realised world equal to the check's virtual world (strict), Remove E-flat 0; the HUD shot
//     survival  (cx-survival)  headless, survival (the RS base), strict (the verifier re-runs it): the INSTANT twin (Sites.placeConnector in
//                              creative); INSTANT refused NOT_ALLOWED in survival; the plan checked in survival (the link one target: free 0,
//                              its bill); a stockpile, the conservation sum; Sites.placeConnector (AUTO): a construction site, fed in waves:
//                              PLACED and built, the target's bill equal to the check's, the world equal to the twin cell for cell, items in =
//                              items out (exact once built and once removed: every item back), Remove E-flat 0
//     report                   REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-cx/<step>.json in the main checkout (GATE7CCX_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CX-run');
process.env.GATE6B_OUT = process.env.GATE7CCX_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-cx');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, fails, log, results, root, state } = L;
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const core = await import('./lib/gate6chy-core.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

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
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CX is $0: sim only, no Claude call' }, null, 2)}\n`);
}

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
  out.kit = kitOnce(['kit/test/cx.test.mjs', 'kit/test/st.test.mjs', 'kit/test/f7c-foundation.test.mjs', 'kit/test/plan-k1-batch.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 14, `kit: cx.test.mjs (the one-part plan writes only the link, between the two points; in survival one target; the other kinds' typed refusals) and the ST/7cF/rope tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--no-daemon', '--tests', 'dev.larattalabs.architect.apiimpl.ApiCXTest', '--tests', 'dev.larattalabs.architect.apiimpl.ApiSTTest', '--tests', 'dev.larattalabs.architect.api.Api7cFTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiCXTest (placeConnector follows the helper\'s region.planCheck; the one-part plan, claim and anchors equal the kit fixture; the kinds, spiral = stairs_around; params copied, architect_mc:* left out; bad requests refused), ApiSTTest (the drop warning, now with "build a link here") and Api7cFTest', out.java.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

const FX = () => G.fixture(ctx, 'cx/cx01_ravine');
const planDir = (checkId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId);
const checkIdOf = (notes) => (/\(check ([^)\s]+)\)/.exec((notes ?? []).join(' ')) ?? [])[1] ?? null;
/** The snapshot box: the terrain's claim and 8 round it, 8 under the ravine's floor to 40 over the lips. */
const boxOf = (W) => G.boxOf(W);

const SHOTS = path.join(OUT, 'shots');
/** A screenshot for the glance gallery (the client's dev.screenshot), copied into shots/. */
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  log(`  shot ${name}`);
  // (a glance shot, never a gate item: capped, so a hidden client's frame wait can't hold the step)
  const r = await Promise.race([call('dev.screenshot', { name: `cx-${name}`, hideHud: false, frames: 6 }, 90_000), L.sleep(90_000).then(() => { throw new Error('screenshot: no answer in 90 s'); })]);
  const dest = path.join(SHOTS, `cx-${name}.png`);
  try { fs.copyFileSync(r.path, dest); } catch { /* the path the client gave stays the evidence */ }
  return fs.existsSync(dest) ? dest : r.path;
}
async function plotState() { return call('dev.plot.state', {}, 10_000); }
async function waitMarker(pred, timeoutMs = 900_000) {
  const end = Date.now() + timeoutMs;
  let st;
  while (Date.now() < end) {
    st = await plotState();
    if (pred(st)) return st;
    await L.sleep(1000);
  }
  return st;
}
/** Regions.remove of a region by its owner (the player's UUID for the marker's path), waited for; a refusal returns at once. */
async function removeRegion(region) {
  const owner = (await call('dev.region.state', { region }, 60_000))?.view?.owner ?? null;
  log(`  removing ${region} (requester ${owner})`);
  const r = await call('dev.region.remove', { region, ...(owner ? { requester: owner } : { force: true }) }, 3_600_000); // (force: only the owner check; never a blocker)
  if (!r.removed) { log(`  removal refused: ${json(r)}`); return r; }
  for (let i = 0; i < 600; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await L.sleep(1000);
  }
  await L.settle(2000);
  return r;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const fx = FX();
  const s = await G.site(ctx, 'cx ingame', fx, { creative: true });
  const a = s.wp.anchors.cx_from, b = s.wp.anchors.cx_to;
  const box = boxOf(s.W);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  await L.settle(3000);
  const before = path.join(OUT, 'cx-before.arwd.gz'), after = path.join(OUT, 'cx-after.arwd.gz');
  await call('dev.region.dump', { box, file: before, light: false }, 1_800_000);
  const pre = await G.snap(ctx, box, 'cx-ingame-pre');
  await L.tp(a[0] - 4, a[1] + 2, a[2] - 6);
  await L.settle(1500);
  // the Build a link key: the connector mode (no drop remembered: both ends are marked)
  const k = await call('dev.cx.key', { press: true }, 10_000);
  out.key = { key: k.key, drop: k.drop, connector: k.marker?.connector, phase: k.marker?.phase };
  check(k.key === 'K' && k.drop === null && k.marker?.active && k.marker?.connector === 'rope_bridge' && k.marker?.phase === 'first_corner',
    `the Build a link key (${k.key}) starts the plot marker's connector mode: ${k.marker?.connector} (the default), the first end, no drop remembered`, out.key);
  // a refusal through the marker: a rock stair between the two flat lips (nothing to climb) stays on the second end with its reason
  await call('dev.cx.key', { kind: 'rock_stair' }, 10_000);
  await call('dev.plot.corner', { x: a[0], y: a[1], z: a[2], confirm: true }, 10_000);
  await call('dev.plot.corner', { x: b[0], y: b[1], z: b[2], confirm: true }, 10_000);
  const r0 = await waitMarker((st) => st.lastConnector && st.phase !== 'placing');
  out.refused = { last: r0.lastConnector, phase: r0.phase, status: r0.status };
  check(r0.active && r0.phase === 'second_corner' && r0.lastConnector?.placed === false && /^NO_LINK: NO_CLIMB/.test(r0.lastConnector?.refused ?? '') && /^No rock stair here: NO_LINK/.test(r0.status ?? ''),
    `a rock stair marked on the flat lips: refused on the second end (${r0.lastConnector?.refused}), the HUD says "${r0.status}"`, out.refused);
  const e0 = await G.diff(ctx, box, pre);
  check(e0.mismatches === 0, `the refused rock stair wrote nothing: E-flat ${e0.mismatches}`, e0.list.slice(0, 8));
  // the rope bridge: F's pick back to rope_bridge, the second end marked again
  await call('dev.cx.key', { kind: 'rope_bridge' }, 10_000);
  await L.tp(a[0] - 4, a[1] + 3, a[2] - 6, -60, 20);
  await call('dev.plot.corner', { x: b[0], y: b[1], z: b[2], confirm: false }, 10_000);
  await L.settle(800);
  out.shot = await shot('marker').catch((e) => { log(`  shot marker: ${e.message}`); return { error: String(e) }; });
  await call('dev.plot.corner', { x: b[0], y: b[1], z: b[2], confirm: true }, 10_000);
  const r1 = await waitMarker((st) => st.lastConnector?.placed === true || (st.lastConnector && st.lastConnector.refused && st.phase === 'second_corner' && !/rock stair/.test(st.status ?? '')));
  const lc = r1.lastConnector;
  out.placed = lc;
  check(lc?.placed === true && /^\S+$/.test(lc.siteId ?? '') && !r1.active && JSON.stringify(lc.from) === JSON.stringify(a) && JSON.stringify(lc.to) === JSON.stringify(b),
    `a rope bridge marked between ${json(a)} and ${json(b)}: Sites.placeConnector's player path placed it (${lc?.siteId}), the mode ended`, lc);
  if (!lc?.placed) return out;
  const region = lc.siteId;
  const st = await L.waitRegion(region, 3_600_000);
  out.state = st.view.state;
  check(st.view.state === 'PLACED', `the connector's region: ${st.view.state} (one site group, ${st.view.cellsWritten ?? '?'} cells)`);
  await L.settle(4000);
  await call('dev.region.dump', { box, file: after, light: false }, 1_800_000);
  const checkId = checkIdOf(lc.notes);
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir(checkId), after, before, { lots: true });
  out.virtual = { checkId, written: rv.written, differ: rv.differ, first: rv.first };
  const ok = RV.realisedOk(rv, ['rope'], { strict: true });
  check(!!checkId && rv.written > 0 && ok.pass, `the realised world equals the check's virtual world (strict): ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}`, { missing: ok.missing, loose: ok.loose, first: rv.first.slice(0, 3) });
  await L.tp(a[0] - 6, a[1] + 6, a[2] - 10);
  await L.settle(1500);
  out.shotPlaced = await shot('placed').catch((e) => { log(`  shot placed: ${e.message}`); return { error: String(e) }; });
  const rm = await removeRegion(region);
  out.removed = { removed: rm.removed };
  const e = await G.diff(ctx, box, pre);
  out.eflat = { mismatches: e.mismatches, list: e.list.slice(0, 8) };
  check(rm.removed && e.mismatches === 0, `Regions.remove of the connector's region: E-flat ${e.mismatches} over the box`, out.eflat);
  return out;
};

// ------------------------------------------------------------------ survival (strict: the verifier re-runs it)

const place = (s, o = {}) => call('dev.cx.place', { kind: 'rope_bridge', from: s.wp.anchors.cx_from, to: s.wp.anchors.cx_to, owner: G.OWNER, opKey: o.opKey ?? 'gate.cx', ...o }, 1_800_000);

/** The INSTANT twin: the creative flat base, the same ravine, Sites.placeConnector there (INSTANT), PLACED, the box snapshotted. */
async function twin(fx) {
  const s = await G.site(ctx, 'cx twin', fx, { creative: true });
  const r = await place(s, { opKey: 'gate.cx.twin' });
  if (!r.placed) throw new Error(`twin: refused ${json(r.refusals)}`);
  const st = await L.waitRegion(r.siteId, 3_600_000);
  const box = boxOf(s.W);
  const file = path.join(OUT, 'cx-twin.snap.gz');
  await call('dev.region.hash', { box, mode: 'snap', file }, 3_600_000);
  return { file, box, region: r.siteId, state: st.view.state };
}

steps.survival = async () => {
  await ensure();
  spendZero();
  const out = {};
  const fx = FX();
  const T = await twin(fx);
  out.twin = { region: T.region, state: T.state };
  check(T.state === 'PLACED', `the INSTANT twin: Sites.placeConnector in creative (${T.region}): ${T.state}`);
  const s = await G.site(ctx, 'cx survival', fx);
  const box = boxOf(s.W);
  const pre = await G.snap(ctx, box, 'cx-survival-pre');
  // INSTANT in survival: refused (the world's mode)
  const ri = await place(s, { mode: 'INSTANT', opKey: 'gate.cx.instant' });
  out.instant = ri;
  check(ri.placed === false && ri.refusals?.[0]?.reason === 'NOT_ALLOWED', `INSTANT in survival: refused ${ri.refusals?.[0]?.reason} (${ri.refusals?.[0]?.message})`, ri);
  // the very plan placeConnector checks, checked in survival for its bill
  const P = await call('dev.cx.plan', { kind: 'rope_bridge', from: s.wp.anchors.cx_from, to: s.wp.anchors.cx_to }, 60_000);
  const ck = await call('dev.region.checkPlan', { plan: P.plan, claim: P.claim, owner: G.OWNER, anchors: P.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(OUT, 'cx-survival-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
  const part = (ck.check?.parts ?? []).find((q) => q.part === 'link');
  const sv = part?.cost?.survival;
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, class: part?.class, sv };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && part?.class === 'fits' && sv?.free === 0 && sv?.held > 0 && sum(sv?.bom) > 0,
    `the connector's plan checked in survival: ${ck.check?.overall}; link ${part?.class}: one target, free ${sv?.free}, held ${sv?.held}, its bill ${json(sv?.bom)}`, out.check);
  const crateAt = await G.pile(ctx, s, 3);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const r = await place(s);
  out.place = r;
  check(r.placed === true && /^\S+$/.test(r.siteId ?? '') && (r.notes ?? []).some((n) => /survival: a construction site/.test(n)) && (r.notes ?? []).some((n) => n.startsWith('its bill: ')),
    `Sites.placeConnector (AUTO) in survival: placed ${r.siteId}, a construction site (${json(r.notes)})`, r);
  if (!r.placed) return out;
  const region = r.siteId;
  const p0 = await C.point('realised');
  const f = await G.feed(ctx, region, { cons: C, fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, parts: (rs.build.parts ?? []).map((q) => [q.part, q.state, q.targets?.length]) };
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100 && f.waves >= 2, `fed from the owner's stockpile in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(out.build)}`);
  const targets = (rs.targets ?? []).map((t) => ({ target: t.target, part: t.part, cells: t.cells, built: t.built, bom: t.bom }));
  out.targets = targets;
  check(targets.length > 0 && targets.every((t) => t.part === 'link' && t.built), `the connector is its construction target(s), built: ${json(targets.map((t) => [t.target, t.part, t.cells, t.built]))}`, targets);
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  check(G.same(bills.want.link, bills.got.link) && G.same(bills.got.link, sv?.bom) && G.same(bills.want.__region__, bills.got.__region__),
    `the target's bill put down equals the check's cost.survival.bom, item for item (${json(bills.got.link)}), and the region's whole bill`, bills);
  const pb = await C.point('built');
  out.builtPoint = pb;
  check(G.exact(p0) && G.exact(pb) && pb.paid > 0, `items in = items out once built: every item fed is in the stockpile or standing as a paid block (the conservation sum ${json(pb.diff)}, identity ${pb.identity}, ${pb.paid} paid standing)`, pb);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twinDiff = d;
  check(d.mismatches === 0, `the survival-built connector equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  const pr = await C.point('removed');
  out.removedPoint = pr;
  check(G.exact(pr) && pr.paid === 0, `items in = items out once removed: every item back (the conservation sum ${json(pr.diff)}, identity ${pr.identity}, ${pr.paid} paid standing; refund ${json(rm.refund)})`, pr);
  out.conservation = C.points;
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'survival']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7c-CX (one connector)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ccx.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
