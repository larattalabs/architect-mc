#!/usr/bin/env node
// Phase 6c slice T1 gate (docs/CONTRACT.md "Phase 6c slice T1: passes, fields and relief" §6) against a dev client of the T1 run
// worktree (`../architect-mc-T1-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no
// Claude). Ports 8918 (sidecar) / 8919 (DevBridge). $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6ct1.mjs <step>
//     start [world] | stop | base      the client and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit                              the kit's T1 tests (the relief op, the pass framework and lint, Jacobi on a 5x5 hand case, erosion
//                                       never moves a pin, N-T1-1), the goldens that must not move (11), the whole kit suite, the
//                                       sidecar's pass budget test
//     plantime                          item 5: relief_demo on the synthetic 1024x1024 survey through the plan CLI with the helper's
//                                       sandbox flags and the pass budget (2 GB heap), median of 3 (BAR); item 6 offline: the IR sha and
//                                       the field blob shas over the 3 plans, tile shas 1 = 4 workers, forward and shuffled
//     stale                             item 11: the v0.17.0 kit and the 0.17.0 mod's IrStale refuse a relief plan PLAN_STALE
//     apicompat                         item 12: tools/api-compat.mjs --gate6cw (the 0.17.0, 0.16.0, 0.15.0 apitest jars, the 0.17.0 surface)
//     res1                              §3 in game: a program with passes on a 320x320 claim gets its second plan over a resolution-1
//                                       survey (320x320 columns); a program without passes keeps the resolution-4 survey
//     reliefflat | relief               relief_demo on S3's pinned claim, flat then natural (scenarios.mjs, phase 6c-t1): items 1-4, 6-10
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-t1/<step>.json in the main checkout (GATE6CT1_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-T1-run');
process.env.GATE6B_OUT = process.env.GATE6CT1_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-t1');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, state, startClient, stopClient, tp } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const PHASE = '6c-t1';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const MAIN_ART = () => path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts');

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice T1 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  // a lobby world, never a base: the client's autoworld would create a missing base as a normal world (MP's lesson)
  await startClient(process.argv[3] ?? 'G6C T1 Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[BASE, 'normal'], [FLAT, 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    await L.setRules(preset === 'flat' ? 'exact' : 'default');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline: unit, plan time, stale, api-compat

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.t1 = nodeTest(['kit/test/relief-t1.test.mjs']);
  check(out.t1.code === 0 && out.t1.fail === 0 && out.t1.pass >= 9, `unit (kit): the relief op (evaluation, clamps, refusals), Jacobi on a 5x5 hand case, erosion never moves a pin, the pass, declared passes (an undeclared pass fails), N-T1-1, relief_demo, the passes lint: ${out.t1.pass} pass, ${out.t1.fail} fail`, out.t1.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 11: format-1 goldens, S1's and S7's tile goldens, mega_bench and the 6b fixtures unchanged; the realise lint: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/regions-passes.test.ts', 'test/regions-real-kit-6b.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.sidecar = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§1-§3 (sidecar): declared passes pick the pass budget (120 s, 2 GB), region.planned carries the kit's passes, notes and siteplan.json the timings: ${out.sidecar.summary}`);
  return out;
};

/** One plan of relief_demo through the kit CLI in the helper's sandbox (permission model, no network, the pass heap). */
function sandboxPlan(dir, surveyFile, params, claim, heapMb) {
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'out', 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'params.json'), JSON.stringify(params));
  fs.copyFileSync(surveyFile, path.join(dir, 'out', 'survey.bin'));
  const o = path.join(dir, 'out');
  const node = ['--permission', `--allow-fs-read=${KIT}`, `--allow-fs-read=${o}`, `--allow-fs-write=${o}`, `--max-old-space-size=${heapMb}`,
    path.join(KIT, 'tools', 'region.mjs'), 'plan', path.join(KIT, 'regions', 'relief_demo.mjs'), '--params', path.join(o, 'params.json'), '--survey', path.join(o, 'survey.bin'),
    '--seed', '424242', '--claim', claim.join(','), '--blobs-out', path.join(o, 'blobs'), '--out', o, '--json'];
  const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
  const t0 = performance.now();
  const r = spawnSync('/usr/bin/time', [...timeArgs, process.execPath, ...node], { encoding: 'utf8', timeout: 600_000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  const wallMs = performance.now() - t0;
  const err = r.stderr ?? '';
  // peak RSS: macOS "maximum resident set size" in bytes; Linux "Maximum resident set size (kbytes)"
  const mac = /(\d+)\s+maximum resident set size/.exec(err), lin = /Maximum resident set size \(kbytes\): (\d+)/.exec(err);
  const peakMb = mac ? Number(mac[1]) / 1048576 : lin ? Number(lin[1]) / 1024 : null;
  const plan = fs.existsSync(path.join(o, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(o, 'plan.json'), 'utf8')) : null;
  return { code: r.status, wallMs, peakMb, plan, out: o, tail: `${r.stdout}`.split('\n').slice(-3).join('\n') + err.split('\n').filter((l) => /error|Error/.test(l)).slice(0, 5).join('\n') };
}

steps.plantime = async () => {
  const { synthBytes } = await imp('lib/region/synth.mjs');
  const dir = path.join(OUT, 'plantime');
  fs.mkdirSync(dir, { recursive: true });
  const surveyFile = path.join(dir, 'synth-1024.bin');
  // the committed generator (kit/lib/region/synth.mjs), seeded: 1024x1024 at resolution 1 (the size a pass program's second survey reaches)
  fs.writeFileSync(surveyFile, synthBytes({ minX: 0, minZ: 0, width: 1024, depth: 1024, resolution: 1, seed: 't1-bench' }));
  const params = { pads: 64, radius: 24 };
  const claim = [0, 0, 1023, 1023, -64, 319];
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = sandboxPlan(dir, surveyFile, params, claim, 2048);
    const pass = r.plan?.passRuns?.find((p) => p.name === 'relief');
    const fieldShas = Object.fromEntries((r.plan?.blobs ?? []).filter((b) => b.kind === 'field').map((b) => [b.name, b.sha]));
    runs.push({ code: r.code, wallMs: Math.round(r.wallMs), planMs: r.plan?.stats?.ms?.total ?? null, reliefMs: pass?.ms ?? null, passHeapMb: pass?.heapMb ?? null, peakMb: r.peakMb === null ? null : Math.round(r.peakMb),
      irSha: r.plan?.irSha ?? null, fieldShas, cells: r.plan?.budget?.cells ?? null, notes: r.plan?.notes ?? [], tail: r.code ? r.tail : undefined });
    if (i === 2 && r.plan) fs.cpSync(r.out, path.join(dir, 'last'), { recursive: true });
  }
  const med = (k) => { const v = runs.map((x) => x[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const out = { survey: { bytes: fs.statSync(surveyFile).size, sha: sha256(fs.readFileSync(surveyFile)), columns: 1024 * 1024 }, params, runs, median: { reliefMs: med('reliefMs'), wallMs: med('wallMs'), peakMb: med('peakMb') }, load1: os.loadavg()[0] };
  check(runs.every((x) => x.code === 0 && x.irSha), `item 5: 3 plans of relief_demo on the synthetic 1024x1024 survey in the sandbox (2048 MB heap): ${runs.map((x) => x.code).join(', ')} (${runs[0].notes.filter((n) => /relief_demo|pass/.test(n)).join('; ')})`);
  bar(out.median.reliefMs !== null && out.median.reliefMs <= 60_000, `item 5: the relief pass ${out.median.reliefMs} ms (median of 3), at most 60 s (load ${out.load1.toFixed(1)})`);
  bar(out.median.wallMs !== null && out.median.wallMs <= 120_000, `item 5: the whole plan ${out.median.wallMs} ms wall (median of 3), at most 120 s`);
  bar(out.median.peakMb !== null && out.median.peakMb <= 2048, `item 5: peak memory ${out.median.peakMb} MB RSS (median of 3), at most 2 GB`);
  // item 6 offline: the same IR and field blobs over the 3 plans; tile shas for 1 and 4 workers, forward and shuffled
  check(new Set(runs.map((x) => x.irSha)).size === 1, `item 6: the IR sha over 3 plans: ${runs.map((x) => x.irSha?.slice(0, 12)).join(', ')}`);
  check(new Set(runs.map((x) => JSON.stringify(x.fieldShas))).size === 1 && Object.keys(runs[0].fieldShas).length >= 1, `item 6: the field blob shas over 3 plans: ${JSON.stringify(Object.fromEntries(Object.entries(runs[0].fieldShas).map(([k, v]) => [k, v.slice(0, 12)])))}`);
  const { tileShas } = await import('./scenarios.mjs');
  const ts = await tileShas(path.join(dir, 'last'));
  out.tiles = { count: Object.keys(ts.tiles).length, cells: ts.cells, workersSame: ts.workersSame, timing: ts.timing };
  check(ts.workersSame, `item 6: ${out.tiles.count} tile shas equal for 1 and 4 workers, forward and shuffled`);
  return out;
};

steps.stale = async () => {
  const out = {};
  const dir = path.join(OUT, 'v0170-src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C '${root}' archive v0.17.0 kit | tar -x -C '${dir}'`]);
  // a relief plan from this kit: relief_demo on a flat claim (the hill and the blend)
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const survey = makeColumns(0, 0, 192, 192, 1); survey.ground.fill(64); survey.height.fill(64); survey.floor.fill(64);
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'relief_demo.mjs'), survey, claim, node: 'gate' });
  out.requires = p.ir.requires;
  out.kitVersion = p.ir.kitVersion;
  const old = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'realise.mjs')).href);
  const asOld = { ...p.ir, kitVersion: old.EVAL_KIT_VERSION }; // the kind alone, as if that kit had written it
  out.oldKit = { version: old.EVAL_KIT_VERSION, reason: old.staleReason(p.ir), kindOnly: old.staleReason(asOld) };
  let compiled = null;
  try { old.compileIR(p.ir, { blobs: (sha) => p.blobs.get(sha) }); } catch (e) { compiled = e.message; }
  out.oldKit.compile = compiled;
  check(/^PLAN_STALE: plan needs kit 0\.20\.0 \/ kinds \[relief\]; this is kit /.test(compiled ?? ''), `item 11: the v0.17.0 kit (${out.oldKit.version}) refuses the plan: ${compiled}`);
  check(/^plan needs kinds \[relief\]; this is kit /.test(out.oldKit.kindOnly ?? ''), `item 11: the v0.17.0 kit names the kind alone: ${out.oldKit.kindOnly}`);
  // nothing written: a stale plan never reaches a tile (the old evaluator throws before any cell)
  let wrote = null;
  try { wrote = old.evalTile(p.ir, '1,1', survey, { blobs: (sha) => p.blobs.get(sha) }).count; } catch (e) { wrote = `refused: ${e.message.slice(0, 60)}`; }
  out.oldKit.evalTile = wrote;
  check(typeof wrote === 'string' && wrote.startsWith('refused: PLAN_STALE'), `item 11: the v0.17.0 evaluator writes nothing (${wrote})`);
  // the v0.17.0 mod jar's IrStale on the same IR (its own compiled class, run with gson)
  const jar = path.join(MAIN_ART(), 'gate6c-w', 'v0170', 'architect_mc-0.17.0.jar');
  const gson = execFileSync('sh', ['-c', `ls '${path.join(root, '.gradle-home')}'/caches/modules-2/files-2.1/com.google.code.gson/gson/*/*/gson-*.jar | grep -v sources | head -1`]).toString().trim();
  const src = path.join(dir, 'Stale.java');
  fs.writeFileSync(src, 'import com.google.gson.*;\npublic class Stale { public static void main(String[] a) throws Exception { for (String f : a) { JsonObject ir = JsonParser.parseString(java.nio.file.Files.readString(java.nio.file.Path.of(f))).getAsJsonObject(); System.out.println(dev.larattalabs.architect.region.IrStale.reason(ir, null)); } } }\n');
  fs.writeFileSync(path.join(dir, 'ir.json'), p.irJson);
  fs.writeFileSync(path.join(dir, 'ir-kind-only.json'), JSON.stringify(asOld));
  const lines = execFileSync(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', `${jar}:${gson}`, src, path.join(dir, 'ir.json'), path.join(dir, 'ir-kind-only.json')]).toString().trim().split('\n');
  out.oldMod = { jar, lines };
  check(/^plan needs kit 0\.20\.0 \/ kinds \[relief\]; this is kit /.test(lines[0]) && /^plan needs kinds \[relief\]; this is kit /.test(lines[1] ?? ''), `item 11: the v0.17.0 mod's IrStale refuses it PLAN_STALE: ${lines.join(' | ')}`);
  const { staleReason } = await imp('lib/realise.mjs');
  out.thisKit = staleReason(p.ir);
  check(out.thisKit === null, 'item 11: this kit (0.20.0) accepts it');
  return out;
};

steps.apicompat = async () => {
  // this checkout's main and client classes, compiled at its HEAD first (incremental; api-compat's default class dirs)
  execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' });
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cw'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 12: api-compat against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ §3 in game: the resolution-1 second survey

steps.res1 = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B T1 Res1', FLAT);
  const claim = [10000, 10000, 10319, 10319];
  await tp(10160, 0, 10160);
  const surveyOf = (planId) => {
    const b = fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', planId, 'survey.bin'));
    return { resolution: b.readInt32LE(24), width: b.readInt32LE(16), depth: b.readInt32LE(20), bytes: b.length };
  };
  const p = await L.plan('relief_demo', claim, { surveyLoad: 'bounded:512', check: false });
  out.relief = { planId: p.planId, notes: p.notes, survey: surveyOf(p.planId), surveySha: p.surveySha };
  check(out.relief.survey.resolution === 1 && out.relief.survey.width === 320 && out.relief.survey.depth === 320, `§3: relief_demo (passes) on a 320x320 claim: the second plan's survey is resolution ${out.relief.survey.resolution}, ${out.relief.survey.width}x${out.relief.survey.depth} columns (${out.relief.survey.bytes} bytes)`);
  check((p.notes ?? []).some((n) => /^second plan: a resolution-1 survey for the passes \(320x320 columns/.test(n)) && (p.notes ?? []).some((n) => /^pass relief: /.test(n)), `§3: the plan notes name the second survey and the pass timing: ${(p.notes ?? []).filter((n) => /second plan|pass relief/.test(n)).join('; ')}`);
  const q = await L.plan('region_small', claim, { surveyLoad: 'bounded:512', check: false });
  out.noPasses = { planId: q.planId, notes: q.notes, survey: surveyOf(q.planId) };
  check(out.noPasses.survey.resolution === 4 && !(q.notes ?? []).some((n) => /second plan/.test(n)), `§3: region_small (no passes) on the same claim keeps the resolution-4 survey (${out.noPasses.survey.width}x${out.noPasses.survey.depth}) and one plan`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ the scenario runs (relief_demo on S3's pinned claim)

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-40).join('\n') };
}
const ART = () => path.join(path.resolve(process.env.SCENARIOS_ART), PHASE, 'relief_demo');
const latest = (flat) => {
  const d = ART();
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).map((x) => path.join(d, x)) : [];
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};
function scenarioStep(flat) {
  const r = scenario(['run', 'relief_demo', '--phase', PHASE, ...(flat ? ['--flat'] : [])]);
  const dir = latest(flat);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  const rows = m?.rows ?? [];
  for (const x of rows) {
    if (!x.gated || x.id === 'gallery') continue;
    if (flat && (x.id === 'golden' || x.id === 'determinism' || x.id === 'exactness')) continue; // judged by the natural run (scenarios.mjs)
    if (x.id === 'mspt' || x.id === 't1-tiles') bar(x.pass, `${x.label}: ${x.value}`);
    else check(x.pass, `${x.label}: ${x.value}`);
  }
  check(r.code === 0, `scenarios.mjs run relief_demo${flat ? ' --flat' : ''}: exit ${r.code}${r.fails.length ? ` (${r.fails.join('; ')})` : ''}`);
  return { dir, exit: r.code, evidence: dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null, relief: m?.relief ?? null, rows };
}
steps.reliefflat = async () => scenarioStep(true);
steps.relief = async () => scenarioStep(false);

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'plantime', 'stale', 'apicompat', 'res1', 'reliefflat', 'relief']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  const md = `# Gate 6c-T1 (passes, fields and relief)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ct1.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
