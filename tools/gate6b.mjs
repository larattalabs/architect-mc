#!/usr/bin/env node
// Phase 6b gate (docs/CONTRACT.md "# Phase 6b contract", §12) against the dev client of the 6b run worktree
// (`../architect-mc-6b-run`, tools/run-gate6b-client.sh). Regions go through the DevBridge (docs/DEVBRIDGE.md "Regions
// (phase 6b)"). The client is launched and stopped by PID. Paid steps (the template picks: crater, rift, picks) run on the
// claude login only: the script refuses to start with an API key or token in its environment, and logs the sidecar's auth
// mode at each paid step (artifacts/gate6b/auth.log); spend is summed in artifacts/gate6b/spend.json, cap $3.
//
//   node tools/gate6b.mjs <step> [args]       steps at the end of this file
//
// Evidence: artifacts/gate6b/<step>.json in the main checkout (GATE6B_OUT overrides), all.log, REPORT.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CAP_USD, GAME_DIR, LIBRARY, MAIN, OUT, RUN, SAVES, call, check, clientPids, cmd, connect, copyWorld, fails, fresh, leaveWorld, log, logAuth,
  openWorld, plan, prepare, realise, refuseKeys, results, root, setRules, settle, sleep, spendAdd, spendGuard, spendRead, startClient, state,
  stopClient, tp, waitRegion, write,
} from './lib/run6b.mjs';
import { findSite, SCENARIO_DIR, readScenario } from './find-site.mjs';

refuseKeys();

/** The pinned world seed of every 6b fixture (S1-S6, the crater and rift gate sites, the volume fixture). */
export const SEED = '2026100906';
const STUB_IDS = ['g6a_stub_9', 'g6a_stub_14', 'g6a_stub_19', 'g6a_stub_24'];
const KIT_EXAMPLES = ['cabin', 'gatehouse', 'tavern', 'tower'];
export const LOT_ENTRIES = [...STUB_IDS, ...KIT_EXAMPLES];
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';

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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
const box3 = (claim, y0, y1, m = 8) => [claim[0] - m, y0 - m, claim[1] - m, claim[2] + m, y1 + m, claim[3] + m];

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: process.argv[4] ?? 'sim' });
  return { head, pids: clientPids() };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
  return { pids: clientPids() };
};

/** The base worlds: the pinned seed's normal world (default rules) and a flat one (the exact rules); the stub blueprints. */
steps.base = async () => {
  await ensure();
  for (const [name, preset] of [[BASE, 'normal'], [FLAT, 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: SEED, cheats: true });
    await setRules(preset === 'flat' ? 'exact' : 'default');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  if (!STUB_IDS.every((id) => fs.existsSync(path.join(LIBRARY, id)) || fs.existsSync(path.join(LIBRARY, `${id}.nbt`)))) execFileSync('node', [path.join(root, 'tools', 'gate6a-stubs.mjs'), LIBRARY]);
  return { worlds: [BASE, FLAT], seed: SEED };
};

/** find-site for the scenarios and gate sites: `findsite <id>|all`. */
steps.findsite = async () => {
  await ensure();
  const all = [...fs.readdirSync(SCENARIO_DIR), ...fs.readdirSync(path.join(SCENARIO_DIR, 'sites'))].filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const ids = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') : all;
  const out = {};
  for (const id of ids) {
    const sc = readScenario(id);
    if (sc.fixture?.surveySha && !process.env.REFIND) { out[id] = { pinned: sc.fixture }; continue; }
    await fresh('G6B FindSite', BASE);
    out[id] = await findSite(id, { call, cmd, tp, log });
    check(!!out[id].claim, `findsite ${id}: ${JSON.stringify(out[id].claim)} score ${out[id].score} (${out[id].tried} candidates)`);
  }
  await leaveWorld();
  return out;
};

/** A crater_works end to end on the flat world: plan (report, previews), prepare, realise with lots, the group undo exact. */
steps.smoke = async () => {
  await ensure();
  await fresh('G6B Smoke', FLAT);
  await tp(0.5, 120, 0.5);
  const claim = [-100, -100, 99, 99];
  const p = await plan('crater_works', claim, { surveyLoad: 'bounded:256' });
  check(!!p.report && p.report.errors === 0, `smoke: the plan carries a report (${p.report?.errors} errors, ${p.report?.warnings} warnings)`, p.summary);
  check(!!p.previews?.paths && Object.keys(p.previews.paths).length >= 4, `smoke: the plan carries previews (${JSON.stringify(p.previews).slice(0, 200)})`);
  const pr = await prepare(p.planId);
  const p2 = await plan('crater_works', claim, { surveyLoad: 'generated:64' });
  const yr = p2.claimY ?? [-64, 319];
  const box = box3(claim, yr[0], yr[1]);
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const region = await realise(p2.planId, { lotEntries: LOT_ENTRIES, fitLots: true });
  const st = await waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `smoke: region ${region} ${st.view.state}, ${st.view.cellsWritten} cells, lots ${JSON.stringify(st.view.lots.map((l) => l.state))}`);
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(5000);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  check(rm.removed && h2.sha256 === h0.sha256, `smoke: the group undo is exact (${rm.restored} cells, ${rm.seconds?.toFixed(1)} s)`, rm);
  await leaveWorld();
  return { plan: { planId: p2.planId, irSha: p2.irSha, budget: p2.budget, report: p2.report?.errors }, prepare: pr.stats, state: st.view, remove: rm };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6b.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
