#!/usr/bin/env node
// Phase 6c slice S2 gate (docs/CONTRACT.md "Phase 6c slice S2: the ice-spike outpost goes green" §4). Offline steps here; S2's runs
// (natural on a client for the gallery's cameras, flat) are tools/scenarios.mjs run s2 --phase 6c (gate-chains step 6c-scenario-s2).
// $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cs2.mjs <step>
//     unit         the kit's S2 tests (ice_outpost on a synthetic ice-spike claim; the four kit fixes with their broken variants), the
//                  goldens that must not move (S1, S7, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo, crater_toolbox,
//                  the 6b fixtures), the whole kit suite, the sidecar's feature list
//     feasibility  item 1: ice_outpost planned offline on the re-pinned plan survey (scenarios/s2_ice_spikes.json planSurvey.sha, the
//                  committed S2 golden's survey and frozen volume, else forms_demo's): at least 6 lots on the land band, every lot routed
//                  from the gate, the checker 0 errors and no M1-M4; the first plan (no volume yet) asks for the volume the second reads
//     apicompat    tools/api-compat.mjs --gate6cs2 (the 0.29.0, 0.28.0 and 0.27.0 apitest jars, the 0.29.0 surface)
//     report       REPORT.md over the step JSONs and S2's latest natural and flat runs
//
// Evidence: artifacts/gate6c-s2/<step>.json in the main checkout (GATE6CS2_OUT overrides), REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GATE6CS2_OUT ?? path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'gate6c-s2');
const ART = process.env.SCENARIOS_ART ?? path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'scenarios');
const KIT = path.join(root, 'kit');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) if (process.env[k]) { console.error(`refusing: ${k} is set ($0 gate)`); process.exit(2); }

const results = {};
let failures = 0;
const check = (ok, msg, data) => { results[msg] = { ok: !!ok, ...(data === undefined ? {} : { data }) }; if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok && data !== undefined) console.log(`     ${JSON.stringify(data).slice(0, 600)}`); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice S2 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

const steps = {};

steps.unit = async () => {
  const out = {};
  out.s2 = nodeTest(['kit/test/outpost-s2.test.mjs']);
  check(out.s2.code === 0 && out.s2.fail === 0 && out.s2.pass >= 6, `unit (kit): ice_outpost on a synthetic ice-spike claim (lots on dry ice-free land, every lot routed, 0 kept cells written, no M1-M4, M17 0, soul lanterns for a bright light role, deterministic); keep sets as route obstacles by column, no retaining column on a kept column, the relief keeps the kept columns, the grade quantum at 0.2, lightCover's format-2 draft, each with its broken variant: ${out.s2.pass} pass, ${out.s2.fail} fail`, out.s2.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `the goldens that must not move (format-1 goldens, S1's and S7's tiles, mega_bench, the 6b fixtures, relief_demo, route_demo, forms_demo, scatter_demo, crater_toolbox) and the T1/T2 suites over the changed passes: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const sc = spawnSync('npx', ['vitest', 'run', 'test/jobs.test.ts', 'test/plan-check.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 900_000 });
  const st = `${sc.stdout}${sc.stderr}`;
  out.sidecar = { code: sc.status, summary: st.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ') };
  check(sc.status === 0, `§1 (sidecar): region.outpost appended to the features: ${out.sidecar.summary}`);
  spendZero();
  return out;
};

steps.feasibility = async () => {
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const sc = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's2_ice_spikes.json'), 'utf8'));
  // the re-pinned plan survey: S2's own golden when committed, else forms_demo's (the same claim, the pinned sha)
  const dirs = ['s2', 'forms_demo'].map((d) => path.join(root, 'scenarios', 'goldens', d)).filter((d) => fs.existsSync(path.join(d, 'survey.bin')) && sha256(fs.readFileSync(path.join(d, 'survey.bin'))) === sc.fixture.planSurvey.sha);
  check(dirs.length > 0, `item 1: a committed survey equal to the re-pinned plan survey (${sc.fixture.planSurvey.sha.slice(0, 12)})`);
  if (!dirs.length) return {};
  const gDir = dirs[0];
  const gIr = JSON.parse(fs.readFileSync(path.join(gDir, 'ir.json'), 'utf8'));
  const vName = Object.entries(gIr.blobs ?? {}).find(([, b]) => b.kind === 'volume');
  const bytes = fs.readFileSync(path.join(gDir, 'blobs', `${vName[1].sha}.bin`));
  const decoded = decodeArvx(bytes);
  const survey = fs.readFileSync(path.join(gDir, 'survey.bin'));
  const c = sc.fixture.claim;
  const bible = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', sc.bibleFixture), 'utf8')).roles;
  const opts = { programFile: path.join(KIT, 'regions', 'ice_outpost.mjs'), params: sc.params ?? {}, survey, seed: sc.seed ?? '1', claim: { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: -64, maxY: 319 }, roles: bible };
  const p0 = await planRegion({ ...opts, volumes: [] });
  const box = p0.needVolumes?.[0];
  check(box && ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'].every((k) => box[k] === decoded.box[k]), `item 1: the first plan (no volume yet) asks for the frozen volume the golden holds: ${JSON.stringify(box)}`);
  const t0 = Date.now();
  const p = await planRegion({ ...opts, volumes: [{ sha: decoded.sha, box: decoded.box, bytes: Uint8Array.from(bytes), decoded }] });
  const ms = Date.now() - t0;
  const rep = checkRegion({ ir: p.ir, survey, blobs: (sha) => p.blobs.get(sha), volumes: [decoded], meta: p.meta });
  const o = p.meta.outpost;
  const m14 = rep.findings.filter((f) => /^M[1-4]/.test(f.rule));
  const routed = p.meta.route.edges.filter((e) => e.ok).length;
  check(o.lots.length >= 6, `item 1: ${o.lots.length} lots on the land band (at least 6; ${o.land.band} band columns of ${36864}, ${o.land.keptColumns} kept ice columns): ${o.lots.map((l) => `${l.id} ${l.size.join('x')} @${l.at.join(',')} ${l.front}`).join('; ')}; unplaced ${o.unplaced.map((u) => u.id).join(', ') || 'none'}`, { unplaced: o.unplaced });
  check(routed === p.meta.route.edges.length && routed === o.lots.length, `item 1: every lot routed from the gate (${routed}/${p.meta.route.edges.length}; widths ${p.meta.route.edges.map((e) => `${e.id} ${e.width}`).join(', ')})`);
  check(rep.errors === 0 && m14.length === 0, `item 1: the plan's checker 0 errors, no M1-M4 (keep written ${rep.metrics.keep?.written}; M5 ${(100 * rep.metrics.M5.share).toFixed(2)}%; M17 ${rep.metrics.M17?.melting})`, m14.map((f) => `${f.rule} ${f.part}: ${f.message}`));
  console.log(`rec  item 1: the plan took ${ms} ms offline (load ${os.loadavg()[0].toFixed(1)})`);
  spendZero();
  return { survey: path.relative(root, gDir), surveySha: sc.fixture.planSurvey.sha, lots: o.lots, unplaced: o.unplaced, gate: o.gate, land: o.land, routes: p.meta.route.edges.map((e) => ({ id: e.id, ok: e.ok, width: e.width, length: e.length, movers: e.movers })), errors: rep.errors, warnings: rep.findings.map((f) => `${f.rule} x${f.count}`), ms };
};

steps.apicompat = async () => {
  execFileSync('./gradlew', ['compileJava', 'compileClientJava', '--offline', '-q'], { cwd: path.join(root, 'mod'), env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, stdio: 'ignore' });
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cs2'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `api-compat against the 0.29.0, 0.28.0 and 0.27.0 apitest jars and the 0.29.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'feasibility', 'apicompat']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const runsDir = path.join(ART, '6c', 's2');
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
  const md = `# Gate 6c-S2 (the ice-spike outpost goes green)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n\n## Scenario runs (artifacts/scenarios/6c/s2)\n\n${lines.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length + lines.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cs2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
let data = null, error = null;
try { data = await steps[name](); } catch (e) { error = String(e?.stack ?? e); check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results, data }, null, 1)}\n`);
console.log(`== ${name}: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
