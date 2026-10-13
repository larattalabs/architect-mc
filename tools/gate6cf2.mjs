#!/usr/bin/env node
// Phase 6c slice F2 gate (docs/CONTRACT.md "Phase 6c slice F2: scatter and feature stamps", §5) against a dev client (or a headless
// server) of a run worktree (`../architect-mc-F2-run` by hand; the gate runner's own under tools/gate-run.mjs; the sim sidecar, no
// Claude). Ports 8924 (sidecar) / 8925 (DevBridge) by hand. $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cf2.mjs <step>
//     start [world] | stop | base      the client and the base worlds (6b's G6B Seed Base: seed 2026100906, S2's and the volume fixture's
//                                       world; G6B Flat Base)
//     unit                              items 1-3, 5, 7, 10 offline: kit/test/scatter-f2.test.mjs (tile independence 1 vs 4 workers and the
//                                       K2 window check, density over 50 seeds, supports over 60 seeded claims, stamps turned + skirt,
//                                       determinism and the kit golden with synthetic stamps), the goldens that must not move (S1, S7,
//                                       mega_bench, the 6b fixtures, forms_demo, relief_demo), the Java ApiF2Test; N-F2-1: no stamp in the
//                                       repo, none in the built jar
//     stale                             item 10: the v0.21.0 kit and mod jar refuse a scatter/stamp plan PLAN_STALE (no game: their own code)
//     apicompat                         item 11: api-compat against the 0.22.0, 0.21.0 and 0.20.0 apitest jars and the 0.22.0 surface
//     harvest                           item 6 in game: the stamp library harvested in a scratch superflat world into the game's
//                                       architect/stamps (local-only, N-F2-1), then again into a temp dir: every stamp byte-identical
//     pin                               scatter_demo's and scatter_cave's program seeds and cameras (scenarios/*.json), once
//     report                            REPORT.md over the step JSONs
//   The scenario runs (items 1, 3-5, 7-9 on the realised world) are tools/scenarios.mjs run scatter_demo [--flat] / scatter_cave
//   --phase 6c-f2 (gate-chains step 6cf2-scenario-scatter).
//
// Evidence: artifacts/gate6c-f2/<step>.json in the main checkout (GATE6CF2_OUT overrides), REPORT.md, spend.json. Timing lines use
// bar() (docs/GATES.md "Timing bars": recorded in change and slice, judged at release).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-F2-run');
process.env.GATE6B_OUT = process.env.GATE6CF2_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-f2');
process.env.GATE6B_SIDECAR_PORT ??= '8924';
process.env.GATE6B_DEV_PORT ??= '8925';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, GAME_DIR, call, check, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, startClient, state, stopClient, write } = L;
const { LIBRARY, SEEDS } = await import('./lib/stamp-library.mjs');

refuseKeys();
fs.mkdirSync(OUT, { recursive: true });
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const MAIN_ART = () => path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts');
const SCRATCH = 'F2 Stamps';

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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice F2 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B Flat Base', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'gate6b.mjs'), 'base'], { cwd: root, encoding: 'utf8', env: process.env });
  check(r.status === 0, `base: gate6b base (exit ${r.status})`);
  spendZero();
  return { tail: `${r.stdout}${r.stderr}`.split('\n').slice(-10).join('\n') };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, env = {}) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, ...env } });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}
const gradle = (args) => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') } });

steps.unit = async () => {
  const out = {};
  out.f2 = nodeTest(['kit/test/scatter-f2.test.mjs']);
  check(out.f2.code === 0 && out.f2.fail === 0 && out.f2.pass >= 9, `items 1-3, 5, 7, 10 (kit): scatter-f2 (tiles 1 = 4 workers and the K2 window, density over 50 seeds, supports over 60 claims, stamps turned + skirt, 4 turns identity, anchors, the lantern's melt clearing, the missing-stamp fallback, IR x3 and the kit golden): ${out.f2.pass} pass, ${out.f2.fail} fail`, out.f2.failing);
  out.goldens = nodeTest(['--test-skip-pattern=evaluation cost', 'kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/forms-f1.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/village.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 10: the goldens that must not move (mega_bench tiles, S1, S7, forms_demo, relief_demo, the 6b fixtures, villages) and scatter_demo's committed scenario golden: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  const j = gradle(['test', '--offline', '-q', '--tests', 'dev.larattalabs.architect.region.ApiF2Test', '--tests', 'dev.larattalabs.architect.region.ApiT1Test', '--tests', 'dev.larattalabs.architect.region.PlanStaleTest']);
  check(j.status === 0, `item 10 (mod): ApiF2Test (features, kinds appended after relief, a T1 game refuses scatter/stamp), ApiT1Test, PlanStaleTest (exit ${j.status})`, j.status ? `${j.stdout}${j.stderr}`.slice(-1500) : undefined);
  // N-F2-1: no stamp in the repo, none in the jar
  const tracked = execFileSync('git', ['-C', root, 'ls-files']).toString().split('\n').filter((f) => /(^|\/)stamps\//.test(f) || /\.arsp$/.test(f));
  check(tracked.length === 0, `N-F2-1: no stamp file tracked in the repo (${tracked.length ? tracked.slice(0, 5).join(', ') : 'none'})`);
  const libs = path.join(root, 'mod', 'build', 'libs');
  const jar = fs.existsSync(libs) ? fs.readdirSync(libs).filter((f) => /^architect_mc-.*\.jar$/.test(f) && !f.includes('sources')).sort().pop() : null;
  if (jar) {
    const list = execFileSync('unzip', ['-l', path.join(libs, jar)]).toString();
    const stampEntries = list.split('\n').filter((l) => /stamps\//.test(l));
    check(stampEntries.length === 0, `N-F2-1: the built jar ${jar} holds no stamp (${stampEntries.length} entries under stamps/)`);
    out.jar = { jar, stampEntries: stampEntries.length };
  } else check(false, 'N-F2-1: no built mod jar to list (run the mod build first)');
  return out;
};

steps.stale = async () => {
  const out = {};
  const dir = path.join(OUT, 'v0210-src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C '${root}' archive v0.21.0 kit | tar -x -C '${dir}'`]);
  // a scatter + stamp plan from this kit: scatter_demo over a synthetic survey with synthetic stamps (no vanilla data)
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { synthSurvey, synthWorld } = await imp('lib/region/synth.mjs');
  const { syntheticStamp } = await imp('lib/region/stamps.mjs');
  const claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const stamps = new Map(['oak/1', 'birch/1', 'spruce/1', 'acacia/1', 'dark_oak/1', 'spruce/2', 'oak/2'].map((k, i) => [k, syntheticStamp('tree', i + 1)]));
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'scatter_demo.mjs'), survey: synthSurvey(claim, 'golden', synthWorld('golden')), claim, stamps, node: 'test' });
  out.requires = p.ir.requires;
  out.kitVersion = p.ir.kitVersion;
  check(p.ir.requires.includes('scatter') && p.ir.requires.includes('stamp'), `item 10: the plan requires scatter and stamp (${p.ir.requires.join(', ')})`);
  const old = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'realise.mjs')).href);
  const asOld = { ...p.ir, kitVersion: old.EVAL_KIT_VERSION };
  let compiled = null;
  try { old.compileIR(p.ir, { blobs: (sha) => p.blobs.get(sha) }); } catch (e) { compiled = e.message; }
  out.oldKit = { version: old.EVAL_KIT_VERSION, compile: compiled, kindOnly: old.staleReason(asOld) };
  check(new RegExp(`^PLAN_STALE: plan needs kit ${p.ir.kitVersion.replaceAll('.', '\\.')} / kinds \\[scatter, stamp\\]; this is kit ${old.EVAL_KIT_VERSION.replaceAll('.', '\\.')}$`).test(compiled ?? ''), `item 10: the v0.21.0 kit (${old.EVAL_KIT_VERSION}) refuses the plan: ${compiled}`);
  check(out.oldKit.kindOnly === `plan needs kinds [scatter, stamp]; this is kit ${old.EVAL_KIT_VERSION}`, `item 10: the v0.21.0 kit names the kinds alone: ${out.oldKit.kindOnly}`);
  // the 0.21.0 mod jar's IrStale on the same IR (its own compiled class, run with gson)
  const jar = path.join(MAIN_ART(), 'gate6c-f2', 'v0210', 'architect_mc-0.21.0.jar');
  const gson = execFileSync('sh', ['-c', `ls '${path.join(root, '.gradle-home')}'/caches/modules-2/files-2.1/com.google.code.gson/gson/*/*/gson-*.jar | grep -v sources | head -1`]).toString().trim();
  const src = path.join(dir, 'Stale.java');
  fs.writeFileSync(src, 'import com.google.gson.*;\npublic class Stale { public static void main(String[] a) throws Exception { for (String f : a) { JsonObject ir = JsonParser.parseString(java.nio.file.Files.readString(java.nio.file.Path.of(f))).getAsJsonObject(); System.out.println(dev.larattalabs.architect.region.IrStale.reason(ir, null)); } } }\n');
  fs.writeFileSync(path.join(dir, 'ir.json'), p.irJson);
  fs.writeFileSync(path.join(dir, 'ir-kind-only.json'), JSON.stringify(asOld));
  const java = path.join(process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', 'bin', 'java');
  const lines = execFileSync(java, ['-cp', `${jar}:${gson}`, src, path.join(dir, 'ir.json'), path.join(dir, 'ir-kind-only.json')]).toString().trim().split('\n');
  out.oldMod = { jar, lines };
  check(lines[0] === `plan needs kit ${p.ir.kitVersion} / kinds [scatter, stamp]; this is kit ${old.EVAL_KIT_VERSION}` && lines[1] === `plan needs kinds [scatter, stamp]; this is kit ${old.EVAL_KIT_VERSION}`, `item 10: the 0.21.0 mod's IrStale refuses it PLAN_STALE: ${lines.join(' | ')}`);
  const { staleReason } = await imp('lib/realise.mjs');
  out.thisKit = staleReason(p.ir);
  check(out.thisKit === null, `item 10: this kit (${p.ir.kitVersion}) accepts it`);
  return out;
};

steps.apicompat = async () => {
  const classes = path.join(root, 'mod', 'build', 'classes', 'java', 'main');
  if (!fs.existsSync(classes)) gradle(['compileJava', 'compileClientJava', '--offline', '-q']);
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cf2'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 11: api-compat against the 0.22.0, 0.21.0 and 0.20.0 apitest jars and the 0.22.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ item 6: the harvest, twice

const sha = (b) => createHash('sha256').update(b).digest('hex');
steps.harvest = async () => {
  await ensure();
  const flatScratch = path.join(SAVES, SCRATCH, 'level.dat');
  await openWorld(SCRATCH, fs.existsSync(flatScratch) ? {} : { mode: 'creative', preset: 'flat', seed: '2026101201', cheats: true });
  await call('dev.camera', { x: 8.5, y: -40, z: 8.5, yaw: 0, pitch: 30 }).catch(() => null);
  const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
  const lib = path.join(GAME_DIR, 'architect', 'stamps');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-stamps-'));
  const rows = [];
  let placed = 0, same = 0, total = 0;
  const t0 = Date.now();
  try {
    for (const e of LIBRARY) {
      const a = await call('dev.feature.stamp', { feature: e.feature, seeds, ground: e.ground }, 600_000);
      const b = await call('dev.feature.stamp', { feature: e.feature, seeds, ground: e.ground, dir: tmp }, 600_000);
      for (const s of a.stamps) {
        total++;
        const s2 = b.stamps.find((x) => x.seed === s.seed);
        const ok = !!(s.placed && s.cells);
        if (ok) placed++;
        const eq = !!s.file && !!s2?.file && Buffer.compare(fs.readFileSync(s.file), fs.readFileSync(s2.file)) === 0;
        if (eq) same++;
        rows.push({ feature: e.feature, ground: e.ground, seed: s.seed, placed: s.placed, cells: s.cells, size: s.size, root: s.root, palette: s.palette, blockEntities: s.blockEntities, edge: s.edge, sha: s.sha, sha2: s2?.sha ?? null, fileSha: s.file ? sha(fs.readFileSync(s.file)) : null, same: eq });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    await leaveWorld().catch(() => {});
  }
  check(placed === total && total === LIBRARY.length * SEEDS, `item 6: every library stamp harvested (${placed} of ${total}: ${LIBRARY.length} features x ${SEEDS} seeds) into ${path.relative(root, lib) || lib} (local-only, N-F2-1)`);
  check(same === total, `item 6: re-harvesting each stamp on the same version gives the same bytes (${same} of ${total})`, rows.filter((r) => !r.same).slice(0, 10));
  const edge = rows.filter((r) => r.edge > 0);
  check(edge.length === 0, `harvest: no stamp touches the capture box's edge (${edge.map((r) => `${r.feature}/${r.seed}`).join(', ') || 'none'})`);
  L.bar(Date.now() - t0 < 600_000, `harvest: ${total} stamps twice in ${((Date.now() - t0) / 1000).toFixed(0)} s (load ${os.loadavg()[0].toFixed(1)})`);
  spendZero();
  return { lib, rows };
};

// ------------------------------------------------------------------ the scenario pins

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, tail: t.split('\n').slice(-40).join('\n') };
}
steps.pin = async () => {
  await ensure();
  const out = {};
  for (const id of ['scatter_demo', 'scatter_cave']) {
    const r = scenario(['pin', id]);
    check(r.code === 0, `pin: ${id}'s seed and cameras (exit ${r.code})`, r.code ? r.tail : undefined);
    out[id] = r.tail.slice(-800);
  }
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'stale', 'apicompat', 'harvest']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([m, r]) => !r.ok && !m.startsWith('BAR '));
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : m.startsWith('BAR ') ? 'BAR (recorded)' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = fs.existsSync(path.join(OUT, 'spend.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8')) : { totalUsd: 0, capUsd: 0 };
  const md = `# Gate 6c-F2 (scatter and feature stamps)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}). The scenario runs (scatter_demo flat and natural, scatter_cave) are under the scenarios dir; their rows in each run's metrics.json.\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cf2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
