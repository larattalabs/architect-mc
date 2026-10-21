#!/usr/bin/env node
// Phase 6c slice S3 gate (docs/CONTRACT.md "Phase 6c slice S3: the mountainside monastery v1, terraced, goes green" §9). Offline steps
// and item 4 in game (the headless server or a client of the S3 run worktree: GATE6B_RUN, default `../architect-mc-S3-run`; the sim
// sidecar, no Claude). S3's scenario runs (natural with the gallery's cameras, flat on the hill) are tools/scenarios.mjs run s3 --phase 6c
// (gate-chains step 6c-scenario-s3). $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cs3.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit         (s3-unit)           item 2: kit/test/terraces-s3.test.mjs (the terrace's blend; the member: levels, rise, retain, the flat-site
//                                      note, the districts form and the standard zone form; the broken variants unretained and
//                                      spring_buried), the goldens that must not move, the whole kit suite, the sidecar's features, the mod's
//                                      ApiS3Test; item 8 (api-compat --gate6cs3)
//     identity     (s3-unit)           item 5: every committed plan fixture (the 59 asks among them) as on the merge base (answers and IR, but
//                                      kitVersion); the 59 asks' gap table unchanged
//     feasibility  (s3-unit)           item 1: terraced_monastery offline on the re-pinned survey and its frozen volume (S3's committed golden):
//                                      at least 9 lots on terrace levels, every lot reached from the gate within grade, virtual M5 under 0.5%,
//                                      the checker 0 errors and no M1-M4, the spring's columns unwritten
//     plan         (s3-plan)           item 4 in game (tools/lib/gate6cs3-game.mjs): the Steward-shaped plan through checkPlan, realiseApproved
//                                      and Regions.remove on a settled copy of S3 (E-normal 0 unclassified) and on the flat hill (E-flat 0)
//     apicompat                         item 8 alone
//     report                            REPORT.md over the step JSONs and S3's latest natural and flat runs
//
// Evidence: artifacts/gate6c-s3/<step>.json in the main checkout (GATE6CS3_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-S3-run');
process.env.GATE6B_OUT = process.env.GATE6CS3_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-s3');
process.env.GATE6B_SIDECAR_PORT ??= '8926';
process.env.GATE6B_DEV_PORT ??= '8927';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const { kitReuse } = await import('./lib/kit-reuse.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const ART = process.env.SCENARIOS_ART ?? path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'scenarios');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice S3 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B S3 Lobby', { backend: 'sim' });
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
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);
function junit(name) {
  const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-${name}.xml`);
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  const g = (k) => Number((new RegExp(`${k}="(\\d+)"`).exec(t) ?? [])[1] ?? -1);
  return { tests: g('tests'), failures: g('failures'), errors: g('errors') };
}

steps.unit = async () => {
  const out = {};
  out.s3 = nodeTest(['kit/test/terraces-s3.test.mjs']);
  check(out.s3.code === 0 && out.s3.fail === 0 && out.s3.pass >= 11, `item 2 (kit): the terrace's blend (pins, retained only over 2, throws without the relief pass, an unpinned blend refuses); the member (levels on the ladder, rise, retain wall and blend, the flat-site note, the districts form and the standard zone form on its locator); the broken variants unretained (open rims, M8) and spring_buried (the program's own check): ${out.s3.pass} pass, ${out.s3.fail} fail`, out.s3.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/districts-d.test.mjs', 'kit/test/districts-d2.test.mjs', 'kit/test/outpost-s2.test.mjs', 'kit/test/voc-farfluid.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `the goldens that must not move (format-1 goldens, the scenario tile goldens, the 6b fixtures), T1/T2/D1/D2/S2's suites over the changed passes, farfluid's rule: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = kitOnce(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/jobs.test.ts', 'test/vocc.test.ts', 'test/system-refs.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  out.sidecar = { code: sc.status, summary: `${sc.stdout}${sc.stderr}`.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§5 (sidecar): region.terracedZones and region.monastery appended to the features; the compact plan/0 within its bound: ${out.sidecar.summary}`);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*ApiS3Test', '--tests', '*ApiS2Test'], { cwd: path.join(root, 'mod'), encoding: 'utf8', timeout: 1_800_000, env });
  out.mod = { code: g.status, s3: junit('dev.larattalabs.architect.region.ApiS3Test') };
  check(g.status === 0 && out.mod.s3 && out.mod.s3.tests > 0 && out.mod.s3.failures === 0 && out.mod.s3.errors === 0, `§5 (mod): ApiS3Test (the version floor, terracedZones and scenarioS3, no new kind): ${json(out.mod)}`);
  Object.assign(out, await apicompat());
  spendZero();
  return out;
};

async function apicompat() {
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cs3'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  const t = `${ac.stdout}${ac.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(ac.status === 0 && /all \d+ checks clean/.test(t), `item 8: api-compat --gate6cs3 clean against the 0.40.0, 0.39.1 and 0.39.0 apitest jars and the 0.40.0 jar's 1.37.0 surface; $0.00: ${t.trim().split('\n').pop()}`);
  return { apicompat: { code: ac.status, last: t.trim().split('\n').pop() } };
}
steps.apicompat = async () => { const o = await apicompat(); spendZero(); return o; };

steps.identity = async () => {
  const out = {};
  const K = await import('./lib/gate6cs3-kit.mjs');
  const u = await K.unchanged(root, { check, log });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, baseWithTerraces: u.baseWithTerraces };
  fs.writeFileSync(path.join(OUT, 's3-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  check(u.n > 0 && u.differ.length === 0 && u.baseWithTerraces.length === 0, `item 5: every committed plan fixture as on the merge base ${u.base.slice(0, 10)} (answers, overall, IR but kitVersion, first plan): ${u.same}/${u.n} byte-identical; no base fixture carries terraces`, u.differ);
  const { asksGap } = await import('./lib/gate6chy-b.mjs');
  const before = await asksGap(path.join(K.baseTree(root).dir, 'kit')), after = await asksGap(KIT);
  fs.writeFileSync(path.join(OUT, 's3-asks-before.md'), before.text);
  fs.writeFileSync(path.join(OUT, 's3-asks-after.md'), after.text);
  out.asks = { malformedBefore: before.malformed, malformedAfter: after.malformed, same: before.text === after.text };
  check(before.text === after.text && after.malformed === 0, `item 5: the 59 asks' answers and gap table unchanged (${after.text.split('\n')[0]})`);
  spendZero();
  return out;
};

steps.feasibility = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const sc = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's3_monastery.json'), 'utf8'));
  // the re-pinned survey (after the 90 s settle): S3's golden when committed, else a run dir given by GATE6CS3_SURVEY_DIR (its raw/plan)
  const dirs = [path.join(root, 'scenarios', 'goldens', 's3'), process.env.GATE6CS3_SURVEY_DIR].filter((d) => d && fs.existsSync(path.join(d, 'survey.bin')));
  const gDir = dirs.find((d) => sha256(fs.readFileSync(path.join(d, 'survey.bin'))) === sc.fixture.planSurvey.sha) ?? null;
  check(!!gDir, `item 1: a committed survey equal to the re-pinned plan survey (${sc.fixture.planSurvey.sha.slice(0, 12)}, after the 90 s settle)`);
  if (!gDir) return {};
  const gIr = JSON.parse(fs.readFileSync(path.join(gDir, 'ir.json'), 'utf8'));
  const volumes = Object.values(gIr.volumes ?? {}).map((v) => { const bytes = fs.readFileSync(path.join(gDir, 'blobs', `${gIr.blobs[v.blob].sha}.bin`)); const decoded = decodeArvx(bytes); return { sha: decoded.sha, box: decoded.box, bytes: Uint8Array.from(bytes), decoded }; });
  const survey = fs.readFileSync(path.join(gDir, 'survey.bin'));
  const c = sc.fixture.claim;
  const bible = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', sc.bibleFixture), 'utf8'));
  const opts = { programFile: path.join(KIT, 'regions', 'terraced_monastery.mjs'), params: sc.params ?? {}, survey, seed: sc.seed, claim: { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: -64, maxY: 319 }, roles: bible.roles, fluids: bible.fluids, ...(gIr.biomes ? {} : {}) };
  const t0 = Date.now();
  const p = await planRegion({ ...opts, volumes });
  const ms = Date.now() - t0;
  const m = p.meta.monastery;
  const rep = checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha), volumes: volumes.map((v) => v.decoded), meta: p.meta });
  const m14 = rep.findings.filter((f) => /^M[1-4]/.test(f.rule));
  const tLots = Object.values(m.terraces ?? {}).reduce((a, t) => a + t.lots.length, 0);
  const levels = Object.fromEntries(Object.entries(m.terraces ?? {}).map(([k, t]) => [k, t.levels]));
  check(tLots >= 9, `item 1: ${tLots} lots on terrace levels (at least 9): ${Object.entries(m.terraces ?? {}).map(([k, t]) => `${k} ${t.lots.map((l) => `${l.id}@${l.y}`).join(' ')}`).join('; ')}; unplaced ${Object.values(m.districts ?? {}).flatMap((d) => d.unplaced).join(', ') || 'none'}`, { levels });
  const edges = p.meta.route?.edges ?? [];
  const M2 = rep.metrics.M2;
  check(edges.length > 0 && edges.filter((e) => /^(gate|gardens|cloister)_|^d_/.test(e.id)).every((e) => e.ok) && M2.reached === M2.nodes, `item 1: every lot reached from the gate within grade ${(sc.params?.gradePct ?? 20) / 100} (the districts' routes ${edges.filter((e) => e.ok).length}/${edges.length} routed; M2 ${M2.reached}/${M2.nodes} nodes)`, edges.filter((e) => !e.ok).map((e) => `${e.id} ${e.failed}`));
  check(rep.metrics.M5.share < 0.005, `item 1: virtual M5 ${(100 * rep.metrics.M5.share).toFixed(2)}% (under 0.5%; ${rep.metrics.M5.darkSpawnable} of ${rep.metrics.M5.walkArea})`);
  check(rep.errors === 0 && m14.length === 0, `item 1: the checker 0 errors, no M1-M4 (M8 ${rep.metrics.M8 ? `${rep.metrics.M8.unguarded} open of ${rep.metrics.M8.edgeCells}` : 'n/a'})`, m14.map((f) => `${f.rule} ${f.part}: ${f.message}`));
  check(m.springWritten === 0, `item 1: the spring's columns unwritten (${m.springWritten} cells)`);
  console.log(`rec  item 1: the plan took ${ms} ms offline (load ${os.loadavg()[0].toFixed(1)})`);
  spendZero();
  return { survey: path.relative(root, gDir), surveySha: sc.fixture.planSurvey.sha, lots: tLots, terraces: m.terraces, districts: m.districts, anchors: m.anchors, answers: m.answers, lamps: m.lamps, brink: m.brinkRails, M5: rep.metrics.M5, M8: { ...rep.metrics.M8, unguardedSample: undefined }, errors: rep.errors, warnings: rep.findings.map((f) => `${f.rule} x${f.count}`), ms };
};

// ------------------------------------------------------------------ in game

steps.plan = async () => {
  await ensure();
  const G = await import('./lib/gate6cs3-game.mjs');
  const out = {};
  for (const v of (process.env.GATE6CS3_PLAN ?? 'natural,flat').split(',')) out[v] = await G.planTwin(ctx, v);
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'identity', 'feasibility', 'plan']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !(r === true || r?.ok));
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r === true || r?.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const runsDir = path.join(ART, '6c', 's3');
  const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((d) => fs.existsSync(path.join(runsDir, d, 'metrics.json'))).sort() : [];
  const lines = [];
  for (const kind of ['natural', 'flat']) {
    const d = runs.filter((x) => x.endsWith('-flat') === (kind === 'flat')).pop();
    if (!d) { lines.push(`- ${kind}: no run`); continue; }
    const m = JSON.parse(fs.readFileSync(path.join(runsDir, d, 'metrics.json'), 'utf8'));
    const ev = fs.readFileSync(path.join(runsDir, d, 'evidence.sha'), 'utf8').trim();
    lines.push(`- ${kind} \`${d}\` (evidence \`${ev.slice(0, 12)}\`):`);
    for (const r of m.rows) lines.push(`  - ${r.gated ? (r.pass ? 'ok' : 'FAIL') : 'rec'} ${r.label}: ${r.value}`);
  }
  spendZero();
  const md = `# Gate 6c-S3 (the mountainside monastery v1, terraced, goes green)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n\n## Scenario runs (artifacts/scenarios/6c/s3)\n\n${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length + lines.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cs3.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
