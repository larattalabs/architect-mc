#!/usr/bin/env node
// Phase 6c slice VOC gate (docs/CONTRACT.md "Phase 6c slice VOC" §8) against the headless server of the VOC run worktree (GATE6B_RUN,
// default `../architect-mc-VOC-run`, a detached worktree at this checkout's HEAD; the sim or stub sidecar, no Claude). $0: no Claude call
// anywhere. One driver for the batch: VOC-a's items (the vocabulary) in tools/lib/gate6cvoc-a.mjs and VOC-b's (budgets and rules) in
// tools/lib/gate6cvoc-b.mjs, each a map of step -> named items `{name, run(ctx)}`; a step runs VOC-a's, then VOC-b's. The step names are
// frozen with VOC-a's interface (voc/core).
//
//   node tools/gate6cvoc.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (voc-unit)             offline: items 1, 3, 4 (kit), 5, 12, 13 (gen-vocab), 14 (api-compat), the kit's VOC tests, the
//                                      Java VOC tests; VOC-b's 6, 7 (kit and stub sidecar)
//     registry  (voc-registry)         item 2: dev.vocab.registry against kit/lib/blocks.mjs and the generator's digests, 0 differences;
//                                      the negative control
//     probe     (voc-probe)            item 10: each kit/vocab/hazards.json row in game at default rules
//     survival  (voc-survival)         item 4 in game (the generated creative-only list read by survival placement); VOC-b's item 11
//     ingame    (voc-ingame)           VOC-b's item 8 (v50 and v51 through checkPlan and realiseApproved)
//     natural   (voc-natural)          VOC-b's item 9 (v50n; the drift probe)
//     look      (6cvoc-look)           VOC-b's item 15 (the look, client, recorded not judged)
//     cunit     (vocc-unit)            VOC-c's offline items (tools/lib/gate6cvoc-c.mjs): 1-4, 7-9
//     cingame   (vocc-ingame)          VOC-c's in-game items (headless): 5, 6, the pre-check (S-VOCc-2), the delta re-judge (S-VOCc-3)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-voc/<step>.json in the main checkout (GATE6CVOC_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-VOC-run');
process.env.GATE6B_OUT = process.env.GATE6CVOC_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-voc');
process.env.GATE6B_SIDECAR_PORT ??= '8914';
process.env.GATE6B_DEV_PORT ??= '8915';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const A = await import('./lib/gate6cvoc-a.mjs');
const B = await import('./lib/gate6cvoc-b.mjs');
// (6c VOC-c) rule.palette measured: its own steps, cunit and cingame
const C = await import('./lib/gate6cvoc-c.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

/** The context every item gets (VOC-a's and VOC-b's): the run helpers, the kit importer, the output dir. */
const ctx = { L, OUT, KIT, imp, json, root, check, log };

/** The step names (frozen with voc/core): the driver step -> its gate-chains.json step. */
export const STEPS = Object.freeze({ unit: 'voc-unit', registry: 'voc-registry', probe: 'voc-probe', survival: 'voc-survival', ingame: 'voc-ingame', natural: 'voc-natural', look: '6cvoc-look', cunit: 'vocc-unit', cingame: 'vocc-ingame' });

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice VOC is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
/** Runs a step's items: VOC-a's, then VOC-b's. */
async function items(step) {
  const out = {};
  for (const it of [...(A.items[step] ?? []), ...(B.items[step] ?? [])]) {
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
  await startClient(process.argv[3] ?? 'G6B Flat Base', { backend: 'sim' });
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

steps.unit = async () => { const r = await items('unit'); spendZero(); return r; };
// (6c VOC-c) its items only (no VOC-a/VOC-b item runs under these steps)
async function itemsC(step) {
  const out = {};
  for (const it of C.items[step] ?? []) {
    log(`-- ${it.name}`);
    out[it.name] = await it.run(ctx);
  }
  return out;
}
steps.cunit = async () => { const r = await itemsC('vocc-unit'); spendZero(); return r; };
steps.cingame = async () => { await ensure(); const r = await itemsC('vocc-ingame'); spendZero(); return r; };
for (const s of ['registry', 'probe', 'survival', 'ingame', 'natural', 'look']) {
  steps[s] = async () => { await ensure(); const r = await items(s); spendZero(); return r; };
}

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json'].includes(f));
  const lines = ['# Gate 6c slice VOC', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gate6cvoc.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const f = L.fails();
  log(f ? `${f} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(f ? 1 : 0);
}
void json;
