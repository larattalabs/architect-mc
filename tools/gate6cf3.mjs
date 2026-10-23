#!/usr/bin/env node
// Phase 6c slice F3 gate (docs/CONTRACT.md "Phase 6c slice F3: forms II, trees, mushrooms, coral, roots and stalactites" §10) against
// the headless server of the F3 run worktree (GATE6B_RUN, default `../architect-mc-F3-run`, a detached worktree at this checkout's HEAD;
// the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6cf3.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit      (f3-unit)              offline: item 1 (the generators' properties), items 2, 7, 9 (the F3 kit tests: every fixture's answer,
//                                      the broken variants, the catalogue), §8 byte identity against the merge base (every committed
//                                      fixture but the named exceptions; M18 and M19 recorded on each), §9 the 59 asks before and after,
//                                      item 11 (determinism: IR and blob shas over 3 plans; the grove goldens), item 13 (api-compat --gate6cf3,
//                                      the compact plan/0's size, $0), the Java units (StillOursF3Test, CopperTest, ApiF3Test)
//     ingame    (f3-ingame)            items 3, 4, 6, 8 on a flat world: v72, v74, v75, v77 (and the coral lane's v73, c01; s01) through
//                                      Regions.checkPlan and realiseApproved: READY, PLACED, the realised cells equal the baked ones by state,
//                                      vanilla's rules recomputed on the dump, the realised M3, a 2-minute stand at default random ticks, the
//                                      drift (a leaf, a mushroom face, a dripstone tip, a player's block on a form cell), Regions.remove E-flat
//     natural   (f3-natural)           item 5: grove_demo's plan on its forest site (scenarios/sites/grove.json) after a no-region control:
//                                      E-normal 0 unclassified, 0 classified cells within 8 of a form's columns
//     forest    (f3-forest)            item 10 (recorded): mega_bench_forest planned (IR and blob sizes, trees, cover) and 16 forest tiles
//                                      evaluated (per-tile p50/p99, cells/s); the organic read (axis-run share per generator)
//     look      (f3-look, a client)    item 14: shots of each species, a coral pond, the cave's stalactites, roots down a bank; the gallery
//     golden                           (by hand) cut scenarios/goldens/grove_demo_flat from a kit plan of grove_demo on its flat claim
//     report                           REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-f3/<step>.json in the main checkout (GATE6CF3_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatePart, sliceSections, slicesOf } from './lib/gate-part.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-F3-run');
process.env.GATE6B_OUT = process.env.GATE6CF3_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-f3');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const CORE = await import('./lib/gate6chy-core.mjs');
const G = await import('./lib/gate6cf3-game.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core: CORE };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice F3 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B F3 Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of ['G6B Seed Base', 'G6B Flat Base']) await L.ensureBase(name);
  spendZero();
  return { worlds: ['G6B Seed Base', 'G6B Flat Base'] };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

steps.unit = async () => {
  const out = {};
  // a split unit step (docs/GATES.md "Turbo"): `items` (every item but the byte identity) and the byte identity's fixture loop in
  // round-robin slices; whole, every section runs exactly as before
  const P = gatePart(['items', ...sliceSections('unchanged', 3)], { log });
  const slice = slicesOf(P, 'unchanged', 3);
  if (P.want('items')) {
  // item 1 (the generators) and items 2, 7, 8 (plan side), 9 (the catalogue): the F3 kit tests
  const files = ['kit/test/forms-f3-property.test.mjs', 'kit/test/forms-f3.test.mjs', ...(fs.existsSync(path.join(KIT, 'test', 'forms-f3-coral.test.mjs')) ? ['kit/test/forms-f3-coral.test.mjs'] : [])];
  out.kit = nodeTest(files);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 10, `items 1, 2, 7, 8, 9 (kit): ${files.map((f) => path.basename(f)).join(', ')}: ${out.kit.pass} pass, ${out.kit.fail} fail (200 seeds per generator and preset: ops at most 32 primitives, lint STATE clean, nothing floating; every F3 fixture's answer; the broken variants caught; catalogue 11's diff)`, out.kit.failing);
  // the P0 catalogue rule (item 9: every supported entry has a valid/ fixture that fits) and the scenario goldens (item 11)
  out.p0 = nodeTest(['kit/test/plan-p0.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-golden.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `items 9, 11, 12 (kit): plan-p0 (every supported entry has a valid fixture that fits; every reserved one an extension fixture), the scenario goldens (grove_demo's among them) and mega_bench's golden (unchanged): ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  }
  // §8 byte identity and M18/M19 per fixture
  const K = await import('./lib/gate6cf3-kit.mjs');
  if (!slice || slice.length) {
  const u = await K.unchanged(root, { check, log, slice });
  fs.writeFileSync(path.join(OUT, 'f3-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, excepted: K.EXCEPT, m18: Object.entries(u.m18).filter(([, v]) => v.count > 0), m19: Object.entries(u.m19).filter(([, v]) => v.count > 0) };
  }
  if (P.want('items')) {
  // §9 the 59 asks before and after
  const { asksGap } = await import('./lib/gate6chy-b.mjs');
  const baseDir = path.resolve(root, '..', 'architect-mc-F3-main');
  const before = await asksGap(path.join(baseDir, 'kit')), after = await asksGap(KIT);
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'f3');
  fs.writeFileSync(path.join(OUT, 'f3-asks-before.md'), before.text);
  fs.writeFileSync(path.join(OUT, 'f3-asks-after.md'), after.text);
  const lines = (t) => new Map(t.split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('  ') && l.includes('/')).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  // ((batch v0.41.0) the five asks FL moves by name are FL's to judge)
  const { FL_MOVED_ASKS, flAsksFilter } = await import('./lib/fl-norm.mjs');
  const flAsk = (k) => FL_MOVED_ASKS.includes(`${k.split('/')[0]}.json`);
  const moved = [...la].filter(([k, v]) => lb.get(k) !== v && !flAsk(k)).map(([k]) => k);
  const cb = fs.existsSync(path.join(F, 'asks-before.md')) ? fs.readFileSync(path.join(F, 'asks-before.md'), 'utf8') : null, ca = fs.existsSync(path.join(F, 'asks-after.md')) ? fs.readFileSync(path.join(F, 'asks-after.md'), 'utf8') : null;
  // ((6c close-out A) the tables compared without what later slices moved: FL's five free asks and their rows (fl-norm flAsksFilter), VOC-c's
  // palette rules; the base may already be past F3, so its table may equal either committed one)
  const later = (t) => (t == null ? null : flAsksFilter(t).split('\n').filter((l) => !/rule\.palette/.test(l)).join('\n'));
  out.asks = { moved, malformedBefore: before.malformed, malformedAfter: after.malformed, parts: la.size, committed: (later(before.text) === later(cb) || later(before.text) === later(ca)) && later(after.text) === later(ca) };
  check(after.malformed === 0 && moved.length === 0 && la.size > 0 && out.asks.committed, `§9: the 59 asks on the merge base and on this head (fixtures/plan/f3/asks-before.md, asks-after.md): ${after.malformed} malformed, ${moved.length} part(s) moved class of ${la.size}; no recorded plan names an F3 block`, moved);
  // item 11: determinism (IR and blob shas over 3 plans) on v72, v75 and grove_demo (flat)
  out.determinism = await determinism();
  check(out.determinism.every((d) => d.same), `item 11: IR and blob shas identical over 3 plans: ${json(out.determinism.map((d) => [d.what, d.ir.slice(0, 12), d.same]))}`);
  // item 13: api-compat, the compact plan/0's size, $0
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cf3'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 13: api-compat --gate6cf3 clean against the 0.40.0, 0.39.1 and 0.39.0 apitest jars and the 0.40.0 jar's 1.37.0 surface; $0.00`, out.apicompat.tail);
  out.compact = await compactSize();
  check(out.compact.chars < 84_000, `item 13 (recorded, S-FL-8's bound 84,000): the compact plan/0 is ${out.compact.chars} characters (${out.compact.delta >= 0 ? '+' : ''}${out.compact.delta} over the merge base's ${out.compact.base})`);
  // the Java units: StillOurs' F3 rows and Coral, copper's unchanged, the API's features
  const { gradle } = await import('./lib/src-gradle.mjs').catch(() => ({ gradle: null }));
  const args = ['test', '--offline', '--tests', 'dev.larattalabs.architect.journal.StillOursF3Test', '--tests', 'dev.larattalabs.architect.journal.CopperTest', '--tests', 'dev.larattalabs.architect.apiimpl.ApiF3Test'];
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const jr = gradle ? await gradle(path.join(root, 'mod'), args, { env }) : spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: jr.status ?? jr.code, tail: `${jr.stdout ?? ''}${jr.stderr ?? ''}`.split('\n').slice(-8) };
  check((jr.status ?? jr.code) === 0, `Java units: StillOursF3Test (mushroom faces and dripstone thickness volatile, Coral.canonical equal to the kit's 40 rows, a dead coral holds the live one), CopperTest, ApiF3Test: gradle exit ${jr.status ?? jr.code}`, out.java.tail);
  }
  spendZero();
  return out;
};

/** Item 11: IR and blob shas over 3 plans (kit, in process). */
async function determinism() {
  const H = await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href);
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const out = [];
  for (const rel of ['valid/v72_f3_grove.json', 'valid/v75_f3_stalactites.json']) {
    const fx = G.fixture(ctx, rel);
    const shas = [];
    for (let i = 0; i < 3; i++) {
      const s = fx.terrain ? H.flatSurvey(fx.terrain) : H.flatSurvey();
      const r = await H.checkPlanVolumes(fx.plan, { volume: fx.volume ?? {}, survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim) });
      shas.push([sha(r.res.irJson), sha(Buffer.concat([...r.res.blobs.keys()].sort().map((k) => Buffer.from(r.res.blobs.get(k)))))]);
    }
    out.push({ what: rel, ir: shas[0][0], blobs: shas[0][1], same: shas.every((x) => x[0] === shas[0][0] && x[1] === shas[0][1]) });
  }
  {
    const s = H.flatSurvey({ W: 192, D: 192, x0: 3392, z0: -1536 });
    const shas = [];
    for (let i = 0; i < 3; i++) {
      const r = await planRegion({ programFile: path.join(KIT, 'regions', 'grove_demo.mjs'), params: {}, survey: s.bytes, claim: s.claim, roles: {} });
      shas.push([sha(r.irJson), sha(Buffer.concat([...r.blobs.keys()].sort().map((k) => Buffer.from(r.blobs.get(k)))))]);
    }
    out.push({ what: 'grove_demo (flat)', ir: shas[0][0], blobs: shas[0][1], same: shas.every((x) => x[0] === shas[0][0] && x[1] === shas[0][1]) });
  }
  return out;
}

/** Item 13 (recorded): the compact plan/0's length here and on the merge base (the sidecar's own expansion of plan/0#compact, by tsx). */
async function compactSize() {
  const one = (kit) => {
    const src = `import { expandSystemRefs } from ${JSON.stringify(path.join(root, 'sidecar', 'src', 'jobs', 'systemrefs.ts'))};\nprocess.stdout.write(String((await expandSystemRefs(${JSON.stringify(kit)}, ['plan/0#compact'])).length));`;
    const f = path.join(OUT, 'f3-compact.mts');
    fs.writeFileSync(f, src);
    const r = spawnSync(path.join(root, 'sidecar', 'node_modules', '.bin', 'tsx'), [f], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 300_000 });
    return Number(r.stdout.trim());
  };
  const chars = one(KIT), base = one(path.join(path.resolve(root, '..', 'architect-mc-F3-main'), 'kit'));
  return { chars, base, delta: chars - base };
}

// ------------------------------------------------------------------ in game (items 3, 4, 6, 8)

steps.ingame = async () => {
  await ensure();
  const out = {};
  // v72: the grove; the stand; the drift (a leaf, a mushroom face, a player's block on a trunk cell)
  out.v72 = await G.realiseF3(ctx, 'v72', G.fixture(ctx, 'valid/v72_f3_grove.json'), { stand: 120, drift: driftGrove, expectKept: (d) => (d?.player?.at ? [d.player.at.join(',')] : []) });
  // v74: roots down the bank; v75: the cave's stalactites (the stand; a dripstone tip's thickness changed); v77: the nether's giants
  out.v74 = await G.realiseF3(ctx, 'v74', G.fixture(ctx, 'valid/v74_f3_roots_bank.json'), {});
  out.v75 = await G.realiseF3(ctx, 'v75', G.fixture(ctx, 'valid/v75_f3_stalactites.json'), { stand: 120, drift: driftCave });
  out.v77 = await G.realiseF3(ctx, 'v77', G.fixture(ctx, 'valid/v77_f3_nether.json'), {});
  // the coral lane (F3-c): v73, c01 and the drained pond's dead coral (its own module)
  const coralLib = path.join(root, 'tools', 'lib', 'gate6cf3-coral.mjs');
  if (fs.existsSync(coralLib)) out.coral = await (await import(pathToFileURL(coralLib).href)).coralItems(ctx);
  else check(false, 'items 3, 4, 6 (coral): tools/lib/gate6cf3-coral.mjs is not in this build yet (the coral lane)');
  // s01: Steward-shaped (a hamlet, a giant oak near its well, a coral pond, two mushrooms at its edge)
  const s01 = path.join(KIT, 'test', 'fixtures', 'plan', 'f3', 's01_steward_glade.json');
  if (fs.existsSync(s01)) out.s01 = await G.realiseF3(ctx, 's01', JSON.parse(fs.readFileSync(s01, 'utf8')), {});
  else check(false, 'item 3 (s01_steward_glade): the Steward-shaped fixture is not in this build yet');
  spendZero();
  return out;
};

/** Item 6 on v72: a leaf's distance and a mushroom face changed by a player-like change beside them; a player's block on a trunk cell. */
async function driftGrove(r, { g, after, norm }) {
  const out = {};
  const oak = g.byForm.find((f) => /oak/.test(f.id) && f.generator === 'giantTree');
  const red = g.byForm.find((f) => f.generator === 'giantMushroom');
  const air = (x, y, z) => !after.stateAt(x, y, z);
  // a leaf: its distance set by a /setblock of the same leaf (as a neighbour's update would leave it: persistent kept)
  const leaf = [...oak.cells].find(([k, s]) => /_leaves/.test(s) && /distance=[1-5]/.test(s) && (() => { const [x, y, z] = k.split(',').map(Number); return air(x, y + 1, z); })());
  if (leaf) {
    const [x, y, z] = leaf[0].split(',').map(Number);
    const d = Number(/distance=(\d)/.exec(leaf[1])[1]);
    const nd = d === 1 ? 2 : d - 1;
    await L.cmd(`/setblock ${x} ${y} ${z} ${leaf[1].replace(/distance=\d/, `distance=${nd}`)} strict`);
    const dl = await G.dumpOf(ctx, [x, y, z, x, y, z], 'f3-v72-leaf');
    out.leaf = { at: [x, y, z], from: d, to: nd, now: dl.stateAt(x, y, z) };
    check(new RegExp(`distance=${nd}`).test(out.leaf.now ?? '') && /persistent=true/.test(out.leaf.now ?? ''), `item 6 (v72): a leaf of the oak at ${x} ${y} ${z} drifted (distance ${d} -> ${nd}, a /setblock strict of its own block as a neighbour's update leaves it): ${out.leaf.now}`, out.leaf);
  }
  // a mushroom face: a player places a red mushroom block beside a cap cell (its face turns false), then breaks it again
  const cap = [...red.cells].find(([k, s]) => /mushroom_block/.test(s) && (() => { const [x, y, z] = k.split(',').map(Number); return air(x + 1, y, z) && /east=true/.test(s); })());
  if (cap) {
    const [x, y, z] = cap[0].split(',').map(Number);
    const capBlock = cap[1].replace(/\[.*$/, '');
    const pu = await L.call('dev.pt.uses', { ops: [{ item: capBlock, at: [x + 1, y, z], on: [x, y, z], face: 'east', placer: 'F3Player' }] }, 120_000);
    const br = await L.call('dev.pt.breaks', { at: [[x + 1, y, z]], placer: 'F3Player' }, 120_000);
    const d = await G.dumpOf(ctx, [x, y, z, x, y, z], 'f3-v72-cap');
    out.face = { at: [x, y, z], placed: pu.results?.[0]?.state ?? null, broken: br.broken, now: d.stateAt(x, y, z) };
    check(/east=false/.test(out.face.now ?? '') && out.face.placed, `item 6 (v72): a player placed a ${capBlock.replace('minecraft:', '')} beside our cap at ${x} ${y} ${z} and broke it again: the cap's east face is false now (${out.face.now})`, out.face);
  }
  // a player's block on a form cell: the player mines one of the oak's outer trunk logs and places stone there (PT records it)
  const log0 = [...oak.cells].find(([k, s]) => /oak_log/.test(s) && (() => { const [x, y, z] = k.split(',').map(Number); return air(x + 1, y, z) && y > 66 && y < 70 && /oak_(log|wood)/.test(oak.cells.get(`${x - 1},${y},${z}`) ?? ''); })());
  if (log0) {
    const [x, y, z] = log0[0].split(',').map(Number);
    const br = await L.call('dev.pt.breaks', { at: [[x, y, z]], placer: 'F3Player' }, 120_000);
    const pu = await L.call('dev.pt.uses', { ops: [{ item: 'minecraft:stone', at: [x, y, z], on: [x - 1, y, z], face: 'east', placer: 'F3Player' }] }, 120_000);
    const rec = await L.call('dev.pt.at', { at: [x, y, z] });
    out.player = { at: [x, y, z], broken: br.broken, placed: pu.results?.[0]?.state ?? null, record: rec };
    check(br.broken === 1 && /stone/.test(out.player.placed ?? '') && !!rec.placer, `item 6 (v72): a player mined the oak's trunk log at ${x} ${y} ${z} and placed stone there (PT recorded ${rec.placer ?? 'nothing'})`, out.player);
  }
  void norm;
  return out;
}

/** Item 6 on v75: a stalactite tip's thickness changed (a /setblock of the same block, as a neighbour's update would leave it). */
async function driftCave(r, { g, after }) {
  const tip = [...g.cells].find(([k, s]) => /pointed_dripstone/.test(s) && /thickness=tip,/.test(s) && /vertical_direction=down/.test(s));
  if (!tip) return { tip: null };
  const [x, y, z] = tip[0].split(',').map(Number);
  await L.cmd(`/setblock ${x} ${y} ${z} ${tip[1].replace('thickness=tip,', 'thickness=frustum,')} strict`);
  const d = await G.dumpOf(ctx, [x, y, z, x, y, z], 'f3-v75-tip');
  void after;
  const now = d.stateAt(x, y, z);
  check(/thickness=frustum/.test(now ?? ''), `item 6 (v75): a stalactite tip at ${x} ${y} ${z} drifted to frustum (a /setblock strict of its own block): ${now}`);
  return { tip: { at: [x, y, z], now } };
}

// ------------------------------------------------------------------ natural (item 5)

steps.natural = async () => {
  await ensure();
  const site = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'sites', 'grove.json'), 'utf8'));
  const c = site.fixture.claim;
  const { GROVE_PLAN } = await imp('regions/grove_demo.mjs');
  const fx = { plan: GROVE_PLAN, anchors: {} };
  const out = {};
  // the no-region control: the same box, the same wait, no region: the world's own drift on this site
  await L.ensureBase('G6B Seed Base');
  await L.fresh('G6B F3 control', 'G6B Seed Base');
  await L.setRules('exact');
  await L.tp((c[0] + c[2]) / 2, 200, (c[1] + c[3]) / 2);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
  await L.settle(20_000);
  const cbox = [c[0], 40, c[1], c[2], 160, c[3]];
  const f = await CORE.snap(ctx, cbox, 'f3-control');
  await L.settle(60_000);
  const df = await L.call('dev.region.hash', { box: cbox, mode: 'diff', file: f }, 4 * 3_600_000);
  out.control = { mismatches: df.mismatches, classes: df.classes ?? {} };
  check(true, `item 5 (recorded): the no-region control on the grove site: ${df.mismatches} mismatch(es) in 60 s ${json(df.classes ?? {})}`);
  await L.leaveWorld();
  out.grove = await G.realiseF3(ctx, 'grove', fx, { base: 'G6B Seed Base', site: c, control: out.control });
  // item 11: grove_demo's golden over the natural site's own survey (the check's plan dir), as the scenario goldens are cut
  if (out.grove.realise?.planId && process.env.F3_WRITE_GOLDEN === '1') out.golden = await groveGolden('grove_demo', fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', out.grove.realise.planId, 'survey.bin')), { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: -64, maxY: 319 });
  spendZero();
  return out;
};

/** Cut scenarios/goldens/<name> from grove_demo planned by the kit over `survey` and `claim`. */
async function groveGolden(name, survey, claim) {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { tileShas } = await import('./scenarios.mjs');
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'grove_demo.mjs'), params: {}, survey, claim, roles: {}, node: process.versions.node.split('.')[0] });
  // (the IR records the Node major, as the other goldens: tools/release-version.mjs re-plans with it)
  const dir = path.join(root, 'scenarios', 'goldens', name);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ir.json'), p.irJson);
  fs.writeFileSync(path.join(dir, 'survey.bin'), survey);
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(p.meta, null, 1)}\n`);
  // only the blobs the IR names (tools/release-version.mjs compares the set); a stale one left from an earlier cut is removed
  const named = new Set(Object.values(p.ir.blobs ?? {}).map((b) => b.sha).filter(Boolean));
  for (const f of fs.readdirSync(path.join(dir, 'blobs'))) if (!named.has(f.replace(/\.bin$/, ''))) fs.unlinkSync(path.join(dir, 'blobs', f));
  for (const [k, b] of p.blobs) if (named.has(k)) fs.writeFileSync(path.join(dir, 'blobs', `${k}.bin`), b);
  const t = await tileShas(dir);
  fs.writeFileSync(path.join(root, 'scenarios', 'goldens', `${name}.json`), `${JSON.stringify({ scenario: 'grove_demo', variant: name.endsWith('_flat') ? 'flat' : 'natural', version: 0, note: `tile shas of grove_demo planned by the kit over ${name.endsWith('_flat') ? 'its flat claim' : 'its forest site\'s own survey (the f3-natural check\'s)'}, 1 worker = 4 workers shuffled; inputs in goldens/${name}/`, irSha: t.irSha, kitVersion: p.ir.kitVersion, cells: t.cells, tiles: t.tiles }, null, 1)}\n`);
  check(t.workersSame, `golden: ${name} cut: IR ${t.irSha.slice(0, 12)}, ${Object.keys(t.tiles).length} tiles, ${t.cells} cells, 1 worker = 4 workers shuffled`);
  return { irSha: t.irSha, tiles: Object.keys(t.tiles).length, cells: t.cells };
}

// ------------------------------------------------------------------ the forest variant (item 10, recorded)

steps.forest = async () => {
  const out = {};
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { synthSurvey } = await imp('lib/region/synth.mjs');
  const { evalTile } = await imp('lib/realise.mjs');
  const { windowFromSurvey } = await imp('lib/region/survey.mjs');
  const CLAIM = { minX: -500, minZ: -500, maxX: 499, maxZ: 499, minY: -64, maxY: 319 };
  const survey = synthSurvey(CLAIM, 'golden');
  const t0 = performance.now();
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'mega_bench_forest.mjs'), survey, claim: CLAIM, node: 'golden' });
  const planMs = performance.now() - t0;
  const blobBytes = [...p.blobs.values()].reduce((n, b) => n + b.length, 0);
  out.plan = { ms: Math.round(planMs), irBytes: p.irJson.length, blobBytes, irSha: p.irSha, forest: p.meta.forest };
  check(true, `item 10 (recorded): mega_bench_forest planned in ${Math.round(planMs)} ms: ${p.meta.forest?.trees} giant trees over ${(100 * (p.meta.forest?.coverShare ?? 0)).toFixed(1)}% of the claim (${p.meta.forest?.variants} baked variants, ${p.meta.forest?.cells} tree cells; by species ${json(p.meta.forest?.bySpecies)}); IR ${p.irJson.length} bytes (bar at the close-out: under 4 MB), blobs ${blobBytes} bytes (under 16 MB)`);
  // 16 forest tiles: the tiles of the last stage most covered by trees, each evaluated as the realise does (the best of 3 passes)
  const stage = p.ir.stages[p.ir.stages.length - 1];
  const keys = p.ir.tiles[stage].terrain;
  const counts = new Map();
  for (const f of p.ir.forms) if (f.generator === 'giantTree') { const k = `${Math.floor(f.bounds.minX / 64)},${Math.floor(f.bounds.minZ / 64)}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  const pick = keys.filter((k) => counts.has(k)).sort((a, b) => counts.get(b) - counts.get(a) || (a < b ? -1 : 1)).slice(0, 16);
  const blobs = (sha) => p.blobs.get(sha) ?? null;
  const times = [];
  let cells = 0;
  for (const key of pick) {
    const w = windowFromSurvey(survey, key);
    let best = Infinity, n = 0;
    for (let i = 0; i < 3; i++) { const t = performance.now(); const e = evalTile(p.ir, key, w, { stage, set: 'terrain', blobs }); best = Math.min(best, performance.now() - t); n = e.count ?? n; }
    times.push(best);
    cells += n;
  }
  times.sort((a, b) => a - b);
  const total = times.reduce((a, b) => a + b, 0);
  out.tiles = { n: pick.length, p50Ms: times[times.length >> 1], p99Ms: times[Math.min(times.length - 1, Math.floor(times.length * 0.99))], maxMs: times[times.length - 1], cells, cellsPerSecond: total ? Math.round(cells / (total / 1000)) : 0, keys: pick };
  check(true, `item 10 (recorded): 16 forest tiles evaluated (best of 3): p50 ${out.tiles.p50Ms?.toFixed(1)} ms, p99 ${out.tiles.p99Ms?.toFixed(1)} ms, ${out.tiles.cells} cells, ${out.tiles.cellsPerSecond} cells/s (bars at the close-out: p99 under 2 s, at least 45k cells/s)`);
  // the organic read (N-F1-1, recorded): the axis-run share per generator over each form's boundary cells
  out.organic = await organicRead();
  check(true, `item 10 (recorded): the organic read (axis-run share of each generator's boundary cells): ${json(out.organic)}`);
  spendZero();
  return out;
};

/** The organic read (F1's, N-F1-1, recorded): tools/lib/scenario-metrics.mjs axisRunShare per generator over grove_demo's and v77's plans. */
async function organicRead() {
  const M = await import('./lib/scenario-metrics.mjs');
  const H = await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href);
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const out = {};
  const s = H.flatSurvey({ W: 192, D: 192, x0: 3392, z0: -1536 });
  const plans = [await planRegion({ programFile: path.join(KIT, 'regions', 'grove_demo.mjs'), params: {}, survey: s.bytes, claim: s.claim, roles: {} })];
  const v77 = G.fixture(ctx, 'valid/v77_f3_nether.json');
  const s2 = H.flatSurvey();
  plans.push((await H.checkPlanLocal(v77.plan, { survey: s2.bytes, claim: s2.claim, anchors: H.stewardAnchors(s2.claim) })).res);
  const acc = {};
  for (const [i, p] of plans.entries()) {
    const sv = i === 0 ? s.bytes : s2.bytes;
    const { vw } = buildVirtual({ ir: p.ir, survey: sv, blobs: (sha) => p.blobs.get(sha) ?? null });
    for (const gname of [...new Set((p.ir.forms ?? []).map((f) => f.generator))]) {
      const r = M.axisRunShare({ ...p.ir, forms: p.ir.forms.filter((f) => f.generator === gname), floating: [] }, vw);
      const a = (acc[gname] ??= { boundary: 0, inRun: 0 });
      a.boundary += r.boundaryCells ?? r.boundary ?? 0;
      a.inRun += (r.share ?? 0) * (r.boundaryCells ?? r.boundary ?? 0);
    }
  }
  for (const [k, a] of Object.entries(acc)) out[k] = { boundaryCells: a.boundary, share: a.boundary ? Math.round((1000 * a.inRun) / a.boundary) / 1000 : 0 };
  return out;
}

// ------------------------------------------------------------------ the golden (by hand)

steps.golden = async () => {
  const H = await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href);
  const s = H.flatSurvey({ W: 192, D: 192, x0: 3392, z0: -1536 });
  const out = { flat: await groveGolden('grove_demo_flat', s.bytes, s.claim) };
  // the natural golden again over its committed survey (f3-natural cut it from the site's own survey)
  const sv = path.join(root, 'scenarios', 'goldens', 'grove_demo', 'survey.bin');
  if (fs.existsSync(sv)) {
    const c = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'sites', 'grove.json'), 'utf8')).fixture.claim;
    out.natural = await groveGolden('grove_demo', fs.readFileSync(sv), { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: -64, maxY: 319 });
  }
  return out;
};

// ------------------------------------------------------------------ the look (item 14, a client)

steps.look = async () => {
  await ensure();
  const LOOK = await import('./lib/gate6cf3-look.mjs');
  const out = await LOOK.look(ctx);
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json', 'f3-unchanged.json'].includes(f) && !/check\.json$/.test(f));
  const lines = ['# Gate 6c slice F3', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (!j.results) continue;
    const fails = Object.entries(j.results).filter(([, v]) => v === false || v?.ok === false);
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s): ${fails.length ? `${fails.length} FAIL` : 'PASS'}`, '');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cf3.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
