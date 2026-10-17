#!/usr/bin/env node
// Phase 6c slice T3b gate (docs/CONTRACT.md "Phase 6c slice T3" §10: items 2-6 and 9 for tunnels, the tunnel parts of 7, 8, 11, 12, 14,
// the look) against the headless server of the T3b run worktree (`../architect-mc-T3b-run`, a detached worktree at this checkout's HEAD;
// the sim sidecar, no Claude). Ports 8918 (sidecar) / 8919 (DevBridge); the look step's client 8920 / 8921. $0: no Claude call anywhere.
//
//   node tools/gate6ct3b.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     pin                               the natural hill (scenarios/sites/tunnel_hill.json): find-site's spiral and summary over the
//                                       pinned seed, then a straight line with a surface bore of 32-60 cells, no tree or water in its
//                                       corridor, crossings_demo's hill variant planned with its frozen volume (one tunnel, M3:tunnel and
//                                       M4:tunnel clean), and no fluid within 4 of its void read from that volume
//     unit                              items 7, 8, 11, 12 (tunnels) offline: the kit's T3b tests, P0's tests, the goldens that must not
//                                       move, the whole kit suite; the Java plan-check tests
//     ingame                            items 2, 3, 9 on a flat world (headless): crossings_demo's tunnels (a 3x3 bore with a sand band and
//                                       a 1-wide bore through a ridge raised in stage ground) planned in the two-plan flow, realised, re-read
//                                       (cover, shell, lining, sand band: 0 falling blocks and 0 gravity cells over air, height clear, 0 dark
//                                       floor cells, 0 fluid within 2, M1/M3/M4 0), both kit movers and vanilla dev.nav.villager through
//                                       every bore both ways (the hard bar), the removal exact (E-flat 0); the postern (v40's walled village
//                                       with a cliff ridge built by commands, checked, approved, realised): villagers through it both ways,
//                                       closure with it, E-flat 0; item 5's "a plan without a tunnel part plans once" (v34)
//     natural                           items 2-6, 9 on the pinned hill (headless, fresh copies of the seed world): checkPlan with volumes
//                                       (answers equal the kit's for the same volume sha; notes "read N frozen volumes"); fluids (water 2
//                                       from the bore refused WATER with the cell, at 3 fits, realised, 2-minute stand, 0 fluid in the
//                                       void; lava 1 refused, at 3 fits); the stale rock (a shell cell mined and water 2 from the bore:
//                                       ARTIFACT_STALE naming the tunnel and the cell; the recheck after the mine fits again; with
//                                       neither it realises); the realised bore re-read (item 2), villagers through (item 3), the removal's
//                                       E-normal (0 unclassified, no classified mismatch within 6 of the bore's written cells); load:
//                                       "generate" (an unloaded corridor incomplete VOLUME under "loaded", fits under "generate"; ends a
//                                       thousand apart stay incomplete VOLUME past the per-edge cap under "generate")
//     look                              the look (client, recorded not judged): the flat demo's portal and its lit interior, the hill's
//                                       portal; cameras for the gallery
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-t3/t3b/<step>.json in the main checkout (GATE6CT3B_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-T3b-run');
process.env.GATE6B_OUT = process.env.GATE6CT3B_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-t3', 't3b');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;

refuseKeysSafe();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:t3b';
const FLAT_CLAIM = [6000, 6000, 6255, 6111];
const SITE_FILE = path.join(root, 'scenarios', 'sites', 'tunnel_hill.json');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function refuseKeysSafe() { L.refuseKeys(); }

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice T3b is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B T3b Lobby', { backend: 'sim' });
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
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.t3b = nodeTest(['kit/test/tunnel-t3b.test.mjs', 'kit/test/plan-t3b.test.mjs']);
  check(out.t3b.code === 0 && out.t3b.fail === 0 && out.t3b.pass >= 19, `items 2, 4, 7, 8, 11, 12 (kit, tunnels): the floor profile, the survey-first cover, the corridor box, the geometry's checks in order (NO_COVER, SPAN, TOO_STEEP, WATER, PROTECTED, VOLUME), the lining, cave sealing, falling-block lining and the fluid buffer (a pocket 2 from the bore and lava 1 from it refused, at 3 fits); the two-plan flow (the first plan asks one corridor and answers incomplete VOLUME); v37 (fits, M3:tunnel, M4:tunnel, M5, M6, M8 clean, both movers through); the refusal fixtures; the broken variants (noLining, noLamps, fluidBuffer 0, cover 1, the postern ignored); §9's recorded tunnels; v40's postern; v38b's auto tunnel; determinism: ${out.t3b.pass} pass, ${out.t3b.fail} fail`, out.t3b.failing);
  out.p0 = nodeTest(['kit/test/plan-p0.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/plan-k1-batch.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `item 16: P0's tests after T3 (v37, v38b, v40 fit; e17 answers tunnel.under; item 9's coverage without t3-pending-b.json), the K1 foundation and batch tests: ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/rope-k1b.test.mjs', 'kit/test/plan-k1b.test.mjs', 'kit/test/plan-k1a.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 13: the tile goldens that must not move (S1, S7, S2, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo, districts_demo, links_demo); T2's routes (its water test unchanged); K1's tests; the lint (the tunnel files on the plan path): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  // item 14 (recorded): v37's check time with and without the volume pass (the kit's in-process two-plan flow)
  {
    const H = await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href);
    const fx = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', 'valid', 'v37_tunnel.json'), 'utf8'));
    const sv = H.flatSurvey(fx.terrain);
    const o = { survey: sv.bytes, claim: sv.claim, anchors: { ...H.stewardAnchors(sv.claim), ...fx.anchors } };
    const t0 = Date.now();
    const one = await H.checkPlanLocal(fx.plan, o);
    const t1 = Date.now();
    const two = await H.checkPlanVolumes(fx.plan, { ...o, volume: fx.volume });
    const t2 = Date.now();
    out.timing = { firstPlanMs: t1 - t0, twoPlanMs: t2 - t1, overall: [one.check.overall, two.check.overall], note: 'recorded, not judged' };
    log(`  item 14 (recorded): v37 checked once ${out.timing.firstPlanMs} ms (${one.check.overall}), with the volume pass ${out.timing.twoPlanMs} ms (${two.check.overall})`);
  }
  // the Java side: the plan check's tunnel gate, the load option's key, the rock comparison (PlanChecksT3Test)
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*PlanChecksT3Test*', '--tests', '*ApiT3Test*'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  const xml = path.join(root, 'mod', 'build', 'test-results', 'test', 'TEST-dev.larattalabs.architect.region.PlanChecksT3Test.xml');
  const m = fs.existsSync(xml) ? /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(fs.readFileSync(xml, 'utf8')) : null;
  out.java = { code: g.status, tests: m ? +m[1] : 0, failures: m ? +m[2] + +m[3] : -1 };
  check(g.status === 0 && out.java.tests >= 4 && out.java.failures === 0, `items 5, 6 (Java): only a plan with a tunnel part asks for volumes; load "loaded" keeps the key's body; the rock comparison names the tunnel and the cells, PLANT as AIR, MISSING not judged, at most 16 named: ${out.java.tests} tests, ${out.java.failures} failures`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ shared in-game helpers

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const vols = await volumesOf(planDir, ir);
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs, volumes: vols });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep };
}

/** The decoded frozen volumes a plan's IR records (its side blobs). */
async function volumesOf(planDir, ir) {
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const out = [];
  for (const v of Object.values(ir.volumes ?? {})) {
    const sha = ir.blobs?.[v.blob]?.sha;
    const f = sha ? path.join(planDir, 'blobs', `${sha}.bin`) : null;
    if (f && fs.existsSync(f)) out.push(decodeArvx(fs.readFileSync(f)));
  }
  return out;
}

/**
 * Item 2 over the realised world: every bore's cover, shell (solid, and no soil, sand, ice or snow left in it unlined), gravity, fluids
 * within 2, the height clear, 0 dark floor cells, M1/M3/M4 0 in the tunnel parts.
 */
async function item2(tag, { meta, world, rep }) {
  const { voxelClassOf } = await imp('lib/blocks.mjs');
  const per = rep.metrics.tunnels?.per ?? [];
  const out = { tunnels: per, M5tunnel: rep.metrics.M5tunnel ?? null };
  check(per.length === (meta.tunnels ?? []).length && per.length >= 1, `item 2 (${tag}): ${per.length} tunnel(s) re-read from the realised world (${per.map((q) => `${q.width}x${q.height} ${q.length}`).join(', ')})`);
  check(per.every((q) => q.coverMin >= 2 && q.boreRun >= 4), `item 2 (${tag}): cover at least 2 site-solid over every bore cell, bores of 4+ (${per.map((q) => `cover ${q.coverMin}, bore ${q.boreRun}`).join('; ')})`);
  check(per.every((q) => q.shellOpen === 0), `item 2 (${tag}): every shell cell solid and not falling (${per.map((q) => `${q.shell - q.shellOpen}/${q.shell}`).join(', ')})`);
  // every exposed soil, loose, ice or snow shell cell lined: none of those classes left face-adjacent to a bore cell's void
  const P = world.pal, unlined = [];
  for (const t of meta.tunnels ?? []) {
    const voids = new Set(t.voids.map((c) => `${c[0]},${c[1]},${c[2]}`)), floor = new Set(t.floor.map((c) => `${c[0]},${c[1]},${c[2]}`));
    const [fx, , fz] = t.from, [dx, dz] = t.dir;
    for (const [x, y, z] of t.floor) {
      const i = (x - fx) * dx + (z - fz) * dz;
      if (!t.bore[i - 1]) continue;
      for (let h = 1; h <= t.height; h++) for (const [ax, ay, az] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
        const k = `${x + ax},${y + h + ay},${z + az}`;
        if (voids.has(k) || floor.has(k)) continue;
        const st = P.states[world.get(x + ax, y + h + ay, z + az)];
        const c = voxelClassOf(String(st).replace(/\[.*$/, ''));
        if (['SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG', 'LEAVES', 'PLANT'].includes(c)) unlined.push([x + ax, y + h + ay, z + az, st]);
      }
    }
  }
  out.unlined = unlined.slice(0, 20);
  check(!unlined.length, `item 2 (${tag}): every exposed soil, loose, ice and snow shell cell lined (${unlined.length} left)`);
  check(per.every((q) => q.gravity === 0), `item 2 (${tag}): 0 gravity cells over air (${per.map((q) => q.gravity).join(', ')})`);
  check(per.every((q) => q.notClear === 0 && q.clear === q.floorCells), `item 2 (${tag}): the height clear over 100% of floor cells (${per.map((q) => `${q.clear}/${q.floorCells}`).join(', ')})`);
  check(rep.metrics.M5tunnel && rep.metrics.M5tunnel.darkSpawnable === 0 && rep.metrics.M5tunnel.floorCells > 0, `item 2 (${tag}): 0 dark spawnable floor cells (M5 over the realised light: ${json(rep.metrics.M5tunnel)})`);
  check(per.every((q) => q.fluids === 0), `item 2 (${tag}): 0 fluid cells within 2 of the void, re-surveyed (${per.map((q) => q.fluids).join(', ')})`);
  const parts = new Set((meta.tunnels ?? []).map((t) => t.part));
  const bad = rep.findings.filter((f) => /^M(1|3|4)(:|$)/.test(f.rule) && (parts.has(f.part) || /tunnel/.test(f.rule)));
  check(!bad.length, `item 2 (${tag}): M1, M3 and M4 0 in the tunnels (${bad.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  return out;
}

/** Item 3: both kit movers and vanilla's villager through every tunnel, both ways (feet over the start walk cell and the landing). */
async function item3(tag, { meta, world }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const out = { kit: {}, vanilla: {} };
  for (const q of meta.tunnels ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    out.kit[q.id] = Object.fromEntries(['player', 'villager'].map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
    await cmd('/kill @e[type=!minecraft:player]');
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out.vanilla[q.id] = { width: q.width, there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
  }
  check(Object.values(out.kit).every((v) => v.player && v.villager), `item 3 (${tag}): kit player and villager movers through every bore, both ways (${json(out.kit)})`);
  check(Object.keys(out.vanilla).length >= 1 && Object.values(out.vanilla).every((v) => v.there && v.back), `item 3 (${tag}, the hard bar): vanilla dev.nav.villager through every bore both ways (${json(Object.fromEntries(Object.entries(out.vanilla).map(([k, v]) => [k, [v.width, v.there, v.back]])))})`);
  return out;
}

/** Falling-block entities now (an /execute count): the sand band must never fall. */
async function fallingNow() {
  const r = await cmd('/execute if entity @e[type=minecraft:falling_block]').catch(() => ({ messages: [] }));
  const msg = (r.messages ?? []).join(' ');
  const m = /count: (\d+)/i.exec(msg);
  return m ? +m[1] : /passed/i.test(msg) ? 1 : 0;
}

/** The plan's box for dumps: the claim + 8 over its written y span +- 8 (the scenarios' exactness box). */
async function boxOf(planDir, claim) {
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs, volumes: await volumesOf(planDir, ir) });
  let y0 = Infinity, y1 = -Infinity;
  vw.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  return [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
}

/** Realise (a plan or an approved artifact), counting falling blocks while it places and through a stand, then re-read. */
async function realiseAndRead(tag, { planDir, claim, box, start, standMs = 120_000 }) {
  const out = {};
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await tp((claim[0] + claim[2]) / 2, Math.min(319, box[4] + 12), (claim[1] + claim[3]) / 2);
  await L.settle(5000);
  await cmd('/kill @e[type=!minecraft:player]');
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  out.snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  let falling = 0;
  const region = await start();
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { falling = Math.max(falling, await fallingNow()); if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { region, state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  check(st.view.state === 'PLACED', `${tag}: realised (${st.view.state}, ${out.realise.cells} cells)`);
  // the stand: the band and the bore's surroundings stay put (falling blocks counted every 10 s)
  for (let t = 0; t < standMs; t += 10_000) { await sleep(10_000); falling = Math.max(falling, await fallingNow()); }
  out.falling = falling;
  check(falling === 0, `item 2 (${tag}): 0 falling-block entities during the realise and a ${standMs / 1000} s stand (max seen ${falling})`);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  out.R = await realisedOf(planDir, before, after);
  out.snapF = snapF;
  return out;
}

/** Item 9: the removal by its owner, its exactness over the box; E-normal: no classified mismatch within 6 of a tunnel's written cells. */
async function item9(tag, { region, box, snapF, meta, flat }) {
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const cells = (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
  // the tunnels' written cells (void, floor, lining and portal: the guard runs hold the void and floor; the lining is inside their 2-buffer)
  const near = (x, y, z) => (meta.tunnels ?? []).some((t) => {
    for (let k = 0; k < t.guard.length; k += 4) {
      const gx = t.guard[k], gz = t.guard[k + 1];
      if (Math.abs(gx - x) > 8 || Math.abs(gz - z) > 8) continue;
      if (Math.max(Math.abs(gx - x), Math.abs(gz - z)) <= 6 && y >= t.guard[k + 2] - 6 && y <= t.guard[k + 3] + 6) return true;
    }
    return false;
  });
  const list = diff.list ?? [];
  const nearTunnel = list.filter((m) => { const [x, y, z] = String(m.pos).split(',').map(Number); return near(x, y, z); });
  const out = { kind: flat ? 'E-flat' : 'E-normal', box, cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, nearTunnel: nearTunnel.slice(0, 50), list: list.slice(0, 50),
    journal: (meta.tunnels ?? []).map((t) => ({ id: t.id, carved: t.carved, lined: t.lined, written: t.counts?.written ?? null })) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 9 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored; journal per tunnel ${json(out.journal)})`);
  else {
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    check(rm.removed && none === 0, `item 9 (${tag}): the removal's E-normal: ${diff.mismatches} mismatches (${json(diff.classes ?? {})}), 0 unclassified (${none})`);
    check(list.length >= diff.mismatches && nearTunnel.length === 0, `item 9 (${tag}): no mismatch of any class within 6 of the bore's written cells (${nearTunnel.length}; journal per tunnel ${json(out.journal)})`);
  }
  return out;
}

const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);

// ------------------------------------------------------------------ ingame (flat)

steps.ingame = async () => {
  await ensure();
  const out = {};
  // ---- crossings_demo's tunnels on the flat claim: the two-plan flow (Regions.plan), realised, re-read, villagers, removal
  await L.fresh('G6B T3b Flat', FLAT);
  await L.setRules('exact');
  await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 100, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
  const p = await L.plan('crossings_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const planDir = sideDir(p.planId);
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  out.plan = { planId: p.planId, irSha: p.irSha, notes: p.notes ?? null, tunnels: (meta.tunnels ?? []).map((t) => ({ id: t.id, width: t.width, length: t.length, carved: t.carved, lined: t.lined })) };
  check((meta.tunnels ?? []).length === 2 && (p.notes ?? []).some((n) => /read 1 frozen volume/.test(n)), `flat: crossings_demo planned 2 tunnels through the ridge raised in ground (a 3x3 and a 1-wide), its corridor read in the two-plan flow (${(meta.tunnels ?? []).map((t) => `${t.width}x${t.height} ${t.length}`).join(', ')}; ${(p.notes ?? []).filter((n) => /volume/.test(n)).join('; ')})`);
  const box = await boxOf(planDir, FLAT_CLAIM);
  const rr = await realiseAndRead('flat', { planDir, claim: FLAT_CLAIM, box, start: () => L.realise(p.planId, {}), standMs: 60_000 });
  out.realise = { ...rr.realise, falling: rr.falling };
  out.item2 = await item2('flat', rr.R);
  out.item3 = await item3('flat', rr.R);
  out.item9 = await item9('flat', { region: rr.realise.region, box, snapF: rr.snapF, meta: rr.R.meta, flat: true });
  await leaveWorld();
  // ---- the postern: v40's walled village east of a cliff ridge built by commands (the world's own rock), checked, approved, realised
  out.postern = await posternRun();
  // ---- item 5's control: a plan without a tunnel part (v34's auto on rift_city) plans once: no volume pass
  await L.fresh('G6B T3b V34', FLAT);
  const v34 = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', 'valid', 'v34_auto.json'), 'utf8'));
  await tp(1120, 100, 2080);
  const c34 = await call('dev.region.checkPlan', { plan: v34.plan, claim: [1000, 2000, 1239, 2159], owner: OWNER, anchors: v34.anchors ?? {} }, 900_000);
  out.v34 = { overall: c34.check?.overall ?? null, volumePass: c34.volumePass ?? null, notes: (c34.check?.notes ?? []).filter((n) => /volume/.test(n)) };
  check(c34.check && c34.volumePass === null && !out.v34.notes.length, `item 5: a plan without a tunnel part (v34's auto) plans once: no volume pass, no volume note (${out.v34.overall})`);
  await leaveWorld();
  spendZero();
  return out;
};

/** v40 in game: a cliff ridge by commands, the walled village and its postern checked through plan_v0, realised from the artifact. */
async function posternRun() {
  const out = {};
  await L.fresh('G6B T3b Postern', FLAT);
  await L.setRules('exact');
  const CL = 7157, Z0 = 7000, Z1 = 7159; // the cliff's east face at x 7157 (v40's shape moved by +6000, +5000)
  await tp(CL, 100, (Z0 + Z1) / 2);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  const G = await groundAt(CL - 80, (Z0 + Z1) >> 1); // the flat world's surface block
  out.ground = G;
  for (let h = 1; h <= 14; h++) await cmd(`/fill ${CL - 50 + h} ${G + h} ${Z0} ${CL} ${G + h} ${Z1} minecraft:stone`);
  await cmd(`/fill ${CL - 49} ${G + 1} ${Z0} ${CL} ${G + 14} ${Z1} minecraft:stone replace minecraft:air`).catch(() => null);
  // grass over the ridge's top surface (a natural look; the volume reads SOIL there)
  for (let h = 1; h <= 14; h++) await cmd(`/fill ${CL - 50 + h} ${G + h} ${Z0} ${h === 14 ? CL : CL - 50 + h} ${G + h} ${Z1} minecraft:grass_block`);
  await L.settle(3000);
  const v40 = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'plan', 'valid', 'v40_postern.json'), 'utf8'));
  const sh = ([x, , z]) => [x + 6000, G + 1, z + 5000];
  const anchors = Object.fromEntries(Object.entries(v40.anchors).map(([k, v]) => [k, sh(v)]));
  const claim = [7000 - 0, 7000 - 0, 7239, 7159];
  const c = await call('dev.region.checkPlan', { plan: v40.plan, claim, owner: OWNER, anchors }, 900_000);
  out.check = { overall: c.check?.overall ?? null, parts: (c.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, reasons: a.reasons ?? null, tunnels: a.geometry?.tunnels ?? null })), volumePass: c.volumePass ?? null };
  check(c.check?.overall === 'READY' && c.check.parts.find((a) => a.part === 'postern')?.geometry?.tunnels?.[0]?.crossing?.lands === 'postern_town_wall', `postern: v40 checked READY in game (the tunnel under the wall a postern: ${json(c.check?.parts?.find((a) => a.part === 'postern')?.geometry?.tunnels?.[0]?.crossing ?? null)})`);
  if (c.check?.artifactSha) {
    const planDir = sideDir(c.check.checkId);
    const box = await boxOf(planDir, claim);
    const rr = await realiseAndRead('postern', { planDir, claim, box, start: async () => (await call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000)).region, standMs: 20_000 });
    out.item2 = await item2('postern', rr.R);
    out.item3 = await item3('postern', rr.R);
    const w = rr.R.rep.metrics.walls?.town_wall ?? null;
    out.closure = w ? { posternCells: w.posternCells ?? 0, cut: w.cut, closure: w.closure } : null;
    check(!!w && (w.posternCells ?? 0) > 0 && w.cut === 0 && ['player', 'villager'].every((m) => w.closure?.[m]?.leaks === 0 && w.closure[m].across === w.closure[m].nodes), `postern (M2:wall over the realised world): its bore under the wall is an opening, no route cut; closure 0 leaks with it blocked, every node across with it open (${json(out.closure)})`);
    out.item9 = await item9('postern', { region: rr.realise.region, box, snapF: rr.snapF, meta: rr.R.meta, flat: true });
  }
  await leaveWorld();
  return out;
}

// ------------------------------------------------------------------ natural (the pinned hill)

/** The pinned hill: its claim and line (scenarios/sites/tunnel_hill.json). */
function hill() {
  const s = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  if (!s.fixture?.line) throw new Error('tunnel_hill is not pinned: run `node tools/gate6ct3b.mjs pin` first');
  return s.fixture;
}
/** The tunnel part over the pinned line: approach 0 (the line itself, so a hazard placed beside it is judged on it). */
const lineOf = (f) => ({
  plan: { schemaVersion: 'plan/0', planId: 't3b_hill', connectors: [{ id: 'bore', kind: 'tunnel', approach: 0, from: { anchor: 'hill_w' }, to: { anchor: 'hill_e' } }] },
  anchors: { hill_w: [f.line.a[0], f.line.a[1] + 1, f.line.a[2]], hill_e: [f.line.b[0], f.line.b[1] + 1, f.line.b[2]] },
});

/** The block state at a cell (a one-cell dump), for restoring a cell a test changed. */
async function stateAt(x, y, z) {
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const f = path.join(OUT, `cell-${x}_${y}_${z}.arwd.gz`);
  await call('dev.region.dump', { box: [x, y, z, x, y, z], file: f }, 60_000);
  const d = await decodeArwd(fs.readFileSync(f));
  return d.palette[d.cells[d.at(x, y, z)]];
}

/** The highest non-air block of a column (a dump of y -64..319 at one column). */
async function groundAt(x, z) {
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const f = path.join(OUT, `col-${x}_${z}.arwd.gz`);
  await call('dev.region.dump', { box: [x, -64, z, x, 319, z], file: f }, 60_000);
  const d = await decodeArwd(fs.readFileSync(f));
  for (let y = 319; y >= -64; y--) if (!/^minecraft:(air|cave_air|void_air)$/.test(d.palette[d.cells[d.at(x, y, z)]])) return y;
  return -64;
}

/** A check of the hill's tunnel (plan_v0 through Regions.checkPlan): the DevBridge answer. */
async function checkHill(f, extra = {}) {
  const { plan, anchors } = lineOf(f);
  return call('dev.region.checkPlan', { plan, claim: f.claim, owner: OWNER, anchors, ...extra }, 900_000);
}

steps.natural = async () => {
  await ensure();
  const f = hill();
  const out = { site: { claim: f.claim, line: f.line } };
  const mid = Math.floor((f.line.a[0] + f.line.b[0]) / 2), zl = f.line.a[2];
  const at = async () => { await tp(mid, 200, zl); await call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => null); };
  // (the hazard cells beside the bore's middle: the void's lanes are z - 1 .. z + 1 (3 wide); a cell 2 from the void is z + 3)

  // ---- A: item 5 (the check with volumes, answers equal the kit's) and item 4 (water 2 refused, at 3 fits, realised, stand: dry)
  await L.fresh('G6B T3b Hill A', BASE);
  await L.setRules('exact'); // (stricter than K1b's natural round: no random ticks, no spawns, so nothing grows or grazes near the bore)
  await at();
  const c0 = await checkHill(f);
  const bore0 = c0.check?.parts?.find((a) => a.part === 'bore');
  out.check = { overall: c0.check?.overall ?? null, class: bore0?.class ?? null, reasons: bore0?.reasons ?? null, notes: c0.check?.notes ?? null, volumePass: c0.volumePass ?? null, ms: c0.ms ?? null, tunnel: bore0?.geometry?.tunnels?.[0] ?? null };
  check(c0.check?.overall === 'READY' && bore0?.class === 'fits', `item 5 (hill): checkPlan of the hill's tunnel READY, the bore fits (${bore0?.class} ${json(bore0?.reasons ?? null)})`);
  check((c0.check?.notes ?? []).some((n) => /^read 1 frozen volume/.test(n)) && c0.volumePass?.read === 1, `item 5 (hill): the check notes "read 1 frozen volume" (the two-plan flow: ${json(c0.volumePass)})`);
  // the kit's answer over the same survey and volume (the check's own plan dir): equal answers
  if (c0.check?.checkId) {
    const dir = sideDir(c0.check.checkId);
    const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
    const vols = await volumesOf(dir, ir);
    const H = await import(pathToFileURL(path.join(KIT, 'test', 'plan-helpers.mjs')).href);
    const survey = fs.readFileSync(path.join(dir, 'survey.bin'));
    const claim = { minX: f.claim[0], minZ: f.claim[1], maxX: f.claim[2], maxZ: f.claim[3], minY: -64, maxY: 319 };
    const { plan, anchors } = lineOf(f);
    const kitR = await H.checkPlanLocal(plan, { survey, claim, anchors, volumes: vols.map((d) => ({ box: d.box, sha: d.sha, decoded: d, bytes: fs.readFileSync(path.join(dir, 'blobs', `${ir.blobs[Object.values(ir.volumes)[0].blob].sha}.bin`)) })), budget: {} });
    const strip = (parts) => JSON.stringify(parts.map((a) => ({ part: a.part, class: a.class, geometry: a.geometry ?? null, reasons: a.reasons ?? null })));
    out.kitEqual = strip(kitR.check.parts) === strip(c0.check.parts);
    out.volumeSha = vols.map((d) => d.sha);
    check(out.kitEqual, `item 5 (hill): the answers equal the kit's for the same survey and volume sha ${out.volumeSha.map((s) => s.slice(0, 12)).join(', ')}`);
  }
  out.timing = { checkMs: c0.ms ?? null, volumePass: c0.volumePass ?? null };
  const t0 = bore0?.geometry?.tunnels?.[0];
  if (!t0) throw new Error('the hill tunnel did not fit: nothing further to test');
  const midFloor = Math.round(t0.from[1] + (t0.to[1] - t0.from[1]) / 2);
  const hz = (d, y = midFloor + 1) => [mid, y, zl + 1 + d]; // d cells from the void's south lane
  const fluidTest = async (kind, refuseD, fitD, worldName) => {
    const res = {};
    await L.fresh(worldName, BASE);
    await L.setRules('exact');
    await at();
    const [rx, ry, rz] = hz(refuseD);
    const was = await stateAt(rx, ry, rz);
    await cmd(`/setblock ${rx} ${ry} ${rz} minecraft:${kind}`);
    const c1 = await checkHill(f);
    const a1 = c1.check?.parts?.find((a) => a.part === 'bore');
    res.refused = { at: [rx, ry, rz], class: a1?.class ?? null, code: a1?.reasons?.[0]?.code ?? null, kind: a1?.reasons?.[0]?.evidence?.kind ?? null, sample: a1?.reasons?.[0]?.evidence?.sample ?? null };
    check(a1?.class === 'refused' && a1.reasons[0].code === 'WATER' && a1.reasons[0].evidence.kind === kind && (a1.reasons[0].evidence.sample ?? []).some((q) => q.at[0] === rx && q.at[1] === ry && q.at[2] === rz), `item 4 (hill): ${kind} set ${refuseD} from the bore before the check: refused WATER (kind ${a1?.reasons?.[0]?.evidence?.kind}) naming the cell ${rx},${ry},${rz}`);
    await cmd(`/setblock ${rx} ${ry} ${rz} ${was}`);
    const [fx2, fy2, fz2] = hz(fitD);
    await cmd(`/setblock ${fx2} ${fy2} ${fz2} minecraft:${kind}`);
    const c2 = await checkHill(f);
    const a2 = c2.check?.parts?.find((a) => a.part === 'bore');
    res.fits = { at: [fx2, fy2, fz2], class: a2?.class ?? null };
    check(a2?.class === 'fits' && c2.check.artifactSha, `item 4 (hill): the same ${kind} ${fitD} from the bore: fits`);
    if (c2.check?.artifactSha) {
      const r = await call('dev.region.realiseApproved', { sha: c2.check.artifactSha }, 300_000);
      const st = await L.waitRegion(r.region, 3_600_000);
      res.state = st.view.state;
      await sleep(120_000);
      // the void and cut after a 2-minute stand: dry (a dump over the bore's box)
      const g = c2.check.parts.find((a) => a.part === 'bore').geometry.tunnels[0];
      const box = [Math.min(g.from[0], g.to[0]) - 1, Math.min(g.from[1], g.to[1]), zl - 3, Math.max(g.from[0], g.to[0]) + 1, Math.max(g.from[1], g.to[1]) + 6, zl + 3];
      const { decodeArwd } = await imp('lib/region/vworld.mjs');
      const file = path.join(OUT, `hill-${kind}-stand.arwd.gz`);
      await call('dev.region.dump', { box, file }, 600_000);
      const d = await decodeArwd(fs.readFileSync(file));
      let wet = 0;
      for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = zl - 1; z <= zl + 1; z++) {
        const s = String(d.palette[d.cells[d.at(x, y, z)]] ?? '');
        if (/^minecraft:(water|lava)/.test(s) || /waterlogged=true/.test(s)) wet++;
      }
      res.wetInVoid = wet;
      check(st.view.state === 'PLACED' && wet === 0, `item 4 (hill): realised (${st.view.state}); after a 2-minute stand 0 fluid cells inside the void or cut (${wet}) with the ${kind} ${fitD} from it`);
    }
    await leaveWorld();
    return res;
  };
  out.water = await fluidTest('water', 2, 3, 'G6B T3b Hill Water');
  out.lava = await fluidTest('lava', 1, 3, 'G6B T3b Hill Lava');

  // ---- C: item 6 (stale rock), then the realise with neither (items 2, 3, 9 natural)
  await L.fresh('G6B T3b Hill Stale', BASE);
  await L.setRules('exact'); // (stricter than K1b's natural round: no random ticks, no spawns, so nothing grows or grazes near the bore)
  await at();
  const c3 = await checkHill(f);
  const sha = c3.check?.artifactSha;
  out.stale = { sha };
  if (!sha) throw new Error('the hill check gave no artifact');
  // a player's mine: one shell cell (the bore's south wall, mid, one over the floor) to air
  const [sx, sy, sz] = [mid, midFloor + 1, zl + 2];
  const wasS = await stateAt(sx, sy, sz);
  await cmd(`/setblock ${sx} ${sy} ${sz} minecraft:air`);
  const s1 = await call('dev.region.realiseApproved', { sha }, 300_000);
  out.stale.mine = { refused: s1.refused ?? null, reason: s1.reason ?? null, message: s1.message ?? s1.refused ?? null };
  const msg1 = JSON.stringify(s1);
  check(/ARTIFACT_STALE/.test(msg1) && /tunnel bore/.test(msg1) && msg1.includes(`(${sx}, ${sy}, ${sz})`), `item 6 (hill): a shell cell mined (${sx},${sy},${sz}): realiseApproved ARTIFACT_STALE naming the tunnel and the cell (${String(s1.message ?? s1.refused ?? msg1).slice(0, 200)})`);
  // Steward's one retry: checked again, the mined cell is sealed and the tunnel fits
  const c4 = await checkHill(f);
  out.stale.recheck = { overall: c4.check?.overall ?? null, lined: c4.check?.parts?.[0]?.geometry?.tunnels?.[0]?.lined ?? null, sha: c4.check?.artifactSha ?? null };
  check(c4.check?.overall === 'READY' && c4.check.artifactSha !== sha, `item 6 (hill): checked again after the mine (plan v1's one retry): READY with a new artifact (the cave cell sealed: lined ${out.stale.recheck.lined} vs ${out.check.tunnel?.lined})`);
  await cmd(`/setblock ${sx} ${sy} ${sz} ${wasS}`);
  // water 2 from the bore
  const [wx, wy, wz] = hz(2);
  const wasW = await stateAt(wx, wy, wz);
  await cmd(`/setblock ${wx} ${wy} ${wz} minecraft:water`);
  const s2 = await call('dev.region.realiseApproved', { sha }, 300_000);
  const msg2 = JSON.stringify(s2);
  out.stale.water = { message: s2.message ?? s2.refused ?? msg2 };
  check(/ARTIFACT_STALE/.test(msg2) && /tunnel bore/.test(msg2) && msg2.includes(`(${wx}, ${wy}, ${wz})`), `item 6 (hill): water set 2 from the bore: realiseApproved ARTIFACT_STALE naming the tunnel and the cell (${String(s2.message ?? s2.refused ?? msg2).slice(0, 200)})`);
  await cmd(`/setblock ${wx} ${wy} ${wz} ${wasW}`);
  // with neither: it realises (and is re-read: items 2, 3, 9)
  const dir3 = sideDir(c3.check.checkId);
  const box = await boxOf(dir3, f.claim);
  const rr = await realiseAndRead('hill', { planDir: dir3, claim: f.claim, box, start: async () => {
    const s3 = await call('dev.region.realiseApproved', { sha }, 300_000);
    check(!!s3.region, `item 6 (hill): with neither change, realiseApproved realises the approved artifact (${s3.region ?? JSON.stringify(s3).slice(0, 200)})`);
    return s3.region;
  }, standMs: 120_000 });
  out.realise = { ...rr.realise, falling: rr.falling };
  out.item2 = await item2('hill', rr.R);
  out.item3 = await item3('hill', rr.R);
  out.item9 = await item9('hill', { region: rr.realise.region, box, snapF: rr.snapF, meta: rr.R.meta, flat: false });
  await leaveWorld();

  // ---- D: load "generate": the hill's corridor never generated (a fresh copy, the bot at spawn)
  await L.fresh('G6B T3b Hill Gen', BASE);
  await L.setRules('exact');
  await tp(0.5, 200, 0.5);
  const g1 = await checkHill(f);
  const ga = g1.check?.parts?.find((a) => a.part === 'bore');
  out.generate = { loaded: { overall: g1.check?.overall ?? null, class: ga?.class ?? null, code: ga?.reasons?.[0]?.code ?? null, notes: g1.check?.notes ?? null } };
  check(g1.check?.overall === 'INCOMPLETE' && ga?.class === 'incomplete' && ga.reasons[0].code === 'VOLUME', `load (hill): the corridor not loaded or generated, load "loaded": incomplete VOLUME, overall INCOMPLETE (${json(out.generate.loaded)})`);
  const g2 = await checkHill(f, { load: 'generate' });
  const gb = g2.check?.parts?.find((a) => a.part === 'bore');
  out.generate.generate = { overall: g2.check?.overall ?? null, class: gb?.class ?? null, volumePass: g2.volumePass ?? null, ms: g2.ms ?? null };
  check(g2.check?.overall === 'READY' && gb?.class === 'fits', `load (hill): the same check with load "generate" prepares and generates the corridor: fits, READY (${json(out.generate.generate)})`);
  // past the cap: ends a thousand apart over the hill (a corridor over 4,000,000 cells), even with "generate"
  const cx = Math.floor((f.claim[0] + f.claim[2]) / 2);
  const capClaim = [cx - 511, zl - 40, cx + 512, zl + 40];
  const capPlan = { schemaVersion: 'plan/0', planId: 't3b_cap', connectors: [{ id: 'far', kind: 'tunnel', approach: 32, width: 5, from: { anchor: 'far_w' }, to: { anchor: 'far_e' } }] };
  const g3 = await call('dev.region.checkPlan', { plan: capPlan, claim: capClaim, owner: OWNER, anchors: { far_w: [cx - 500, 30, zl], far_e: [cx + 500, 30, zl] }, load: 'generate' }, 900_000);
  const gc = g3.check?.parts?.find((a) => a.part === 'far');
  out.generate.cap = { overall: g3.check?.overall ?? null, class: gc?.class ?? null, reasons: gc?.reasons ?? null };
  check(gc?.class === 'incomplete' && gc.reasons[0].code === 'VOLUME' && gc.reasons[0].evidence?.cap === 'edgeCells', `load (hill): ends 1000 apart (approach 32, width 5) with load "generate": still incomplete VOLUME past the per-edge cap (${json(gc?.reasons?.[0]?.evidence ?? null)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ pin (the natural hill)

steps.pin = async () => {
  await ensure();
  const FS = await import('./find-site.mjs');
  const { surveyApi } = await imp('lib/region/survey.mjs');
  const { pickLine } = await imp('lib/connectors/crossingsTunnels.mjs');
  const { FLAG_TREE, FLAG_WATER, FLAG_LAVA } = await imp('lib/region/pack.mjs');
  const { decodeArvx, classAt } = await imp('lib/region/volume.mjs');
  const site = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  const needs = site.needs;
  await L.fresh('G6B T3b Pin', BASE);
  await L.setRules('default');
  const [w, d] = needs.size;
  const out = { tried: [] };
  let found = null;
  const [c0x, c0z] = needs.center ?? [0, 0];
  for (const [ox0, oz0] of FS.candidates(needs.candidates, needs.step)) {
    const ox = ox0 + c0x, oz = oz0 + c0z;
    const x0 = ox - Math.floor(w / 2), z0 = oz - Math.floor(d / 2), x1 = x0 + w - 1, z1 = z0 + d - 1;
    await tp(ox + 0.5, 220, oz + 0.5);
    const r = await cmd(`/apitest survey ${x0} ${z0} ${x1} ${z1} 4 bounded:64`);
    const key = (r.messages ?? []).find((m) => m.startsWith('{'));
    let sample = key ? JSON.parse(key) : null;
    for (let i = 0; sample?.pending && i < 600; i++) {
      const g = await cmd(`/apitest get ${sample.pending}`);
      const line = (g.messages ?? []).find((m) => m.startsWith('{'));
      const v = line ? JSON.parse(line) : null;
      if (v?.value) { sample = v.value; break; }
      await sleep(1000);
    }
    if (!sample?.summary) continue;
    const s = FS.parseSummary(sample.summary);
    const sc = FS.score(s, needs);
    const row = { claim: [x0, z0, x1, z1], relief: s.max - s.min, water: s.water, trees: s.trees, biomes: s.biomes, score: sc };
    out.tried.push(row);
    log(`  candidate ${x0},${z0}: relief ${row.relief}, water ${s.water}%, trees ${s.trees}% -> ${sc}`);
    if (sc === null) continue;
    // a hill of rock, not of sand: a desert's or a beach's sand is no site-solid (its bore would be short), a badlands' red sand likewise
    const sandy = Object.entries(s.biomes).filter(([b]) => /desert|beach|badlands/.test(b)).reduce((a, [, v]) => a + v, 0);
    if (sandy > 20) { log(`  candidate ${x0},${z0}: sandy ${sandy}%`); continue; }
    // the line: the claim's survey at resolution 1, a surface bore of 32-60 cells between low ends
    const file = path.join(OUT, `pin-${x0}_${z0}.arsv`);
    await call('dev.region.survey', { claim: [x0, z0, x1, z1], surveyLoad: 'bounded:256', file }, 900_000);
    const claim = { minX: x0, minZ: z0, maxX: x1, maxZ: z1, minY: -64, maxY: 319 };
    const S = surveyApi(fs.readFileSync(file), claim);
    const line = pickLine(S, [x0, z0, x1, z1], 3, 3);
    row.line = line ? { a: line.a, b: line.b, L: line.L, run: line.run } : null;
    log(`  candidate ${x0},${z0}: line ${json(row.line)}`);
    if (!line) continue;
    // the corridor's columns: no tree and no water or lava within reach of the bore (the line +- 6 along z, its x span +- 6)
    let trees = 0, wet = 0;
    for (let z = line.a[2] - 6; z <= line.a[2] + 6; z++) for (let x = line.a[0] - 6; x <= line.b[0] + 6; x++) {
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const fl = S.columns.flags[(x - S.columns.minX) + (z - S.columns.minZ) * S.columns.width];
      if (fl & FLAG_TREE) trees++;
      if (fl & (FLAG_WATER | FLAG_LAVA)) wet++;
    }
    row.corridor = { trees, wet };
    log(`  candidate ${x0},${z0}: corridor trees ${trees}, water ${wet}`);
    if (trees || wet) continue;
    // crossings_demo's hill variant on the claim (its two-plan flow reads the corridor's volume): one tunnel, its checks clean
    const p = await L.plan('crossings_demo', [x0, z0, x1, z1], { params: { variant: 'hill' }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
    const meta = JSON.parse(fs.readFileSync(path.join(sideDir(p.planId), 'meta.json'), 'utf8'));
    const t = (meta.tunnels ?? [])[0];
    const bad = (p.report?.findings ?? []).filter((q) => /^M(3|4)(:tunnel|:gravity)/.test(q.rule));
    row.plan = { planId: p.planId, tunnels: (meta.tunnels ?? []).length, bore: t ? t.bore.filter(Boolean).length : 0, findings: bad.map((q) => q.rule), notes: (p.notes ?? []).slice(-2) };
    log(`  candidate ${x0},${z0}: crossings_demo hill ${json(row.plan)}`);
    // at least 2 cover over a 32-cell bore by the frozen volume's rock (§10's pin), not only by the surface
    if (!t || bad.length || row.plan.bore < 32) continue;
    // no fluid within 4 of the void, from the plan's own frozen volume
    const ir = JSON.parse(fs.readFileSync(path.join(sideDir(p.planId), 'ir.json'), 'utf8'));
    const vb = Object.values(ir.volumes ?? {})[0];
    const vol = vb ? decodeArvx(fs.readFileSync(path.join(sideDir(p.planId), 'blobs', `${ir.blobs[vb.blob].sha}.bin`))) : null;
    let near = 0;
    if (vol) for (const [x, y, z] of t.voids) for (let ax = -4; ax <= 4 && !near; ax++) for (let ay = -4; ay <= 4 && !near; ay++) for (let az = -4; az <= 4 && !near; az++) if ([6, 7, 4].includes(classAt(vol, x + ax, y + ay, z + az))) near++;
    row.fluid4 = vol ? near : null;
    log(`  candidate ${x0},${z0}: fluid within 4 of the void ${row.fluid4}`);
    if (!vol || near) continue;
    found = { claim: [x0, z0, x1, z1], line: { a: line.a, b: line.b, L: line.L, run: line.run }, tunnel: { from: t.from, to: t.to, length: t.length, bore: t.bore.filter(Boolean).length, coverMin: Math.min(...t.cover.filter((c, i) => t.bore[i])) }, stats: { relief: row.relief, water: s.water, trees: s.trees, biomes: s.biomes, min: s.min, max: s.max }, volumeSha: vol.sha };
    break;
  }
  check(!!found, `pin: a hill with a straight line of 32+ bore cells under 2+ cover, no tree or water in the corridor, crossings_demo's hill tunnel clean, no fluid within 4 (${found ? `${json(found.claim)}, line ${json(found.line)}` : `none of ${out.tried.length}`})`);
  if (found) {
    site.fixture = { ...found, foundBy: `tools/gate6ct3b.mjs pin @ seed ${SEED}`, worldSeed: SEED, tried: out.tried.length };
    fs.writeFileSync(SITE_FILE, `${JSON.stringify(site, null, 2)}\n`);
  }
  out.found = found;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

async function shot(name, eye, lookAt) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: lookAt[0], y: lookAt[1], z: lookAt[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `t3b_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at: lookAt, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [] };
  await L.fresh('G6B T3b Look', FLAT);
  await L.setRules('exact');
  await cmd('/time set 13000'); // dusk: the lanterns read against the evening
  await cmd('/weather clear');
  await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 100, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
  const p = await L.plan('crossings_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const meta = JSON.parse(fs.readFileSync(path.join(sideDir(p.planId), 'meta.json'), 'utf8'));
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3_600_000);
  out.flat = { planId: p.planId, state: st.view.state, tunnels: (meta.tunnels ?? []).map((t) => ({ id: t.id, from: t.from, to: t.to, width: t.width })) };
  const t = (meta.tunnels ?? []).find((q) => q.width === 3) ?? meta.tunnels?.[0];
  if (t) {
    const [x, y, z] = t.from;
    const portal = t.portals?.[0];
    const px = portal ? portal.cells.find((c) => c[3] === 'lintel')[0] : x + 3;
    out.shots.push(await shot('portal', [x - 9.5, y + 4, z + 4.5], [px + 0.5, y + 2, z + 0.5]));
    out.shots.push(await shot('portal_wide', [x - 22.5, y + 14, z + 14.5], [px + 6, y + 4, z]));
    out.shots.push(await shot('interior', [px + 1.5, y + 2.6, z + 0.5], [px + 30.5, y + 1.5, z + 0.5]));
    const n = (meta.tunnels ?? []).find((q) => q.width === 1);
    if (n) out.shots.push(await shot('narrow', [n.from[0] - 6.5, n.from[1] + 3, n.from[2] + 2.5], [n.from[0] + 6.5, n.from[1] + 1.5, n.from[2] + 0.5]));
  }
  await call('dev.release', {}).catch(() => null);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['pin', 'unit', 'ingame', 'natural', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-T3b (tunnels)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ct3b.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
