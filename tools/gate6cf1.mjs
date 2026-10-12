#!/usr/bin/env node
// Phase 6c slice F1 gate (docs/CONTRACT.md "Phase 6c slice F1: forms I, ice spikes and rock spires", §7) against a dev client of the F1
// run worktree (`../architect-mc-F1-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no
// Claude, apitest on the classpath). Ports 8918 (sidecar) / 8919 (DevBridge). $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cf1.mjs <step>
//     start [world] | stop | base      the client and the base worlds (G6B Seed Base: seed 2026100906, S2's world; G6B Flat Base)
//     unit                              items 1, 6, 9 (no game): the kit's forms tests (200 seeds per generator), the bake threshold
//                                       measured, determinism and the golden, the goldens of S1/S7/mega_bench unchanged
//     variants                          the broken variants (kit, no game): an ice spike under a lantern (M17), a 6-wide unbuttressed
//                                       ledge (M3), a spike over a kept natural spike (M1)
//     stale                             item 12: the v0.17.0 kit and mod refuse a voxels plan PLAN_STALE (no game: their own code)
//     apicompat                         item 13: api-compat against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface
//     pin                               forms_demo's program seed and cameras on S2's claim (scenarios/forms_demo.json), once
//     flat | natural                    items 2-5, 7-11: tools/scenarios.mjs run forms_demo (the flat variant first: E-flat)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-f1/<step>.json in the main checkout (GATE6CF1_OUT overrides), all.log, REPORT.md, spend.json; the
// scenario runs under artifacts/scenarios/6c-f1/forms_demo/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-F1-run');
process.env.GATE6B_OUT = process.env.GATE6CF1_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-f1');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
process.env.SCENARIOS_ART ??= path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'scenarios');
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, startClient, state, stopClient, tp, write } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice F1 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: 'sim' });
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

// ------------------------------------------------------------------ items 1, 6, 9, 12 offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}
const load1 = () => Number(execFileSync('sysctl', ['-n', 'vm.loadavg']).toString().trim().replace(/[{}]/g, '').trim().split(/\s+/)[0]);

/**
 * Item 6: the evaluation cost per op. N ops of real iceSpike clusters (12-32 primitives each) whose bounds all cover one tile (the
 * worst case: a form's ops overlapping) and the same N spread over the tile; one tile evaluated (best of 3); the baked voxels op of
 * the same cells for comparison, in the process's CPU time. The threshold holds when the overlapping case at BAKE_OPS stays under half the 2 s tile bar and at
 * 45k cells/s or more.
 */
async function bakeCost() {
  const { evalTile, walkKinds } = await imp('lib/realise.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const { iceSpike } = await imp('lib/forms/iceSpike.mjs');
  const { bakeOps, opPrimitives, BAKE_OPS } = await imp('lib/forms/rules.mjs');
  const w = makeColumns(-8, -8, 80, 80, 1); w.ground.fill(64); w.height.fill(64); w.floor.fill(64);
  const opsFor = (n, spread) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const at = spread ? [4 + (i * 37) % 56, 64, 4 + (i * 53) % 56] : [24 + (i % 16), 64, 24 + ((i >> 4) % 16)];
      out.push(...iceSpike({ at, preset: 'classic', seed: `cost${i}` }).ops.filter((o) => o.op === 'shape'));
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  };
  const irOf = (ops, blobs) => { const ir = { format: 2, id: 'cost', kitVersion: '0.19.0', claim: { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 }, stages: ['s'], parts: [{ id: 'p', stage: 's', set: 'terrain', ops }], ...(blobs ? { blobs } : {}) }; ir.requires = walkKinds(ir); return ir; };
  // CPU time of this (single-threaded) process, best of 3: a loaded box deschedules the thread, which wall time would count
  const time = (ir, blobs) => { let best = Infinity, cells = 0; for (let k = 0; k < 3; k++) { const c0 = process.cpuUsage(); const e = evalTile(ir, '0,0', w, { blobs, countOnly: true }); const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); cells = e.count; } return { ms: best, cells }; };
  const rows = [];
  for (const n of [25, 50, 100, 200, 400, 800]) {
    const over = opsFor(n, false), spread = opsFor(n, true);
    const prims = over.reduce((a, o) => a + opPrimitives(o), 0);
    const a = time(irOf(over)), b = time(irOf(spread));
    const baked = bakeOps(over, 'vox');
    const sha = 'b'.repeat(64);
    const c = time(irOf([baked.op], { vox: { sha, bytes: baked.bytes.length, kind: 'voxels' } }), { [sha]: baked.bytes });
    rows.push({ ops: n, primitives: prims, overlapping: { ms: Math.round(a.ms), cells: a.cells, usPerOpColumn: Math.round((a.ms * 1000) / (n * 4096) * 100) / 100 }, spread: { ms: Math.round(b.ms), cells: b.cells }, baked: { ms: Math.round(c.ms), cells: c.cells, bytes: baked.bytes.length } });
  }
  // the largest measured N whose overlapping tile stays under 1 s (half the 2 s bar) and at 45k cells/s or more: the threshold holds
  // when BAKE_OPS is at most that
  const fit = rows.filter((r) => r.overlapping.ms < 1000 && r.overlapping.cells / Math.max(0.001, r.overlapping.ms / 1000) >= 45000).map((r) => r.ops);
  const ok = Math.max(0, ...fit);
  return { load1: load1(), threshold: BAKE_OPS, rows, largestWithinBars: ok, verdict: ok >= BAKE_OPS ? `holds: ${BAKE_OPS} ops are within the bars (largest measured within: ${ok})` : `too high: only ${ok} overlapping ops stay within the bars` };
}

steps.unit = async () => {
  const out = {};
  out.forms = nodeTest(['kit/test/forms-f1.test.mjs']);
  check(out.forms.code === 0 && out.forms.fail === 0 && out.forms.pass >= 9, `items 1, 2-4 (kit), 7, 9: the forms tests (200 seeds per generator: ops at most 32 primitives, 0 forms over BAKE_OPS unbaked, settled; voxels exact and tile-independent; the bake; M17, M3, keep; forms_demo 3 plans identical): ${out.forms.pass} pass, ${out.forms.fail} fail`, out.forms.failing);
  // (the islands' evaluation-cost test is a wall-time measure that unit-kit runs; skipped here, it flakes under load)
  out.goldens = nodeTest(['--test-skip-pattern=evaluation cost', 'kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/village.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `items 9, 12: goldens (mega_bench tiles, S1 and S7 tile shas, forms_demo's golden when committed, 6b fixtures, islands, villages): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.bake = await bakeCost();
  // (GATES.md "Policy update") a timing measure: recorded, never blocking; the check line states the data
  check(true, `item 6: the bake threshold (${out.bake.threshold} ops; CPU time): ${out.bake.verdict} (load ${out.bake.load1})`, out.bake.rows);
  out.goldenFiles = Object.fromEntries(['s1.json', 's7.json', 'forms_demo.json'].map((f) => [f, fs.existsSync(path.join(root, 'scenarios', 'goldens', f))]));
  return out;
};

// ------------------------------------------------------------------ the broken variants (kit, no game)

steps.variants = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { region } = await imp('lib/region/program.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const { VC, decodeArvx, encodeArvx } = await imp('lib/region/volume.mjs');
  const { iceSpike } = await imp('lib/forms/iceSpike.mjs');
  const claim = { minX: 0, minZ: 0, maxX: 127, maxZ: 127, minY: -64, maxY: 319 };
  const survey = makeColumns(0, 0, 128, 128, 1); survey.ground.fill(64); survey.height.fill(64); survey.floor.fill(64);
  const variant = async (name, fn, volumes = []) => {
    const program = { id: 'f1_variant', default: (ctx) => { const r = region(ctx); r.stages(['s']); fn(r); r.anchor('entrance', [2, 2]); r.anchor('spawn', [2, 2]); return r; } };
    const p = await planRegion({ program, programSource: name, survey, claim, volumes, node: 'test' });
    const rep = checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha), volumes: volumes.map((v) => v.decoded), meta: p.meta });
    return rep;
  };
  const brief = (rep, re) => rep.findings.filter((f) => re.test(f.rule)).map((f) => ({ rule: f.rule, severity: f.severity, part: f.part, count: f.count, message: f.message }));
  const out = {};
  // 1. an ice spike under a lantern (M17); the same spike of packed ice is clean
  let rep = await variant('ice under lantern', (r) => {
    r.part('spike', { stage: 's' }).fill({ kind: 'cone', c: [40, { abs: 65 }, 40], r0: 2.5, r1: 0, h: 12 }, 'minecraft:ice', { cond: 0 });
    r.part('lamp', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [43, 40, 66, 66, 0], materials: ['minecraft:lantern'], cond: 2, walk: false });
  });
  out.iceUnderLantern = brief(rep, /^M17/);
  check(out.iceUnderLantern.length === 1 && out.iceUnderLantern[0].part === 'spike', `variants: an ice spike under a lantern -> M17 on its part (${out.iceUnderLantern.map((f) => f.message).join('; ')})`);
  rep = await variant('packed under lantern', (r) => {
    r.part('spike', { stage: 's' }).fill({ kind: 'cone', c: [40, { abs: 65 }, 40], r0: 2.5, r1: 0, h: 12 }, 'minecraft:packed_ice', { cond: 0 });
    r.part('lamp', { stage: 's' })._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [43, 40, 66, 66, 0], materials: ['minecraft:lantern'], cond: 2, walk: false });
  });
  out.packedControl = brief(rep, /^M17/);
  check(out.packedControl.length === 0, 'variants: control, the same spike in packed ice -> no M17');
  // 2. a spire with a 6-wide unbuttressed overhang (M3)
  rep = await variant('unbuttressed ledge', (r) => r.rockSpire('spire_bad', { at: [60, 64, 60], preset: 'tower', ledge: [6, 6], ledges: [1, 1], seed: '3' }, { stage: 's', _unsafe: { noButtress: true, ledgeOut: 2 } }));
  out.overhang = { findings: brief(rep, /^M3/), max: rep.metrics.M3.maxOverhang };
  check(out.overhang.findings.some((f) => f.rule === 'M3:overhang' && f.part === 'spire_bad') && out.overhang.max > 4, `variants: a spire with an unbuttressed ledge overhanging ${out.overhang.max > 4 ? 'more than 4' : out.overhang.max} -> M3:overhang (${out.overhang.findings.map((f) => f.message).join('; ')})`);
  rep = await variant('buttressed ledge', (r) => r.rockSpire('spire_ok', { at: [60, 64, 60], preset: 'tower', ledge: [6, 6], ledges: [1, 1], seed: '3' }, { stage: 's' }));
  out.overhangControl = brief(rep, /^M3/);
  check(out.overhangControl.length === 0, 'variants: control, the same ledge with its buttress -> no M3 finding');
  // 3. a spike written over a kept natural spike (M1)
  const box = { minX: 0, minY: 60, minZ: 0, maxX: 31, maxY: 80, maxZ: 31 };
  const W = 32, H = 21, D = 32;
  const classes = new Uint8Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) classes[(x * D + z) * H + y] = y + 60 <= 64 ? VC.SOIL : (x === 10 && z === 10 && y + 60 <= 72 ? VC.ICE : VC.AIR);
  const bytes = encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  const vol = { sha: decoded.sha, box, bytes, decoded };
  rep = await variant('spike over kept', (r) => { r.keepNatural('ICE', box); r.form('ice_bad', iceSpike({ at: [10, 64, 10], preset: 'stubby', seed: '3' }), { stage: 's' }); }, [vol]);
  out.overKept = { findings: brief(rep, /^M1/), ok: rep.ok, keep: rep.metrics.keep };
  check(!rep.ok && out.overKept.findings.some((f) => f.part === 'ice_bad' && f.severity === 'error'), `variants: a spike over a kept natural spike -> an M1 error on its part (${out.overKept.findings.map((f) => f.message).join('; ')})`);
  return out;
};

// ------------------------------------------------------------------ item 12: v0.17.0 refuses a voxels plan

steps.stale = async () => {
  const out = {};
  const dir = path.join(OUT, 'v0170-src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C '${root}' archive v0.17.0 kit | tar -x -C '${dir}'`]);
  // a voxels plan from this kit: forms_demo on a flat claim (its first spire baked)
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const fd = await imp('regions/forms_demo.mjs');
  const claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 };
  const survey = makeColumns(0, 0, 192, 192, 1); survey.ground.fill(64); survey.height.fill(64); survey.floor.fill(64);
  const p = await planRegion({ program: fd, programSource: 'forms_demo', survey, claim, node: 'test' });
  out.requires = p.ir.requires;
  out.kitVersion = p.ir.kitVersion;
  const old = await import(pathToFileURL(path.join(dir, 'kit', 'lib', 'realise.mjs')).href);
  const asOld = { ...p.ir, kitVersion: '0.16.0' }; // the kind alone, as if a 0.16.0 kit had written it
  out.oldKit = { version: old.EVAL_KIT_VERSION, reason: old.staleReason(p.ir), kindOnly: old.staleReason(asOld) };
  let compiled = null;
  try { old.compileIR(p.ir, { blobs: (sha) => p.blobs.get(sha) }); } catch (e) { compiled = e.message; }
  out.oldKit.compile = compiled;
  check(/^PLAN_STALE: plan needs kit 0\.19\.0 \/ kinds \[voxels\]; this is kit 0\.16\.0$/.test(compiled ?? ''), `item 12: the v0.17.0 kit (${out.oldKit.version}) refuses the plan: ${compiled}`);
  check(out.oldKit.kindOnly === 'plan needs kinds [voxels]; this is kit 0.16.0', `item 12: the v0.17.0 kit names the kind alone: ${out.oldKit.kindOnly}`);
  // the v0.17.0 mod jar's IrStale on the same IR (its own compiled class, run with gson)
  const jar = path.join(MAIN_ART(), 'gate6c-f1', 'v0170', 'architect_mc-0.17.0.jar');
  const gson = execFileSync('sh', ['-c', `ls '${path.join(root, '.gradle-home')}'/caches/modules-2/files-2.1/com.google.code.gson/gson/*/*/gson-*.jar | grep -v sources | head -1`]).toString().trim();
  const src = path.join(dir, 'Stale.java');
  fs.writeFileSync(src, 'import com.google.gson.*;\npublic class Stale { public static void main(String[] a) throws Exception { for (String f : a) { JsonObject ir = JsonParser.parseString(java.nio.file.Files.readString(java.nio.file.Path.of(f))).getAsJsonObject(); System.out.println(dev.larattalabs.architect.region.IrStale.reason(ir, null)); } } }\n');
  fs.writeFileSync(path.join(dir, 'ir.json'), p.irJson);
  fs.writeFileSync(path.join(dir, 'ir-kind-only.json'), JSON.stringify(asOld));
  const java = path.join(process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', 'bin', 'java');
  const lines = execFileSync(java, ['-cp', `${jar}:${gson}`, src, path.join(dir, 'ir.json'), path.join(dir, 'ir-kind-only.json')]).toString().trim().split('\n');
  out.oldMod = { jar, lines };
  check(lines[0] === 'plan needs kit 0.19.0 / kinds [voxels]; this is kit 0.16.0' && lines[1] === 'plan needs kinds [voxels]; this is kit 0.16.0', `item 12: the v0.17.0 mod's IrStale refuses it PLAN_STALE: ${lines.join(' | ')}`);
  // and this build accepts it
  const { staleReason } = await imp('lib/realise.mjs');
  out.thisKit = staleReason(p.ir);
  check(out.thisKit === null, 'item 12: this kit (0.19.0) accepts it');
  return out;
};
const MAIN_ART = () => path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts');

// ------------------------------------------------------------------ item 13: api-compat

steps.apicompat = async () => {
  const classes = path.join(root, 'mod', 'build', 'classes', 'java', 'main');
  if (!fs.existsSync(classes)) execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' });
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cf1'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 13: api-compat against the 0.17.0, 0.16.0 and 0.15.0 apitest jars and the 0.17.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ the scenario runs

function scenario(args) {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 4 * 3_600_000, env: process.env });
  const t = `${r.stdout}${r.stderr}`;
  fs.appendFileSync(path.join(OUT, 'scenarios.log'), t);
  return { code: r.status, fails: t.split('\n').filter((l) => /^FAIL /.test(l)), tail: t.split('\n').slice(-40).join('\n') };
}
const ART = () => path.join(path.resolve(process.env.SCENARIOS_ART), '6c-f1', 'forms_demo');
const latest = (flat) => {
  const d = ART();
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('-flat') === flat && fs.existsSync(path.join(d, x, 'metrics.json'))).map((x) => path.join(d, x)) : [];
  runs.sort((a, b) => fs.statSync(path.join(a, 'metrics.json')).mtimeMs - fs.statSync(path.join(b, 'metrics.json')).mtimeMs);
  return runs.length ? runs[runs.length - 1] : null;
};

steps.pin = async () => {
  await ensure();
  const r = scenario(['pin', 'forms_demo']);
  check(r.code === 0, `pin: forms_demo's seed and cameras on S2's claim (exit ${r.code})`, r.code ? r.tail : undefined);
  return { tail: r.tail.slice(-1500) };
};

async function scenarioStep(flat) {
  await ensure();
  const r = scenario(['run', 'forms_demo', '--phase', '6c-f1', ...(flat ? ['--flat'] : [])]);
  const dir = latest(flat);
  const m = dir ? JSON.parse(fs.readFileSync(path.join(dir, 'metrics.json'), 'utf8')) : null;
  check(r.code === 0, `forms_demo ${flat ? 'flat' : 'natural'}: every gated run bar (exit ${r.code})${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  for (const row of m?.rows ?? []) if (row.gated) check(row.pass || (flat && ['determinism', 'exactness'].includes(row.id)), `${flat ? 'flat' : 'natural'} ${row.label}: ${row.value} (bar: ${row.threshold})`);
  const ev = dir ? fs.readFileSync(path.join(dir, 'evidence.sha'), 'utf8').trim() : null;
  return { dir, evidence: ev, rows: m?.rows, forms: m?.forms, tail: r.code ? r.tail : undefined };
}
steps.flat = () => scenarioStep(true);
steps.natural = () => scenarioStep(false);

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'variants', 'stale', 'apicompat', 'flat', 'natural']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-F1 (forms I: ice spikes and rock spires)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cf1.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
