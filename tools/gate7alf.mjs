#!/usr/bin/env node
// Phase 7a slice LF gate (docs/CONTRACT.md "Phase 7a slice LF: lifts" §9) against a dev client or the headless server of the LF run
// worktree (`../architect-mc-LF-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8980 (sidecar) /
// 8981 (DevBridge) by default (the runner sets its own; LF's range is 8980-8989). $0: no Claude call anywhere.
//
//   node tools/gate7alf.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (lf-unit)               items 2, 3 (kit), 9 (Java), 11 offline: kit/test/lf.test.mjs (the tower: two layers, the airlock, the
//                                       rim's rails, a light every 6, the down column; the single breach reaching nothing outside;
//                                       v7a_lf_cliff fits with its body's bubble set, the IR kind, the crossing, the BOM, the checker clean,
//                                       the kit player up and back down, the villager not; the refusals NO_CLIMB, SPAN 65, ANCHOR, HEADROOM,
//                                       MOVER with their wouldFits; KC; the broken variants; Steward's two lifts and the gap tables; the
//                                       catalogue flip; determinism; lifts_demo flat themed in three bibles), the foundation's, P0's, H's,
//                                       KC's, T2's, CW's, RK's and the vocabulary's tests; the structure lint's p0:lf and p0:valid; the
//                                       catalogue diff; the Java (StillOursLFTest, RegionFluidsLFTest, ApiLFTest and H's fluid tests);
//                                       api-compat against the 0.47.0 and 0.45.0 apitest jars and mod surfaces
//     unchanged (lf-unit)               item 3: every committed plan fixture without a lift plans as on the merge base (answers, IR, the
//                                       first plan; tools/lib/gate7a-kit.mjs), but LF's named movers (LF_MOVED)
//     probe     (lf-probe)              item 1 (headless, command-built on a flat world): water poured over soul sand and magma becomes the
//                                       columns; a written bubble_column over its base stays; a door holds a column open and shut; vanilla's
//                                       drowned spawn rules in a river biome pass in a dark column and never in a lit one; the bot player
//                                       rides up 8, 30 and 48 (launched over the rim, stepping onto the top cell) and down a down column
//                                       out through its airlock (dev.lift.ride)
//     ingame    (lf-ingame)             items 4-6, 8 on flat worlds (headless): lifts_demo flat (faces 8 and 48 raised in stage ground, the
//                                       high one with a down column) planned, realised (PLACED only once the bodies settled), the census
//                                       (every shaft cell a bubble column of its drag, 0 fluid elsewhere in the watch box), re-read from
//                                       the dumps (M10:lift 0, M5:lift 0, realised == virtual strict), the kit movers (the player up and
//                                       down, the villager not), the ride shown 5 times each way, a 2-minute stand at default rules (0
//                                       fluid outside the shafts), Regions.remove E-flat 0; v7a_lf_cliff (plan v1's shape) on its terrain
//                                       by commands: Regions.checkPlan then realiseApproved, the census, the rides, the breach probe (an
//                                       inner shell cell set to air: the water stops at the outer layer), removed (E-flat 0 but the breached
//                                       cell's own record)
//     survival  (lf-survival)           item 10 (RS merged): v7a_lf_cliff in survival: checked in survival, fed from a stockpile, built (the
//                                       shell bottom up, the column after its last paid cell); the bills equal the check's
//                                       cost.survival.bom; the world equal to its INSTANT twin; the census; removed E-flat 0
//     natural   (lf-natural)            items 4, 5, 8 on CW's pinned cliff (scenarios/sites/cliff_face.json, a fresh copy of the seed world,
//                                       exact rules): lifts_demo natural (the survey's best face), realised, the census, re-read (the cells
//                                       the plan wrote: tree and water drift elsewhere recorded, not judged), the kit movers, the removal's
//                                       E-normal (0 unclassified within 6 of the written cells)
//     look      (lf-look)               item 12 (client, recorded not judged: N-LF-1): lifts_demo flat in three bibles: the tower from the
//                                       approach (the entry), the shaft from inside its airlock, the top landing (the exit), the tower's side
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-lf/<step>.json in the main checkout (GATE7ALF_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-LF-run');
process.env.GATE6B_OUT = process.env.GATE7ALF_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-lf');
process.env.GATE6B_SIDECAR_PORT ??= '8980';
process.env.GATE6B_DEV_PORT ??= '8981';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:lf';
const FLAT_CLAIM = [6000, 6000, 6199, 6111];
const SITE_FILE = path.join(root, 'scenarios', 'sites', 'cliff_face.json');
const JARS = path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'gate7a-lf', 'jars');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (x, y, z) => `${x},${y},${z}`;
const RIDES = 5;

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice LF is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C LF Lobby', { backend: 'sim' });
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
  out.lf = kitOnce(['kit/test/lf.test.mjs']);
  check(out.lf.code === 0 && out.lf.fail === 0 && out.lf.pass >= 10, `items 2, 3, 5, 6, 7, 11 (kit): the tower (two layers on every open side, the airlock's two doors, the rim's rails, a light every 6, the down column), the single breach reaching nothing outside, v7a_lf_cliff (fits; the body's bubble set and the IR kind bubbleColumns; the crossing, the graph edge, the BOM, the siteplan row; M10:lift, M25, M5 clean; the kit player up the column and back down the down column, the villager not), the refusals NO_CLIMB (a path that fits alone), SPAN 65, ANCHOR, HEADROOM, MOVER (a stair that fits alone), KC (a pond at the foot kept clear, M25:clear 0), the broken variants (one layer, one door, no light), Steward's two lifts NO_CLIMB with the gap tables, the catalogue flip, determinism, lifts_demo flat (the movers, rails joined and on something, every block themed in three bibles): ${out.lf.pass} pass, ${out.lf.fail} fail`, out.lf.failing);
  out.found = kitOnce(['kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/h-core.test.mjs', 'kit/test/h-a.test.mjs', 'kit/test/hy-core.test.mjs', 'kit/test/kc.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/catwalk-cw.test.mjs', 'kit/test/rk.test.mjs', 'kit/test/cl.test.mjs', 'kit/test/vocab-rules.test.mjs', 'kit/test/forms-f3-coral.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/catalogue-since.test.mjs', 'kit/test/catalogue-c38.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `items 3, 11 (kit): the foundation's tests, P0 (connector.lift supported, e15 off it), H's and HY's cores (bodies unchanged without a bubble set), KC, T2's routes, CW's, RK's and CL's rows (the route pass's commit change inert for them), the vocabulary (M27:convert unchanged but a lift's own base), the coral's decor, the realise lint, the catalogue: ${out.found.pass} pass, ${out.found.fail} fail`, out.found.failing);
  const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'p0:lf,p0:valid/1,p0:valid/2,p0:valid/3,p0:valid/4,p0:valid/5,p0:valid/6,p0:h/1,p0:h/2,p0:kc'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-20);
  check(lint.status === 0, 'items 2, 6 (lint): the structure lint\'s p0:lf (the refusal set as expected, the broken variants caught by M10:lift and M5:lift, S-THEME clean) and p0:valid (v7a_lf_cliff clean), H\'s and KC\'s cases unchanged', out.lint);
  const d = spawnSync(process.execPath, ['tools/plan-catalogue-diff.mjs', 'kit/test/fixtures/plan/catalogue-pre7a.json', 'kit/schemas/plan-catalogue.golden.json'], { cwd: root, encoding: 'utf8' });
  out.diff = `${d.stdout}${d.stderr}`.trim();
  const flips = (/reserved -> supported: (.*)/.exec(out.diff) ?? [])[1] ?? '';
  check(d.status === 0 && flips.split(', ').includes('connector.lift') && /retired: none/.test(out.diff) && /REMOVED \(never allowed\): none/.test(out.diff), `item 11: tools/plan-catalogue-diff.mjs pre-7a -> the golden flips connector.lift reserved -> supported (with the other merged 7a slices'): ${flips}; nothing retired or removed`, out.diff.split('\n'));
  // the slice's Java: the StillOurs row (the verifier re-runs it: item 9), the fluids stage's bubble set, the census's reading, the IR kind,
  // the feature; H's fluid tests unchanged
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const gr = spawnSync('./gradlew', ['test', '--offline', '--tests', '*StillOursLFTest', '--tests', '*RegionFluidsLFTest', '--tests', '*ApiLFTest', '--tests', '*StillOursFluidsTest', '--tests', '*StillOursF3Test', '--tests', 'dev.larattalabs.architect.region.RegionFluids*', '--tests', '*PlanStaleTest', '--tests', '*UmtPropertiesTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: gr.status, tail: `${gr.stdout}${gr.stderr}`.trim().split('\n').slice(-8) };
  check(gr.status === 0, 'items 7, 9 (Java): StillOursLFTest (a written bubble column holds as any column, a source or air; a source holds as a column; a player\'s block does not; the journal\'s holds and same agree), RegionFluidsLFTest (the bubble set, open at the gate, the column\'s fluid a source, the IR kind appended), ApiLFTest (feature liftConnectors), H\'s and F3\'s fluid and StillOurs tests, PlanStaleTest, UMT', out.java.tail);
  // api-compat: the 0.47.0 and 0.45.0 apitest jars and mod surfaces (main's latest releases; copied into the evidence dir from their tag builds)
  out.apicompat = [];
  for (const [label, args] of [['0.47.0 apitest', [path.join(JARS, 'architect_apitest-0.47.0+nosidecar.jar')]], ['0.45.0 apitest', [path.join(JARS, 'architect_apitest-0.45.0+nosidecar.jar')]],
    ['0.47.0 surface', ['--surface', path.join(JARS, 'architect_mc-0.47.0+nosidecar.jar')]], ['0.45.0 surface', ['--surface', path.join(JARS, 'architect_mc-0.45.0+nosidecar.jar')]]]) {
    const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
    const tail = `${ac.stdout}${ac.stderr}`.trim().split('\n').slice(-3);
    out.apicompat.push({ label, code: ac.status, tail });
    check(ac.status === 0 && tail.some((l) => /every referenced api member exists/.test(l)), `item 11: api-compat against the ${label} (a feature, an IR kind and a StillOurs row only: no record, method or enum value)`, tail);
  }
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const { LF_MOVED } = await import('./lib/lf-norm.mjs');
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'LF', except: LF_MOVED, mergedIf: 'kit/lib/region/checkLifts.mjs' });
  fs.writeFileSync(path.join(OUT, 'lf-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

// ------------------------------------------------------------------ in game helpers

/** One cell's block state (a one-cell dump). */
async function stateAt(x, y, z) {
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const f = path.join(OUT, `cell-${x}_${y}_${z}.arwd.gz`);
  await call('dev.region.dump', { box: [x, y, z, x, y, z], file: f }, 60_000);
  const d = await decodeArwd(fs.readFileSync(f));
  return d.palette[d.cells[d.at(x, y, z)]];
}

/** A plan dir's lift bodies (the IR's fluid ops with a bubble set): cells, bubble states, shell, watch. */
function liftBodies(ir) {
  const cellsOf = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };
  const out = [];
  for (const p of ir.parts) for (const o of p.ops ?? []) {
    if (o.op !== 'fluid' || !Array.isArray(o.bubble) || !o.bubble.length) continue;
    const bubble = new Map();
    for (const d of o.bubble) for (const c of cellsOf(d.cells)) bubble.set(k3(...c), d.state);
    out.push({ id: o.id, part: o.part, cells: cellsOf(o.cells), bubble, shell: cellsOf(o.shell), watch: cellsOf(o.watch), spill: cellsOf(o.spill) });
  }
  return out;
}
const boxAround = (cells, g = 2) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of cells) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
  return [b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g];
};

/**
 * A lift body's census (§3.3, §9 item 4): every shaft cell a bubble column of its drag (its state exactly), 0 other fluid in its watch box
 * (the cells, shell and watch grown by 2) that was not there before (`before`: positions holding fluid then) and is not `allow`ed.
 */
async function census(body, before = new Set(), allow = new Set()) {
  const box = boxAround([...body.cells, ...body.shell, ...body.watch], 2);
  const c = await call('dev.fluid.census', { box }, 120_000);
  const now = new Map(c.fluids.map(([x, y, z, s]) => [k3(x, y, z), s]));
  const wrong = [], outside = [];
  let columns = 0;
  for (const [k, want] of body.bubble) { const s = now.get(k); if (s !== want) wrong.push([k, s ?? 'none', want]); else columns++; }
  for (const [k, s] of now) if (!body.bubble.has(k) && !before.has(k) && !allow.has(k)) outside.push([k, s]);
  return { ok: !wrong.length && !outside.length, columns, cells: body.bubble.size, wrong: wrong.slice(0, 12), outside: outside.slice(0, 12), outsideCount: outside.length, ticks: c.ticks.length, box };
}

/** The fluid cells of a box now (positions), for a census's `before`. */
async function fluidsIn(box) {
  const c = await call('dev.fluid.census', { box }, 120_000);
  return new Set(c.fluids.map(([x, y, z]) => k3(x, y, z)));
}

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

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs, volumes: await volumesOf(planDir, ir) });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep, vw };
}

/** Item 5's geometry over the realised world: M10:lift's rows re-read, M5:lift; the kit movers per lift (the player up and down, not the villager). */
async function item5(tag, { meta, world, rep }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.lifts?.per ?? [];
  const recs = meta.lifts ?? [];
  const out = { lifts: per };
  check(per.length === recs.length && per.length >= 1, `item 5 (${tag}): ${per.length} lift(s) re-read from the realised world (${per.map((q) => `rise ${q.rise}${q.down ? ' with a down column' : ''}`).join(', ')})`);
  check(per.every((q) => q.columnBad === 0 && q.base === (q.down ? 2 : 1)), `item 4/5 (${tag}): every shaft cell a bubble column of its drag over its base (soul sand, magma) (${per.map((q) => `${q.column - q.columnBad}/${q.column} column, ${q.base} base`).join('; ')})`);
  check(per.every((q) => q.shellBad === 0 && q.doorBad === 0 && q.railBad === 0 && q.headBad === 0), `item 5 (${tag}): the shell 2 thick at every y, both airlock doors, the rim's rails, 3 clear over the top (M10:lift 0: ${per.map((q) => `${q.shellBad} shell, ${q.doorBad} door, ${q.railBad} rail, ${q.headBad} head`).join('; ')})`);
  check(per.every((q) => q.darkShaft === 0 && q.darkWalk === 0) && !rep.findings.some((f) => f.rule === 'M5:lift' || f.rule === 'M10:lift'), `item 5 (${tag}): no shaft cell at block light 0 (drowned), no dark walk cell at the foot or the top (M5:lift 0; the realised light: ${per.map((q) => `${q.darkShaft} dark shaft, ${q.darkWalk} dark walk`).join('; ')})`);
  const m3 = rep.findings.filter((f) => /^M3/.test(f.rule) && recs.some((q) => q.part === f.part));
  check(!m3.length, `item 5 (${tag}): M3 0 in the lift parts (${m3.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  out.movers = {};
  for (const q of recs) {
    const foot = [q.foot[0], q.foot[1] + 1, q.foot[2]], top = [q.top[0], q.top[1] + 1, q.top[2]];
    const up = nodeReached(walkGraph(world, [foot], { mover: 'player' }), top);
    const vil = nodeReached(walkGraph(world, [foot], { mover: 'villager' }), top);
    const down = q.downTop ? nodeReached(walkGraph(world, [[q.downTop[0], q.downTop[1] + 1, q.downTop[2]]], { mover: 'player' }), [q.downFoot[0], q.downFoot[1] + 1, q.downFoot[2]]) : null;
    out.movers[q.id] = { up, down, villager: vil };
  }
  check(Object.values(out.movers).every((v) => v.up && v.down !== false && !v.villager), `item 5 (${tag}, the hard bar): the kit player from the approach through the airlock to the top cell, and back by the down column where there is one; the kit villager refused (${json(out.movers)})`);
  return out;
}

/** The P2 SMOKE row: realised == virtual per writer kind (strict on a flat world). */
async function smoke(tag, planDir, after, before, strict) {
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
  check(rv.differ === 0 || !strict, `item 4/P2 SMOKE (${tag}${strict ? ', strict' : ''}): realised == virtual, ${rv.differ} of ${rv.written} differ: ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  return { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
}

/** The ride (dev.lift.ride): `n` rides up every lift (onto its top cell) and down every down column (out to its approach). */
async function rides(tag, recs, n = RIDES) {
  const out = {};
  for (const q of recs) {
    for (const sh of q.shafts) {
      const up = sh.kind === 'up';
      const [dx, dz] = q.dir, [rx, rz] = [-dz, dx];
      const exit = up ? [sh.top[0], sh.top[1] + 1, sh.top[2]] : [sh.approach[0], sh.approach[1] + 1, sh.approach[2]];
      const doors = sh.doors.map(([x, z]) => [x, q.y0 + 1, z]);
      const runs = [];
      for (let i = 0; i < n; i++) {
        const r = await call('dev.lift.ride', { x: sh.col[0], z: sh.col[1], y0: q.y0, yT: q.yT, drag: !up, face: [dx, dz], exit, ...(up ? {} : { doors }) }, 120_000).catch((e) => ({ rode: false, error: String(e?.message ?? e) }));
        runs.push({ ok: !!r.rode, reached: r.reached ?? null, exited: r.exited ?? null, maxY: r.maxY ?? null, minY: r.minY ?? null, ticks: r.ticks ?? null, exitAt: r.exitAt ?? null, ...(r.error ? { error: r.error } : {}) });
      }
      void rx; void rz;
      out[`${q.id}:${sh.kind}`] = { rise: q.rise, runs, ok: runs.filter((r) => r.ok).length };
    }
  }
  check(Object.values(out).every((v) => v.ok === n), `item 1/5 (${tag}, shown): the bot player rides each column ${n} times (dev.lift.ride, vanilla's travel and bubble column push): ${Object.entries(out).map(([k, v]) => `${k} rise ${v.rise}: ${v.ok}/${n}`).join('; ')}`, Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.runs.filter((r) => !r.ok).slice(0, 2)])));
  return out;
}

/**
 * The breach probe (§9 item 6): one inner shell cell of the column (a lateral cell at mid-height) set to air; after a settle the water
 * stops at the outer layer: no fluid outside the shaft but the breached cell. The cell is put back as it was (the water there replaced).
 */
async function breach(tag, rec, body) {
  const up = rec.shafts.find((s) => s.kind === 'up');
  const [dx, dz] = rec.dir, [rx, rz] = [-dz, dx];
  const side = rec.down ? (rec.side === 'left' ? 1 : -1) : -1; // (never the shared layer)
  const y = rec.y0 + Math.floor(rec.rise / 2) + 1 + (rec.lights.some((l) => l[1] === rec.y0 + Math.floor(rec.rise / 2) + 1) ? 1 : 0);
  const cell = [up.col[0] + rx * side, y, up.col[1] + rz * side];
  const was = await stateAt(...cell);
  const before = await fluidsIn(boxAround([...body.cells, ...body.shell], 3));
  await cmd(`/setblock ${cell.join(' ')} minecraft:air`);
  await L.gameWait(10_000, { real: sleep, label: `lf ${tag} breach, 200 ticks` });
  const c = await census(body, before, new Set([k3(...cell)]));
  const inCell = await stateAt(...cell);
  await cmd(`/setblock ${cell.join(' ')} ${was}`);
  await L.settle(3000);
  const out = { cell, was, inCell, outside: c.outside, outsideCount: c.outsideCount, columns: c.columns };
  check(c.outsideCount === 0, `item 6 (${tag}): a breach (the inner shell cell ${cell.join(',')} set to air): the water stops at the outer layer (the breached cell holds ${inCell}; ${c.outsideCount} fluid cell(s) outside the shaft beyond it)`, c.outside);
  return out;
}

/** Plan lifts_demo, realise (PLACED once the bodies settled), census, re-read, movers, rides, a stand, remove. */
async function demoRun(tag, claim, { kind, params = {}, standMs = 60_000 }) {
  const out = { claim, kind };
  const flat = kind === 'flat';
  await tp((claim[0] + claim[2]) / 2, flat ? -20 : 200, (claim[1] + claim[3]) / 2);
  const p = await L.plan('lifts_demo', claim, { params: { variant: kind, ...params }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const planDir = sideDir(p.planId);
  out.plan = { planId: p.planId, irSha: p.irSha, notes: (p.notes ?? []).slice(-2) };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const recs = meta.lifts ?? [];
  check(recs.length >= (flat ? 2 : 1), `${tag}: lifts_demo (${kind}) planned ${recs.length} lift(s) (${recs.map((q) => `rise ${q.rise}${q.down ? ' with a down column' : ''}`).join('; ')}; ${out.plan.notes.join(' / ')})`);
  if (!recs.length) return out;
  out.lifts = recs.map((q) => ({ id: q.id, rise: q.rise, down: q.down, foot: q.foot, top: q.top }));
  const bodies = liftBodies(ir);
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const blobsP = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw: vP } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs: blobsP, volumes: await volumesOf(planDir, ir) });
  let y0 = Infinity, y1 = -Infinity;
  vP.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
  await tp((claim[0] + claim[2]) / 2, Math.min(319, y1 + 20), (claim[1] + claim[3]) / 2);
  await L.settle(flat ? 5000 : 60_000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  const fluidBefore = new Map();
  for (const b of bodies) fluidBefore.set(b.id, await fluidsIn(boxAround([...b.cells, ...b.shell, ...b.watch], 2)));
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED || s.waiting?.PLAYER_IN_BOX) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  const fst = await call('dev.fluid.state', { region }, 60_000).catch(() => null);
  out.fluids = fst;
  const bodyRows = Object.values(fst?.bodies ?? {});
  check(st.view.state === 'PLACED' && bodyRows.length === bodies.length && bodyRows.every((b) => b.state === 'settled'), `item 4 (${tag}): realised PLACED only once the lift bodies settled (${st.view.state}; ${bodyRows.map((b) => `${b.id ?? '?'} ${b.state}${b.settledAt != null ? ` in ${b.settledAt} ticks` : ''}`).join(', ') || json(fst).slice(0, 200)})`);
  out.census = {};
  for (const b of bodies) out.census[b.id] = await census(b, fluidBefore.get(b.id));
  check(Object.values(out.census).every((c) => c.ok), `item 4 (${tag}): the census exact: every shaft cell a bubble column of its drag, 0 fluid elsewhere in its watch box (${Object.entries(out.census).map(([k, c]) => `${k} ${c.columns}/${c.cells} columns, ${c.outsideCount} outside, ${c.wrong.length} wrong`).join('; ')})`, Object.values(out.census).flatMap((c) => [...c.wrong, ...c.outside]).slice(0, 12));
  // a stand (the world's exact rules: E-flat is judged after it; cliffRun stands at default rules)
  await L.gameWait(standMs, { real: sleep, label: `lf ${tag} stand` });
  out.stand = {};
  for (const b of bodies) out.stand[b.id] = await census(b, fluidBefore.get(b.id));
  check(Object.values(out.stand).every((c) => c.ok), `item 6 (${tag}): a ${standMs / 1000} s stand: still every column cell a column, 0 fluid outside the shafts (${Object.entries(out.stand).map(([k, c]) => `${k} ${c.columns}/${c.cells}, ${c.outsideCount} outside`).join('; ')})`);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, planDir, after, before, flat);
  await cmd('/kill @e[type=!minecraft:player]');
  out.rides = await rides(tag, R.meta.lifts ?? []);
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  for (let i = 0; i < 600; i++) { const s = await call('dev.region.state', { region }, 60_000).catch(() => null); if (!s?.view || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s.view.state)) break; await sleep(1000); }
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 8 (${tag}): Regions.remove by its owner restores the box exactly, the columns drained first, fluid cells compared exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored; journal ${out.realise.cells} cells written)`, out.exact.list.slice(0, 8));
  else {
    // (natural: judge the cells the plan wrote and 6 round them; tree and water drift elsewhere on the claim is recorded)
    const written = new Set();
    vP.eachWritten((x, y, z) => { written.add(k3(x, y, z)); });
    const near = (pos) => { const [x, y, z] = String(pos).split(/[ ,]+/).map(Number); for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -6; dz <= 6; dz++) if (written.has(k3(x + dx, y + dy, z + dz))) return true; return false; };
    const list = diff.list ?? [];
    const close = list.filter((m) => near(m.pos) && (m.class ?? 'none') === 'none');
    out.exact.near = { unclassified: close.length, sample: close.slice(0, 8), listed: list.length, truncated: list.length < diff.mismatches };
    check(rm.removed && close.length === 0, `item 8 (${tag}): the removal's E-normal: 0 unclassified mismatches within 6 of the ${written.size} written cells (${diff.mismatches} mismatches over the box, ${json(diff.classes ?? {})}: drift elsewhere recorded, not judged)`, close.slice(0, 8));
  }
  return out;
}

/** A fixture's check's plan dir (the sidecar's, by the check's id). */
function planDirOf(ck) {
  const id = ck.check?.checkId;
  return id && fs.existsSync(path.join(sideDir(id), 'meta.json')) ? sideDir(id) : null;
}

/**
 * v7a_lf_cliff (plan v1's shape) on its terrain by commands: Regions.checkPlan, realiseApproved (PLACED once settled), the census, the
 * movers, the rides, the breach probe, removed (E-flat 0 but the breached cell's own record).
 */
async function cliffRun(tag) {
  const out = { fixture: 'valid/v7a_lf_cliff.json' };
  const fx = G.fixture(ctx, 'valid/v7a_lf_cliff.json');
  // (plan v1's shape: the lift required, the path pending required false, a plan id)
  fx.plan = { ...fx.plan, planId: 'lf_cliff', connectors: fx.plan.connectors.map((c) => (c.kind === 'lift' ? { ...c, required: true } : { ...c, required: false })) };
  const s = await G.site(ctx, tag, fx, { creative: true });
  const W = s.W;
  await tp((W.claim[0] + W.claim[2]) / 2, 140, (W.claim[1] + W.claim[3]) / 2);
  const ck = await G.check(ctx, tag, s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'cliff_lift');
  out.check = { overall: ck.check?.overall ?? null, class: a?.class ?? null, lifts: a?.geometry?.lifts ?? null, bom: a?.cost?.bom ?? null };
  check(ck.check?.overall === 'READY' && a?.class === 'fits', `item 4 (${tag}): v7a_lf_cliff (plan v1's shape) through Regions.checkPlan: ${ck.check?.overall}, cliff_lift ${a?.class} (${json((a?.geometry?.lifts ?? []).map((q) => [q.rise, q.down, q.crossing]))})`);
  if (!ck.check?.artifactSha) return out;
  const planDir = planDirOf(ck);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const bodies = liftBodies(ir);
  const box = G.boxOf(W);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const pre = await G.snap(ctx, box, `lf-${tag}-pre`);
  const fluidBefore = new Map();
  for (const b of bodies) fluidBefore.set(b.id, await fluidsIn(boxAround([...b.cells, ...b.shell, ...b.watch], 2)));
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
  const fst = await call('dev.fluid.state', { region }, 60_000).catch(() => null);
  const bodyRows = Object.values(fst?.bodies ?? {});
  check(st.view.state === 'PLACED' && bodyRows.length >= 1 && bodyRows.every((b) => b.state === 'settled'), `item 4 (${tag}): realiseApproved: PLACED only once the lift's body settled (${st.view.state}; ${bodyRows.map((b) => `${b.state}${b.settledAt != null ? ` in ${b.settledAt} ticks` : ''}`).join(', ')})`);
  out.census = {};
  for (const b of bodies) out.census[b.id] = await census(b, fluidBefore.get(b.id));
  check(Object.values(out.census).every((c) => c.ok), `item 4 (${tag}): the census exact: ${Object.entries(out.census).map(([k, c]) => `${k} ${c.columns}/${c.cells} columns, ${c.outsideCount} outside`).join('; ')}`, Object.values(out.census).flatMap((c) => [...c.wrong, ...c.outside]).slice(0, 12));
  // item 6: a 2-minute stand at default rules (random ticks, the time running): 0 fluid outside the shaft
  for (const r of ['random_tick_speed 3', 'advance_time true']) await cmd(`/gamerule ${r}`);
  await L.gameWait(120_000, { real: sleep, label: `lf ${tag} stand at default rules` });
  for (const r of ['random_tick_speed 0', 'advance_time false']) await cmd(`/gamerule ${r}`);
  out.stand = {};
  for (const b of bodies) out.stand[b.id] = await census(b, fluidBefore.get(b.id));
  check(Object.values(out.stand).every((c) => c.ok), `item 6 (${tag}): a 120 s stand at default rules (random ticks, the time running): still every column cell a column, 0 fluid outside the shaft (${Object.entries(out.stand).map(([k, c]) => `${k} ${c.columns}/${c.cells}, ${c.outsideCount} outside`).join('; ')})`);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, planDir, after, before, false);
  await cmd('/kill @e[type=!minecraft:player]');
  out.rides = await rides(tag, R.meta.lifts ?? []);
  out.breach = await breach(tag, (R.meta.lifts ?? [])[0], bodies[0]);
  const rm = await G.remove(ctx, region);
  const d = await G.diff(ctx, box, pre);
  const bc = out.breach?.cell ? out.breach.cell.join(',') : null;
  // (the stand's random ticks turn grass under the terrain's bands to dirt: the world's growth, classified; the breached cell: a command's)
  const growth = d.list.filter((m) => m.class === 'growth');
  const rest = d.list.filter((m) => m.pos !== bc && m.class !== 'growth');
  out.exact = { removed: rm.removed, mismatches: d.mismatches, growth: growth.length, rest: rest.length, list: d.list.filter((m) => m.class !== 'growth').slice(0, 20) };
  check(rm.removed && rest.length === 0, `item 8 (${tag}): Regions.remove (the column drained first, then the shell): E-flat ${rest.length} unclassified (${growth.length} growth from the default-rules stand's random ticks, recorded; ${d.mismatches - rest.length - growth.length} at the breached cell, put back by a command: its own record, not the region's)`, rest.slice(0, 8));
  await leaveWorld();
  return out;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.ensureBase(FLAT);
  await L.fresh('G6B LF Flat', FLAT);
  await L.setRules('exact');
  out.flat = await demoRun('flat', FLAT_CLAIM, { kind: 'flat' });
  await leaveWorld();
  out.cliff = await cliffRun('cliff');
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 1: the probe (command-built)

/**
 * A command-built lift on the superflat base at (x, z) (the shaft's column; the face north of it): a cliff of `rise` behind it, the two
 * layers round the shaft, the airlock's doors, the base (soul sand, or magma with `down`). Returns its geometry for dev.lift.ride.
 */
async function buildColumn(x, z, g, rise, { down = false, water = true, light = false } = {}) {
  const yT = g + rise;
  await cmd(`/fill ${x - 3} ${g + 1} ${z - 6} ${x + 3} ${yT} ${z - 1} minecraft:stone`);
  await cmd(`/fill ${x - 2} ${g} ${z} ${x + 2} ${yT + 1} ${z + 2} minecraft:stone_bricks`);
  await cmd(`/fill ${x} ${g + 1} ${z} ${x} ${yT + 4} ${z} minecraft:air`);
  await cmd(`/setblock ${x} ${g} ${z} ${down ? 'minecraft:magma_block' : 'minecraft:soul_sand'}`);
  for (const dz of [1, 2]) {
    await cmd(`/setblock ${x} ${g + 1} ${z + dz} minecraft:oak_door[facing=north,half=lower]`);
    await cmd(`/setblock ${x} ${g + 2} ${z + dz} minecraft:oak_door[facing=north,half=upper]`);
  }
  if (light) for (let y = g + 3; y < yT; y += 6) await cmd(`/setblock ${x - 1} ${y} ${z} minecraft:sea_lantern`);
  if (water) await cmd(`/fill ${x} ${g + 1} ${z} ${x} ${yT} ${z} minecraft:water`);
  return { col: [x, z], y0: g, yT, top: [x, yT + 1, z - 1], approach: [x, g + 1, z + 3], doors: [[x, g + 1, z + 1], [x, g + 1, z + 2]] };
}

steps.probe = async () => {
  await ensure();
  const out = {};
  await L.ensureBase(FLAT);
  await L.fresh('G6B LF Probe', FLAT);
  await L.setRules('exact');
  await cmd('/difficulty normal');
  const g = -61; // (the superflat base's grass)
  const X = 7000, Z = 7000;
  await tp(X, 20, Z + 20);
  // (a) water poured over soul sand and over magma becomes the columns (the scheduled tick from the base)
  const colUp = await buildColumn(X, Z, g, 8);
  const colDown = await buildColumn(X + 20, Z, g, 8, { down: true });
  await L.gameWait(5000, { real: sleep, label: 'lf probe columns form, 100 ticks' });
  const states = async (c) => { const o = []; for (let y = c.y0 + 1; y <= c.yT; y++) o.push(await stateAt(c.col[0], y, c.col[1])); return o; };
  out.formed = { up: await states(colUp), down: await states(colDown) };
  check(out.formed.up.every((s) => s === 'minecraft:bubble_column[drag=false]') && out.formed.down.every((s) => s === 'minecraft:bubble_column[drag=true]'), `item 1: water poured over soul sand becomes bubble_column[drag=false], over magma [drag=true] (${json({ up: [...new Set(out.formed.up)], down: [...new Set(out.formed.down)] })})`);
  // (b) a written bubble_column over its base stays (the fluids stage writes the states directly)
  const colW = await buildColumn(X + 40, Z, g, 8, { water: false });
  await cmd(`/fill ${X + 40} ${g + 1} ${Z} ${X + 40} ${g + 8} ${Z} minecraft:bubble_column[drag=false]`);
  await L.gameWait(10_000, { real: sleep, label: 'lf probe written column, 200 ticks' });
  out.written = await states(colW);
  check(out.written.every((s) => s === 'minecraft:bubble_column[drag=false]'), `item 1: a written bubble_column over its soul sand stays (${json([...new Set(out.written)])})`);
  // (c) a door holds a column, open and shut: the cell past the outer door stays dry with the inner door open, then shut
  const past = [X, g + 1, Z + 3];
  const dry = async () => !/water|bubble/.test(await stateAt(...past));
  await cmd(`/setblock ${X} ${g + 1} ${Z + 1} minecraft:oak_door[facing=north,half=lower,open=true]`);
  await cmd(`/setblock ${X} ${g + 2} ${Z + 1} minecraft:oak_door[facing=north,half=upper,open=true]`);
  await L.gameWait(5000, { real: sleep, label: 'lf probe door open' });
  const openDry = await dry(), openDoorCell = await stateAt(X, g + 1, Z + 1);
  await cmd(`/setblock ${X} ${g + 1} ${Z + 2} minecraft:oak_door[facing=north,half=lower,open=true]`);
  await cmd(`/setblock ${X} ${g + 2} ${Z + 2} minecraft:oak_door[facing=north,half=upper,open=true]`);
  await L.gameWait(5000, { real: sleep, label: 'lf probe both doors open' });
  const bothOpenDry = await dry();
  for (const dz of [1, 2]) {
    await cmd(`/setblock ${X} ${g + 1} ${Z + dz} minecraft:oak_door[facing=north,half=lower,open=false]`);
    await cmd(`/setblock ${X} ${g + 2} ${Z + dz} minecraft:oak_door[facing=north,half=upper,open=false]`);
  }
  await L.gameWait(5000, { real: sleep, label: 'lf probe doors shut' });
  out.doors = { openInner: { dry: openDry, doorCell: openDoorCell }, bothOpen: bothOpenDry, shut: await dry() };
  check(openDry && bothOpenDry && out.doors.shut && !/water/.test(openDoorCell), `item 1: a door holds the column open and shut (the inner door open: ${openDry ? 'dry' : 'WET'} past it, its cell ${openDoorCell}; both open: ${bothOpenDry ? 'dry' : 'WET'}; shut: ${out.doors.shut ? 'dry' : 'WET'})`);
  // (d) drowned: vanilla's spawn rules in a river biome pass in a dark column and never in a lit one (the light every 6 rests on it)
  const dark = await buildColumn(X + 60, Z, g, 30);
  const lit = await buildColumn(X + 80, Z, g, 30, { light: true });
  // (the box under /fillbiome's 32,768-cell limit: the two columns, their cells' biome)
  for (const c of [dark, lit]) { const r = await cmd(`/fillbiome ${c.col[0] - 2} ${g - 1} ${c.col[1] - 2} ${c.col[0] + 2} ${c.yT + 1} ${c.col[1] + 2} minecraft:river`); out.fillbiome = [...(out.fillbiome ?? []), (r.messages ?? []).join(' ')]; }
  await L.gameWait(5000, { real: sleep, label: 'lf probe columns form' });
  const cellAt = (c) => ({ x: c.col[0], y: c.y0 + 12, z: c.col[1] });
  out.drowned = { dark: await call('dev.lift.spawnRule', { ...cellAt(dark), tries: 600 }, 60_000), lit: await call('dev.lift.spawnRule', { ...cellAt(lit), tries: 600 }, 60_000) };
  check(out.drowned.dark.passed > 0 && out.drowned.lit.passed === 0 && out.drowned.lit.light > 0, `item 1: drowned spawn rules (river biome, a column cell 12 up): dark (block light ${out.drowned.dark.light}) ${out.drowned.dark.passed}/${out.drowned.dark.tries} pass; lit (block light ${out.drowned.lit.light}, sea lanterns every 6) ${out.drowned.lit.passed}/${out.drowned.lit.tries}`, out.drowned);
  // (e) the rides: up 8, 30 and 48 (launched over the rim, stepping onto the top cell), and down a down column out through its airlock
  out.rides = {};
  const towers = [['up8', colUp, false], ['up30', dark, false], ['up48', await buildColumn(X + 100, Z, g, 48), false], ['down30', await buildColumn(X + 120, Z, g, 30, { down: true }), true]];
  await L.gameWait(5000, { real: sleep, label: 'lf probe columns form' });
  for (const [name, c, down] of towers) {
    const r = await call('dev.lift.ride', { x: c.col[0], z: c.col[1], y0: c.y0, yT: c.yT, drag: down, face: [0, -1], exit: down ? c.approach : c.top, ...(down ? { doors: c.doors } : {}) }, 120_000).catch((e) => ({ rode: false, error: String(e?.message ?? e) }));
    out.rides[name] = r;
  }
  check(Object.values(out.rides).every((r) => r.rode), `item 1: the bot player rides (dev.lift.ride: LivingEntity.travel and the column's own push): ${Object.entries(out.rides).map(([k, r]) => `${k} ${r.rode ? 'ok' : 'FAIL'} (reached ${r.reached}, exited ${r.exited}, y ${r.minY?.toFixed?.(1)}..${r.maxY?.toFixed?.(1)}, ${r.ticks} ticks)`).join('; ')}`, out.rides);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 10: survival (RS)

steps.survival = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, 'valid/v7a_lf_cliff.json');
  const T = await G.twin(ctx, 'lf', fx);
  const s = await G.site(ctx, 'lf', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'lf-surv-pre');
  const ck = await G.check(ctx, 'lf', s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'cliff_lift');
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, cost: a?.cost ?? null };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!a?.cost?.survival, `item 10: v7a_lf_cliff through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}, cost.survival ${json(a?.cost?.survival && { free: a.cost.survival.free, held: a.cost.survival.held })}`);
  if (!ck.check?.artifactSha) return out;
  out.bills = { survival: a?.cost?.survival?.bom ?? null, bom: a?.cost?.bom ?? null };
  const crateAt = await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted, state: st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent } };
  check(st.view.state === 'PLACED' && rs.build?.done && rs.build?.percent === 100, `item 10: realiseApproved in survival and fed in ${f.waves} waves: ${st.view.state}, build ${json(out.feed.build)} (the shell bottom up; the column written after its last paid cell: RS §7.3's barrier)`);
  const fst = await call('dev.fluid.state', { region }, 60_000).catch(() => null);
  out.fluids = fst;
  const bodyRows = Object.values(fst?.bodies ?? {});
  check(bodyRows.length >= 1 && bodyRows.every((b) => b.state === 'settled'), `item 10: the lift's body written and settled after the build (${bodyRows.map((b) => b.state).join(', ')})`);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ;
  check(differ.length === 0, `item 10: the check's cost.survival.bom against the targets' bills put down, per part (soul sand and magma from the stockpile, the water free): ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal, item for item (BOM exact)'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 10: the survival build equals its INSTANT twin cell for cell (the crates aside), the columns included: ${d.mismatches} differ`, d.list);
  const pile0 = await G.pileState(ctx);
  const rm = await G.remove(ctx, region);
  const pile1 = await G.pileState(ctx);
  out.refund = { before: pile0, after: pile1 };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `item 10: Regions.remove: E-flat ${ef.length} (the crates aside; the column drained first)`, ef.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the natural site (CW's pinned cliff)

steps.natural = async () => {
  await ensure();
  const site = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  if (!site.fixture?.claim) { check(false, 'natural: the cliff face is not pinned'); return {}; }
  await L.ensureBase(BASE);
  await L.fresh('G6B LF Natural', BASE);
  await L.setRules('exact');
  const out = await demoRun('natural', site.fixture.claim, { kind: 'natural', standMs: 60_000 });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `lf_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

/** The look's cameras of one lift: the entry (out from the approach), the shaft (from its inner door, up), the exit landing, the side. */
async function liftShots(tag, which, q) {
  const [dx, dz] = q.dir, [rx, rz] = [-dz, dx];
  const [ax, , az] = q.foot, y0 = q.y0, yT = q.yT;
  const up = q.shafts.find((s) => s.kind === 'up');
  const c = (x, z) => [x + 0.5, z + 0.5];
  const out = [];
  const [ex, ez] = c(ax - dx * 9 + rx * 5, az - dz * 9 + rz * 5);
  out.push(await shot(`${tag}_${which}_entry`, [ex, y0 + 4, ez], [ax + dx * 2 + 0.5, y0 + 3, az + dz * 2 + 0.5]));
  const [ix, iz] = c(up.col[0] - dx * 1, up.col[1] - dz * 1);
  out.push(await shot(`${tag}_${which}_shaft`, [ix, y0 + 1.6, iz], [up.col[0] + 0.5, Math.min(yT, y0 + 14), up.col[1] + 0.5]));
  const [tx, tz] = c(q.top[0] + dx * 4 + rx * 2, q.top[2] + dz * 4 + rz * 2);
  out.push(await shot(`${tag}_${which}_exit`, [tx, yT + 4, tz], [up.col[0] + 0.5, yT + 1, up.col[1] + 0.5]));
  const [sx, sz] = c(ax + dx * 2 + rx * 14, az + dz * 2 + rz * 14);
  out.push(await shot(`${tag}_${which}_side`, [sx, y0 + Math.floor(q.rise / 2) + 3, sz], [ax + dx * 2 + 0.5, y0 + Math.floor(q.rise / 2), az + dz * 2 + 0.5]));
  return out;
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.ensureBase(FLAT);
    await L.fresh(`G6B LF Look ${tag}`, FLAT);
    await L.setRules('exact');
    await cmd('/time set 13000');
    await cmd('/weather clear');
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 0, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const p = await L.plan('lifts_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER, ...(bible ? { bible } : {}) });
    const meta = JSON.parse(fs.readFileSync(path.join(sideDir(p.planId), 'meta.json'), 'utf8'));
    const region = await L.realise(p.planId, {});
    const st = await L.waitRegion(region, 3_600_000, async (s) => { if (s.waiting?.PLAYER_IN_BOX || s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
    const recs = meta.lifts ?? [];
    check(st.view.state === 'PLACED' && recs.length === 2, `look (${tag}): lifts_demo flat realised with its two lifts (${st.view.state}; recorded, not judged: Noah's call, N-LF-1)`);
    out.bibles[tag] = { planId: p.planId, state: st.view.state, lifts: recs.map((q) => ({ id: q.id, rise: q.rise, down: q.down, shell: q.shell, cap: q.cap, door: q.door, rail: q.rail, light: q.light, foot: q.foot, top: q.top })) };
    for (const q of recs) out.shots.push(...await liftShots(tag, q.down ? 'high' : 'low', q));
    await call('dev.release', {}).catch(() => null);
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 300, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const rm = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000).catch((e) => ({ error: String(e?.message ?? e) }));
    out.bibles[tag].remove = { removed: rm.removed ?? null, error: rm.error ?? null };
    await leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'probe', 'ingame', 'survival', 'natural', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-LF (lifts)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7alf.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(L.fails() ? 1 : 0);
