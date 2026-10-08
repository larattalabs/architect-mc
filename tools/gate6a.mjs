#!/usr/bin/env node
// Phase 6a gate (docs/CONTRACT.md "# Phase 6 contract", §9 "Phase 6a gate") against the dev client of the run worktree
// (tools/run-gate6a-client.sh: the real sidecar with its sim backend, DevBridge 8893, sidecar 8892, the apitest mod). Regions
// go through the DevBridge hooks dev.region.* (the API underneath) and apitest's /apitest r* steps; the client is launched and
// stopped by PID. No Claude, no keys.
//
//   node tools/gate6a.mjs <step> [args]       steps at the end of this file
//
// Evidence: artifacts/gate6a/<step>.json in the MAIN checkout (GATE6A_OUT overrides), all.log, bench.json, REPORT.md.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE6A_OUT ? path.resolve(process.env.GATE6A_OUT) : path.join(MAIN, 'artifacts', 'gate6a');
fs.mkdirSync(OUT, { recursive: true });
const RUN = process.env.GATE6A_RUN ? path.resolve(process.env.GATE6A_RUN) : path.resolve(root, '..', 'architect-mc-6a-run');
const PORT = Number(process.env.ARCHITECT_DEV_PORT || 8893);
const SIDECAR_PORT = Number(process.env.ARCHITECT_PORT || 8892);
const GAME_DIR = path.join(RUN, 'mod', 'run');
const SAVES = path.join(GAME_DIR, 'saves');
const LIBRARY = path.join(GAME_DIR, 'architect', 'library');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failures = 0;
const logFile = path.join(OUT, 'all.log');
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
};
const check = (ok, m, data) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
const CTX = path.join(OUT, 'context.json');
const ctx = fs.existsSync(CTX) ? JSON.parse(fs.readFileSync(CTX, 'utf8')) : {};
const saveCtx = () => fs.writeFileSync(CTX, JSON.stringify(ctx, null, 2));

// ------------------------------------------------------------------ the client (launched and stopped by PID)

let dev = null;
async function connect(timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), 'utf8').trim();
      dev = await DevClient.connect({ port: PORT, token, timeoutMs: 20_000 });
      return dev;
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`no DevBridge on ${PORT}: ${last}`);
}
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});

function clientPids() {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(RUN)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function startClient(world, env = {}) {
  if (clientPids().length) throw new Error(`a client of ${RUN} runs already: ${clientPids()}`);
  const opts = path.join(GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(RUN, 'tools', 'run-gate6a-client.sh'), [], { cwd: RUN, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, ARCHITECT_PORT: String(SIDECAR_PORT), ARCHITECT_DEV_PORT: String(PORT), ARCHITECT_AUTOWORLD_NAME: world, ...env } });
  p.unref();
  await connect(900_000);
  await waitInWorld();
  log(`client up (pid ${clientPids()}) in ${world}`);
}

async function waitInWorld(timeoutMs = 900_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = await call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) {
      await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
      await sleep(2000);
      return st;
    }
    await sleep(1000);
  }
  throw new Error('not in a world');
}

async function stopClient() {
  const pids = clientPids();
  if (!pids.length) return;
  try {
    await dev?.call('dev.quit', {}, { timeoutMs: 30_000 });
  } catch {
    // gone already
  }
  for (let i = 0; i < 120 && clientPids().length; i++) await sleep(1000);
  for (const pid of clientPids()) {
    if (pids.includes(pid)) {
      log(`killing my client pid ${pid}`);
      process.kill(pid, 'SIGTERM');
    }
  }
  for (let i = 0; i < 60 && clientPids().length; i++) await sleep(1000);
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
}

async function waitDead(timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && clientPids().length) await sleep(500);
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
  return clientPids().length === 0;
}

// ------------------------------------------------------------------ commands and worlds

const cmd = async (c) => call('dev.command', { cmd: c }, 120_000);
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 200)}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 120_000) => {
  const key = pending.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${key}`);
};
const settle = (ms = 3000) => call('dev.wait', { ms }, ms + 20_000);

async function setRules(extra = []) {
  for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'fire_spread_radius_around_player 0',
    'spawn_mobs false', 'spawn_monsters false', ...extra]) {
    await cmd(`/gamerule ${r}`);
  }
  await cmd('/weather clear');
  await cmd('/time set 6000');
}

async function leaveWorld() {
  const st = await call('dev.state');
  if (!st.inWorld) return;
  await call('dev.world.leave', {}, 300_000);
  for (let i = 0; i < 600; i++) {
    if (!(await call('dev.state')).inWorld) return;
    await sleep(500);
  }
  throw new Error('still in the world');
}
async function openWorld(name, opts = {}) {
  await leaveWorld();
  await call('dev.world.open', { name, ...opts }, 30_000);
  for (let i = 0; i < 1800; i++) {
    await sleep(500);
    const st = await call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) {
      await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
      await sleep(2000);
      return;
    }
  }
  throw new Error(`world ${name} did not open`);
}
function copyWorld(from, to) {
  const src = path.join(SAVES, from);
  const dst = path.join(SAVES, to);
  if (!dst.startsWith(SAVES + path.sep) || !to.startsWith('G6A ')) throw new Error(`refusing to replace ${dst}`);
  fs.rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', src, dst]);
  fs.rmSync(path.join(dst, 'session.lock'), { force: true });
}
async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
async function tp(x, y, z) {
  await cmd(`/tp @s ${x} ${y} ${z} 0 30`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1500);
}
function du(p) {
  try {
    return execFileSync('du', ['-sk', p]).toString().split(/\s+/)[0] * 1024;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ regions

const MEGA = { program: 'mega_bench', claim: [-500, -500, 499, 499] };
const SMALL = { program: 'region_small', claim: [-96, -96, 95, 95] };
const STUB_IDS = ['g6a_stub_9', 'g6a_stub_14', 'g6a_stub_19', 'g6a_stub_24'];
const KIT_EXAMPLES = ['cabin', 'gatehouse', 'tavern', 'tower'];
const LOT_ENTRIES = [...STUB_IDS, ...KIT_EXAMPLES];

async function plan(spec, surveyLoad = 'loaded', params = {}) {
  const r = await call('dev.region.plan', { program: spec.program, claim: spec.claim, params, surveyLoad }, 600_000);
  if (r.refused) throw new Error(`plan refused: ${r.refused}`);
  log(`  plan ${r.planId}: ir ${r.irSha?.slice(0, 12)}, ${r.lots?.length} lots, stages ${r.stages?.join(',')}, budget ${JSON.stringify(r.budget)}, ${r.ms?.toFixed(0)} ms`);
  return r;
}
async function prepare(planId, inFlight) {
  const r = await call('dev.region.prepare', { planId, ...(inFlight ? { inFlight } : {}), wait: true }, 4 * 3_600_000);
  if (r.refused) throw new Error(`prepare refused: ${r.refused}`);
  log(`  prepare ${planId}: ${JSON.stringify(r.stats ?? r)}`);
  return r;
}
async function realise(planId, opts = {}) {
  const r = await call('dev.region.realise', { planId, lotEntries: LOT_ENTRIES, ...opts }, 300_000);
  if (r.refused) throw new Error(`realise refused: ${r.refused}`);
  log(`  realise ${planId} -> ${r.region}`);
  return r.region;
}
const regionState = (region) => call('dev.region.state', { region }, 60_000);

/** Waits for a region's batch to end, polling once a minute (logging waits); returns the last state. */
async function waitRegion(region, timeoutMs = 3 * 3_600_000, onPoll = null) {
  const end = Date.now() + timeoutMs;
  let st;
  while (Date.now() < end) {
    st = await regionState(region);
    const v = st.view;
    log(`  ${region} ${v.state}: ${v.stages.map((s) => `${s.name} ${s.tilesDone}/${s.tilesTotal}`).join(', ')}; cells ${v.cellsWritten}; items ${JSON.stringify(st.items)}; waiting ${JSON.stringify(st.waiting)}`);
    if (onPoll) await onPoll(st);
    if (['PLACED', 'PARTIAL', 'FAILED'].includes(v.state) || st.batchStatus && st.batchStatus !== 'RUNNING') return st;
    await sleep(Math.min(60_000, Math.max(5_000, end - Date.now())));
  }
  throw new Error(`region ${region} did not finish`);
}

// ------------------------------------------------------------------ steps

const steps = {};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data;
  let error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    failures++;
  }
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, error, results: { ...results }, data });
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6A Smoke');
  return { head, pids: clientPids() };
};
steps.stop = async () => {
  try {
    await connect(10_000);
  } catch {
    // not answering: by PID below
  }
  await stopClient();
  return { pids: clientPids() };
};

/** The base worlds: a normal world of seed mega6 (claim centre at 0,0) and a flat one; creative, cheats, the gate's rules. */
steps.base = async () => {
  if (!dev) await connect();
  for (const [name, preset] of [['G6A Mega Base', 'normal'], ['G6A Flat Base', 'flat']]) {
    if (fs.existsSync(path.join(SAVES, name, 'level.dat'))) continue;
    await leaveWorld();
    await openWorld(name, { mode: 'creative', preset, seed: 'mega6', cheats: true });
    await setRules();
    await tp(0.5, 200, 0.5);
    await cmd('/kill @e[type=!minecraft:player]');
    await cmd('/save-all flush');
    await leaveWorld();
  }
  execFileSync('node', [path.join(root, 'tools', 'gate6a-stubs.mjs'), LIBRARY]);
  return { worlds: ['G6A Mega Base', 'G6A Flat Base'], stubs: STUB_IDS };
};

/** A small region end to end on the flat world: plan, prepare, realise, hash, group undo exact. */
steps.smoke = async () => {
  if (!dev) await connect();
  await fresh('G6A Smoke', 'G6A Flat Base');
  await tp(0.5, 120, 0.5);
  await cmd('/architect reload').catch(() => null);
  const box = [SMALL.claim[0] - 8, -64, SMALL.claim[1] - 8, SMALL.claim[2] + 8, 120, SMALL.claim[3] + 8];
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const p = await plan(SMALL, 'loaded');
  const pr = await prepare(p.planId);
  const p2 = await plan(SMALL, 'generated:64');
  const region = await realise(p2.planId);
  const st = await waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `smoke: region ${region} ${st.view.state}, ${st.view.cellsWritten} cells`, st);
  const h1 = await call('dev.region.hash', { box }, 3_600_000);
  check(h1.sha256 !== h0.sha256, 'smoke: the region changed the world');
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(3000);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  check(rm.removed && h2.sha256 === h0.sha256, `smoke: the group undo is exact (${rm.restored} cells, ${rm.seconds?.toFixed(1)} s)`, rm);
  await leaveWorld();
  return { plan: p2, prepare: pr, state: st, remove: rm };
};

/** Debugging: node tools/gate6a.mjs eval '<async js>' with the helpers in scope. */
steps.eval = async () => {
  if (!dev) await connect();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const helpers = { call, cmd, api, result, plan, prepare, realise, regionState, waitRegion, fresh, openWorld, leaveWorld, tp, sleep, ctx, saveCtx, log };
  const f = new AsyncFunction(...Object.keys(helpers), process.argv[3]);
  const v = await f(...Object.values(helpers));
  console.log(JSON.stringify(v, null, 1));
  return v;
};

const which = process.argv[2] ?? 'smoke';
if (!steps[which]) {
  console.error(`unknown step ${which}; steps: ${Object.keys(steps).join(' ')}`);
  process.exit(2);
}
await run(which);
log(failures === 0 ? `ALL OK (${which})` : `${failures} FAILURE(S) (${which})`);
try {
  dev?.close();
} catch {
  // closed
}
process.exit(failures === 0 ? 0 : 1);
