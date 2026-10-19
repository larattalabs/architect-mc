#!/usr/bin/env node
// Phase 6c slice HY gate (docs/CONTRACT.md "Phase 6c slice HY" §14) against the headless server of the HY run worktree (GATE6B_RUN,
// default `../architect-mc-HY-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0: no Claude call anywhere.
// One driver for the batch: HY-core's items in tools/lib/gate6chy-core.mjs, HY-b's (courses) in tools/lib/gate6chy-b.mjs and HY-c's
// (water gates) in tools/lib/gate6chy-c.mjs, each a list of named items a step runs after the core's. HY-a's pass checks are its own
// driver (tools/gate6chya.mjs, kit only). The step names are frozen with HY-core's interface:
//
//   node tools/gate6chy.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit      (hy-unit)              offline: item 12's byte identity (every committed plan fixture without an HY part, H's included,
//                                      as on origin/main, r08 and e15 by name), the kit's HY and H tests, P0's tests, the whole kit suite,
//                                      the Java H and HY tests, api-compat --gate6chy
//     ingame    (hy-ingame)            items 2-7 and 18 (b) on a flat world: hy_core_demo through Regions.checkPlan and realiseApproved
//     crash     (hy-crash)             item 8: FL1, FL4 (between reaches), FL5 (a removal between the head and the tail), FL3
//     natural   (hy-natural)           HY-b's natural items (S3)
//     cold      (hy-cold)              item 18 (a) (the freezing probe, recorded) and HY-b's cold items
//     look      (6chy-look)            the look (client, recorded not judged; HY-b's and HY-c's cameras)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-hy/<step>.json in the main checkout (GATE6CHY_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-HY-run');
process.env.GATE6B_OUT = process.env.GATE6CHY_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-hy');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const CORE = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const C = await import('./lib/gate6chy-c.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

/** The context every item gets (the core's and the halves'): the run helpers, the kit importer, the output dir, HY-core's helpers. */
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
/** (HY-b, development only) GATE6CHY_SKIP_CORE=1 runs only the halves' items of an in-game step; a gate run never sets it. */
const SKIP_CORE = !!process.env.GATE6CHY_SKIP_CORE;
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice HY is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
/** Run the halves' items of a step (each `{name, run(ctx)}`), after the core's. */
async function halves(step) {
  const out = {};
  for (const it of [...(B.items[step] ?? []), ...(C.items[step] ?? [])]) {
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
  await startClient(process.argv[3] ?? 'G6B HY Lobby', { backend: 'sim' });
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
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
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
  out.unchanged = await CORE.unchanged(root);
  check(out.unchanged.ok, `item 12: ${out.unchanged.same} of ${out.unchanged.n} committed plan fixtures without an HY part (every dir, H's and the asks included) answer as on origin/main ${out.unchanged.mainHead.slice(0, 10)} and plan the same IR but its kitVersion; the named exceptions that differ: ${out.unchanged.excepted.join(', ') || 'none'}; ${out.unchanged.skipped} skipped (course parts, or new since main)`, out.unchanged.differ);
  out.core = nodeTest(['kit/test/hy-core.test.mjs']);
  check(out.core.code === 0 && out.core.fail === 0 && out.core.pass >= 8, `items 2, 12, 13 (kit, HY-core): catalogue 8 and its diff from catalogue-h.json, R24, the course members of the fluid op (requires courses), the overflow hook and the emit order, M25 on hy_core_demo clean and each broken variant caught (order, shell, leak, keep, lint), siteplan courses, determinism: ${out.core.pass} pass, ${out.core.fail} fail`, out.core.failing);
  out.h = nodeTest(['kit/test/h-core.test.mjs', 'kit/test/h-foundation.test.mjs', 'kit/test/h-a.test.mjs', 'kit/test/h-wet.test.mjs', 'kit/test/h-batch.test.mjs', 'kit/test/hy-a.test.mjs']);
  check(out.h.code === 0 && out.h.fail === 0, `H's tests and HY-a's after HY-core: ${out.h.pass} pass, ${out.h.fail} fail`, out.h.failing);
  out.p0 = nodeTest(['kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/catalogue-since.test.mjs'].filter((f) => fs.existsSync(path.join(root, f))));
  check(out.p0.code === 0 && out.p0.fail === 0, `item 12: P0's tests after HY (hy-pending-b/c.json, e15 without the course, sinceApi stamped): ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.java = await javaTests(['*ApiHTest*', '*RegionFluidsTest*', '*RegionFluidsHYTest*', '*PlanChecksHTest*', '*StillOursFluidsTest*', '*ArvxFluidsTest*'], 15);
  check(out.java.ok, `items 4, 5, 8, 19 (Java): the course members, the write order, the upstream closure, the guard reader, versions, kinds and features: ${out.java.tests} tests, ${out.java.failures} failures`);
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6chy'], { cwd: root, encoding: 'utf8', timeout: 900_000 });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
  check(ac.status === 0, `item 19: api-compat --gate6chy clean against the 0.37.0, 0.36.1 and 0.36.0 apitest jars and the 0.37.0 jar's 1.34.0 surface`, out.apicompat.tail);
  out.halves = await halves('unit');
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game (HY-core's items; the halves' after)

steps.ingame = async () => {
  await ensure();
  return { core: SKIP_CORE ? 'skipped (GATE6CHY_SKIP_CORE)' : await CORE.ingame(ctx), halves: await halves('ingame') };
};
steps.crash = async () => {
  await ensure();
  return { core: SKIP_CORE ? 'skipped (GATE6CHY_SKIP_CORE)' : await CORE.crash(ctx), halves: await halves('crash') };
};
steps.natural = async () => {
  await ensure();
  return { halves: await halves('natural') };
};
steps.cold = async () => {
  await ensure();
  return { core: SKIP_CORE ? 'skipped (GATE6CHY_SKIP_CORE)' : await CORE.cold(ctx), halves: await halves('cold') };
};
steps.look = async () => {
  await ensure();
  return { halves: await halves('look') };
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json'].includes(f));
  const lines = ['# Gate 6c slice HY', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
  console.error(`usage: node tools/gate6chy.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
