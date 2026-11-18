#!/usr/bin/env node
// Phase 8c's in-game lane gate (docs/CONTRACT.md "Phase 8c": slices PB, WU, CR) against the headless server of the 8c run worktree
// (GATE6B_RUN, default `../architect-mc-8c-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0.
// The items live in tools/lib/gate8c-game.mjs; the hand IRs are kit/regions/river_demo.mjs and fall_island.mjs.
//
//   node tools/gate8c.mjs <step>
//     start [world] | stop | base      the headless server and the base worlds
//     probe     (8c-probe)             PB: the river's long-flow census against its prediction; fall damage at 24, 32 and 48 drops
//                                      into basins 2 and 3 deep (recorded in kit/lint/water-calibration.json's `flowing`)
//     ingame    (8c-ingame)            WU: river_demo and fall_island PLACED, census equal, Remove E-flat 0 in the watch sets; the wash
//                                      rule; foreign water left by the drain; a Remove while draining joins it; 0 new item entities
//     crash     (8c-crash)             CR: FL7, FL8, FL9 bare and +save, then FL1+save, FL2+save, FL4+save and FL5+save on the river
//     survival  (8c-survival)          SV: c05 in survival (the staged island's typed terrain wait, the hidden room), river_demo's
//                                      wash in survival (and its nowash control), c03 a river through a hamlet in survival (bills,
//                                      Remove exact), Steward's rows through dev.region.state (tools/lib/gate8c-sv.mjs)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate8c/<step>.json in the main checkout (GATE8C_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatePart } from './lib/gate-part.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-8c-run');
process.env.GATE6B_OUT = process.env.GATE8C_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate8c');
process.env.GATE6B_SIDECAR_PORT ??= '9074';
process.env.GATE6B_DEV_PORT ??= '9075';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const G = await import('./lib/gate8c-game.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, sprintWaits: true };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'phase 8c in-game lane is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B 8c Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(G.FLAT);
  spendZero();
  return { worlds: [G.FLAT] };
};

const INGAME_SECTIONS = G.INGAME.map((it) => it.key);
const CRASH_SECTIONS = G.CRASH.map((it) => it.key);
const SV = await import('./lib/gate8c-sv.mjs');
const SURVIVAL_SECTIONS = SV.SURVIVAL.map((it) => it.key);
async function items(list, sections, c = ctx) {
  const P = gatePart(sections, { log });
  const out = {};
  for (const it of list) {
    if (!P.want(it.key)) continue;
    log(`-- ${it.key}: ${it.name}`);
    try {
      out[it.key] = await it.run(c);
    } catch (e) {
      log(String(e?.stack ?? e));
      check(false, `${it.key}: ${String(e?.message ?? e).slice(0, 300)}`);
      out[it.key] = { error: String(e?.message ?? e) };
      try { await L.leaveWorld(); } catch { /* the next item opens its own world */ }
    }
  }
  return out;
}
steps.probe = async () => { await ensure(); spendZero(); return G.probe(ctx); };
steps.ingame = async () => { await ensure(); spendZero(); return items(G.INGAME, INGAME_SECTIONS); };
steps.crash = async () => { await ensure(); spendZero(); return items(G.CRASH, CRASH_SECTIONS); };
steps.survival = async () => {
  await ensure();
  spendZero();
  const svCtx = { ...ctx, B: await import('./lib/gate6chy-b.mjs'), core: await import('./lib/gate6chy-core.mjs'), G: await import('./lib/gate6crs-game.mjs') };
  return items(SV.SURVIVAL, SURVIVAL_SECTIONS, svCtx);
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && f !== 'spend.json');
  const lines = ['# Gate 8c (in-game lane)', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (!j.results) continue;
    const fails = Object.entries(j.results).filter(([, v]) => v === false || v?.ok === false);
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s): ${fails.length ? `${fails.length} FAIL` : 'PASS'}`, '');
    for (const [k] of fails) lines.push(`- FAIL ${k}`);
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate8c.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
