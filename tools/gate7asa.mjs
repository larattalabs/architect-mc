#!/usr/bin/env node
// Phase 7a slice SA gate (docs/CONTRACT.md "Phase 7a slice SA: spiral stairs round a form" §8) against a dev client or the headless
// server of the SA run worktree (`../architect-mc-SA-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude).
// Ports 8970 (sidecar) / 8971 (DevBridge) by default (the runner sets its own). $0: no Claude call anywhere.
//
//   node tools/gate7asa.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (sa-unit)               items 1, 2 (kit), 9 offline: kit/test/sa.test.mjs (the hug on tapering and stepped sections,
//                                       landings, the three tops, every refusal with its evidence, M10:spiral on the valid fixtures and
//                                       the broken variants, the host never written, the KC row, the wire shapes, themed, survival's
//                                       row, determinism), the foundation's, P0's, K1's and T3's tests, the realise lint; the structure
//                                       lint's p0:sa case; the catalogue diff (pre-7a -> the golden: connector.stairs_around reserved ->
//                                       supported); the Java ApiSATest
//     unchanged (sa-unit)               item 2: every committed plan fixture without a spiral plans as on the merge base (answers, IR, the
//                                       first plan; tools/lib/gate7a-kit.mjs), but the foundation's named movers (F7A_MOVED, on main already); SA moves no committed fixture (e15 drops c_stairs_around: its other answers are as before)
//     ingame    (sa-ingame)             items 3-5 and 7 on flat worlds (headless): v7a_sa_spire (plan v1's shape) on its terrain built
//                                       by commands through Regions.checkPlan then realiseApproved; v7a_sa_spike, v7a_sa_tree and the
//                                       2-wide v7a_sa_villager likewise; each re-read from the dumps (M10:spiral 0, M3 0 in its part, M5
//                                       0 dark walk cells, M8 0, the host's cells as planned: 0 changed, realised == virtual), the kit
//                                       player both ways foot <-> lookout (the villager fixture: the kit villager and vanilla
//                                       dev.nav.villager both ways, the hard bar), Regions.remove E-flat 0 (the host gone with it)
//     survival  (sa-survival)           item 8 (RS merged): v7a_sa_spire in survival: checked in survival, fed from a stockpile, built;
//                                       the bills equal the check's cost.survival.bom; the world equal to its INSTANT twin; removed E-flat 0
//     look      (sa-look)               item 10 (client, recorded not judged: N-SA-1): the spire, the tree and the mushroom in three bibles
//                                       (default, infernal, coastal), the spike in the default: the whole spiral, a close-up of the treads
//                                       and rails, a landing, the lookout deck; at dusk (the lamps)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-sa/<step>.json in the main checkout (GATE7ASA_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-SA-run');
process.env.GATE6B_OUT = process.env.GATE7ASA_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-sa');
process.env.GATE6B_SIDECAR_PORT ??= '8970';
process.env.GATE6B_DEV_PORT ??= '8971';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, leaveWorld, log, results, root, state, startClient, stopClient } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice SA is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C SA Lobby', { backend: 'sim' });
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
  return { worlds: [BASE, FLAT], seed: SEED };
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
  out.sa = kitOnce(['kit/test/sa.test.mjs']);
  check(out.sa.code === 0 && out.sa.fail === 0 && out.sa.pass >= 10, `item 1 (kit): the hug on tapering and stepped sections (counter-clockwise, face-adjacent steps rising 1 or 0), landings every 8, the three tops (summit, canopy 3 under the leaves, {y}), width 2, SPAN/HEADROOM/NO_FEATURE/MOVER with their evidence, the valid fixtures (spire, spike, tree, mushroom, a 2-wide villager spiral) fit with M10:spiral, M3, M5, M6, M8 clean, the host never written, the lookout node, the stairs_around edge's crossing, siteplan spirals[], cost.bom exact, every block themed (soul lanterns by ice), M10:spiral on floating and noRails, the KC row (M25:clear 0), survival's row, determinism: ${out.sa.pass} pass, ${out.sa.fail} fail`, out.sa.failing);
  out.found = kitOnce(['kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/catalogue-since.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `items 2, 9 (kit): the foundation's tests, P0 (connector.stairs_around supported with its valid fixtures, e15 off it), K1's and T3's foundation tests, the realise lint: ${out.found.pass} pass, ${out.found.fail} fail`, out.found.failing);
  const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'p0:sa,p0:valid/1,p0:valid/2,p0:valid/3,p0:valid/4,p0:valid/5,p0:valid/6'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-16);
  check(lint.status === 0, 'item 1 (lint): the structure lint\'s p0:sa (the refusal set as expected, the broken variants caught, S-THEME clean) and p0:valid (the SA fixtures among them: M10:spiral, S-THEME clean)', out.lint);
  const d = spawnSync(process.execPath, ['tools/plan-catalogue-diff.mjs', 'kit/test/fixtures/plan/catalogue-pre7a.json', 'kit/schemas/plan-catalogue.golden.json'], { cwd: root, encoding: 'utf8' });
  out.diff = `${d.stdout}${d.stderr}`.trim();
  const flips = (/reserved -> supported: (.*)/.exec(out.diff) ?? [])[1] ?? '';
  check(d.status === 0 && flips.split(', ').includes('connector.stairs_around') && /retired: none/.test(out.diff) && /REMOVED \(never allowed\): none/.test(out.diff), `item 9: tools/plan-catalogue-diff.mjs pre-7a -> the golden flips connector.stairs_around reserved -> supported (with the other merged 7a slices'): ${flips}; nothing retired or removed`, out.diff.split('\n'));
  // the Java half: the feature spiralStairs (sidecar region.spirals)
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const j = spawnSync(path.join(root, 'mod', 'gradlew'), ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.api.ApiSATest'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  out.java = `${j.stdout}${j.stderr}`.trim().split('\n').slice(-6);
  check(j.status === 0, 'item 9 (Java): ApiSATest (the feature spiralStairs from region.spirals; none from other helpers or protocol 1)', out.java);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const { F7A_MOVED } = await import('./lib/f7a-norm.mjs');
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'SA', except: F7A_MOVED, mergedIf: 'kit/lib/connectors/kinds7a.mjs' });
  fs.writeFileSync(path.join(OUT, 'sa-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

// ------------------------------------------------------------------ in game: the re-read

/** The realised world from two dumps (the plan's virtual world marks its cells), the checker on it, and the virtual world. */
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

/** Item 5 over the realised world: every spiral's bars re-read, M3 in its part, the host's cells as planned; item 4's kit movers. */
async function item5(tag, { ir, meta, world, rep, vw }, { villager = false } = {}) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.spirals?.per ?? [];
  const recs = meta.spirals ?? [];
  const out = { spirals: per };
  check(per.length === recs.length && per.length >= 1, `item 5 (${tag}): ${per.length} spiral(s) re-read from the realised world (${recs.map((q) => `${q.host}: rise ${q.rise}, ${q.turns} turns, top ${q.topKind}`).join(', ')})`);
  const m10 = rep.findings.filter((f) => f.rule === 'M10:spiral');
  check(!m10.length && per.every((q) => q.ok), `item 5 (${tag}): M10:spiral 0 (every step beside the last rising 1 or 0, standable with 2 clear, attached, the outer edge within ${per.map((q) => q.outerMax).join('/')}, rails on ${per.map((q) => `${q.railed}/${q.edges}`).join(', ')} open edges, ${per.map((q) => q.dark).join('/')} dark)${m10.length ? `: ${m10.map((f) => f.message).join('; ').slice(0, 300)}` : ''}`);
  const own = new Set(recs.map((q) => q.part));
  for (const rule of ['M3', 'M5', 'M6', 'M8']) {
    const f = rep.findings.filter((x) => (x.rule === rule || x.rule.startsWith(`${rule}:`)) && own.has(x.part));
    check(!f.length, `item 5 (${tag}): ${rule} 0 in the spiral's part (${f.map((x) => `${x.rule} ${x.count}`).join(', ') || 'none'})`);
  }
  // the host's cells as planned (a spiral never writes its host)
  out.host = {};
  for (const q of recs) {
    const hi = ir.parts.findIndex((p) => p.id === q.form);
    let n = 0, changed = 0;
    const sample = [];
    vw.eachWritten((x, y, z, idx, fl, p) => {
      if (p !== hi) return;
      n++;
      const got = world.pal.states[world.get(x, y, z)], want = vw.pal.states[idx];
      if (String(got).replace(/\[.*$/, '') !== String(want).replace(/\[.*$/, '')) { changed++; if (sample.length < 8) sample.push([x, y, z, want, got]); }
    });
    out.host[q.id] = { cells: n, changed, sample };
  }
  check(Object.values(out.host).every((h) => h.cells > 0 && h.changed === 0), `item 5 (${tag}): 0 host cells changed (${json(Object.fromEntries(Object.entries(out.host).map(([k, v]) => [k, `${v.changed}/${v.cells}`])))})`, Object.values(out.host).flatMap((h) => h.sample));
  // item 4: the kit's player (and villager on a villager spiral) from the foot to the lookout and back
  out.movers = {};
  for (const q of recs) {
    const a = [q.foot[0], q.foot[1] + 1, q.foot[2]], b = [q.top[0], q.top[1] + 1, q.top[2]];
    const movers = villager ? ['player', 'villager'] : ['player'];
    out.movers[q.id] = Object.fromEntries(movers.map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
  }
  check(Object.values(out.movers).every((v) => Object.values(v).every(Boolean)), `item 4 (${tag}): the kit's ${villager ? 'player and villager' : 'player'} foot <-> lookout both ways (${json(out.movers)})`);
  return out;
}

/** Vanilla's villager path up and down every spiral (the hard bar on a villager spiral), foot <-> lookout (feet cells). */
async function nav(meta) {
  const out = {};
  for (const q of meta.spirals ?? []) {
    const a = [q.foot[0], q.foot[1] + 1, q.foot[2]], b = [q.top[0], q.top[1] + 1, q.top[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out[q.id] = { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
  }
  return out;
}

/** The P2 SMOKE row: realised == virtual per writer kind (spirals strict on a flat world). */
async function smoke(tag, planDir, after, before) {
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
  check(RV.realisedOk(rv, ['spirals'], { strict: true }).pass && (rv.byKind.spirals?.differ ?? 0) === 0 && (rv.byKind.spirals?.written ?? 0) > 0, `item 3/P2 SMOKE (${tag}): realised == virtual per writer kind, ${rv.differ} of ${rv.written} differ (spirals ${rv.byKind.spirals?.differ ?? '?'} of ${rv.byKind.spirals?.written ?? 0}): ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  return { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
}

/**
 * A plan/0 fixture on its terrain built by commands in a fresh flat world (RS's site helper): Regions.checkPlan (load: generate),
 * realiseApproved, re-read (the kit's plan of the same request over the world's survey as the virtual world), crossed, removed.
 */
async function fixtureRun(tag, name, { villager = false } = {}) {
  const out = { fixture: name };
  const fx = G.fixture(ctx, name);
  const s = await G.site(ctx, tag, fx, { creative: true });
  const ck = await G.check(ctx, tag, s);
  out.check = { overall: ck.check?.overall ?? null, parts: (ck.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, spirals: a.geometry?.spirals, reasons: a.reasons })) };
  check(ck.check?.overall === 'READY' && (ck.check?.parts ?? []).every((a) => a.class === 'fits'), `item 3 (${tag}): ${name} (plan v1's shape) checks READY through Regions.checkPlan (${json(out.check.parts.map((a) => [a.part, a.class, (a.spirals ?? []).map((c) => [c.host, c.rise, c.turns, c.top?.kind])]))})`);
  if (!ck.check?.artifactSha) return out;
  const box = G.boxOf(s.W);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const pre = await G.snap(ctx, box, `sa-${tag}-pre`);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
  check(st.view.state === 'PLACED', `item 3 (${tag}): realised from its approved artifact (${st.view.state})`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  // (the check's own plan dir: the mod's plan, its seed and survey, is the virtual world the re-read compares against, as CL's)
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId ?? st.view.planId);
  check(fs.existsSync(path.join(planDir, 'ir.json')), `item 3 (${tag}): the check's plan dir (${path.basename(planDir)})`);
  if (!fs.existsSync(path.join(planDir, 'ir.json'))) { await leaveWorld(); return out; }
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R, { villager });
  out.smoke = await smoke(tag, planDir, after, before);
  if (villager) {
    await cmd('/kill @e[type=!minecraft:player]');
    out.nav = await nav(R.meta);
    check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 4 (${tag}, the hard bar): vanilla dev.nav.villager up and down the 2-wide spiral, foot <-> lookout (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  }
  const rm = await G.remove(ctx, region);
  const d = await G.diff(ctx, box, pre);
  out.exact = { removed: rm.removed, mismatches: d.mismatches, classes: d.classes, list: d.list.slice(0, 20) };
  check(rm.removed && d.mismatches === 0, `item 7 (${tag}): Regions.remove: E-flat ${d.mismatches} (the spiral and its host gone, the land as it was)`, d.list.slice(0, 8));
  await leaveWorld();
  return out;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  out.spire = await fixtureRun('spire', 'valid/v7a_sa_spire.json');
  out.spike = await fixtureRun('spike', 'valid/v7a_sa_spike.json');
  out.tree = await fixtureRun('tree', 'valid/v7a_sa_tree.json');
  out.villager = await fixtureRun('villager', 'valid/v7a_sa_villager.json', { villager: true });
  // (item 6, the KC row, is the kit's: kit/test/sa.test.mjs over sa/k01_spiral_fountain, M25:clear 0)
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 8: survival (RS)

steps.survival = async () => {
  await ensure();
  const out = {};
  const name = 'valid/v7a_sa_spire.json';
  const fx = G.fixture(ctx, name);
  const T = await G.twin(ctx, 'sa', fx);
  const s = await G.site(ctx, 'sa', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'sa-surv-pre');
  const ck = await G.check(ctx, 'sa', s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'stair');
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, cost: a?.cost ?? null };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!a?.cost?.survival, `item 8: v7a_sa_spire through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}, cost.survival ${json(a?.cost?.survival && { free: a.cost.survival.free, held: a.cost.survival.held })}`);
  if (!ck.check?.artifactSha) return out;
  const crateAt = await G.pile(ctx, s, 6);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 3_600_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted, state: st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent } };
  check(st.view.state === 'PLACED' && rs.build?.done && rs.build?.percent === 100, `item 8: realiseApproved in survival and fed in ${f.waves} waves: ${st.view.state}, build ${json(out.feed.build)}`);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ;
  check(differ.length === 0, `item 8: the check's cost.survival.bom against the targets' bills put down, per part: ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal, item for item (BOM exact)'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 8: the survival build equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ (bottom up is by construction: the spiral's cells are written in level order, each tread on the one below, its support or the host)`, d.list);
  const rm = await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `item 8: Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
const LOOK_HOSTS = [['spire', 'valid/v7a_sa_spire.json'], ['tree', 'valid/v7a_sa_tree.json'], ['mushroom', 'valid/v7a_sa_mushroom.json'], ['spike', 'valid/v7a_sa_spike.json']];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `sa_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], runs: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  const only = process.env.SA_LOOK_ONLY ? new Set(process.env.SA_LOOK_ONLY.split(',')) : null;
  for (const [host, name] of LOOK_HOSTS) {
    for (const bible of host === 'spike' ? [null] : LOOK_BIBLES) {
      const tag = `${host}_${bible ?? 'default'}`;
      if (only && !only.has(tag)) continue;
      const fx = G.fixture(ctx, name);
      const s = await G.site(ctx, `look ${tag}`, fx, { creative: true });
      await cmd('/time set 6000');
      const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', ...(bible ? { bible } : {}) }, 1_800_000);
      const a = (ck.check?.parts ?? []).find((q) => q.part === 'stair');
      const g = a?.geometry?.spirals?.[0];
      check(ck.check?.overall === 'READY' && !!g, `look (${tag}): ${name} checks READY in ${bible ?? 'the default bible'} (recorded, not judged: Noah's call, N-SA-1)`);
      if (!ck.check?.artifactSha || !g) { await leaveWorld(); continue; }
      const region = await G.realise(ctx, ck.check.artifactSha);
      const st = await L.waitRegion(region, 3_600_000);
      out.runs[tag] = { state: st.view.state, spiral: g };
      const [fx0, fy, fz] = g.foot, [tx, ty, tz] = g.top.at;
      const cx = (fx0 + tx) / 2, cz = (fz + tz) / 2, mid = Math.round((fy + ty) / 2);
      // the whole spiral from the south-west, high; a close-up of the treads and rails half way up; the lookout deck from over it; the
      // foot and its approach; a landing (the first one) from beside it
      out.shots.push(await shot(`${tag}_whole`, [cx - 22.5, ty + 6, cz + 22.5], [cx + 0.5, mid, cz + 0.5]));
      out.shots.push(await shot(`${tag}_closeup`, [cx + 9.5, mid + 3, cz + 9.5], [cx + 0.5, mid, cz + 0.5]));
      out.shots.push(await shot(`${tag}_lookout`, [tx + 6.5, ty + 7, tz + 6.5], [tx + 0.5, ty + 1, tz + 0.5]));
      out.shots.push(await shot(`${tag}_foot`, [fx0 + 0.5 - 10 * Math.sign(cx - fx0 || 1), fy + 4, fz + 6.5], [fx0 + 0.5, fy + 2, fz + 0.5]));
      if (!bible) {
        await cmd('/time set 13000');
        out.shots.push(await shot(`${tag}_dusk`, [cx - 16.5, ty + 2, cz + 16.5], [cx + 0.5, mid, cz + 0.5]));
      }
      await call('dev.release', {}).catch(() => null);
      const rm = await G.remove(ctx, region).catch((e) => ({ error: String(e?.message ?? e) }));
      out.runs[tag].remove = { removed: rm.removed ?? null, error: rm.error ?? null };
      await leaveWorld();
    }
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'ingame', 'survival', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-SA (spiral stairs)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7asa.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(L.fails() ? 1 : 0);
