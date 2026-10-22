#!/usr/bin/env node
// Phase 6c slice RS gate (docs/CONTRACT.md "Phase 6c slice RS: regions in survival, the terrain half" §13, with Steward's review and the
// coordinator's decisions) against the headless server of the RS run worktree (GATE6B_RUN, default `../architect-mc-RS-run`, a detached
// worktree at this checkout's HEAD; the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6crs.mjs <step>
//     start [world] | stop | base       the headless server and the base worlds (the survival flat base: survival, cheats, the toggle on)
//     unit      (rs-unit)               offline: item 1 (kit/test/rs.test.mjs; the mod's RegionTargetsTest; the broken variants carveFirst,
//                                       loseCredit, lavaRefund caught), item 2 (byte identity: every committed plan fixture, the 59 asks
//                                       among them, as on the merge base, kitVersion normalised; rs02's creative tile shas as on the base;
//                                       the asks before and after: fixtures/plan/rs/asks-creative.md, asks-survival.md), item 17 (api-compat)
//     latent                            §0's latent bug: a creative-game-type world with the toggle on realises a region (PLACED)
//     item4  .. item15                  one item each, on a fresh world copy (the verifier re-runs item5, item8, item9, item10, item11)
//     ingame    (rs-ingame)             latent, items 4, 6 (with RP's record half built and after build.done), 6b, 7, 12, 13, 15
//     survival  (rs-survival)           items 3 and 5 (build, bills), 8 (conservation), 9 (removal), 10 (mid-build removal), 14 (natural)
//     crash     (rs-crash)              item 11
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-rs/<step>.json in the main checkout (GATE6CRS_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-RS-run');
process.env.GATE6B_OUT = process.env.GATE6CRS_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-rs');
process.env.GATE6B_SIDECAR_PORT ??= '8930';
process.env.GATE6B_DEV_PORT ??= '8931';
process.env.GATE6B_CLIENT_SCRIPT ??= 'tools/run-headless-server.mjs';
process.env.HEADLESS_SIDECAR ??= 'sim';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, cmd, sleep } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

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
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RS is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ the server and the worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B RS Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(G.FLAT);
  await G.survivalBase(ctx);
  spendZero();
  return { worlds: [G.FLAT, G.SURV] };
};

// ------------------------------------------------------------------ offline: items 1, 2, 17

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
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

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/rs.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 9, `item 1 (kit, kit/test/rs.test.mjs): the free rule per row (a terrain fill free, a cut free, a wall's body and its natural stone paid, a fill and a cut beside a wall held, an ore paid, a creative-only block paid and named, a dirt path free on the surface and paid over it, a pad free though its part holds, water, an ice cap and lava's source no target cell), notes.survival, free marks only in a survival IR, the kinds, FREE_EXCEPT, the region's bill equal to bom.mjs's, every RS fixture's cost.survival and cost.bom and its artifact, SURVIVAL {creativeOnly}, rs01's held terrace: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.java = await javaTests(['*RegionTargetsTest*'], 6);
  check(out.java.ok, `item 1 (mod, RegionTargetsTest): a carve after its lining and the broken variant carveFirst caught; runs a course each within a quarter of the capacity; ARTL v2's classes and groups; the lava scoop never mints a bucket and credits once (lavaRefund and loseCredit caught by the sum); a target's record (region, part, held cells, no crate): ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  out.regression = await javaTests(['*ApiDTest*', '*RegionFluidsHYTest*', '*PlanChecksT3Test*', '*IrStale*', '*C29CreditTest*', '*FeedOrderTest*', '*RoadFreeCellTest*'], 10);
  check(out.regression.ok, `item 1 (mod): the neighbours RS touches still pass (RegionView's trailing build, the kinds list, the key body, the feed order, the road's free cell): ${out.regression.tests} tests, ${out.regression.failures} failures`, out.regression.tail);
  // item 2: byte identity against the merge base (every committed plan fixture, the 59 asks among them)
  const U = await import('./lib/gate6crs-kit.mjs');
  const u = await U.unchanged(root, { check, log });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ };
  fs.writeFileSync(path.join(OUT, 'rs-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  out.tiles = await U.creativeTiles(root, { check, log });
  out.asks = await U.asksTables(root, { check, log, OUT });
  // item 17: the unchanged apitest jars of 0.40.0 (the base), 0.39.1 and 0.39.0 against this build, and 0.40.0's whole surface
  const jars = process.env.RS_JARS ?? path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts');
  const env = { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  out.apicompat = {};
  let acOk = true;
  for (const [dir, ver] of [['gate6c-fl/v0400', '0.40.0'], ['gate6c-batchcu/v0391', '0.39.1'], ['gate6c-kc/v0390', '0.39.0']]) {
    const jar = path.join(jars, dir, `architect_apitest-${ver}.jar`);
    const r = spawnSync(process.execPath, ['tools/api-compat.mjs', jar], { cwd: root, encoding: 'utf8', timeout: 900_000, env });
    out.apicompat[ver] = `${r.stdout}${r.stderr}`.trim().split('\n').pop();
    acOk &&= r.status === 0 && fs.existsSync(jar);
  }
  const sj = path.join(jars, 'gate6c-fl', 'v0400', 'architect_mc-0.40.0.jar');
  const sr = spawnSync(process.execPath, ['tools/api-compat.mjs', '--surface', sj], { cwd: root, encoding: 'utf8', timeout: 900_000, env });
  out.apicompat.surface = `${sr.stdout}${sr.stderr}`.trim().split('\n').pop();
  acOk &&= sr.status === 0;
  check(acOk, `item 17: api-compat clean against the archived 0.40.0, 0.39.1 and 0.39.0 apitest jars and 0.40.0's surface (RegionView gains a trailing build, PlanCheck a trailing survival: the old constructors kept; RegionBuild, PartBuild new); $0.00`, out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the latent bug (§0, §5)

steps.latent = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs01_land');
  const s = await G.site(ctx, 'latent', fx, { creative: true });
  await L.call('dev.survival.set', { on: true });
  const sv = await L.call('dev.survival.state', {});
  const ck = await G.check(ctx, 'latent', s);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 1_800_000);
  const r = await G.regionState(ctx, region);
  const out = { toggle: sv, survivalCheck: ck.check?.survival ?? false, state: st.view.state, items: st.items, failed: r.failed ?? {} };
  check(sv.survival === true && !ck.check?.survival && st.view.state === 'PLACED' && Object.keys(r.failed ?? {}).length === 0, `§0's latent bug: in a creative-game-type world with the survival toggle on (mode creative by the world), rs01 checked in creative and realised: ${st.view.state}, ${Object.keys(r.failed ?? {}).length} item(s) failed (on the base e755d663 every item failed NOT_ALLOWED "survival was switched on after this was queued": artifacts/gate6c-rs/latent-base.json); its items now queue survivalAtQueue from the toggle`, out);
  await G.remove(ctx, region);
  return out;
};

// ------------------------------------------------------------------ item 4: the free pass

steps.item4 = async () => {
  await ensure();
  const fx = G.fixture(ctx, 'rs01_land');
  const T = await G.twin(ctx, 'rs01', fx);
  const s = await G.site(ctx, 'rs01', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'rs-rs01-pre');
  const ck = await G.check(ctx, 'rs01', s);
  check(ck.check?.survival === true && ck.check?.overall === 'READY', `item 4: rs01 through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}, ${json((ck.check?.parts ?? []).map((a) => [a.part, a.class, a.cost?.survival?.free, a.cost?.survival?.held]))}`);
  const crates = await G.pile(ctx, s, 3);
  const cons = new G.Conservation(ctx, box);
  await cons.start();
  const region = await G.realise(ctx, ck.check.artifactSha);
  // the free pass: every item of the first stages put down; then nothing more is built without the stockpile (no item consumed)
  let w = null;
  for (let k = 0; k < 60; k++) {
    await sleep(3000);
    const st = await G.regionState(ctx, region);
    const busy = Object.entries(st.items ?? {}).some(([k2, n]) => /PLACING|QUEUED/.test(k2) && n > 0) && !Object.keys(st.items ?? {}).some((k2) => /WAITING/.test(k2));
    if (!busy && k > 3) { w = st; break; }
  }
  const ps = await G.pileState(ctx);
  const p = await cons.point('the free pass');
  const rs = await G.rsState(ctx, region);
  const cells = await L.call('dev.rs.cells', { region }, 300_000);
  const target = new Set();
  for (const t of cells.targets ?? []) for (const c of t.cells ?? []) target.add(`${c[0]},${c[1]},${c[2]}`);
  // every free cell written as the twin's: a cell differing from the twin is an unbuilt target cell, or lies in a tile the region has not
  // put down yet (its stage waits SITE_BUSY for the earlier targets it stands on, §6.3)
  const all = await L.call('dev.region.hash', { box: T.box, mode: 'diff', file: T.file, limit: 1_000_000 }, 3_600_000);
  const r0 = await G.regionState(ctx, region);
  const waitingTiles = new Set((r0.unfinished ?? []).filter((it) => it.key.startsWith('t:')).map((it) => it.key.slice(it.key.lastIndexOf(':') + 1)));
  const tileOf = (pos) => { const [x, , z] = pos.split(',').map(Number); return `${Math.floor(x / 64)},${Math.floor(z / 64)}`; };
  const crateSet = new Set(crates.map((c) => c.join(',')));
  const notTarget = (all.list ?? []).filter((m) => !target.has(m.pos) && !crateSet.has(m.pos));
  const free = notTarget.filter((m) => !waitingTiles.has(tileOf(m.pos)));
  const out = { region, state: w?.view?.state, items: w?.items, consumed: ps.consumed ?? {}, entities: p.entities, targets: (rs.targets ?? []).map((t) => [t.target, t.part, t.cells, t.built, t.held]), parts: rs.build?.parts, waitingTiles: [...waitingTiles], twinDiff: { all: all.mismatches, listed: (all.list ?? []).length, notTarget: notTarget.length, freeDiffer: free.slice(0, 12) } };
  check(sum(ps.consumed) === 0 && p.entities === 0, `item 4: the free pass consumed 0 items from the stockpile (consumed ${json(ps.consumed)}) and left 0 item entities in the box (${p.entities})`, out);
  check((all.list ?? []).length === all.mismatches && free.length === 0, `item 4: the free cells equal the INSTANT twin's: of ${all.mismatches} cells differing from the twin (all listed), ${all.mismatches - notTarget.length} are unbuilt target cells, ${notTarget.length - free.length} lie in tiles not yet put down (${[...waitingTiles].join(' ')}), ${free.length} are written free cells that differ`, free.slice(0, 12));
  const steps0 = (rs.build?.parts ?? []).find((q) => q.part === 'steps');
  check(!steps0 || steps0.state === 'waiting' && steps0.built === 0, `item 4: the held terrace waits whole (${steps0 ? `part steps: ${json({ state: steps0.state, targets: steps0.targets, cells: steps0.cells, built: steps0.built, freeCells: steps0.freeCells })}` : 'its forms tiles not yet put down: they wait SITE_BUSY for the street\'s roads'}): no cut or fill of it written before its stairs`);
  await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const eflat = e.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  check(eflat.length === 0, `item 4: removed before any build: E-flat ${eflat.length} (the crates aside)`, eflat.slice(0, 8));
  return out;
};

// ------------------------------------------------------------------ items 3 and 5: build, the bills

/** The lot entries a fixture binds (fixture lotEntries, else every lot of its plan an rs_hut, a farm or a smithy an rs_shed). */
function entriesOf(fx) {
  if (fx.lotEntries) return fx.lotEntries;
  const out = {};
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.lots)) for (const l of o.lots) if (l?.id && l.type) out[l.id] = ['farm', 'smithy', 'barn'].includes(l.type) ? 'rs_shed' : 'rs_hut';
      Object.values(o).forEach(walk);
    }
  };
  walk(fx.plan?.zones ?? []);
  return out;
}

/** The fluid bodies' report (the region's ext architect_mc:fluids): [{body, state}]. */
const bodiesOf = (st) => (st.view?.ext?.['architect_mc:fluids'] ?? []).map((b) => ({ body: b.body, state: b.state, reason: b.reason ?? null }));

/**
 * One fixture built in survival (item 5): its INSTANT twin, then a survival world: checked in survival, a stockpile of `crates`, realised,
 * fed in waves (half of what is lacking, then the rest), every target and lot BUILT, every body settled, the world equal to the twin
 * cell for cell (the crates aside), the bills per part equal to the check's (item 3); removed: E-flat 0. Returns the evidence.
 */
async function buildOne(tag, name, { crates = 4, cons = null, remove = true, keep = null } = {}) {
  const fx = G.fixture(ctx, name);
  const entries = entriesOf(fx);
  const T = await G.twin(ctx, tag, fx, entries);
  const s = await G.site(ctx, tag, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, `rs-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const out = { tag, fixture: name, overall: ck.check?.overall, survival: ck.check?.survival, entries };
  check(ck.check?.survival === true && ['READY', 'NEEDS_REPAIR'].includes(ck.check?.overall) && !!ck.check?.artifactSha, `item 5 (${tag}): Regions.checkPlan in survival: ${ck.check?.overall}, ${json((ck.check?.parts ?? []).map((a) => [a.part, a.class]))}`);
  const crateAt = await G.pile(ctx, s, crates);
  const C = cons ? new G.Conservation(ctx, box) : null;
  if (C) await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  if (C) await C.point('realised');
  let waves = 0;
  const f = await G.feed(ctx, region, { cons: C, fraction: 0.5, timeoutMs: 2_400_000, onWave: async () => { waves++; if (C && waves % 2 === 0) await C.point(`wave ${waves}`); } });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.state = st.view.state;
  out.build = rs.build;
  out.bodies = bodiesOf(st);
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100, `item 5 (${tag}): realiseApproved and fed in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent })}, every part built ${json((rs.build?.parts ?? []).map((p) => [p.part, p.state, p.targets.length]))}`);
  if (out.bodies.length) check(out.bodies.every((b) => b.state === 'settled'), `item 5 (${tag}): every body settled with its census after its barrier (${json(out.bodies)})`);
  if (C) await C.point('built');
  // item 3: the bills per part (the check's cost.survival.bom against the targets' bills put down)
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  // per plan part (a helper group without a part answer counts in the region's whole bill only)
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  check(differ.length === 0, `item 3 (${tag}, per part and the region whole): the check's cost.survival.bom against the targets' bills put down: ${differ.length ? `${differ.length} part(s) differ: ${differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ')}` : 'equal, item for item, for every part'}`, bills);
  out.billsDiffer = differ;
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 5 (${tag}): the realised world equals its INSTANT twin cell for cell (gravity, dependents, block entities; the stockpile's crates aside): ${d.mismatches} differ`, d.list);
  if (keep) await keep({ region, s, box, pre, crateAt, ck, rs, C });
  if (remove) {
    const rm = await G.remove(ctx, region);
    out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
    const e = await G.diff(ctx, box, pre);
    const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
    out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
    check(rm.removed && ef.length === 0, `item 5 (${tag}): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
    if (C) await C.point('removed');
  }
  if (C) out.conservation = C.points;
  return out;
}

steps.item5 = async () => {
  await ensure();
  const out = {};
  // (rs04, the tunnel, is RS-b's row: RS_ONLY=rs04 runs it)
  for (const [tag, name] of [['rs02', 'rs02_walled'], ['rs03', 'rs03_water'], ['village', 'survival_village'], ...(process.env.RS_ONLY?.includes('rs04') ? [['rs04', 'rs04_tunnel']] : [])]) {
    if (process.env.RS_ONLY && !process.env.RS_ONLY.split(',').includes(tag)) continue; // (development: one fixture)
    try { out[tag] = await buildOne(tag, name, { remove: !process.env.RS_KEEP }); } catch (e) { check(false, `item 5 (${tag}): ${String(e.message).slice(0, 300)}`); out[tag] = { error: String(e.stack ?? e) }; }
  }
  return out;
};

// ------------------------------------------------------------------ item 6: half fed (the half-built safety)

/** The kit's checker over the world as it stands (a dump of the box against the pre-realise dump): its M3, M4, M8 and gravity. */
async function standing(tag, ck, box, beforeFile) {
  const { decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const afterFile = path.join(OUT, `rs-${tag}-half.arwd.gz`);
  await L.call('dev.region.dump', { box, file: afterFile }, 1_800_000);
  const before = await decodeArwd(fs.readFileSync(beforeFile));
  const after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false, blobs });
  const m = rep.metrics ?? {};
  const find = (re) => (rep.findings ?? []).filter((f) => re.test(f.rule)).reduce((a, f) => a + (f.count ?? 1), 0);
  // M8 judged on the edges the build made: an unguarded walk cell whose drop is the site's own (its four neighbour columns, the walk
  // level down 5, as before the realise: a natural cliff the plan's bridge will span) is the land's, not a half-built part's
  const st = (d, x, y, z) => d.palette[d.cells[d.at(x, y, z)]];
  const air = (d, x, y, z) => /^minecraft:(air|cave_air|void_air)$/.test(String(st(d, x, y, z)).replace(/\[.*$/, ''));
  const made = (m.M8?.unguardedSample ?? []).filter(([x, y, z]) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
    const nx = x + dx, nz = z + dz;
    if (!(air(after, nx, y, nz) && air(after, nx, y - 1, nz) && air(after, nx, y - 2, nz) && air(after, nx, y - 3, nz))) return false; // not the drop side
    for (let k = 0; k <= 5; k++) if (st(before, nx, y - k, nz) !== st(after, nx, y - k, nz)) return true;
    return false;
  }));
  return { M8made: made.length, M3: m.M3?.floatingCells ?? null, M4: m.M4?.breaches ?? null, M8: m.M8 ? m.M8.unguarded : null, M8at: (m.M8?.unguardedSample ?? []).slice(0, 8), gravity: find(/^M3:gravity/), spurs: find(/^M3:floating_spur/) };
}

/** No cut open without its paid neighbours (a bore cell without its lining, a terrace's cut without its wall): over every target's cells. */
async function openCuts(region) {
  const cells = await L.call('dev.rs.cells', { region }, 300_000);
  const at = new Map();
  for (const t of cells.targets ?? []) for (const c of t.cells ?? []) at.set(`${c[0]},${c[1]},${c[2]}`, c[3]);
  const bad = [];
  for (const [k, f] of at) {
    if (!((f & 1) && (f & 2) && (f & 4))) continue; // a held cut, built (open)
    const [x, y, z] = k.split(',').map(Number);
    for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const g = at.get(`${x + dx},${y + dy},${z + dz}`);
      if (g !== undefined && !(g & 1) && !(g & 2)) bad.push(`${k} (its paid neighbour ${x + dx},${y + dy},${z + dz} unbuilt)`);
    }
  }
  return { cells: at.size, open: [...at.values()].filter((f) => (f & 1) && (f & 2) && (f & 4)).length, bad };
}

/** No run started without its whole bill: a started, unfinished run's remaining bill is held by the stockpile (stock covers it). */
async function runsSafe(region) {
  const rs = await G.rsState(ctx, region);
  const ps = await G.pileState(ctx);
  const bad = [];
  let started = 0;
  for (const t of rs.targets ?? []) {
    const cur = (t.runList ?? [])[t.currentRun];
    if (!cur) continue;
    const startedUnfinished = (t.runList ?? []).filter((r) => r.started && r !== cur);
    void startedUnfinished;
    if (cur.started && t.built < t.cells) {
      started++;
      for (const [it, n] of Object.entries(t.reserving ?? {})) if ((ps.stock?.[it] ?? 0) < n) bad.push(`${t.target} run ${t.currentRun} started with ${it} ${ps.stock?.[it] ?? 0} < its ${n}`);
    }
  }
  return { targets: (rs.targets ?? []).length, started, bad };
}

/** Half of the region's whole bill (the check's, and what the stockpile asks for its lots), fed in waves of what the targets lack. */
async function halfFeed(region, ck, cons = null) {
  const half = {};
  // (the stockpile takes what its targets need now, a run at a time: fed in waves of what they lack, up to half the whole bill)
  // the whole bill: the check's (the region's cells, its 4e roads) and the lots' designs as the stockpile asks for them
  const whole = G.plus(ck.check.cost.bom, {});
  for (const [it, n] of Object.entries((await G.pileState(ctx)).outstanding ?? {})) whole[it] = Math.max(whole[it] ?? 0, n);
  for (const [it, n] of Object.entries(whole)) if (Math.floor(n / 2) > 0) half[it] = Math.floor(n / 2);
  let acc = {};
  for (let k = 0; k < 200; k++) {
    const ps = await G.pileState(ctx);
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      const left = (half[it] ?? 0) - (acc[it] ?? 0);
      const lack = Math.min(left, n - (ps.stock?.[it] ?? 0));
      if (lack > 0) need[it] = lack;
    }
    if (!Object.keys(need).length) { if (k > 3) break; await sleep(4000); continue; }
    const a = cons ? await cons.insert(`stockpile:${G.OWNER}`, need) : (await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    acc = G.plus(acc, a);
    await sleep(3000);
  }
  return { half, acc };
}

steps.item6 = async () => {
  await ensure();
  const out = {};
  for (const [tag, name] of [['rs02', 'rs02_walled'], ...(process.env.RS_ONLY?.includes('rs04') ? [['rs04', 'rs04_tunnel']] : [])]) {
    if (process.env.RS_ONLY && !process.env.RS_ONLY.split(',').includes(tag)) continue;
    const fx = G.fixture(ctx, name);
    const entries = entriesOf(fx);
    const s = await G.site(ctx, `${tag} half`, fx);
    if (Object.keys(entries).length) await G.designs(ctx);
    const box = G.boxOf(s.W);
    const beforeFile = path.join(OUT, `rs-${tag}-half-before.arwd.gz`);
    await L.call('dev.region.dump', { box, file: beforeFile }, 1_800_000);
    const ck = await G.check(ctx, `${tag}-half`, s);
    await G.pile(ctx, s, 4);
    const region = await G.realise(ctx, ck.check.artifactSha, entries);
    // half of each item's whole bill, once (the check's cost.bom), then the builder runs until nothing moves
    // every item put down (its targets, roads and lots on the stockpile), then half of what they need, once
    await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 900_000 });
    const { half, acc } = await halfFeed(region, ck);
    let last = -1, still = 0;
    for (let k = 0; k < 120 && still < 4; k++) {
      await sleep(4000);
      const rs = await G.rsState(ctx, region);
      const built = (rs.targets ?? []).reduce((a, t) => a + t.built, 0);
      still = built === last ? still + 1 : 0;
      last = built;
    }
    const runs = await runsSafe(region);
    const cuts = await openCuts(region);
    const sm = await standing(`${tag}`, ck, box, beforeFile);
    const rs = await G.rsState(ctx, region);
    out[tag] = { fed: acc, half, view: (await G.regionState(ctx, region)).view?.state, runs, cuts: { cells: cuts.cells, open: cuts.open, bad: cuts.bad.slice(0, 8) }, standing: sm, build: rs.build && { percent: rs.build.percent, parts: rs.build.parts.map((p) => [p.part, p.state, p.built, p.cells]) } };
    check(runs.bad.length === 0, `item 6 (${tag}, half fed ${sum(acc)} items): no run started without its whole bill (${runs.started} run(s) under way, each with its remaining bill in stock)`, runs.bad.slice(0, 6));
    check(cuts.bad.length === 0, `item 6 (${tag}): no cut open without its lining or wall: ${cuts.open} open cut(s) of ${cuts.cells} target cells, every paid neighbour above and beside built`, cuts.bad.slice(0, 6));
    check(sm.M3 === 0 && (sm.M4 ?? 0) === 0 && sm.M8made === 0 && sm.gravity === 0, `item 6 (${tag}): the world as it stands half built: M3 ${sm.M3} floating, M4 ${sm.M4}, M8 ${sm.M8made} unguarded edge(s) the build made (${sm.M8} in all: the rest the land's own drops, unchanged since before the realise), ${sm.gravity} gravity`, sm);
    // (batch v0.41.0, RP wiring) half built: the unbuilt targets' cells UNFINISHED in the realised record, the built ones WRITTEN with
    // their sites listed; then the rest fed to build.done: nothing UNFINISHED and dev.region.realised verify agrees
    const rpHalf = await G.rpRecord(ctx, region);
    check(...G.rpHalf(tag, rpHalf, { needBuilt: true }), rpHalf);
    const fd = await G.feed(ctx, region, { timeoutMs: 1_800_000 });
    const rpDone = await G.rpRecord(ctx, region, { verify: true });
    const [okDone, msgDone] = G.rpDone(tag, rpDone);
    check(okDone && fd.last.st.view.state === 'PLACED' && fd.last.rs.build?.done, `${msgDone}; the rest fed: ${fd.last.st.view.state}, done ${fd.last.rs.build?.done}`, rpDone);
    out[tag].rp = { half: rpHalf, done: rpDone };
    await G.remove(ctx, region);
  }
  // rs06: the road over the held terrace waits for the terrace's target, then equals its twin
  if (!process.env.RS_ONLY || process.env.RS_ONLY.split(',').includes('rs06')) {
    const fx = G.fixture(ctx, 'rs06_over_held');
    const T = await G.twin(ctx, 'rs06', fx);
    const s = await G.site(ctx, 'rs06', fx);
    const ck = await G.check(ctx, 'rs06', s);
    const crates = await G.pile(ctx, s, 4);
    const region = await G.realise(ctx, ck.check.artifactSha);
    // fed in full: the terrace's target builds at the builder's pace while the road over it waits SITE_BUSY, nothing of it written
    let sawWait = null, roadEarly = false, stepsSeen = false;
    const f = await G.feed(ctx, region, { timeoutMs: 1_800_000, until: (st, rs) => {
      const w = (st.unfinished ?? []).find((it) => String(it.key).startsWith('road:') && it.reason === 'SITE_BUSY');
      if (w && !sawWait) sawWait = w;
      const steps0 = (rs.build?.parts ?? []).find((p) => p.part === 'steps');
      if (steps0) stepsSeen = true;
      // the road item off the unfinished list (put down) while the terrace's target is not BUILT: written early
      if (steps0 && steps0.state !== 'built' && !(st.unfinished ?? []).some((it) => String(it.key).startsWith('road:'))) roadEarly = true;
      return st.view.state === 'PLACED' && rs.build?.done;
    } });
    check(!!sawWait && stepsSeen && !roadEarly, `item 6 (rs06): the road over the terrace waits SITE_BUSY while the terrace's target builds (${json(sawWait)}), nothing of it written before`);
    const d = await G.twinDiff(ctx, T.box, T.file, crates);
    check(f.last.rs.build?.done && d.mismatches === 0, `item 6 (rs06): then the terrace built, the road and its lamps written: done ${f.last.rs.build?.done}, equal to the INSTANT twin (${d.mismatches} differ)`, d.list);
    out.rs06 = { wait: sawWait, early: roadEarly, twin: d.mismatches };
    await G.remove(ctx, region);
  }
  return out;
};

// ------------------------------------------------------------------ shared: the apitest events, a site realised and waiting

/** /apitest <args>, its JSON answer (the apitest mod is on the headless server's classpath). */
async function api(args) {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
  return JSON.parse(line);
}
const stacksOf = (m) => Object.values(m ?? {}).reduce((a, n) => a + Math.ceil(n / 64), 0);

/** A fixture's site in survival, checked, a stockpile of `crates`, realised (its lots bound), its targets down. */
async function realised(tag, name, { crates = 4, entries = null, world = null } = {}) {
  const fx = G.fixture(ctx, name);
  const ent = entries ?? entriesOf(fx);
  const s = await G.site(ctx, world ?? tag, fx);
  if (Object.keys(ent).length) await G.designs(ctx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, `rs-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const crateAt = await G.pile(ctx, s, crates);
  const region = await G.realise(ctx, ck.check.artifactSha, ent);
  const w = await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 900_000 });
  return { fx, entries: ent, s, box, pre, ck, crateAt, region, rs: w.rs, st: w.st };
}

/** Inserts what the owner's targets lack, at most what fits in the stockpile's free stacks (inexact: what fits). */
async function feedFit(cons = null) {
  const ps = await G.pileState(ctx);
  let room = (ps.capacityStacks ?? 0) - (ps.usedStacks ?? 0) - 1;
  const need = {};
  for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
    const lack = n - (ps.stock?.[it] ?? 0);
    if (lack <= 0 || room <= 0) continue;
    const k = Math.min(lack, room * 64);
    need[it] = k;
    room -= Math.ceil(k / 64);
  }
  if (!Object.keys(need).length) return {};
  if (cons) return cons.insert(`stockpile:${G.OWNER}`, need);
  return (await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: false }, 120_000)).accepted ?? {};
}

// ------------------------------------------------------------------ item 6b: bigger than the stockpile

steps.item6b = async () => {
  await ensure();
  const R = await realised('rs07', 'rs07_big_tile', { crates: 2 });
  const cap = (await G.pileState(ctx)).capacityStacks;
  const quarter = Math.floor(cap / 4);
  const billStacks = stacksOf(R.ck.check.cost.bom);
  let maxRun = 0, capStacks = 0, runs = 0, waves = 0, inserted = {}, st, rs, maxRes = 0;
  const over = [];
  const end = Date.now() + 3_600_000;
  while (Date.now() < end) {
    st = await G.regionState(ctx, R.region);
    rs = await G.rsState(ctx, R.region);
    for (const t of rs.targets ?? []) { maxRun = Math.max(maxRun, t.maxRunStacks ?? 0); capStacks = Math.max(capStacks, t.capStacks ?? 0); runs += 0; runs = Math.max(runs, t.runs ?? 0); }
    const ps = await G.pileState(ctx);
    const res = stacksOf(ps.reserved);
    maxRes = Math.max(maxRes, res);
    if (res > cap) over.push(res);
    if (st.view.state === 'PLACED' && rs.build?.done) break;
    if (['FAILED', 'PARTIAL'].includes(st.view.state)) break;
    const acc = await feedFit();
    if (Object.keys(acc).length) { waves++; inserted = G.plus(inserted, acc); }
    await sleep(3000);
  }
  const out = { capacity: cap, quarter, billStacks, maxRun, capStacks, runs, maxReserved: maxRes, waves, inserted: sum(inserted), state: st.view.state, build: rs.build && { done: rs.build.done, percent: rs.build.percent, parts: rs.build.parts.map((p) => [p.part, p.state, p.built, p.cells]) } };
  check(billStacks > cap, `item 6b (rs07): the tile's bill is bigger than its 2-crate stockpile: ${billStacks} stacks against ${cap}`, out);
  check(capStacks > 0 && capStacks <= quarter && maxRun <= capStacks && runs > 1, `item 6b (rs07): every run's bill within a quarter of the capacity: the largest ${maxRun} stacks, the cap ${capStacks} (capacity ${cap}, a quarter ${quarter}), ${runs} runs`, out);
  check(over.length === 0, `item 6b (rs07): no reservation past the capacity (the largest ${maxRes} stacks of ${cap})`, over.slice(0, 4));
  check(st.view.state === 'PLACED' && rs.build?.done && (rs.build.parts ?? []).every((p) => p.state === 'built'), `item 6b (rs07): fed in ${waves} waves of what fits (${sum(inserted)} items), every target BUILT, the targets behind it fed: ${json(out.build)}`);
  await G.remove(ctx, R.region);
  return out;
};

// ------------------------------------------------------------------ item 7: order and waits

steps.item7 = async () => {
  await ensure();
  const R = await realised('rs02o', 'rs02_walled');
  // the later stages put down as the earlier targets they stand on are built: fed until the wall's and the rope's targets are down
  const has = (rs, part) => (rs.build?.parts ?? []).some((p) => p.part === part && p.targets.length);
  const f0 = await G.feed(ctx, R.region, { timeoutMs: 1_200_000, until: (st, rs) => has(rs, 'town_wall') && has(rs, 'rope') });
  await api('clear');
  const parts = f0.last.rs.build.parts;
  R.rs = f0.last.rs;
  const wall = parts.find((p) => p.part === 'town_wall'), rope = parts.find((p) => p.part === 'rope');
  const tgt = new Map((R.rs.targets ?? []).map((t) => [t.target, t]));
  const wallBill = wall.targets.reduce((a, id) => G.plus(a, tgt.get(id)?.bom), {});
  const ord = await L.call('dev.stockpile.order', { owner: G.OWNER, ids: wall.targets }, 60_000);
  const order = ord.stockpile?.feedOrder ?? [];
  check(wall.targets.every((t, k) => order[k] === t), `item 7: setFeedOrder puts rs02's wall first: ${json(order.slice(0, wall.targets.length + 2))}`);
  for (const t of rope.targets) await L.call('dev.stockpile.pause', { site: t, paused: true }, 60_000);
  await sleep(10_000); // the wall's targets starve past WaitCalc's threshold (100 ticks): their SITE_WAITING fires
  // the wall's bill alone: with the wall first it builds whole, though every other target wants the same blocks
  await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: wallBill, exact: true }, 120_000);
  // (a rope target put down later is paused as it appears)
  let w = { ok: false };
  for (let k = 0; k < 400 && !w.ok; k++) {
    const st = await G.regionState(ctx, R.region), rs = await G.rsState(ctx, R.region);
    for (const t of (rs.build?.parts ?? []).find((p) => p.part === 'rope')?.targets ?? []) {
      if (!rope.targets.includes(t)) { rope.targets.push(t); await L.call('dev.stockpile.pause', { site: t, paused: true }, 60_000); }
    }
    w = { st, rs, ok: (rs.build?.parts ?? []).find((p) => p.part === 'town_wall')?.state === 'built' };
    if (!w.ok) await sleep(3000);
  }
  rope.built = (w.rs.build?.parts ?? []).find((p) => p.part === 'rope')?.built ?? rope.built;
  const others = (w.rs.build?.parts ?? []).filter((p) => p.part !== 'town_wall' && p.state === 'built' && (w.rs.targets ?? []).some((t) => t.part === p.part && Object.keys(t.bom ?? {}).length));
  check(w.ok, `item 7: fed only the wall's bill (${sum(wallBill)} items), the wall is BUILT first (${json((w.rs.build?.parts ?? []).map((p) => [p.part, p.state]))}); paid parts built before it: ${json(others.map((p) => p.part))}`);
  await sleep(6000);
  // the others starve: SITE_WAITING per target with the region, the part and nextNeeded; the paused rope never waits, never reserves
  const ev = (await api('events 0')).filter((e) => e.event === 'SITE_WAITING' && e.ext?.['architect_mc:region'] === R.region);
  const named = ev.filter((e) => e.wait?.waiting && e.ext?.['architect_mc:part'] && (e.wait.nextNeeded ?? []).length);
  const ropeEv = ev.filter((e) => rope.targets.includes(e.id) && e.wait?.waiting);
  const ps = await G.pileState(ctx);
  const ropeRes = rope.targets.map((t) => ps.targets?.[t]).filter(Boolean);
  const rs1 = await G.rsState(ctx, R.region);
  const starved = (rs1.targets ?? []).filter((t) => t.wait?.waiting && (t.wait.nextNeeded ?? []).length);
  check(named.length > 0, `item 7: SITE_WAITING with the region and the part per waiting target, nextNeeded named: ${named.length} event(s) over ${new Set(named.map((e) => e.id)).size} target(s), e.g. ${json(named[0] && { id: named[0].id, part: named[0].ext['architect_mc:part'], next: named[0].wait.nextNeeded.slice(0, 2) })}; ${starved.length} target(s) waiting with nextNeeded now`);
  const ropeT = (rs1.targets ?? []).filter((t) => rope.targets.includes(t.target));
  const ropeOpen = ropeT.filter((t) => t.built < t.cells);
  check(ropeEv.length === 0 && ropeOpen.length > 0 && ropeOpen.every((t) => t.paused) && ropeRes.every((x) => !x.reserves) && (rs1.build.parts.find((p) => p.part === 'rope')?.built ?? 0) === rope.built, `item 7: pause on the rope bridge: its ${ropeOpen.length} unfinished target(s) paused (${json(ropeT.map((t) => [t.target, t.paused, t.built]))}), reserve nothing, never wait, nothing built since`);
  for (const t of rope.targets) await L.call('dev.stockpile.pause', { site: t, paused: false }, 60_000);
  // fed all but the lots' glass panes: the region PLACED, its lots waiting (a lot's run reserves while its chunks are loaded)
  const noGlass = { insert: async (site, items) => { const it = { ...items }; delete it['minecraft:glass_pane']; return Object.keys(it).length ? (await L.call('dev.crate.insert', { site, items: it, exact: true }, 120_000)).accepted ?? {} : {}; } };
  await G.feed(ctx, R.region, { cons: noGlass, timeoutMs: 1_800_000, until: (st, rs) => st.view.state === 'PLACED' && (rs.targets ?? []).every((t) => t.built >= t.cells) });
  // S-Y-1: a target whose whole frontier is unloaded reserves nothing; the player far away, then back (once the region is PLACED:
  // while it places, the realise keeps its tiles' chunks loaded): a lot of it waits for its glass
  const far = [R.s.W.claim[2] + 1500, 120, R.s.W.claim[3] + 1500];
  const r0 = Object.entries((await G.pileState(ctx)).targets ?? {}).filter(([, x]) => x.reserves).length;
  log(`  S-Y-1: ${r0} target(s) reserving before the player leaves`);
  await cmd('/forceload remove all'); // (the terrain builder force-loaded the claim: gate6chy-b's buildTerrain)
  await L.tp(...far);
  let unl = null;
  for (let k = 0; k < 60 && !unl; k++) {
    await sleep(3000);
    const p = await G.pileState(ctx);
    const ts = Object.entries(p.targets ?? {}).filter(([, x]) => x.built < x.queued && !x.paused); // the owner's unfinished targets (all this region's)
    const u = ts.filter(([, x]) => !x.frontierLoaded);
    if (u.length) unl = { unloaded: u.length, reserving: u.filter(([, x]) => x.reserves).length, of: ts.length };
  }
  let tickets = null;
  if (!unl) { // why not: the vanilla tickets on the reserving targets' chunks
    tickets = [];
    const p = await G.pileState(ctx);
    for (const [id, x] of Object.entries(p.targets ?? {}).filter(([, x]) => x.reserves).slice(0, 4)) {
      const ss = await L.call('dev.site.state', { site: id }, 30_000).catch(() => ({}));
      const bs = JSON.stringify(ss.box ?? ss.restoreBox ?? ss.site?.box ?? ss);
      const mm = [/minX\D+(-?\d+)/, /minY\D+(-?\d+)/, /minZ\D+(-?\d+)/].map((re) => Number((re.exec(bs) ?? [])[1] ?? 0));
      const nc = ss.nextCells?.[0];
      const pos = nc ? [nc.x, nc.y, nc.z] : mm;
      tickets.push({ id, x, pos, t: await L.call('dev.stockpile.tickets', { pos }, 30_000).catch((e) => String(e)) });
    }
    log(`  S-Y-1 tickets: ${json(tickets).slice(0, 2500)}`);
  }
  check(!!unl && unl.reserving === 0 && r0 > 0, `item 7: S-Y-1's unloaded exception: ${r0} target(s) reserving with the player there; with the player ${far.join(',')} away, ${json(unl)} (a target whose frontier is unloaded reserves nothing)`);
  await L.tp(R.s.W.claim[0] + 40, 100, R.s.W.claim[1] + 40);
  await sleep(4000);
  const f = await G.feed(ctx, R.region, { timeoutMs: 2_400_000 });
  const v = f.last.st.view;
  check(v.state === 'PLACED' && v.build?.done && v.build?.percent === 100 && (v.build?.parts ?? []).every((p) => p.state === 'built'), `item 7: resumed and fed: RegionView.build per part ${json((v.build?.parts ?? []).map((p) => [p.part, p.state, p.built, p.cells, p.targets.length]))}, done ${v.build?.done}, ${v.build?.percent}%`);
  await G.remove(ctx, R.region);
  return { order: order.slice(0, 8), wallBill, waits: named.length, unloaded: unl, build: v.build };
};

// ------------------------------------------------------------------ items 8, 9: conservation, removal

steps.item8 = async () => {
  await ensure();
  const o = await buildOne('rs02c', 'rs02_walled', { cons: true });
  const pts = o.conservation ?? [];
  const bad = pts.filter((p) => !G.exact(p));
  check(pts.length >= 10 && bad.length === 0, `item 8 (rs02): Y1's per-item sum constant at ${pts.length} checkpoints through feed, build and removal (${pts.map((p) => p.label).join(', ')})`, bad.slice(0, 4));
  return { points: pts };
};

steps.item9 = async () => {
  await ensure();
  const out = {};
  for (const [tag, name] of [['rs02r', 'rs02_walled'], ['rs03r', 'rs03_water']]) {
    if (process.env.RS_ONLY && !process.env.RS_ONLY.split(',').includes(tag)) continue;
    let pre = null;
    const o = await buildOne(tag, name, { cons: true, keep: async ({ region, rs, C, box }) => {
      // one copper cell weathered (a lot's, rs_hut's back wall), one paid target cell replaced by a player's block
      const sites = (await L.call('dev.sites.state', {}, 60_000)).sites ?? [];
      let copper = null;
      for (const s of sites.filter((x) => (x.blueprint ?? x.blueprintId ?? x.bp) === 'rs_hut')) {
        const c = await L.call('dev.site.cells', { site: s.id }, 60_000).catch(() => ({}));
        const hit = Object.entries(c).find(([k, v]) => /^-?\d+,-?\d+,-?\d+$/.test(k) && String(v).includes('copper_block'));
        if (hit) { copper = hit[0].split(',').map(Number); break; }
      }
      if (copper) {
        await cmd(`/setblock ${copper.join(' ')} minecraft:weathered_copper`);
        C.cleared['minecraft:copper_block'] = (C.cleared['minecraft:copper_block'] ?? 0) + 1; // (the driver's weathering: a copper block became
        C.injected['minecraft:weathered_copper'] = (C.injected['minecraft:weathered_copper'] ?? 0) + 1; // a weathered one)
      }
      const cells = await L.call('dev.rs.cells', { region }, 300_000);
      const t = (cells.targets ?? []).find((x) => (x.cells ?? []).some((c) => (c[3] & 2) && !(c[3] & 1) && !(c[3] & 4)));
      const pc = t.cells.find((c) => (c[3] & 2) && !(c[3] & 1) && !(c[3] & 4)).slice(0, 3);
      const was = (await L.call('dev.journal.at', { x: pc[0], y: pc[1], z: pc[2] }, 30_000)).stack?.slice(-1)[0]?.after ?? '';
      const paidItem = String(was).replace(/\{.*$/, '');
      await cmd(`/setblock ${pc.join(' ')} minecraft:oak_planks`);
      // (the driver's own edit: the paid block gone, a player's oak planks there)
      C.cleared[paidItem] = (C.cleared[paidItem] ?? 0) + 1;
      C.injected['minecraft:oak_planks'] = (C.injected['minecraft:oak_planks'] ?? 0) + 1;
      await sleep(2000);
      const a = await L.call('dev.stockpile.audit', { owner: G.OWNER, min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] }, 120_000);
      const p0 = await G.pileState(ctx);
      pre = { copper, player: pc, paidItem, paid: a.paidStanding, fluid: a.fluidStanding ?? {}, entities: a.entities, keys: p0.creditedKeys, stock: p0.stock, box };
    } });
    const p1 = await G.pileState(ctx);
    const refund = o.removed?.refund ?? {};
    const want = pre.paid; // (the audit counts a weathered copper cell as the block standing)
    const a1 = await L.call('dev.stockpile.audit', { owner: G.OWNER, min: [pre.box[0], pre.box[1], pre.box[2]], max: [pre.box[3], pre.box[4], pre.box[5]] }, 120_000);
    const drops = await L.call('dev.items.near', { pos: pre.player, radius: 6 }, 30_000); // (pushed out of the restored block)
    // credited to the stock, or dropped at the crates past the capacity; the player's block dropped at its cell is no refund
    const got = G.minus(G.plus(G.minus(p1.stock, pre.stock), G.minus(a1.entities, pre.entities)), { 'minecraft:oak_planks': (drops.items ?? {})['minecraft:oak_planks'] ?? 0 });
    const again = await L.call('dev.region.remove', { region: o.region, requester: G.OWNER }, 600_000);
    const p2 = await G.pileState(ctx);
    out[tag] = { pre, refund, credited: got, want, drops, keys: [pre.keys, p1.creditedKeys, p2.creditedKeys], eflat: o.eflat, conservation: o.conservation };
    check(G.same(got, want) && G.same(refund, G.minus(want, pre.fluid)), `item 9 (${tag}): the refund (credited, or dropped at the crates past the capacity) equals the paid cells standing (Regions.remove's refund the targets' and lots', the bodies' scoop and grates on their own key), as standing blocks (the weathered copper cell ${json(pre.copper)} credited as weathered_copper): ${G.same(got, want) ? 'equal' : `differs ${json(G.minus(got, want))}`}`, { got, want });
    check(((drops.items ?? drops.stacks ?? {})['minecraft:oak_planks'] ?? 0) >= 1 || JSON.stringify(drops).includes('oak_planks'), `item 9 (${tag}): the player's block at ${pre.player.join(',')} drops at its cell (${json(drops).slice(0, 200)})`);
    check(o.eflat?.mismatches === 0, `item 9 (${tag}): free cells restored, E-flat ${o.eflat?.mismatches}`);
    check(p2.creditedKeys === p1.creditedKeys && G.same(p2.stock, p1.stock) && again.removed !== false, `item 9 (${tag}): one credit per key: ${pre.keys} -> ${p1.creditedKeys} keys at the removal, ${p2.creditedKeys} after a second remove (nothing credited again)`);
    check((o.conservation ?? []).every(G.exact), `item 9 (${tag}): the conservation sum exact through it (${(o.conservation ?? []).length} points)`);
  }
  return out;
};

// ------------------------------------------------------------------ item 10: mid-build removal

steps.item10 = async () => {
  await ensure();
  const out = {};
  for (const leave of [false, true]) {
    const tag = leave ? 'rs02m2' : 'rs02m1';
    const R = await realised(tag, 'rs02_walled');
    const C = new G.Conservation(ctx, R.box);
    await C.start();
    // half built: half of the bill in waves (a run starts only with its whole bill), the builder until the paid cells built stop moving
    // (the wall mid-build: fed in waves of half what is lacking until its paid cells are partly built)
    await G.feed(ctx, R.region, { cons: C, fraction: 0.5, timeoutMs: 1_800_000, until: (st, rs) => {
      const w = (rs.build?.parts ?? []).find((p) => p.part === 'town_wall');
      return !!w && w.built > w.cells / 4;
    } });
    let last = -1, still = 0, rs;
    for (let k = 0; k < 150 && still < 2; k++) {
      await sleep(3000);
      rs = await G.rsState(ctx, R.region);
      const b = (rs.targets ?? []).reduce((a, t) => a + t.built, 0);
      still = b === last ? still + 1 : 0;
      last = b;
    }
    await C.point('half built');
    const a0 = await L.call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
    const s0 = await G.pileState(ctx);
    const ids = (rs.targets ?? []).map((t) => t.target);
    if (leave) await L.call('dev.placement.slow', { on: true }); // (slow writes: the removal is still running when the world stops)
    const pendP = L.call('dev.region.remove', { region: R.region, requester: G.OWNER }, 3_600_000); // (not awaited: the removal runs)
    await sleep(300);
    const pend = { started: true };
    // at once: the targets leave the feed
    const s1 = await G.pileState(ctx);
    const leftFeed = ids.filter((id) => !s1.targets?.[id] || s1.targets[id].leaving || !(s1.feedOrder ?? []).includes(id));
    if (leave) {
      await sleep(500);
      await L.leaveWorld();
      await L.openWorld(R.s.world);
      const mid = await api(`rget ${R.region}`).catch(() => null);
      check(mid?.state === 'REMOVING', `item 10 (${tag}): after the reopen the region reads REMOVING (stopped mid-removal, resumes): ${mid?.state}`);
      await L.call('dev.placement.slow', { on: false });
      await C.point('reopened mid-removal');
    }
    const rm = leave ? await pendP.catch((e) => ({ error: String(e) })) : await pendP;
    let v;
    for (let k = 0; k < 600; k++) { v = await api(`rget ${R.region}`).catch(() => null); if (!v || v.state !== 'REMOVING') break; await sleep(1000); }
    out[`${tag}.rm`] = rm;
    await sleep(3000);
    const s2 = await G.pileState(ctx);
    await C.point('removed');
    const got = G.minus(s2.stock, s0.stock);
    const e = await G.diff(ctx, R.box, R.pre);
    const ef = e.list.filter((m) => !R.crateAt.some((c) => c.join(',') === m.pos));
    out[tag] = { pending: pend, leftFeed: leftFeed.length, of: ids.length, state: v?.state, refund: got, paid: a0.paidStanding, eflat: ef.length, points: C.points };
    check(ids.length > 1 && leftFeed.length === ids.length && sum(a0.paidStanding) > 0, `item 10 (${tag}, ${sum(a0.paidStanding)} paid items standing): the removal takes the ${ids.length} targets out of the feed at once (${leftFeed.length} left it right after Regions.remove)`);
    check(G.same(got, a0.paidStanding) && (v?.state ?? 'REMOVED') === 'REMOVED', `item 10 (${tag}${leave ? ', saved, left and reopened mid-removal' : ''}): the refund equals the paid cells standing at the removal (${sum(a0.paidStanding)} items), credited once: ${G.same(got, a0.paidStanding) ? 'equal' : `differs ${json(G.minus(got, a0.paidStanding))}`}; ${v?.state ?? 'gone'}`);
    // (the point right after the reopen is recorded, not judged: the audit reads no pending target's cells after a load until its restore
    // ends, so the paid cells still standing mid-removal read as missing then; the end is exact)
    const judged = C.points.filter((p) => p.label !== 'reopened mid-removal');
    check(judged.every(G.exact) && ef.length === 0, `item 10 (${tag}): conservation exact at ${judged.map((p) => p.label).join(', ')}${leave ? ` (mid-removal after the reopen, recorded: ${json(C.points.find((p) => p.label === 'reopened mid-removal')?.diff)})` : ''}, E-flat ${ef.length}`, ef.slice(0, 6));
  }
  return out;
};

// ------------------------------------------------------------------ item 11: crash

steps.item11 = async () => {
  await ensure();
  const out = {};
  const killJvm = async () => {
    const pids = L.clientPids();
    log(`kill -9 my server JVM ${pids}`);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 60 && L.clientPids().length; i++) await sleep(1000);
  };
  // (a) a clean stop mid-build (a target building), resumed: PLACED and built, equal to its twin
  {
    const fx = G.fixture(ctx, 'rs02_walled');
    const entries = entriesOf(fx);
    const T = await G.twin(ctx, 'rs02k', fx, entries);
    const R = await realised('rs02k', 'rs02_walled');
    await G.feed(ctx, R.region, { fraction: 0.5, timeoutMs: 1_200_000, until: (st, rs) => {
      const w = (rs.build?.parts ?? []).find((p) => p.part === 'town_wall');
      return !!w && w.built > w.cells / 4 && w.state !== 'built';
    } });
    const mid = (await G.rsState(ctx, R.region)).build;
    await L.leaveWorld();
    await L.openWorld(R.s.world);
    const f = await G.feed(ctx, R.region, { timeoutMs: 2_400_000 });
    const d = await G.twinDiff(ctx, T.box, T.file, R.crateAt);
    out.clean = { mid: mid && mid.percent, after: f.last.rs.build && f.last.rs.build.percent, twin: d.mismatches };
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done && d.mismatches === 0 && !mid?.done, `item 11 (clean stop mid-build: the wall ${json((mid?.parts ?? []).find((p) => p.part === 'town_wall') && [(mid.parts.find((p) => p.part === 'town_wall')).built, (mid.parts.find((p) => p.part === 'town_wall')).cells])} built): resumed to PLACED and built, equal to its INSTANT twin (${d.mismatches} differ)`, d.list);
    // (b) kill -9 after an autosave, mid-build of the next feed: drift within the units moved since the save
    await G.remove(ctx, R.region);
  }
  {
    const R = await realised('rs02x', 'rs02_walled');
    const C = new G.Conservation(ctx, R.box);
    await C.start();
    const half = {};
    for (const [it, n] of Object.entries(R.ck.check.cost.bom ?? {})) if (Math.floor(n / 3) > 0) half[it] = Math.floor(n / 3);
    await C.insert(`stockpile:${G.OWNER}`, half);
    await sleep(8000);
    await cmd('/save-all flush');
    await sleep(1000);
    const atSave = await C.parts();
    const totSave = C.total(atSave);
    const injAtSave = { ...C.injected };
    const builtAtSave = (await G.rsState(ctx, R.region)).targets.reduce((a, t) => a + t.built, 0);
    await cmd('/save-off'); // (no autosave after this one: what is built from here is lost with the kill)
    await C.insert(`stockpile:${G.OWNER}`, half);
    await G.feed(ctx, R.region, { cons: C, fraction: 0.5, timeoutMs: 600_000, until: (st, rs) => (rs.targets ?? []).reduce((a, t) => a + t.built, 0) > builtAtSave + 200 });
    const pre = await C.parts();
    const moved = {};
    for (const k of new Set([...Object.keys(pre.ledger?.consumed ?? {}), ...Object.keys(pre.ledger?.delivered ?? {})])) {
      const m = (pre.ledger.consumed?.[k] ?? 0) - (atSave.ledger?.consumed?.[k] ?? 0) + (pre.ledger.delivered?.[k] ?? 0) - (atSave.ledger?.delivered?.[k] ?? 0);
      if (m) moved[k] = m;
    }
    const builtPre = (await G.rsState(ctx, R.region)).targets.reduce((a, t) => a + t.built, 0);
    await killJvm();
    try { state.dev?.close(); } catch { /* gone */ }
    state.dev = null;
    await connect(300_000);
    // (the host is up, its server gone: open the world again, the killed save; a session.lock left behind goes first)
    fs.rmSync(path.join(L.SAVES, R.s.world, 'session.lock'), { force: true });
    // (the host notices its server's death on its own time: dev.world.open retried until it takes)
    for (let k = 0; ; k++) {
      try { await L.call('dev.world.open', { name: R.s.world }, 30_000); break; } catch (e) { if (k >= 30) throw e; await sleep(2000); }
    }
    await L.waitInWorld(900_000);
    const a = await C.parts();
    const now = C.total(a);
    const drift = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(totSave)])) { const dd = (now[k] ?? 0) - (totSave[k] ?? 0); if (dd) drift[k] = dd; }
    for (const [k, v] of Object.entries(C.injected)) { const after = v - (injAtSave[k] ?? 0); if (after) drift[k] = (drift[k] ?? 0) + after; if (drift[k] === 0) delete drift[k]; }
    const within = Object.entries(drift).every(([k, v]) => Math.abs(v) <= Math.abs(moved[k] ?? 0) + (C.injected[k] ?? 0) - (injAtSave[k] ?? 0));
    out.kill = { drift, moved, builtPre };
    check(within, `item 11 (kill -9 after an autosave): drift ${json(drift)} within the units moved since that save ${json(moved)} (recorded)`);
    // (c) the lost cells: the rescan re-queues what the save lost; the build finishes
    await sleep(25_000);
    const rs = await G.rsState(ctx, R.region);
    const builtNow = rs.targets.reduce((a, t) => a + t.built, 0);
    const f = await G.feed(ctx, R.region, { timeoutMs: 2_400_000 });
    out.rescan = { builtAtSave, builtPre, builtNow, rescanned: rs.rescanned, rewritten: rs.rewritten, done: f.last.rs.build?.done };
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done && builtNow < builtPre, `item 11 (a halt without a save): the rescan re-reads the targets from the world (${builtAtSave} cells built at the save, ${builtPre} before the kill, ${builtNow} after the reload: the ${builtPre - builtNow} lost cells re-queued; rescanned ${rs.rescanned}, free cells rewritten ${rs.rewritten}), fed to built: done ${f.last.rs.build?.done}`);
    await G.remove(ctx, R.region);
  }
  return out;
};

// ------------------------------------------------------------------ item 12: Steward's flows

steps.item12 = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, 'rs02_walled');
  const entries = entriesOf(fx);
  const s = await G.site(ctx, 'rs02 steward', fx);
  await G.designs(ctx);
  await G.pile(ctx, s, 4);
  const body = { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' };
  // a creative artifact (the toggle off), then survival again: realiseApproved under the first key refused ARTIFACT_STALE
  await L.call('dev.survival.set', { on: false });
  const c0 = await L.call('dev.region.checkPlan', body, 1_800_000);
  await L.call('dev.survival.set', { on: true });
  const K1 = `steward.rs.${Date.now().toString(36)}.a`, K2 = `steward.rs.${Date.now().toString(36)}.b`;
  const r1 = await L.call('dev.region.realiseApproved', { sha: c0.check.artifactSha, lotEntries: entries, opKey: K1 }, 300_000);
  check(c0.check?.survival !== true && /^ARTIFACT_STALE/.test(String(r1.refused?.reason ?? r1.refused ?? '')), `item 12/13: a creative artifact in survival: realiseApproved refused ARTIFACT_STALE (${json(r1.refused ?? r1).slice(0, 200)})`);
  // re-check at Start (survival), pin, a restart, then realiseApproved under the second key
  const c1 = await L.call('dev.region.checkPlan', body, 1_800_000);
  const c2 = await L.call('dev.region.checkPlan', body, 1_800_000);
  check(c1.check?.survival === true && c1.check.artifactSha === c2.check.artifactSha && c1.check.artifactSha !== c0.check.artifactSha, `item 12: re-check at Start in survival: survival true, the same artifact twice (${String(c1.check?.artifactSha).slice(0, 12)}), not the creative one`);
  const pin = await L.call('dev.region.pinArtifact', { sha: c1.check.artifactSha, owner: G.OWNER, on: true }, 60_000);
  check((pin.artifact?.pinnedBy ?? []).includes(G.OWNER), `item 12: pinned (${json(pin.artifact?.pinnedBy)})`);
  await L.leaveWorld();
  await L.openWorld(s.world);
  const r2 = await L.call('dev.region.realiseApproved', { sha: c1.check.artifactSha, lotEntries: entries, opKey: K2 }, 300_000);
  const k1 = await L.call('dev.region.realiseByKey', { owner: G.OWNER, opKey: K1 }, 60_000);
  const k2 = await L.call('dev.region.realiseByKey', { owner: G.OWNER, opKey: K2 }, 60_000);
  check(!!r2.region && k2.region?.id === r2.region && !k1.region, `item 12: after the restart realiseApproved under the second key: ${r2.region} (realiseByKey: K2 ${k2.region?.id}, K1 ${k1.region?.id ?? 'none'})`);
  const region = r2.region;
  const f = await G.feed(ctx, region, { timeoutMs: 2_400_000 });
  check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `item 12: built from the stockpile: ${f.last.st.view.state}, done ${f.last.rs.build?.done}`);
  // rs05: the offer round rs02's region, realised and undone alone, the town untouched
  const box = G.boxOf(s.W);
  const town = await G.snap(ctx, box, 'rs-rs12-town');
  const offer = JSON.parse(JSON.stringify(G.fixture(ctx, 'rs05_offer').plan).replaceAll('${region}', region));
  // (the offer's own claim: the town's and the ring round it, 24 more each side)
  const oclaim = [s.W.claim[0] - 24, s.W.claim[1] - 24, s.W.claim[2] + 24, s.W.claim[3] + 24];
  const oc = await L.call('dev.region.checkPlan', { ...body, claim: oclaim, plan: offer }, 1_800_000);
  out.offer = { overall: oc.check?.overall, parts: (oc.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code]) };
  check(oc.check?.survival === true && !!oc.check?.artifactSha && (oc.check?.parts ?? []).every((a) => a.class !== 'refused'), `item 12 (rs05): the offer checked in survival round ${region}: ${oc.check?.overall} ${json(out.offer.parts)}`);
  if (oc.check?.artifactSha) {
    const or = await G.realise(ctx, oc.check.artifactSha);
    const of = await G.feed(ctx, or, { timeoutMs: 1_800_000 });
    check(of.last.st.view.state === 'PLACED' && of.last.rs.build?.done, `item 12 (rs05): the offer ${or} realised alone and built: ${of.last.st.view.state}, done ${of.last.rs.build?.done}`);
    const rm = await G.remove(ctx, or);
    const d = await G.diff(ctx, box, town);
    const df = d.list.filter((m) => !String(m.now).includes('construction_crate'));
    check(rm.removed && df.length === 0, `item 12 (rs05): undone alone: the town untouched (${df.length} cells differ from the town before the offer)`, df.slice(0, 6));
  }
  await G.remove(ctx, region);
  return out;
};

// ------------------------------------------------------------------ item 13: refusals (the brush row is RS-b's)

steps.item13 = async () => {
  await ensure();
  const out = {};
  // an installed bible whose rails and lanes are spawners (the fixture's style; a game check takes its style from a bible)
  const bdir = path.join(path.dirname(L.LIBRARY), 'bibles', 'rs_spawner', 'versions', '1');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'bible.json'), JSON.stringify({ id: 'rs_spawner', name: 'RS spawner rails', scope: 'settlement', roles: { rail: 'minecraft:spawner', path: 'minecraft:spawner' } }));
  // a spawner prop: SURVIVAL {creativeOnly} at check
  const fx = G.fixture(ctx, 'u_spawner');
  const s = await G.site(ctx, 'spawner', fx);
  const ck = { check: (await L.call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', bible: 'rs_spawner' }, 1_800_000)).check };
  fs.writeFileSync(path.join(OUT, 'rs-spawner-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
  const sv = (ck.check?.parts ?? []).flatMap((a) => (a.reasons ?? []).filter((r) => r.code === 'SURVIVAL').map((r) => [a.part, r.evidence]));
  out.check = sv;
  check(sv.some(([, e]) => e?.kind === 'creativeOnly' && Object.keys(e.blocks ?? {}).includes('minecraft:spawner')), `item 13: a spawner prop answers SURVIVAL {kind: creativeOnly} at check: ${json(sv).slice(0, 200)}`);
  // CREATIVE_ONLY_BLOCK at realise: a program plan (no plan/0 re-plan) whose bible lays its lanes in spawners
  const claim = [s.W.claim[0], s.W.claim[1], s.W.claim[0] + 127, s.W.claim[1] + 127];
  const h0 = await L.call('dev.region.hash', { box: [claim[0], s.W.minY - 4, claim[1], claim[2], s.W.maxY + 20, claim[3]] }, 600_000);
  const p = await L.call('dev.region.plan', { program: 'flat_village', params: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }] }, claim, bible: 'rs_spawner', owner: G.OWNER, surveyLoad: 'generated:64', check: false }, 900_000);
  const rr = p.planId ? await L.call('dev.region.realise', { planId: p.planId }, 120_000) : null;
  await sleep(3000);
  const h1 = await L.call('dev.region.hash', { box: [claim[0], s.W.minY - 4, claim[1], claim[2], s.W.maxY + 20, claim[3]] }, 600_000);
  out.realise = { plan: p.planId ?? p.refused, refused: rr?.refused ?? rr };
  check(/^CREATIVE_ONLY_BLOCK/.test(String(rr?.refused?.reason ?? rr?.refused ?? '')) && h0.sha256 === h1.sha256, `item 13: CREATIVE_ONLY_BLOCK at realise, nothing written (${json(rr?.refused ?? rr ?? p.refused).slice(0, 240)}; hash ${h0.sha256 === h1.sha256 ? 'unchanged' : 'CHANGED'})`);
  // no stockpile: NOT_ALLOWED with the bill
  await L.call('dev.stockpile.dissolve', { owner: G.OWNER }, 60_000).catch(() => null);
  const fx2 = G.fixture(ctx, 'rs02_walled');
  const s2 = await G.site(ctx, 'nopile', fx2);
  await G.designs(ctx);
  const ck2 = await G.check(ctx, 'nopile', s2);
  const r2 = await L.call('dev.region.realiseApproved', { sha: ck2.check.artifactSha, lotEntries: entriesOf(fx2) }, 300_000);
  out.noPile = r2.refused ?? r2;
  const nr = String(r2.refused?.reason ? `${r2.refused.reason}: ${r2.refused.message}` : r2.refused ?? '');
  check(/^NOT_ALLOWED/.test(nr) && /stockpile/.test(nr) && /the bill/.test(nr), `item 13: no stockpile: NOT_ALLOWED with the bill (${nr.slice(0, 200)})`);
  return out;
};

// ------------------------------------------------------------------ item 14: the natural site (S3's claim)

steps.item14 = async () => {
  await ensure();
  const sc = process.env.RS_S3_CLAIM ? JSON.parse(process.env.RS_S3_CLAIM) : null;
  if (!sc) { check(false, 'item 14: S3\'s natural claim is not on this branch yet (RS_S3_CLAIM={world, claim, anchors}): recorded as open'); return { open: true }; }
  return { open: true };
};

// ------------------------------------------------------------------ item 15: free drops (N-RS-2)

steps.item15 = async () => {
  await ensure();
  const R = await realised('rs01f', 'rs01_land', { crates: 3 });
  const f = await G.feed(ctx, R.region, { timeoutMs: 1_800_000 });
  check(f.last.rs.build?.done, `item 15: rs01 built (${f.last.st.view.state})`);
  const cells = await L.call('dev.rs.cells', { region: R.region }, 300_000);
  const spireT = (cells.targets ?? []).find((t) => (f.last.rs.targets ?? []).some((x) => x.target === t.target && x.part === 'spire'));
  const heldSpire = spireT?.cells.find((c) => (c[3] & 1) && (c[3] & 2) && !(c[3] & 4));
  // a free fill cell: a free-pass write of the relief (dev.rs.freeWrite in batches over the claim's columns), solid, not the spire's
  let fill = null;
  const spireCells = new Set((spireT?.cells ?? []).map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (let dx = 4; dx < R.s.W.claim[2] - R.s.W.claim[0] && !fill; dx += 6) {
    const batch = [];
    for (let dz = 4; dz < R.s.W.claim[3] - R.s.W.claim[1]; dz += 6) for (let y = R.s.W.minY - 2; y <= R.s.W.maxY + 8; y++) batch.push([R.s.W.claim[0] + dx, y, R.s.W.claim[1] + dz]);
    const fw = await L.call('dev.rs.freeWrite', { cells: batch }, 120_000);
    for (let k = 0; k < batch.length && !fill; k++) {
      if (fw.free?.[k] !== true || spireCells.has(batch[k].join(','))) continue;
      const j = await L.call('dev.journal.at', { x: batch[k][0], y: batch[k][1], z: batch[k][2] }, 30_000);
      const top = (j.stack ?? []).slice(-1)[0];
      if (top && !/minecraft:(air|water|cave_air)/.test(top.after) && top.kind === 'architect:terrain') fill = batch[k];
    }
  }
  await cmd('/gamemode survival'); // (the terrain builder left the player a spectator)
  const before = (await L.call('dev.stockpile.audit', { owner: G.OWNER, min: [R.box[0], R.box[1], R.box[2]], max: [R.box[3], R.box[4], R.box[5]] }, 120_000)).entities ?? {};
  const b1 = fill ? await L.call('dev.rs.break', { at: fill }, 60_000) : null;
  const b2 = heldSpire ? await L.call('dev.rs.break', { at: heldSpire.slice(0, 3) }, 60_000) : null;
  await sleep(1500);
  const after = (await L.call('dev.stockpile.audit', { owner: G.OWNER, min: [R.box[0], R.box[1], R.box[2]], max: [R.box[3], R.box[4], R.box[5]] }, 120_000)).entities ?? {};
  const dropped = G.minus(after, before);
  // the control: a natural block the region never wrote (outside its claim, in its box) drops as vanilla
  const ctl = [R.s.W.claim[0] - 4, R.s.W.ground ?? R.s.W.minY, R.s.W.claim[1] - 4];
  const b0 = await L.call('dev.rs.break', { at: ctl }, 60_000);
  await sleep(1500);
  const after2 = (await L.call('dev.stockpile.audit', { owner: G.OWNER, min: [R.box[0], R.box[1], R.box[2]], max: [R.box[3], R.box[4], R.box[5]] }, 120_000)).entities ?? {};
  const ctlDrop = G.minus(after2, after);
  check(b0.gameMode === 'survival' && !!b0.broken && Object.keys(ctlDrop).length > 0, `item 15 (the control): a natural block outside the region (${json(ctl)}: ${b0.before}) broken in ${b0.gameMode} drops ${json(ctlDrop)}`);
  check(/air/.test(b1?.after ?? '') && /air/.test(b2?.after ?? '') && Object.keys(dropped).length === 0 && b2.freeBroken >= 2, `item 15 (N-RS-2): a player breaks a free fill cell (${json(fill)}: ${b1?.before}) and a held spire cell (${json(heldSpire?.slice(0, 3))}: ${b2?.before}) in survival: both broken (the event cancelled, the block destroyed without drops), nothing dropped (${json(dropped)}), the hook counted ${b2?.freeBroken}`);
  const rm = await G.remove(ctx, R.region);
  const e = await G.diff(ctx, R.box, R.pre);
  const ef = e.list.filter((m) => !R.crateAt.some((c) => c.join(',') === m.pos) && m.pos !== ctl.join(','));
  check(rm.removed && ef.length === 0, `item 15: then removed as item 9: E-flat ${ef.length} (the mined free cells put back, then restored; the control's cell aside)`, ef.slice(0, 6));
  return { fill, spire: heldSpire, b1, b2, dropped, eflat: ef.length };
};

// (development) one fixture checked in game, survival or creative (RS_FIXTURE, RS_CREATIVE=1): its answers
steps.checkonly = async () => {
  await ensure();
  const fx = G.fixture(ctx, process.env.RS_FIXTURE);
  const s = await G.site(ctx, 'checkonly', fx, { creative: process.env.RS_CREATIVE === '1' });
  const ck = await G.check(ctx, 'checkonly', s);
  for (const a of ck.check?.parts ?? []) log(`  ${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''} ${(a.reasons?.[0]?.message ?? '').slice(0, 300)}`);
  if (process.env.RS_VERBOSE) for (const a of ck.check?.parts ?? []) if (a.reasons?.length) log(JSON.stringify(a.reasons).slice(0, 3000));
  if (process.env.RS_VERBOSE) log(JSON.stringify(s).slice(0, 1500));
  return { overall: ck.check?.overall };
};

// ------------------------------------------------------------------ dispatch

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|latent|item\d+b?|ingame|survival|crash)\.json$/.test(f)).sort();
  const lines = ['# Slice RS gate report', '', `${new Date().toISOString()} · head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  let fail = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 8)})`, '');
    for (const [k, v] of Object.entries(j.results ?? {})) {
      const ok = v?.ok === true;
      if (!ok) fail++;
      lines.push(`- ${ok ? 'ok' : 'FAIL'} ${k}`);
    }
    lines.push('');
  }
  lines.push(`${fail} failure(s); $0.00`);
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files, fail };
};

const groups = {
  ingame: ['latent', 'item4', 'item6', 'item6b', 'item7', 'item12', 'item13', 'item15'],
  survival: ['item5', 'item8', 'item9', 'item10'], // (item14: on S3's claim once S3 has merged)
  crash: ['item11'],
};
const name = process.argv[2];
if (!name || (!steps[name] && !groups[name])) {
  console.error(`usage: node tools/gate6crs.mjs ${[...Object.keys(steps), ...Object.keys(groups)].join('|')}`);
  process.exit(2);
}
for (const s of groups[name] ?? [name]) {
  if (!steps[s]) { check(false, `step ${s} is not built`); continue; }
  await run(s);
}
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
