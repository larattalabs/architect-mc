#!/usr/bin/env node
// Slice BF gate (7c big forms; docs/CONTRACT.md "Phase 7c" §3 row 2, "Slice BF as built") against the headless server of the BF run
// worktree (GATE6B_RUN, default `../architect-mc-BF-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 8916 (sidecar) / 8917 (DevBridge) by default. $0: no Claude call anywhere.
//
//   node tools/gate7cbf.mjs <step>
//     unit     (bf-unit)    offline: kit/test/bf.test.mjs (the catalogue flip, the generators, x01-x03 checked clean, the affordances, the
//                           lake body, the island's anchor, survival free, the four recorded asks) and the 7c/P0 tests it touches; the
//                           Java ApiBFTest and Api7cFTest; byte identity: every committed plan fixture planned here and on the merge base
//                           (../architect-mc-BF-main) identical but the named ones (BF_MOVED); the 59 asks re-made here and on the merge
//                           base: only the four parts that waited on the three forms (and ring_city's ring_town, blocked on its crater lake) move, to fits or
//                           adjusted, 0 malformed, both tables
//                           equal kit/test/fixtures/plan/bf/asks-{before,after}.txt
//     ingame   (bf-ingame)  creative, on the flat base with each fixture's terrain (exact rules): x01 (the hollow mountain with carved
//                           halls), x02 (the free crater with a lake), x03 (the floating-island hamlet) each through Regions.checkPlan
//                           then realiseApproved: PLACED, the realised world equal to the check's virtual world (strict, per writer kind),
//                           x01's affordances answered by Regions.affordances, x02's lake standing still water, Remove E-flat 0 over the
//                           box. Survival (the RS survival base): x01 and the island alone each checked in survival (every form part's
//                           bill empty), realised from an empty stockpile: PLACED with 0 items consumed or outstanding, Remove E-flat 0
//     survival (bf-survival) (slice R2, strict: survival accounting) the RS survival base: x02 (the crater with a lake) checked in
//                           survival (the crater's bill its lake shell's, held), an INSTANT twin, realised and fed from the owner's
//                           stockpile in waves: PLACED and built, the targets' bills equal the check's, the world equal to the twin cell
//                           for cell, the conservation sum exact built and removed, Remove E-flat 0
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-bf/<step>.json in the main checkout (GATE7CBF_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { javaRun } from './lib/junit-reuse.mjs'; // (chore GRB) Java units under the gradle lock

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-BF-run');
process.env.GATE6B_OUT = process.env.GATE7CBF_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-bf');
process.env.GATE6B_SIDECAR_PORT ??= '8916';
process.env.GATE6B_DEV_PORT ??= '8917';
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

/** The recorded asks whose parts waited on the three forms (byte identity's named movers). */
export const BF_MOVED = Object.freeze({
  'asks/dwarven_hold.json': 'BF: mountain_hollow (form.hollow_mountain) answers adjusted on the flat asks claim (raised and hollowed, placed again around the hold zone; was unsupported until 7c)',
  'asks/ring_city.json': 'BF: crater_lake (form.crater, params.lake read as lake) answers fits (was unsupported until 7c)',
  'asks/sky_monastery.json': 'BF: sky_island (form.floating_island) answers adjusted (placed again around the cloister; was unsupported until N-P0-1)',
  'asks/crater_mine.json': 'BF: crater (form.crater) answers fits (was unsupported until 7c)',
  'extension/e13_floating_island.json': 'BF: a bare form.floating_island answers fits (supported, no locator: nearest the claim\'s centre; was unsupported until N-P0-1)',
  'extension/e20_7c_drafts.json': 'BF: hold adjusted, bowl and isle fits (supported since BF; were unsupported until 7c); vault and hang unchanged',
});
// (and ring_city's ring_town, blocked DEPENDENCY on its crater lake before: the dependency lifted, it fits)
const ASKS_MOVE = /^(dwarven_hold\/mountain_hollow|ring_city\/crater_lake|ring_city\/ring_town|sky_monastery\/sky_island|crater_mine\/crater) /;

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice BF is $0: sim only, no Claude call' }, null, 2)}\n`);
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
  out.kit = kitOnce(['kit/test/bf.test.mjs', 'kit/test/f7c-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/catalogue-c38.test.mjs', 'kit/test/forms-island.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 20, `kit: bf.test.mjs (the flip, the generators, x01-x03 clean, the affordances, the lake body, the island's anchor, survival free, the four asks) and the 7c/P0/catalogue/island tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  // ((chore GRB) unit-mod's XML when exact, else this gradle under the checkout's lock: tools/lib/junit-reuse.mjs javaRun)
  const javaArgs = ['test', '--offline', '-q', '--tests', 'dev.larattalabs.architect.apiimpl.ApiBFTest', '--tests', 'dev.larattalabs.architect.api.Api7cFTest'];
  const g = javaRun(root, javaArgs, () => spawnSync('./gradlew', javaArgs, { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 }), { log });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiBFTest (bigForms follows the helper\'s plan.bigForms; the jar\'s plan.json holds the three supported) and Api7cFTest', out.java.tail);
  // byte identity against the merge base, the named exceptions aside
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'BF', except: BF_MOVED, mergedIf: 'kit/lib/forms/bigForms.mjs' });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'bf-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // the 59 asks on the merge base and here
  const baseKit = path.join(path.resolve(root, '..', 'architect-mc-BF-main'), 'kit');
  // ((chore GRB) BF is on main since 30c36d79: on a base past BF nothing moves, and the base's table is the head's, so it equals the committed
  // after table; asks-before.txt stays BF's record of the five parts that waited on the three forms, as SL's and CL's items read their own)
  const onMain = fs.existsSync(path.join(baseKit, 'lib', 'forms', 'bigForms.mjs'));
  const before = await B.asksGap(baseKit, { current: true }), after = await B.asksGap(KIT, { current: true });
  fs.writeFileSync(path.join(OUT, 'bf-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'bf-asks-after.txt'), after.text);
  const lines = (t) => new Map(t.split('\n').filter((l) => /^[a-z_0-9]+\/[a-z_0-9]+ /.test(l)).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...new Set([...la.keys(), ...lb.keys()])].filter((k) => lb.get(k) !== la.get(k));
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'bf');
  out.asks = { moved: moved.map((k) => la.get(k)), malformed: after.malformed, committedAfter: fs.existsSync(path.join(F, 'asks-after.txt')) && fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8') === after.text, committedBefore: fs.existsSync(path.join(F, 'asks-before.txt')) && (fs.readFileSync(path.join(F, 'asks-before.txt'), 'utf8') === before.text || (onMain && fs.existsSync(path.join(F, 'asks-after.txt')) && fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8') === before.text)) };
  check(after.malformed === 0 && ((moved.length === 5 && moved.every((k) => ASKS_MOVE.test(`${k} `) && / (fits|adjusted)$/.test(la.get(k)))) || (onMain && moved.length === 0)) && out.asks.committedAfter && out.asks.committedBefore,
    `the 59 asks on the merge base and here: 0 malformed; ${onMain ? 'BF on the base: nothing moves' : 'exactly the four parts that waited on the three forms and ring_city\'s ring_town (blocked on its crater lake) move, each to fits or adjusted'} (${out.asks.moved.join('; ')}); both tables equal fixtures/plan/bf/asks-{before,after}.txt (${out.asks.committedBefore}, ${out.asks.committedAfter})`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

const planDir = (checkId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId);
const fixture = (n) => G.fixture(ctx, `bf/${n}`);
/** The snapshot box of a site: the claim and 8 round it, 8 under its lowest ground to 96 over its highest (the island's top). */
const boxOf = (W) => [W.claim[0] - 8, W.minY - 8, W.claim[1] - 8, W.claim[2] + 8, W.maxY + 96, W.claim[3] + 8];

/** One fixture in creative: check, realise, realised == virtual, its own probe, remove (E-flat 0). */
async function creative(tag, fx, partId, probe = null) {
  const r = { tag };
  const s = await G.site(ctx, `bf ${tag}`, fx, { creative: true });
  const box = boxOf(s.W);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  await L.settle(3000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: false }, 1_800_000);
  const pre = await G.snap(ctx, box, `bf-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const a = ck.check?.parts?.find((p) => p.part === partId);
  r.check = { overall: ck.check?.overall, class: a?.class, reasons: a?.reasons, notes: a?.notes, parts: (ck.check?.parts ?? []).map((q) => [q.part, q.class]) };
  check(ck.check?.overall === 'READY' && ['fits', 'adjusted'].includes(a?.class), `${tag}: Regions.checkPlan: ${ck.check?.overall}, ${partId} ${a?.class} ${json(a?.reasons ?? [])}`, r.check);
  if (!ck.check?.artifactSha) return r;
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 3_600_000);
  r.state = st.view.state;
  check(st.view.state === 'PLACED', `${tag}: realiseApproved: ${st.view.state} (${st.record?.cellsWritten ?? st.view.cellsWritten ?? '?'} cells)`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: false }, 1_800_000);
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir(ck.check.checkId), after, before, { lots: true });
  r.virtual = { written: rv.written, differ: rv.differ, byKind: Object.fromEntries(Object.entries(rv.byKind).map(([k, v]) => [k, { written: v.written, differ: v.differ }])), first: rv.first };
  const ok = RV.realisedOk(rv, ['forms'], { strict: true });
  check(ok.pass, `${tag}: the realised world equals the check's virtual world (strict, the flat base): ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`, { missing: ok.missing, loose: ok.loose });
  if (probe) r.probe = await probe({ ck, a, st, region, s });
  await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  r.eflat = { mismatches: e.mismatches, list: e.list.slice(0, 8) };
  check(e.mismatches === 0, `${tag}: Regions.remove: E-flat ${e.mismatches} over the box`, r.eflat);
  return r;
}

/** One plan in survival from an empty stockpile: every form part's bill empty, PLACED, 0 consumed or outstanding, E-flat 0. */
async function survival(tag, fx, partIds) {
  const r = { tag };
  const s = await G.site(ctx, `bf ${tag}`, fx);
  const box = boxOf(s.W);
  const pre = await G.snap(ctx, box, `bf-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const parts = Object.fromEntries((ck.check?.parts ?? []).map((q) => [q.part, { class: q.class, survival: q.cost?.survival ?? null }]));
  r.check = { overall: ck.check?.overall, survival: ck.check?.survival, parts };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && partIds.every((id) => ['fits', 'adjusted'].includes(parts[id]?.class) && sum(parts[id]?.survival?.bom) === 0 && parts[id]?.survival?.free > 0),
    `${tag} (survival): Regions.checkPlan in survival: ${ck.check?.overall}; ${partIds.map((id) => `${id} ${parts[id]?.class}, free ${parts[id]?.survival?.free}, held ${parts[id]?.survival?.held}, bill ${json(parts[id]?.survival?.bom)}`).join('; ')}`, r.check);
  if (!ck.check?.artifactSha) return r;
  const crates = await G.pile(ctx, s, 1);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const w = await G.waitFor(ctx, region, (st) => ['PLACED', 'FAILED', 'PARTIAL'].includes(st.view.state), { timeoutMs: 1_800_000, every: 3000 });
  const ps = await G.pileState(ctx);
  const rs = await G.rsState(ctx, region);
  r.built = { state: w.st?.view?.state, consumed: ps.consumed ?? {}, outstanding: ps.outstanding ?? {}, targets: (rs.targets ?? []).map((t) => [t.target, t.part, t.cells, t.built]) };
  check(w.st?.view?.state === 'PLACED' && sum(ps.consumed) === 0 && sum(ps.outstanding) === 0, `${tag} (survival): realised from an empty stockpile: ${w.st?.view?.state}; ${sum(ps.consumed)} item(s) consumed, ${sum(ps.outstanding)} outstanding (the bill: 0 items)`, r.built);
  await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const eflat = e.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  r.eflat = { mismatches: eflat.length, list: eflat.slice(0, 8) };
  check(eflat.length === 0, `${tag} (survival): Regions.remove: E-flat ${eflat.length} over the box (the crate aside)`, r.eflat);
  return r;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  out.x01 = await creative('x01', fixture('x01_hollow_mountain'), 'hold', async ({ a, st }) => {
    // the plan's affordances through Regions.affordances: the cavern's cliff faces, cave and ledge
    const af = await call('dev.af.affordances', { plan: st.view.planId }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
    const got = new Set((af.affordances ?? []).map((x) => x.id));
    const want = a?.geometry?.affordances ?? [];
    const p = { known: af.known, n: af.affordances?.length, want: want.length, missing: want.filter((id) => !got.has(id)), error: af.error };
    check(af.known && want.length >= 3 && p.missing.length === 0 && ['cave_', 'cliff_face_', 'ledge_'].every((k) => want.some((id) => id.startsWith(k))),
      `x01: Regions.affordances answers the hollow mountain's ${want.length} affordances (cave, cliff faces, ledge) among its ${af.affordances?.length}`, p);
    return p;
  });
  out.x02 = await creative('x02', fixture('x02_crater_lake'), 'crater', async ({ a }) => {
    // the lake: the answer names its pond body; its sources, shell and the still water over the bowl are the realised == virtual row's
    const lake = a?.geometry?.lake;
    check(!!lake?.body && lake.depth >= 1, `x02: the answer names the lake's pond body (${json(lake)})`);
    return { lake };
  });
  out.x03 = await creative('x03', fixture('x03_island_hamlet'), 'isle');
  // survival: the hollow mountain, and the island alone (the hamlet's lots are construction sites with their own bill)
  out.s01 = await survival('s01', fixture('x01_hollow_mountain'), ['hold']);
  const isle = JSON.parse(JSON.stringify(fixture('x03_island_hamlet')));
  delete isle.plan.zones;
  out.s03 = await survival('s03', isle, ['isle']);
  return out;
};

// ------------------------------------------------------------------ (slice R2) survival: a crater lake's shell bills its pond's blocks

/**
 * (R2, strict: survival accounting) x02 (the free crater with a lake) in survival: its INSTANT twin; checked in survival, the crater
 * part's bill is its lake shell's (H's rule: the pond's shell is a construction target; the bowl, rim and sources are free terrain); a
 * stockpile and the conservation sum; realised and fed in waves: PLACED and built, the crater's targets built and their bills equal the
 * check's cost.survival.bom item for item, the world equal to the twin cell for cell, items in = items out once built and once removed
 * (every item back), Remove E-flat 0.
 */
async function survivalLake(tag, fx, partId) {
  const out = { tag };
  const T = await G.twin(ctx, `bf-${tag}`, fx, {});
  const s = await G.site(ctx, `bf ${tag}`, fx);
  const box = boxOf(s.W);
  const pre = await G.snap(ctx, box, `bf-${tag}-pre`);
  const ck = await G.check(ctx, `bf-${tag}`, s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === partId);
  const sv = a?.cost?.survival;
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, part: { class: a?.class, survival: sv, lake: a?.geometry?.lake ?? null } };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && ['fits', 'adjusted'].includes(a?.class) && sum(sv?.bom) > 0 && sv?.held > 0 && !!a?.geometry?.lake?.body,
    `${tag} (survival): Regions.checkPlan in survival: ${ck.check?.overall}; ${partId} ${a?.class}: free ${sv?.free}, held ${sv?.held} behind the lake shell's bill ${json(sv?.bom)} (lake ${json(a?.geometry?.lake?.body)})`, out.check);
  if (!ck.check?.artifactSha) return out;
  const crateAt = await G.pile(ctx, s, 3);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha);
  out.region = region;
  const p0 = await C.point('realised');
  // held until supplied: before any feed the crater's target stands unbuilt
  // (the targets appear once the region is queued; the billed one, the shell, waits for its items: the free ones may build at once)
  const billed = (rs) => (rs?.targets ?? []).filter((t) => t.part === partId && sum(t.bom) > 0);
  const w0 = await G.waitFor(ctx, region, (st, rs) => billed(rs).length > 0 || ['PLACED', 'FAILED', 'PARTIAL'].includes(st.view.state), { timeoutMs: 600_000, every: 2000 });
  await L.sleep(15_000);
  const rs0 = await G.rsState(ctx, region);
  const st0 = await L.call('dev.region.state', { region }, 60_000);
  out.held = { state: st0?.view?.state, targets: (rs0.targets ?? []).filter((t) => t.part === partId).map((t) => ({ target: t.target, cells: t.cells, built: t.built, bom: t.bom })) };
  check(w0.ok && billed(rs0).length > 0 && billed(rs0).every((t) => !t.built) && st0?.view?.state !== 'PLACED',
    `${tag} (survival): before any item is fed the lake shell's billed target waits unbuilt (held), the region not PLACED (${st0?.view?.state}): ${json(out.held.targets.map((t) => [t.target, t.cells, t.built, t.bom]))}`, out.held);
  const f = await G.feed(ctx, region, { cons: C, fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, parts: (rs.build.parts ?? []).map((q) => [q.part, q.state, q.targets?.length]) };
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100 && f.waves >= 2, `${tag} (survival): realiseApproved and fed in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(out.build)}`);
  const targets = (rs.targets ?? []).filter((t) => t.part === partId).map((t) => ({ target: t.target, part: t.part, cells: t.cells, built: t.built, bom: t.bom }));
  out.targets = targets;
  check(targets.length > 0 && targets.every((t) => t.built), `${tag} (survival): the lake shell's target is built: ${json(targets.map((t) => [t.target, t.cells, t.built, t.bom]))}`, targets);
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => !G.same(bills.want[p], bills.got[p]));
  check(differ.length === 0 && G.same(bills.want[partId], sv?.bom) && G.same(bills.got[partId], sv?.bom),
    `${tag} (survival): ${partId}'s cost.survival.bom against its targets' bills put down: ${differ.length ? `differs ${differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ')}` : `equal, item for item (${json(bills.got[partId])})`}`, bills);
  const pb = await C.point('built');
  out.builtPoint = pb;
  check(G.exact(p0) && G.exact(pb), `${tag} (survival): items in = items out once built: every item fed is in the stockpile or standing as a paid block (the conservation sum ${json(pb.diff)}, identity ${pb.identity})`, pb);
  await L.settle(5000);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `${tag} (survival): the realised world equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `${tag} (survival): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  const pr = await C.point('removed');
  out.removedPoint = pr;
  check(G.exact(pr), `${tag} (survival): items in = items out once removed: every item back (the conservation sum ${json(pr.diff)}, identity ${pr.identity}; refund ${json(rm.refund)}, the bill ${json(sv?.bom)})`, pr);
  out.conservation = C.points;
  return out;
}

steps.survival = async () => {
  await ensure();
  spendZero();
  return { s02: await survivalLake('s02', fixture('x02_crater_lake'), 'crater') };
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
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7c-BF (big forms)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7cbf.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
