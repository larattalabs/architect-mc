#!/usr/bin/env node
// Phase 6c slice MP gate (docs/CONTRACT.md "Phase 6c slice MP: masks and patterns" §4). The offline items need no game; the
// in-game ones run on a dev client of the MP run worktree (`../architect-mc-MP-run` by default, a detached worktree at this
// checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no Claude, apitest on the classpath). Ports 8924 (sidecar) /
// 8925 (DevBridge) unless the runner gives others. $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cmp.mjs <step>
//     start [world] | stop | base     the client and the base worlds (as gate6b base)
//     pin                             the crater_toolbox scenario's seed, cameras and lot entries (scenarios.mjs pin; once)
//     unit                            items 1-6 and 8 offline: kit/test/mp.test.mjs (mix shares, gradients, masks vs the reference,
//                                     tile independence and the kit golden, the drift fixture, crater without the toolbox), the
//                                     tile goldens that must not move (S1, S7, mega_bench, the 6b family fixtures), the Java
//                                     ApiMPTest + MaskPatternDriftTest (item 6's other half) + PlanStaleTest
//     stale                           item 9: the v0.18.0 kit (staleReason) and the 0.18.0 mod jar (IrStale) refuse a mask/pattern IR
//                                     PLAN_STALE; this build accepts it
//     apicompat                       item 11: tools/api-compat.mjs --gate6cmp (the run worktree's classes, built by unit-mod); with a
//                                     client up, the apitest apimp check (Mask/Pattern through the public API, in game)
//     judge                           items 5, 7 and 10 (timing: BAR lines) from the scenario runs (SCENARIOS_ART/mp-flat, mp): IR sha over 3 plans,
//                                     1 vs 4 workers, the golden; E-flat 0, E-normal classified <= 0.01%; Architect's own tick
//                                     <= 50 ms; the tile evaluation over the natural run's plan: p99 under 2 s, >= 45k cells/s
//     report                          REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-mp/<step>.json in the main checkout (GATE6CMP_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-MP-run');
process.env.GATE6B_OUT = process.env.GATE6CMP_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-mp');
process.env.GATE6B_SIDECAR_PORT ??= '8924';
process.env.GATE6B_DEV_PORT ??= '8925';
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, MAIN, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, startClient, state, stopClient, write } = L;

refuseKeys();
const FLAT = 'G6B Flat Base';
const ART = process.env.SCENARIOS_ART ? path.resolve(process.env.SCENARIOS_ART) : path.join(MAIN, 'artifacts', 'scenarios');
const BASELINE = path.join(MAIN, 'artifacts', 'gate6c-f1', 'v0180'); // (v0.19.0) one 0.18.0 baseline for F1 and MP
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice MP is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
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
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'gate6b.mjs'), 'base'], { cwd: root, encoding: 'utf8', env: process.env });
  check(r.status === 0, `base worlds (gate6b base): exit ${r.status}`);
  spendZero();
  return { out: `${r.stdout}`.slice(-2000) };
};
steps.pin = async () => {
  await ensure();
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), 'pin', 'crater_toolbox'], { cwd: root, encoding: 'utf8', env: process.env, timeout: 3_600_000 });
  check(r.status === 0, `pin crater_toolbox: exit ${r.status}`, `${r.stdout}${r.stderr}`.slice(-1500));
  return JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'crater_toolbox.json'), 'utf8'));
};

// ------------------------------------------------------------------ items 1-6 and 8 (no game)

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), notes: t.split('\n').filter((l) => l.startsWith('# ')) };
}

steps.unit = async () => {
  const out = {};
  out.mp = nodeTest(['kit/test/mp.test.mjs']);
  const item = (re) => out.mp.names.filter((l) => re.test(l));
  const okAll = (ls) => ls.length > 0 && ls.every((l) => l.startsWith('✔'));
  check(okAll(item(/item 1:/)), `item 1: mix shares within 2 points over 50 seeds x 10k cells (${out.mp.notes.find((l) => /mix/.test(l)) ?? ''})`, item(/item 1:/));
  check(okAll(item(/item 2:/)) && item(/item 2:/).length === 2, `item 2: gradients monotone over 1,000 columns; no straight boundary run of 6 (${out.mp.notes.find((l) => /gradient/.test(l)) ?? ''})`, item(/item 2:/));
  check(okAll(item(/item 3:/)) && item(/item 3:/).length === 2, 'item 3: 500 masks x 2,000 cells through evalTile and 500 x 2,000 through compileMask equal the brute-force reference: 100%', item(/item 3:/));
  check(okAll(item(/items 4 and 5:/)), 'items 4 and 5 (kit): the crater toolbox demo\'s IR byte-identical over 3 plans; tile shas for 1 and 4 workers, forward and shuffled, equal the committed kit golden', item(/items 4 and 5:/));
  check(okAll(item(/item 6:/)), 'item 6 (kit): the drift fixture (200 generated specs) is current', item(/item 6:/));
  check(okAll(item(/item 8:/)), 'item 8: crater_works without the toolbox: the same IR with or without toolbox: false (left out of the params)', item(/item 8:/));
  check(out.mp.code === 0 && out.mp.fail === 0, `kit/test/mp.test.mjs: ${out.mp.pass} pass, ${out.mp.fail} fail`, out.mp.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/scenario-goldens.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 8: the tile goldens hold (mega_bench, the 6b family fixtures with crater_works's tiles, S1, S7): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  const env = { ...process.env, JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*ApiMPTest', '--tests', '*MaskPatternDriftTest', '--tests', '*PlanStaleTest', '--tests', '*Api114Test'],
    { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 3_600_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  out.java = { code: g.status, apimp: xml('api.ApiMPTest'), drift: xml('api.MaskPatternDriftTest'), stale: xml('region.PlanStaleTest') };
  check(g.status === 0 && out.java.drift?.tests === 1 && out.java.drift.failures === 0, `item 6: the Java Mask/Pattern validation agrees with the kit on the 200 specs (MaskPatternDriftTest ${json(out.java.drift)})`);
  check(g.status === 0 && out.java.apimp?.tests >= 8 && out.java.apimp.failures === 0 && out.java.stale?.failures === 0,
    `item 11 (Java): ApiMPTest (parse, FIELD_LIMIT paths, no new Reason, features, IR kinds, bundled schemas = the kit's) ${json(out.java.apimp)}; PlanStaleTest ${json(out.java.stale)}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 9: the previous mod refuses a mask/pattern IR

steps.stale = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate6cmp-'));
  // the toolbox IR, planned by this kit over the synthetic survey
  const { planRegion } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'plan.mjs')).href);
  const { synthSurvey } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'synth.mjs')).href);
  const claim = { minX: -100, minZ: -100, maxX: 99, maxZ: 99, minY: -64, maxY: 319 };
  const p = await planRegion({ programFile: path.join(root, 'kit', 'regions', 'crater_works.mjs'), survey: synthSurvey(claim, 'golden'), claim, params: { toolbox: true } });
  fs.writeFileSync(path.join(tmp, 'ir.json'), p.irJson);
  // with the kit's own kitVersion lowered to 0.18.0 (the v0.18.0 tag's kit) too: then only the kinds refuse
  const irKinds = { ...p.ir, kitVersion: '0.18.0' };
  fs.writeFileSync(path.join(tmp, 'ir-kinds.json'), JSON.stringify(irKinds));
  // (a) the v0.18.0 kit (git archive of the tag)
  execFileSync('sh', ['-c', `git -C '${root}' archive v0.18.0 kit | tar -x -C '${tmp}'`]);
  const old = await import(pathToFileURL(path.join(tmp, 'kit', 'lib', 'realise.mjs')).href);
  const kitA = old.staleReason(p.ir), kitB = old.staleReason(irKinds);
  let kitThrow = null;
  try { old.compileIR(irKinds); } catch (e) { kitThrow = String(e.message); }
  check(/^plan needs kit 0\.19\.0/.test(kitA ?? '') && /kinds \[mask, pattern\]/.test(kitB ?? '') && /^PLAN_STALE/.test(kitThrow ?? ''),
    `item 9: the v0.18.0 kit refuses the toolbox IR PLAN_STALE ("${kitA}"; at kit 0.18.0: "${kitB}"; compileIR: "${kitThrow}")`);
  // (b) the 0.18.0 mod jar's IrStale (pure Java + Gson), and this build's
  const gson = execFileSync('sh', ['-c', `find '${path.join(root, '.gradle-home')}' -name 'gson-2*.jar' -not -name '*sources*' | sort | tail -1`]).toString().trim();
  const src = path.join(tmp, 'OldStale.java');
  fs.writeFileSync(src, 'import com.google.gson.*; import java.nio.file.*;\npublic class OldStale { public static void main(String[] a) throws Exception { for (String f : a) System.out.println(String.valueOf(dev.larattalabs.architect.region.IrStale.reason(JsonParser.parseString(Files.readString(Path.of(f))).getAsJsonObject(), null))); } }\n');
  const java = path.join(JAVA_HOME, 'bin', 'java');
  const runJar = (jar) => execFileSync(java, ['-cp', `${jar}${path.delimiter}${gson}`, src, path.join(tmp, 'ir.json'), path.join(tmp, 'ir-kinds.json')], { encoding: 'utf8' }).trim().split('\n');
  const modOld = runJar(path.join(BASELINE, 'architect_mc-0.18.0.jar'));
  check(/^plan needs kit 0\.19\.0 \/ kinds \[mask, pattern\]; this is kit 0\.18\.0$/.test(modOld[0]) && /^plan needs kinds \[mask, pattern\]; this is kit 0\.18\.0$/.test(modOld[1]),
    `item 9: the 0.18.0 mod (IrStale) refuses it PLAN_STALE: "${modOld[0]}"; at kit 0.18.0: "${modOld[1]}"`);
  const newClasses = fs.existsSync(path.join(RUN, 'mod', 'build', 'classes', 'java', 'main')) ? path.join(RUN, 'mod', 'build', 'classes', 'java', 'main') : path.join(root, 'mod', 'build', 'classes', 'java', 'main');
  const modNew = runJar(newClasses);
  check(modNew[0] === 'null', `this build's IrStale accepts it (${modNew[0]}; classes ${newClasses})`);
  spendZero();
  return { kitA, kitB, kitThrow, modOld, modNew, irSha: p.irSha, requires: p.ir.requires };
};

// ------------------------------------------------------------------ item 11: API compatibility

steps.apicompat = async () => {
  // the run worktree's classes (built by unit-mod at this head): main and client (the client API lives there)
  const classes = fs.existsSync(path.join(RUN, 'mod', 'build', 'classes', 'java', 'main')) ? [['main', 'client'].map((d) => path.join(RUN, 'mod', 'build', 'classes', 'java', d)).join(path.delimiter)] : [];
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cmp', ...classes], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 11: api-compat against the 0.18.0, 0.17.0 and 0.16.0 apitest jars and the 0.18.0 surface: ${t.trim().split('\n').pop()}`);
  if (state.dev || (await connect(5_000).then(() => true).catch(() => false))) {
    if (!(await call('dev.state')).inWorld) await openWorld(FLAT);
    const v = await api('apimp');
    const p = v.parse ?? [];
    const okParse = p.length === 6 && p[0].ok && !p[1].ok && p[1].reason === 'FIELD_LIMIT' && /mask\.slope: \[a, b\] needs a <= b/.test(p[1].message)
      && !p[2].ok && p[3].ok && !p[4].ok && /stops\[1\]\.at/.test(p[4].message) && !p[5].ok && p[5].reason === 'FIELD_LIMIT';
    check(/^1\.(1[6-9]|[2-9]\d)\./.test(v.version) && v.featuresMP?.length === 2 && (v.lastReasons === 'PROTECTED FIELD_LIMIT' || /^(FIELD_LIMIT|FORMAT) FORMAT$/.test(v.lastReasons ?? '')) && okParse,
      `item 11: apitest apimp in game: Mask/Pattern parse through the public API (the bundled schemas load), FIELD_LIMIT with the path, masks/patterns features, no new Reason (${json(v).slice(0, 600)})`);
  }
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ items 5, 7, 10 from the scenario runs

function latest(dir) {
  if (!fs.existsSync(dir)) return null;
  if (fs.existsSync(path.join(dir, 'metrics.json'))) return dir;
  const runs = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'metrics.json'))).sort();
  return runs.length ? path.join(dir, runs[runs.length - 1]) : null;
}

/** Every tile of a plan, evaluated in full (payload and sha) over its own survey: per-tile ms and cells/s. */
async function evalPerf(planDir) {
  const { evalTile } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'realise.mjs')).href);
  const { windowFromSurvey } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'survey.mjs')).href);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const jobs = [];
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) jobs.push({ key, stage, set });
  evalTile(ir, jobs[0].key, windowFromSurvey(survey, jobs[0].key), { stage: jobs[0].stage, set: jobs[0].set, blobs }); // warm
  const ms = [];
  let cells = 0, total = 0;
  for (const j of jobs) {
    const w = windowFromSurvey(survey, j.key);
    const t = performance.now();
    const r = evalTile(ir, j.key, w, { stage: j.stage, set: j.set, blobs });
    const d = performance.now() - t;
    ms.push(d); total += d; cells += r.count;
  }
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return { tiles: ms.length, cells, totalMs: Math.round(total), p50Ms: Math.round(q(0.5)), p99Ms: Math.round(q(0.99)), maxMs: Math.round(ms[ms.length - 1]), cellsPerSecond: Math.round(cells / (total / 1000)), load1: os.loadavg()[0] };
}

steps.judge = async () => {
  const flat = latest(path.join(ART, 'mp-flat')), nat = latest(path.join(ART, 'mp'));
  check(!!flat && !!nat, `the scenario runs: flat ${flat ?? 'missing'}, natural ${nat ?? 'missing'}`);
  if (!flat || !nat) return {};
  const rd = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  const out = {};
  for (const [k, d] of [['flat', flat], ['natural', nat]]) {
    const m = rd(d, 'metrics.json'), r = rd(d, 'run.json'), e = rd(d, 'exact.json');
    out[k] = { dir: d, head: r.versions?.head, irShas: r.irShas, workersSame: m.tiles.workersSame, golden: m.tiles.golden, exact: { kind: e.kind, mismatches: e.mismatches, classes: e.classes, cellsWritten: e.cellsWritten },
      mspt: m.mspt?.architect ?? null, cps: m.cellsPerSecond, state: r.state, rows: Object.fromEntries(m.rows.map((x) => [x.id, { pass: x.pass, value: x.value }])) };
  }
  // the flat variant must be flat: its plan survey holds one or two ground heights (a world named G6B Flat Base made by the
  // client's autoworld before gate6b base would be a normal world)
  const { decodeColumns } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'pack.mjs')).href);
  const heights = new Set(decodeColumns(fs.readFileSync(path.join(flat, 'raw', 'plan', 'survey.bin'))).ground).size;
  check(heights <= 2, `the flat run's survey is flat (${heights} distinct ground heights)`);
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  check(out.flat.head === head && out.natural.head === head, `the runs are of this head ${head.slice(0, 10)} (flat ${out.flat.head?.slice(0, 10)}, natural ${out.natural.head?.slice(0, 10)})`);
  const same = (x) => new Set(x.irShas).size === 1 && x.irShas.length === 3;
  check(same(out.flat) && same(out.natural) && out.flat.workersSame && out.natural.workersSame && String(out.natural.golden).startsWith('match'),
    `item 5: the IR sha over 3 plans identical (flat ${out.flat.irShas?.[0]?.slice(0, 12)}, natural ${out.natural.irShas?.[0]?.slice(0, 12)}); tiles 1 vs 4 workers identical; golden scenarios/goldens/crater_toolbox.json: ${out.natural.golden}`);
  const ef = out.flat.exact, en = out.natural.exact;
  const WORLD = ['growth', 'grazed', 'live', 'gravity', 'unsupported'];
  const undoOwn = en.mismatches - WORLD.reduce((a, k) => a + (en.classes?.[k] ?? 0), 0);
  check(out.flat.state === 'PLACED' && out.natural.state === 'PLACED', `both realises PLACED (flat ${out.flat.state}, natural ${out.natural.state})`);
  check(ef.mismatches === 0, `item 7: E-flat ${ef.mismatches} over ${ef.cellsWritten} written cells`);
  check((en.classes?.none ?? 0) === 0 && undoOwn <= 0.0001 * en.cellsWritten, `item 7: E-normal ${en.mismatches} (${json(en.classes ?? {})}), every one classified; the undo's own ${undoOwn} <= 0.01% of ${en.cellsWritten} (${(0.0001 * en.cellsWritten).toFixed(0)})`);
  for (const k of ['flat', 'natural']) {
    const a = out[k].mspt;
    bar(a && (a.placementCpuMsMax ?? a.placementMsMax) <= 50, `item 10 (${k}): Architect's own tick max ${(a?.placementCpuMsMax ?? a?.placementMsMax)?.toFixed?.(1)} ms CPU <= 50 (wall ${a?.placementMsMax?.toFixed?.(1)}, vanilla ${a?.serverMsptMax?.toFixed?.(1)} recorded)`);
  }
  out.evalPerf = await evalPerf(path.join(nat, 'raw', 'plan'));
  const ep = out.evalPerf;
  bar(ep.p99Ms < 2000 && ep.cellsPerSecond >= 45_000, `item 10: the natural plan's ${ep.tiles} tiles evaluated in full: p50 ${ep.p50Ms} ms, p99 ${ep.p99Ms} ms (< 2 s), ${ep.cellsPerSecond} cells/s (>= 45k), load ${ep.load1.toFixed(1)}`);
  // the other scenario rows, recorded (the 6b scenario bars are S1's; MP judges its own items)
  out.recorded = Object.fromEntries(Object.entries(out.natural.rows).filter(([k]) => !['exactness', 'determinism', 'mspt', 'spend', 'gallery'].includes(k)));
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'stale', 'apicompat', 'judge']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-MP (masks and patterns)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cmp.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
