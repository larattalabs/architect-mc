#!/usr/bin/env node
// Phase 6c slice T2 gate (docs/CONTRACT.md "Phase 6c slice T2: slope-aware routing and switchbacks" §3) against a dev client (or the
// headless server) of the T2 run worktree (`../architect-mc-T2-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh:
// the sim sidecar, no Claude). Ports 8918 (sidecar) / 8919 (DevBridge). $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6ct2.mjs <step>
//     start [world] | stop | base      the client and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit                              the kit's T2 tests (the pass, moves, emission, checker rules, route_demo S3 and flat, the broken
//                                       variants, hysteresis), the goldens that must not move (item 12), the whole kit suite, the sidecar's
//                                       feature list and pass budget tests
//     synth                             item 2 on the seeded synthetic 1:2 slope (stairs off): every edge found, a hairpin per 16 rise, every
//                                       hairpin on its flat landing (virtual world), the grade, both movers
//     variants                          the broken variants: a ladder on a villager edge (M2:villager), a route through keep-out with the
//                                       obstacle off (plan refusal KEEP_OUT), a 0.4 grade straight run with the limit off (M2:grade)
//     plantime                          item 7 (BAR): the pass on S3's claim (relief_demo's golden survey) and on the 1024x1024 synthetic with 20
//                                       edges, through the plan CLI in the helper's sandbox with the pass budget, median of 3; item 8 offline: the
//                                       IR sha over the 3 plans, tile shas 1 = 4 workers, forward and shuffled
//     hyst                              item 6 offline over S3's survey: each lot moved by 4 keeps >= 80% of the other edges' cells
//     apicompat                         item 13: tools/api-compat.mjs --gate6ct2 (the 0.24.0, 0.23.0, 0.22.0 apitest jars, the 0.24.0 surface)
//     ingame                            items 4, 5, 10 in game (headless-capable): route_demo on a flat world with a protected area across its
//                                       gate-hall line: the plan honours it, 0 cells written in it (ARWD diff), vanilla villager paths along the
//                                       villager edges, the removal by its owner exact (E-flat 0)
//     routeflat | route                 route_demo on S3's pinned claim, flat then natural (scenarios.mjs, phase 6c-t2): items 1, 3-6, 8-11
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-t2/<step>.json in the main checkout (GATE6CT2_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitReuse } from './lib/kit-reuse.mjs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { sidecarReuse } from './lib/sidecar-reuse.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { srcGradle } from './lib/src-gradle.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-T2-run');
process.env.GATE6B_OUT = process.env.GATE6CT2_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-t2');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, state, startClient, stopClient, tp } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const PHASE = '6c-t2';
const OWNER = 'test:t2';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const SC = () => JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'route_demo.json'), 'utf8'));
const json = (o) => JSON.stringify(o).replaceAll(' ', '');

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice T2 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  // a lobby world, never a base: the client's autoworld would create a missing base as a normal world (MP's lesson)
  await startClient(process.argv[3] ?? 'G6C T2 Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  // a reused run dir's base world from an older creation recipe is moved aside and made again (tools/lib/basestamp.mjs)
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline: unit, synth, variants, plan time, hysteresis, api-compat

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}
/** The kit suite once per gate run (tools/lib/kit-reuse.mjs): files whose checks are pass/fail only take this run's unit-kit results when exact. */
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.t2 = nodeTest(['kit/test/route-t2.test.mjs']);
  check(out.t2.code === 0 && out.t2.fail === 0 && out.t2.pass >= 12, `unit (kit): movers inferred (S-T2-1), the grade window, switchbacks on a 1:2 slope, ladders only off villager edges (S-T2-2), keep-out and KEEP_OUT, water ROUTE_WATER, M2:grade, hysteresis and determinism, column-exact emission, route_demo on S3 and flat: ${out.t2.pass} pass, ${out.t2.fail} fail`, out.t2.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 12: format-1 goldens, S1's and S7's tile goldens, mega_bench and the 6b fixtures unchanged; the realise and passes lint (route.mjs): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = kitOnce(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = sidecarReuse(root, ['test/regions-passes.test.ts', 'test/regions-real-kit-6b.test.ts', 'test/jobs.test.ts']) ?? spawnSync('npx', ['vitest', 'run', 'test/regions-passes.test.ts', 'test/regions-real-kit-6b.test.ts', 'test/jobs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.sidecar = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§1 (sidecar): region.route appended to the features, the pass budget for a program declaring passes: ${out.sidecar.summary}`);
  return out;
};

/** A program object routing `edges` between `nodes` (one pass call), anchors at `at`. */
async function inline(intent, at) {
  const { region } = await imp('lib/region/program.mjs');
  return { id: 'rt_gate', passes: ['route'], default: (ctx) => { const r = region(ctx); r.stages(['ground']); r.pass('route', intent); r.anchor('entrance', at); r.anchor('spawn', at); return r; } };
}

steps.synth = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { encodeColumns } = await imp('lib/region/pack.mjs');
  const { synthSlope } = await imp('lib/region/synth.mjs');
  const { windowGrade } = await imp('lib/region/passes/route.mjs');
  const W = 160, D = 176;
  const s = synthSlope({ width: W, depth: D, seed: 't2-slope' });
  const enc = encodeColumns(s);
  const claim = { minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: -64, maxY: 319 };
  const g = (x, z) => s.ground[x + z * W];
  // three edges from the foot to the top (the straight line about 0.5 grade): the slope's whole width for their switchbacks
  const node = (x, z) => ({ at: [x, g(x, z) + 1, z] });
  const nodes = { a1: node(30, 166), b1: node(30, 10), a2: node(80, 166), b2: node(80, 10), a3: node(130, 166), b3: node(130, 10) };
  const edges = [{ id: 's1', from: 'a1', to: 'b1' }, { id: 's2', from: 'a2', to: 'b2' }, { id: 's3', from: 'a3', to: 'b3' }];
  const t0 = performance.now();
  const p = await planRegion({ program: await inline({ nodes, edges, stairs: false, maxGrade: 0.25 }, [30, 166]), programSource: 'gate6ct2 synth', survey: enc, claim, seed: '11' });
  const ms = Math.round(performance.now() - t0);
  const rep = checkRegion({ ir: p.ir, survey: enc, blobs: p.blobs, meta: p.meta });
  const vw = rep._world, P = vw.pal;
  const out = { ms, notes: p.notes, edges: [] };
  for (const e of p.meta.route.edges) {
    const straight = e.ok ? Math.abs(e.path[e.path.length - 1][1] - e.path[0][1]) / Math.max(1, Math.abs(e.path[e.path.length - 1][2] - e.path[0][2])) : null;
    const flat = (e.landings ?? []).map((l) => l.cells.every(([x, z]) => P.solid[vw.get(x, l.y, z)] && P.passable[vw.get(x, l.y + 1, z)] && P.passable[vw.get(x, l.y + 2, z)]));
    const grade = (e.segments ?? []).filter((x) => x.kind === 'walk' && !x.shared).map((x) => windowGrade(e.path.slice(x.from, x.to + 1).map((q) => q[1]), 0.25));
    const m = rep.metrics.route.edges.find((x) => x.id === e.id);
    out.edges.push({ id: e.id, ok: e.ok, rise: e.rise, straightGrade: straight, hairpins: (e.landings ?? []).length, landingsFlat: flat.filter(Boolean).length, length: e.length, bad: grade.reduce((a, x) => a + x.bad, 0), windows: grade.reduce((a, x) => a + x.windows, 0), player: m?.player, villager: m?.villager });
  }
  check(out.edges.length === 3 && out.edges.every((e) => e.ok), `item 2: every edge found on the 1:2 slope (${out.edges.map((e) => `${e.id} ${e.ok ? `${e.length} cells, rise ${e.rise}` : 'FAILED'}`).join('; ')})`);
  check(out.edges.every((e) => e.straightGrade >= 0.45), `item 2: the straight line is about 0.5 grade (${out.edges.map((e) => e.straightGrade?.toFixed(2)).join(', ')})`);
  check(out.edges.every((e) => e.hairpins >= Math.ceil(e.rise / 16)), `item 2: at least one hairpin per 16 rise (${out.edges.map((e) => `${e.id} ${e.hairpins} for ${e.rise}`).join(', ')})`);
  check(out.edges.every((e) => e.landingsFlat === e.hairpins), `item 2: every hairpin has its landing, flat at one y with 2 clear (${out.edges.map((e) => `${e.landingsFlat}/${e.hairpins}`).join(', ')})`);
  check(out.edges.every((e) => e.bad === 0 && e.windows > 0), `item 1 (synthetic): 0 walk windows over the grade (${out.edges.map((e) => `${e.bad}/${e.windows}`).join(', ')})`);
  check(out.edges.every((e) => e.player && e.villager), 'items 3, 4 (synthetic, virtual): both movers reach every edge\'s ends');
  check(rep.errors === 0 && !rep.findings.some((f) => /^M[1-4]\b/.test(f.rule)), `item 9 (synthetic): 0 errors, no M1-M4 (${rep.findings.map((f) => f.rule).join(', ') || 'none'})`);
  return out;
};

steps.variants = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { makeColumns, encodeColumns } = await imp('lib/region/pack.mjs');
  const out = {};
  const surf = (W, D, g) => { const c = makeColumns(0, 0, W, D, 1); for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { const i = x + z * W, h = g(x, z); c.ground[i] = h; c.height[i] = h; c.floor[i] = h; } return c; };
  const claimOf = (W, D) => ({ minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: -64, maxY: 319 });
  // a ladder on a villager edge (a cliff with a ramp round its end)
  const cliff = surf(96, 96, (x, z) => (x < 70 ? (z < 48 ? 74 : 64) : 64 + Math.floor(Math.max(0, Math.min(40, 68 - z)) / 4)));
  const lad = await planRegion({ program: await inline({ nodes: { a: { at: [30, 65, 80] }, b: { at: [30, 75, 16] } }, edges: [{ id: 'v', from: 'a', to: 'b', movers: ['player', 'villager'] }], _unsafe: { villagerLadders: true } }, [30, 80]), programSource: 'v1', survey: encodeColumns(cliff), claim: claimOf(96, 96), seed: '1' });
  const rl = checkRegion({ ir: lad.ir, survey: encodeColumns(cliff), blobs: lad.blobs, meta: lad.meta });
  out.villagerLadder = rl.findings.filter((f) => f.rule.startsWith('M2')).map((f) => `${f.rule}: ${f.message}`);
  check(rl.findings.some((f) => f.rule === 'M2:villager' && /with a ladder/.test(f.message)), `broken variant: a ladder on a villager edge is M2:villager (${out.villagerLadder.join('; ')})`);
  // a route through keep-out with the obstacle off: the plan is refused
  const flat = surf(96, 64, () => 64);
  try {
    await planRegion({ program: await inline({ nodes: { a: { at: [10, 65, 32] }, b: { at: [86, 65, 32] } }, edges: [{ id: 'k', from: 'a', to: 'b' }], _unsafe: { noKeepOut: true } }, [10, 32]), programSource: 'v2', survey: encodeColumns(flat), claim: claimOf(96, 64), seed: '1', keepOut: [[44, 10, 52, 54]] });
    out.keepOut = 'planned';
  } catch (e) { out.keepOut = e.message; }
  check(/^KEEP_OUT: route k writes into the keep-out rect \[44, 10, 52, 54\]/.test(out.keepOut), `broken variant: a route through keep-out with the obstacle off refuses the plan (${out.keepOut})`);
  // a 0.4 grade straight run with the limit off
  const steep = surf(64, 96, (x, z) => 64 + Math.floor((2 * (95 - z)) / 5));
  const at = (z) => [32, 64 + Math.floor((2 * (95 - z)) / 5) + 1, z];
  const gp = await planRegion({ program: await inline({ nodes: { a: { at: at(88) }, b: { at: at(8) } }, edges: [{ id: 'g', from: 'a', to: 'b' }], stairs: false, _unsafe: { noGrade: true } }, [32, 88]), programSource: 'v3', survey: encodeColumns(steep), claim: claimOf(64, 96), seed: '1' });
  const rg = checkRegion({ ir: gp.ir, survey: encodeColumns(steep), blobs: gp.blobs, meta: gp.meta });
  out.grade = rg.metrics.route.grade;
  check(rg.findings.some((f) => f.rule === 'M2:grade') && out.grade.bad > 0, `broken variant: a 0.4 grade straight run with the limit off is M2:grade (${out.grade.bad} of ${out.grade.windows} windows, max rise ${out.grade.maxRise})`);
  return out;
};

/** One plan through the kit CLI in the helper's sandbox (permission model, no network, the pass heap). */
function sandboxPlan(dir, surveyFile, params, claim, heapMb, keepOut = null) {
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'out', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'params.json'), JSON.stringify(params));
  fs.copyFileSync(surveyFile, path.join(dir, 'out', 'survey.bin'));
  const o = path.join(dir, 'out');
  const node = ['--permission', `--allow-fs-read=${KIT}`, `--allow-fs-read=${o}`, `--allow-fs-write=${o}`, `--max-old-space-size=${heapMb}`,
    path.join(KIT, 'tools', 'region.mjs'), 'plan', path.join(KIT, 'regions', 'route_demo.mjs'), '--params', path.join(o, 'params.json'), '--survey', path.join(o, 'survey.bin'),
    '--seed', '424242', '--claim', claim.join(','), '--blobs-out', path.join(o, 'blobs'), '--out', o, '--json', ...(keepOut ? ['--keep-out', JSON.stringify(keepOut)] : [])];
  const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
  const t0 = performance.now();
  const r = spawnSync('/usr/bin/time', [...timeArgs, process.execPath, ...node], { encoding: 'utf8', timeout: 900_000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  const wallMs = performance.now() - t0;
  const err = r.stderr ?? '';
  const mac = /(\d+)\s+maximum resident set size/.exec(err), lin = /Maximum resident set size \(kbytes\): (\d+)/.exec(err);
  const peakMb = mac ? Number(mac[1]) / 1048576 : lin ? Number(lin[1]) / 1024 : null;
  const plan = fs.existsSync(path.join(o, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(o, 'plan.json'), 'utf8')) : null;
  return { code: r.status, wallMs, peakMb, plan, out: o, tail: `${r.stdout}`.split('\n').slice(-3).join('\n') + err.split('\n').filter((l) => /error|Error/.test(l)).slice(0, 5).join('\n') };
}

steps.plantime = async () => {
  const { synthBytes } = await imp('lib/region/synth.mjs');
  const dir = path.join(OUT, 'plantime');
  fs.mkdirSync(dir, { recursive: true });
  const sc = SC();
  const med = (runs, k) => { const v = runs.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const three = (surveyFile, params, claim, keepOut) => {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const r = sandboxPlan(dir, surveyFile, params, claim, 2048, keepOut);
      const pass = r.plan?.passRuns?.find((p) => p.name === 'route');
      runs.push({ code: r.code, wallMs: Math.round(r.wallMs), routeMs: pass?.ms ?? null, peakMb: r.peakMb === null ? null : Math.round(r.peakMb), irSha: r.plan?.irSha ?? null, notes: (r.plan?.notes ?? []).filter((n) => /pass route|route_demo/.test(n)), tail: r.code ? r.tail : undefined });
      if (i === 2 && r.plan) fs.cpSync(r.out, path.join(dir, `last-${path.basename(surveyFile, '.bin')}`), { recursive: true });
    }
    return runs;
  };
  // S3's claim: relief_demo's golden survey of it, the scenario's sites and keep-out
  const s3File = path.join(dir, 's3.bin');
  fs.copyFileSync(path.join(root, 'scenarios', 'goldens', 'relief_demo', 'survey.bin'), s3File);
  const c = sc.fixture.claim;
  const s3 = three(s3File, sc.params, [c[0], c[1], c[2], c[3], sc.fixture.yRange[0], sc.fixture.yRange[1]], sc.protect.map((a) => [a.x0, a.z0, a.x1, a.z1]));
  // the 1024x1024 synthetic with 20 edges (the four lots' 3 and 17 between grid nodes)
  const synFile = path.join(dir, 'synth-1024.bin');
  fs.writeFileSync(synFile, synthBytes({ minX: 0, minZ: 0, width: 1024, depth: 1024, resolution: 1, seed: 't2-bench' }));
  const syn = three(synFile, { edges: 17, lamps: false }, [0, 0, 1023, 1023, -64, 319], null);
  const out = { load1: os.loadavg()[0], s3: { runs: s3, median: { routeMs: med(s3, 'routeMs'), wallMs: med(s3, 'wallMs'), peakMb: med(s3, 'peakMb') } }, synth: { runs: syn, median: { routeMs: med(syn, 'routeMs'), wallMs: med(syn, 'wallMs'), peakMb: med(syn, 'peakMb') } } };
  check(s3.every((x) => x.code === 0 && x.irSha) && syn.every((x) => x.code === 0 && x.irSha), `item 7: 3 plans each of route_demo on S3's claim and on the 1024x1024 synthetic (20 edges) in the sandbox: ${[...s3, ...syn].map((x) => x.code).join(', ')} (${s3[0].notes.join('; ')} | ${syn[0].notes.join('; ')})`);
  bar(out.s3.median.routeMs !== null && out.s3.median.routeMs <= 30_000, `item 7: the route pass on S3's claim ${out.s3.median.routeMs} ms (median of 3), at most 30 s (load ${out.load1.toFixed(1)})`);
  bar(out.synth.median.routeMs !== null && out.synth.median.routeMs <= 90_000, `item 7: the route pass on the 1024x1024 synthetic with 20 edges ${out.synth.median.routeMs} ms (median of 3), at most 90 s; whole plan ${out.synth.median.wallMs} ms, peak ${out.synth.median.peakMb} MB`);
  // item 8 offline: the same IR over the 3 plans; tile shas for 1 and 4 workers, forward and shuffled
  check(new Set(s3.map((x) => x.irSha)).size === 1 && new Set(syn.map((x) => x.irSha)).size === 1, `item 8: the IR sha over 3 plans: S3 ${s3.map((x) => x.irSha?.slice(0, 12)).join(', ')}; synthetic ${syn.map((x) => x.irSha?.slice(0, 12)).join(', ')}`);
  const { tileShas } = await import('./scenarios.mjs');
  const ts = await tileShas(path.join(dir, 'last-s3'));
  out.tiles = { count: Object.keys(ts.tiles).length, cells: ts.cells, workersSame: ts.workersSame, timing: ts.timing };
  check(ts.workersSame, `item 8: ${out.tiles.count} tile shas equal for 1 and 4 workers, forward and shuffled (S3)`);
  return out;
};

steps.hyst = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const sc = SC();
  const survey = fs.readFileSync(path.join(root, 'scenarios', 'goldens', 'relief_demo', 'survey.bin'));
  const c = sc.fixture.claim;
  const claim = { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: sc.fixture.yRange[0], maxY: sc.fixture.yRange[1] };
  const keepOut = sc.protect.map((a) => [a.x0, a.z0, a.x1, a.z1]);
  const opts = { programFile: path.join(KIT, 'regions', 'route_demo.mjs'), survey, claim, seed: sc.seed, keepOut };
  const p1 = await planRegion({ ...opts, params: sc.params });
  const cells = (e) => new Set((e?.path ?? []).map(([x, , z]) => `${x},${z}`));
  const out = { moves: [] };
  // the re-plan prefers the first plan's routes (hysteresis: an earlier plan's routes cost a third, as 6d's replanning passes them)
  const routePrefer = Object.fromEntries(p1.meta.route.edges.map((e) => [e.id, (e.path ?? []).map(([x, , z]) => [x, z])]));
  for (const n of ['gate', 'hall', 'chapel', 'lookout']) for (const [ax, d] of [['X', 4], ['Z', 4], ['X', -4], ['Z', -4]]) {
    const p2 = await planRegion({ ...opts, params: { ...sc.params, [`${n}${ax}`]: sc.params[`${n}${ax}`] + d }, routePrefer });
    let kept = 0, total = 0;
    for (const e of p1.meta.route.edges) {
      if (e.from === n || e.to === n) continue;
      const a = cells(e), b = cells(p2.meta.route.edges.find((x) => x.id === e.id));
      total += a.size;
      for (const k of a) if (b.has(k)) kept++;
    }
    out.moves.push({ moved: `${n} ${ax}${d > 0 ? '+' : ''}${d}`, kept, total, share: total ? kept / total : 1 });
  }
  const worst = out.moves.reduce((a, m) => (m.share < a.share ? m : a), out.moves[0]);
  check(out.moves.every((m) => m.share >= 0.8), `item 6: one node moved by 4 (each lot, x and z, both ways: ${out.moves.length} re-plans) keeps the other edges' cells (the re-plan prefers the first plan's routes): worst ${worst.moved} ${worst.kept}/${worst.total} (${(100 * worst.share).toFixed(1)}%)`);
  return out;
};

steps.apicompat = async () => {
  srcGradle(root, () => execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' }));
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6ct2'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 13: api-compat against the 0.24.0, 0.23.0 and 0.22.0 apitest jars and the 0.24.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ in game (headless-capable): keep-out, villagers, the removal

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B T2 Ingame', FLAT);
  await L.setRules('exact');
  const X = 9000, Z = 9000;
  const claim = [X, Z, X + 191, Z + 191];
  await tp(X + 96, 40, Z + 96);
  // a first plan without the area: the flat route_demo's gate and hall, and the straight line between them
  const p0 = await L.plan('route_demo', claim, { surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const meta0 = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p0.planId, 'meta.json'), 'utf8'));
  const gh = meta0.route.edges.find((e) => e.id === 'gate_hall');
  const [a, b] = [gh.path[0], gh.path[gh.path.length - 1]];
  const mz = Math.floor((a[2] + b[2]) / 2);
  const area = { owner: OWNER, id: 't2', x0: Math.min(a[0], b[0]) - 20, z0: mz - 3, x1: Math.max(a[0], b[0]) + 20, z1: mz + 3, label: 'T2_keep-out' };
  await api(`unprotect ${OWNER} t2`).catch(() => null);
  out.area = await api(`protect ${json(area)}`);
  const p = await L.plan('route_demo', claim, { surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const ir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'meta.json'), 'utf8'));
  out.plan = { planId: p.planId, keepOut: ir.keepOut, edges: meta.route.edges.map((e) => ({ id: e.id, ok: e.ok, length: e.length, unconstrained: meta0.route.edges.find((x) => x.id === e.id)?.length })), notes: p.notes };
  check(json(ir.keepOut) === json([[area.x0, area.z0, area.x1, area.z1]]) && meta.route.edges.every((e) => e.ok), `item 5: the plan received and honoured the area (IR keepOut ${json(ir.keepOut)}); every edge routed (gate_hall ${out.plan.edges[0].length} cells against ${out.plan.edges[0].unconstrained} unconstrained)`);
  const yr = p.claimY ?? [-64, 64];
  const box = [claim[0] - 8, yr[0], claim[1] - 8, claim[2] + 8, yr[1], claim[3] + 8];
  const before = path.join(OUT, 'ingame-before.arwd.gz'), after = path.join(OUT, 'ingame-after.arwd.gz');
  await call('dev.region.dump', { box, file: before, light: false }, 900_000);
  const h0 = await call('dev.region.hash', { box: [box[0], box[1], box[2], box[3], box[4], box[5]] }, 3_600_000);
  const region = await L.realise(p.planId, { lots: Object.fromEntries(ir.lots.map((l) => [l.id, 'g6a_stub_9'])) });
  const st = await L.waitRegion(region, 3 * 3_600_000);
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  await call('dev.region.dump', { box, file: after, light: false }, 900_000);
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const { changedIn } = await import('./lib/scenario-route.mjs');
  const A = await decodeArwd(fs.readFileSync(before)), B = await decodeArwd(fs.readFileSync(after));
  out.inArea = changedIn(A, B, [[area.x0, area.z0, area.x1, area.z1]]);
  check(st.view.state === 'PLACED' && out.inArea.cells === 0, `item 5: realised (${st.view.state}, ${out.realise.cells} cells), 0 cells written in the area (ARWD diff: ${out.inArea.cells})`);
  // item 4 in game: vanilla's villager path along every villager edge, both ways
  const { routeNav } = await import('./lib/scenario-route.mjs');
  fs.mkdirSync(path.join(OUT, 'ingame'), { recursive: true });
  const nav = await routeNav(L, meta, ir, path.join(OUT, 'ingame'));
  out.nav = Object.fromEntries(Object.entries(nav.edges).map(([k, v]) => [k, [v.there.canReach, v.back.canReach]]));
  const vEdges = meta.route.edges.filter((e) => e.ok && e.movers.includes('villager')).map((e) => e.id);
  check(vEdges.length >= 2 && vEdges.every((id) => out.nav[id]?.[0] && out.nav[id]?.[1]), `item 4: dev.nav.villager reaches end to end along every villager edge, both ways (${JSON.stringify(out.nav)})`);
  check(meta.route.edges.filter((e) => e.movers.includes('villager')).every((e) => !(e.segments ?? []).some((g) => g.kind === 'ladder')), 'item 4: 0 ladder segments on villager edges');
  // item 10 in game: the removal by its owner, exact (E-flat 0 over the box)
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  await L.settle(5000);
  const h1 = await call('dev.region.hash', { box: [box[0], box[1], box[2], box[3], box[4], box[5]] }, 3_600_000);
  out.remove = { removed: rm.removed, restored: rm.restored, same: h0.sha256 === h1.sha256 };
  check(rm.removed && h0.sha256 === h1.sha256, `item 10: removed by its owner (${rm.restored} cells restored); the world hash equals the pre-placement one (E-flat 0)`);
  await api(`unprotect ${OWNER} t2`).catch(() => null);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the scenario runs (route_demo on S3's pinned claim)

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-40).join('\n') };
}
const ART = () => path.join(path.resolve(process.env.SCENARIOS_ART), PHASE, 'route_demo');
const latest = (flat) => {
  const d = ART();
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).map((x) => path.join(d, x)) : [];
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};
function scenarioStep(flat) {
  const r = scenario(['run', 'route_demo', '--phase', PHASE, ...(flat ? ['--flat'] : [])]);
  const dir = latest(flat);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  for (const x of m?.rows ?? []) {
    if (!x.gated || x.id === 'gallery') continue;
    if (flat && (x.id === 'golden' || x.id === 'determinism' || x.id === 'exactness')) continue; // judged by the natural run (scenarios.mjs)
    if (x.id === 'mspt' || x.id === 't2-tiles') bar(x.pass, `${x.label}: ${x.value}`);
    else check(x.pass, `${x.label}: ${x.value}`);
  }
  check(r.code === 0, `scenarios.mjs run route_demo${flat ? ' --flat' : ''}: exit ${r.code}${r.fails.length ? ` (${r.fails.join('; ')})` : ''}`);
  return { dir, exit: r.code, evidence: dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null, route: m?.route ?? null, rows: m?.rows ?? [] };
}
steps.routeflat = async () => scenarioStep(true);
steps.route = async () => scenarioStep(false);

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'synth', 'variants', 'plantime', 'hyst', 'apicompat', 'ingame', 'routeflat', 'route']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  const md = `# Gate 6c-T2 (slope-aware routing and switchbacks)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ct2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
