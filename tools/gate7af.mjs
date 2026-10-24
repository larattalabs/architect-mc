#!/usr/bin/env node
// Phase 7a foundation gate (docs/CONTRACT.md "Phase 7a foundation: the shared interface" §7), kit only, $0: no game, no Claude.
//
//   node tools/gate7af.mjs unit   (7af-unit)   item 1 (inert: every committed plan fixture, every dir and the 59 asks, planned here and
//                                              on the merge base (../architect-mc-7a-foundation-main): answers, IR (kitVersion
//                                              normalised) and the first plan byte-identical but the fixtures the catalogue's three
//                                              changes move by name, F7A_MOVED); item 2 (the catalogue: the golden equals
//                                              planCatalogue(), the diff against catalogue-pre7a.json exactly §4's three entries:
//                                              kit/test/f7a-foundation.test.mjs); item 3 (P0's tests on connector.tube, K1's and T3's
//                                              unit tests); item 4 (the alias: f7a-foundation's span_bridge case); item 5 (the
//                                              compact plan/0 measured here and on the merge base, recorded)
//     report                                   REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-f/<step>.json in the main checkout (GATE7AF_OUT overrides), all.log, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { F7A_MOVED } from './lib/f7a-norm.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.GATE7AF_OUT ?? path.join(path.resolve(root, '..', 'architect-mc'), 'artifacts', 'gate7a-f');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'all.log');
const log = (m) => { const l = String(m); console.log(l); fs.appendFileSync(LOG, `${l}\n`); };
let pass = 0, fail = 0;
const results = [];
const check = (ok, msg, data) => { results.push({ ok: !!ok, msg, ...(data !== undefined ? { data } : {}) }); if (ok) pass++; else fail++; log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${!ok && data !== undefined ? ` ${JSON.stringify(data).slice(0, 600)}` : ''}`); };
for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (process.env[k]) { console.error(`refusing to run with ${k} set ($0 gate)`); process.exit(2); }
const spendZero = () => fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'the 7a foundation gate is $0: kit only, no Claude call' }, null, 2)}\n`);

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

/** The compact plan/0 (the sidecar's own expansion of plan/0#compact, by tsx) over a kit dir. */
function compactOf(kit) {
  const sc = fs.existsSync(path.join(root, 'sidecar', 'node_modules', '.bin', 'tsx')) ? path.join(root, 'sidecar') : path.join(path.resolve(root, '..', 'architect-mc'), 'sidecar');
  const f = path.join(OUT, 'compact.mts');
  fs.writeFileSync(f, `import { expandSystemRefs } from ${JSON.stringify(path.join(sc, 'src', 'jobs', 'systemrefs.ts'))};\nprocess.stdout.write(String((await expandSystemRefs(${JSON.stringify(kit)}, ['plan/0#compact'])).length));`);
  const r = spawnSync(path.join(sc, 'node_modules', '.bin', 'tsx'), [f], { cwd: sc, encoding: 'utf8', timeout: 300_000 });
  return Number(r.stdout.trim()) || null;
}

const steps = {};
steps.unit = async () => {
  const out = {};
  // items 2-4: the foundation's own tests, P0's, K1's and T3's
  out.tests = kitOnce(['kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs']);
  check(out.tests.code === 0 && out.tests.fail === 0 && out.tests.pass >= 20, `items 2-4 (kit): the kinds leaf, the hook table (inert stubs), rows 9-11 off, the profiles equal to COST (an edge with each routes as without), the defs, NO_CLIMB, climb, R25-R27; the catalogue golden and its diff against catalogue-pre7a.json exactly §4's three entries; P0 on connector.tube; the span_bridge alias answering as v35's bridge with the note; K1's and T3's foundation tests: ${out.tests.pass} pass, ${out.tests.fail} fail`, out.tests.failing);
  // item 1: inert
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: '7a-foundation', landed: F7A_MOVED });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved, excepted: F7A_MOVED };
  fs.writeFileSync(path.join(OUT, '7af-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // item 5: the compact plan/0, here and on the merge base
  const base = path.join(path.resolve(root, '..', 'architect-mc-7a-foundation-main'), 'kit');
  out.compact = { chars: compactOf(path.join(root, 'kit')), base: compactOf(base) };
  out.compact.delta = out.compact.chars !== null && out.compact.base !== null ? out.compact.chars - out.compact.base : null;
  // (S-FL-8's 84,000 moved to 96,000 for 7a: the coordinator's ruling 2026-10-23, asked of Steward; foundation §4)
  check(out.compact.chars !== null && out.compact.chars < 96_000, `item 5 (recorded): the compact plan/0 is ${out.compact.chars} characters (${out.compact.delta >= 0 ? '+' : ''}${out.compact.delta} over the merge base's ${out.compact.base}; the bound 96,000, S-FL-8's 84,000 moved for 7a)`);
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = fs.readdirSync(OUT).filter((f) => /^(unit)\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
  const md = ['# 7a foundation gate', '', ...rows.flatMap((r) => [`## ${r.step} (${r.seconds.toFixed(0)} s, head ${r.head.slice(0, 8)})`, '', ...r.results.map((x) => `- ${x.ok ? 'ok' : 'FAIL'} ${x.msg}`), ''])];
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${md.join('\n')}\n`);
};

const name = process.argv[2];
if (!steps[name]) { console.error(`usage: node tools/gate7af.mjs ${Object.keys(steps).join('|')}`); process.exit(2); }
const t0 = Date.now();
let data, error;
log(`== ${name}`);
try { data = await steps[name](); } catch (e) { error = String(e?.stack ?? e); log(error); check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
if (name !== 'report') fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results, data }, null, 1)}\n`);
log(fail ? `${fail} FAILURE(S)` : `ALL ${pass} PASS`);
process.exit(fail ? 1 : 0);
