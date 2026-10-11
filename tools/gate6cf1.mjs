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
  for (const s of ['unit', 'variants', 'stale', 'flat', 'natural']) {
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
