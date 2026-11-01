#!/usr/bin/env node
// Phase 7a slice FB gate (docs/CONTRACT.md "Phase 7a slice FB: flood behaviour, M16" §3). Kit only, offline, no game; $0.
//
//   node tools/gate7afb.mjs <step>
//     unit      (fb-unit)   item 1: kit/test/fb.test.mjs (M16 on synthetic bodies: a 1-thick rim over a lower path found, 2-thick not,
//                           a door counts 1, a sunk pond not, a lot box; v7a_lf_cliff's airlock clean; a warning; no metrics without a
//                           body), with H's, HY's, KC's and LF's kit tests and the water lint's test
//     count     (fb-unit)   item 2 (recorded, never judged): every committed plan fixture (every dir, the 59 asks included) through the
//                           two-plan flow and the checker on the virtual world: M16 findings per fixture (body, cells) and its M8
//                           findings (M8 and its sub-rules, cells; for S-7a-7); fb-count.json and fb-count.md
//     unchanged (fb-unit)   item 3: every committed plan fixture plans as on the merge base (answers, overall, the IR, the first plan:
//                           tools/lib/gate7a-kit.mjs; a warning adds a finding, never a refusal), no named exception
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-fb/<step>.json in the main checkout (GATE7AFB_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_OUT = process.env.GATE7AFB_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-fb');
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, log, results, root } = L;

L.refuseKeys();
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
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice FB is $0: kit only, no Claude call' }, null, 2)}\n`);
}
function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.fb = kitOnce(['kit/test/fb.test.mjs']);
  check(out.fb.code === 0 && out.fb.fail === 0 && out.fb.pass >= 6, `item 1 (kit): M16 on synthetic bodies (a 1-thick rim over a lower path found with its walk and barrier cells, 2-thick not, a door/pane/bars count 1, a sunk pond not, a lot box reached never crossed), v7a_lf_cliff's airlock clean, a warning, no M16 metrics without a body: ${out.fb.pass} pass, ${out.fb.fail} fail`, out.fb.failing);
  out.fluids = kitOnce(['kit/test/h-core.test.mjs', 'kit/test/h-a.test.mjs', 'kit/test/hy-core.test.mjs', 'kit/test/kc.test.mjs', 'kit/test/lf.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/water-lint.test.mjs'].filter((f) => fs.existsSync(path.join(root, f))));
  check(out.fluids.code === 0 && out.fluids.fail === 0, `item 1 (kit): H's, HY's, KC's and LF's tests, the family fixtures' expected reports, the water lint unchanged: ${out.fluids.pass} pass, ${out.fluids.fail} fail`, out.fluids.failing);
  spendZero();
  return out;
};

steps.count = async () => {
  const { fixtures, planFixture } = await import('./lib/gate6ckc-kit.mjs');
  const h = await import(pathToFileURL(path.join(root, 'kit', 'test', 'plan-helpers.mjs')).href);
  const { checkRegion } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'check.mjs')).href);
  const rows = [];
  for (const [name, fx] of fixtures(root)) {
    const row = { fixture: name };
    try {
      const { r, s } = await planFixture(h, root, fx);
      const ir = r.res?.ir ?? (r.res?.irJson ? JSON.parse(r.res.irJson) : null);
      if (!ir) { row.err = 'no IR (refused or malformed)'; rows.push(row); continue; }
      const rep = checkRegion({ ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta, prefix: false });
      row.bodies = rep.metrics.M16?.bodies?.length ?? 0;
      row.M16 = rep.findings.filter((f) => f.rule === 'M16').map((f) => ({ part: f.part, cells: f.count, message: f.message, sample: f.sample.slice(0, 4) }));
      row.M8 = rep.findings.filter((f) => /^M8(:|$)/.test(f.rule)).map((f) => ({ rule: f.rule, part: f.part, cells: f.count }));
      row.M8edges = rep.metrics.M8 ? { edgeCells: rep.metrics.M8.edgeCells, unguarded: rep.metrics.M8.unguarded } : null;
      row.errors = rep.errors;
    } catch (e) { row.err = String(e?.message ?? e).slice(0, 200); }
    rows.push(row);
  }
  const m16 = rows.filter((r) => r.M16?.length), m8 = rows.filter((r) => r.M8?.length), errs = rows.filter((r) => r.err);
  const out = {
    fixtures: rows.length, withBodies: rows.filter((r) => r.bodies).length,
    m16: { fixtures: m16.length, findings: m16.reduce((a, r) => a + r.M16.length, 0), cells: m16.reduce((a, r) => a + r.M16.reduce((b, f) => b + f.cells, 0), 0) },
    m8: { fixtures: m8.length, findings: m8.reduce((a, r) => a + r.M8.length, 0), cells: m8.reduce((a, r) => a + r.M8.reduce((b, f) => b + f.cells, 0), 0) },
    notPlanned: errs.map((r) => `${r.fixture}: ${r.err}`),
  };
  fs.writeFileSync(path.join(OUT, 'fb-count.json'), `${JSON.stringify(rows, null, 1)}\n`);
  const md = ['# FB count (recorded): M16 and M8 on every committed plan fixture (the checker on the virtual world, prefix off)', '',
    `${out.fixtures} fixtures; ${out.withBodies} with a fluid body. M16: ${out.m16.findings} finding(s), ${out.m16.cells} cell(s), in ${out.m16.fixtures} fixture(s). M8 (all sub-rules): ${out.m8.findings} finding(s), ${out.m8.cells} cell(s), in ${out.m8.fixtures} fixture(s).`, '',
    '## M16', '', '| fixture | part | cells | message |', '|---|---|---|---|',
    ...m16.flatMap((r) => r.M16.map((f) => `| ${r.fixture} | ${f.part} | ${f.cells} | ${f.message.replaceAll('|', '/')} |`)), '',
    '## M8 (virtual world; the structure lint judges M8 on its lit world)', '', '| fixture | rule | part | cells |', '|---|---|---|---|',
    ...m8.flatMap((r) => r.M8.map((f) => `| ${r.fixture} | ${f.rule} | ${f.part ?? ''} | ${f.cells} |`)), '',
    ...(errs.length ? ['## Not planned (no IR)', '', ...errs.map((r) => `- ${r.fixture}: ${r.err}`)] : [])];
  fs.writeFileSync(path.join(OUT, 'fb-count.md'), `${md.join('\n')}\n`);
  check(true, `item 2 (recorded): ${out.fixtures} fixtures (${out.withBodies} with a body): M16 ${out.m16.findings} finding(s) / ${out.m16.cells} cell(s) in ${out.m16.fixtures} fixture(s) (${m16.map((r) => r.fixture).join(', ') || 'none'}); M8 ${out.m8.findings} finding(s) / ${out.m8.cells} cell(s) in ${out.m8.fixtures} fixture(s); fb-count.md`);
  check(out.fixtures >= 230, `item 2: ${out.fixtures} committed fixtures counted (every dir, the 59 asks included)`);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'FB', except: {} });
  fs.writeFileSync(path.join(OUT, 'fb-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'count', 'unchanged']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-FB (flood behaviour, M16)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7afb.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
process.exit(L.fails() ? 1 : 0);
