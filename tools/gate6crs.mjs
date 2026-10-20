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
//     ingame    (rs-ingame)             latent, items 4, 6, 6b, 7, 12, 13, 15
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
  // item 17
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 17: api-compat clean against the archived apitest jars (RegionView gains a trailing build, PlanCheck a trailing survival: the old constructors kept; RegionBuild, PartBuild new); $0.00`, out.apicompat.tail);
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
  for (const [tag, name] of [['rs02', 'rs02_walled'], ['rs03', 'rs03_water'], ['rs04', 'rs04_tunnel'], ['village', 'survival_village']]) {
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
  return { M3: m.M3?.floatingCells ?? null, M4: m.M4?.breaches ?? null, M8: m.M8 ? m.M8.unguarded : null, gravity: find(/^M3:gravity/), spurs: find(/^M3:floating_spur/) };
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

steps.item6 = async () => {
  await ensure();
  const out = {};
  for (const [tag, name] of [['rs04', 'rs04_tunnel'], ['rs02', 'rs02_walled']]) {
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
    await G.waitFor(ctx, region, (st, rs) => (rs.targets ?? []).length > 0, { timeoutMs: 300_000 });
    const half = {};
    for (const [it, n] of Object.entries(ck.check.cost.bom ?? {})) if (Math.floor(n / 2) > 0) half[it] = Math.floor(n / 2);
    const acc = (await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: half, exact: false }, 120_000)).accepted ?? {};
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
    out[tag] = { fed: acc, runs, cuts: { cells: cuts.cells, open: cuts.open, bad: cuts.bad.slice(0, 8) }, standing: sm, build: rs.build && { percent: rs.build.percent, parts: rs.build.parts.map((p) => [p.part, p.state, p.built, p.cells]) } };
    check(runs.bad.length === 0, `item 6 (${tag}, half fed ${sum(acc)} items): no run started without its whole bill (${runs.started} run(s) under way, each with its remaining bill in stock)`, runs.bad.slice(0, 6));
    check(cuts.bad.length === 0, `item 6 (${tag}): no cut open without its lining or wall: ${cuts.open} open cut(s) of ${cuts.cells} target cells, every paid neighbour above and beside built`, cuts.bad.slice(0, 6));
    check(sm.M3 === 0 && (sm.M4 ?? 0) === 0 && (sm.M8 ?? 0) === 0 && sm.gravity === 0, `item 6 (${tag}): the world as it stands half built: M3 ${sm.M3} floating, M4 ${sm.M4}, M8 ${sm.M8} unguarded, ${sm.gravity} gravity`, sm);
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
  survival: ['item5', 'item8', 'item9', 'item10', 'item14'],
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
