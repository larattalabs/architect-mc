#!/usr/bin/env node
// Phase 6c slice H gate (docs/CONTRACT.md "Phase 6c slice H" §14) against the headless server of the H run worktree (GATE6B_RUN, default
// `../architect-mc-H-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0: no Claude call anywhere.
// One driver for the batch: H-core's items here, H-a's (water bodies) in tools/lib/gate6ch-a.mjs and H-b's (wet structures) in
// tools/lib/gate6ch-b.mjs, each a list of named items a step runs after the core's (the step names are frozen with H-core's interface).
//
//   node tools/gate6ch.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (h-unit)               offline: the kit's H tests (the fluid model, M25, the lint, catalogue 7 and its diff, the schema,
//                                      R21), P0's tests after H, the T3 and K1 tests, the goldens that must not move, byte identity of
//                                      every committed plan without an H part, the whole kit suite; the Java H tests; api-compat
//     ingame    (h-ingame)             items 1-3, 5, 6 (and 17, recorded) on a flat world: h_core_demo's pond and spout realised with
//                                      the containment check, the census equal to the prediction, settled, a 2-minute stand at default
//                                      rules; the negative control (no_shell_cell realised with the check bypassed: it leaks and the
//                                      census names the cell); the escape guard (predict_short: drained, escaped, PARTIAL, 0 fluid);
//                                      the realise check (a protected area over a shell cell: the body not written, PARTIAL); exact
//                                      undo under the exact rules (E-flat 0, fluid cells by state); the single breach and its undo
//     crash     (h-crash)              item 7: a crash before the fluids stage, one mid-stage, one during removal (drained, before the
//                                      solids): settle at start finishes each, 0 fluid outside the declared cells, the undo exact
//     holders   (h-holders)            fix/drain-holders: a separate site's waterlogged stair layered over a pond source cell; Regions.remove
//                                      keeps it standing (the drain skips cells another entry holds on top) and hands the cell down to it;
//                                      E-flat 0 outside it, then 0 after the stair site goes (tools/lib/gate6ch-holders.mjs)
//     rmcrash   (h-rmcrash)            the same through the removal's crash windows: FL3+save, K6+save, R2q+save (R2 durable, the queue
//                                      file not saved), K7+save (mid-R4)
//     probe     (h-probe)              item 14: (a) the sand anomaly (a sand cell on a rewritten cell, dry and under water, re-read with
//                                      its journal entries); (b) T1's falling water (relief_demo's committed inputs re-planned:
//                                      FLUID_STATE 0, the source of the level-8 cells named); item 13's fire reach (a lava pit, a
//                                      flammable ring at 1-4, random ticks 300, the farthest ignition: M20's reach)
//     natural   (h-natural)            H-a's and H-b's natural items (S3's river and cliff)
//     cold      (h-cold)               H-a's and H-b's cold items (the frozen sites)
//     look      (6ch-look)             the look (client, recorded not judged)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-h/<step>.json in the main checkout (GATE6CH_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { gatePart } from './lib/gate-part.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-H-run');
process.env.GATE6B_OUT = process.env.GATE6CH_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-h');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const A = await import('./lib/gate6ch-a.mjs');
const B = await import('./lib/gate6ch-b.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
void imp; void json;

/** The context every item gets (the core's and the halves'): the run helpers, the kit importer, the output dir. */
const ctx = { L, OUT, KIT, imp, json, root, check, log };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice H is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
/** Run the halves' items of a step (each `{name, run(ctx)}`), after the core's. */
async function halves(step, want = () => true) {
  const out = {};
  for (const it of [...(A.items[step] ?? []), ...(B.items[step] ?? [])]) {
    if (!want(it.name)) continue;
    log(`-- ${it.name}`);
    out[it.name] = await it.run(ctx);
  }
  return out;
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B H Lobby', { backend: 'sim' });
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

/** The kit suite once per gate run (tools/lib/kit-reuse.mjs): files whose checks are pass/fail only take this run's unit-kit results when exact. */
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);
function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

/** Java tests by class pattern (the source checkout's gradle, under the cross-process lock). */
async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; }
  }
  return { code: g.status, tests, failures, ok: g.status === 0 && tests >= minTests && failures === 0 };
}

steps.unit = async () => {
  const out = {};
  // (gate waits, 2026-10-20) the Java tests first (they rebuild mod/build/classes), then api-compat (it only reads those classes) runs
  // in the background beside the kit items and the halves; its check is the same, made when it ends
  out.java = await javaTests(['*ApiHTest*', '*ArvxFluidsTest*', '*StillOursFluidsTest*', '*RegionFluidsTest*', '*PlanChecksHTest*'], 5);
  check(out.java.ok, `items 3, 5, 10, 18 (Java): the features and kinds, ARVX version 3's fluid layer (the cross-language fixture), still ours for fluids, the fluids stage's census and settle, the plan check's H trigger and the fluid guards: ${out.java.tests} tests, ${out.java.failures} failures`);
  const acLog = path.join(OUT, 'api-compat-gate6ch.log');
  fs.mkdirSync(OUT, { recursive: true });
  const acFd = fs.openSync(acLog, 'w'); // a file, not a pipe: the kit items keep this process busy for minutes at a time
  const acDone = new Promise((resolve) => {
    const ch = spawn(process.execPath, ['tools/api-compat.mjs', '--gate6ch'], { cwd: root, stdio: ['ignore', acFd, acFd] });
    const timer = setTimeout(() => ch.kill('SIGTERM'), 900_000);
    ch.on('close', (code) => { clearTimeout(timer); fs.closeSync(acFd); resolve({ status: code, text: fs.readFileSync(acLog, 'utf8') }); });
  });
  out.unchanged = await (await import('./lib/gate6ch-core.mjs')).unchanged(root);
  check(out.unchanged.ok, `item 11: ${out.unchanged.same} of ${out.unchanged.n} committed valid/, K1 and T3 fixtures without an H part answer as on origin/main ${out.unchanged.mainHead.slice(0, 10)} and plan the same IR but its kitVersion; the named exceptions that differ: ${out.unchanged.excepted.join(', ') || 'none'} (wet fits); ${out.unchanged.skipped} skipped (H fixtures, and refused/k1a_r01's two-plan harness)`, out.unchanged.differ);
  out.core = kitOnce(['kit/test/h-core.test.mjs', 'kit/test/h-foundation.test.mjs']);
  check(out.core.code === 0 && out.core.fail === 0 && out.core.pass >= 10, `items 1, 11, 12, 14(b), 15 (kit, H-core): the fluid model (shell, runs, the lint FLUID_STATE), M25 on h_core_demo and each broken variant caught with its cells, vanilla's steady state, catalogue 7 and its diff from catalogue-t3.json, R21-R23, the codes, ARVX version 3, determinism: ${out.core.pass} pass, ${out.core.fail} fail`, out.core.failing);
  out.p0 = kitOnce(['kit/test/plan-p0.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/plan-k1-batch.test.mjs', 'kit/test/plan-t3-batch.test.mjs', 'kit/test/catalogue-since.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `items 11, 12: P0's tests after H (e15/e16 off the flipped ids, h-pending-a/b.json), the K1 and T3 foundation and batch tests, sinceApi stamped: ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/plan-t3a.test.mjs', 'kit/test/plan-t3b.test.mjs', 'kit/test/plan-k1a.test.mjs', 'kit/test/plan-k1b.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 16: the tile goldens that must not move (S1, S7, S2, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo, districts_demo, links_demo, crossings_demo), T2's routes, the T3 and K1 plan tests: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = kitOnce(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.halves = await halves('unit');
  const ac = await acDone;
  out.apicompat = { code: ac.status, tail: ac.text.split('\n').slice(-8) };
  check(ac.status === 0, `item 18: api-compat --gate6ch clean against the 0.36.1, 0.36.0 and 0.35.0 apitest jars and the 0.36.1 jar's 1.33.0 surface`, out.apicompat.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game (H-core's items; the halves' after)

// a split h-ingame (docs/GATES.md "Turbo"): its sections are H-core's items and each half's item (tools/lib/gate-part.mjs)
const H_INGAME_SECTIONS = ['core', ...[...A.items.ingame, ...B.items.ingame].map((it) => it.name)];
steps.ingame = async () => {
  const P = gatePart(H_INGAME_SECTIONS, { log });
  await ensure();
  const core = P.want('core') ? await (await import('./lib/gate6ch-core.mjs')).ingame(ctx) : `another part's (${P.part})`;
  return { core, halves: await halves('ingame', P.want) };
};
steps.crash = async () => {
  await ensure();
  return { core: await (await import('./lib/gate6ch-core.mjs')).crash(ctx), halves: await halves('crash') };
};
// (fix/drain-holders) a later site's block in a body cell through the whole-group drain, and the removal's crash windows
steps.holders = async () => {
  await ensure();
  return await (await import('./lib/gate6ch-holders.mjs')).holders(ctx);
};
steps.rmcrash = async () => {
  await ensure();
  return await (await import('./lib/gate6ch-holders.mjs')).rmcrash(ctx);
};
steps.probe = async () => {
  await ensure();
  return { core: await (await import('./lib/gate6ch-core.mjs')).probe(ctx), halves: await halves('probe') };
};
steps.natural = async () => {
  await ensure();
  return { halves: await halves('natural') };
};
steps.cold = async () => {
  await ensure();
  return { halves: await halves('cold') };
};
steps.look = async () => {
  await ensure();
  return { halves: await halves('look') };
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json'].includes(f));
  const lines = ['# Gate 6c slice H', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
  console.error(`usage: node tools/gate6ch.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
