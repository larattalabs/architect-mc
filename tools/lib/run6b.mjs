// The phase 6b gate's client handling (tools/gate6b.mjs, tools/scenarios.mjs, tools/find-site.mjs): a dev client of the 6b
// run worktree (`../architect-mc-6b-run`, tools/run-gate6b-client.sh: sidecar 8890, DevBridge 8891) launched and stopped by
// PID, worlds copied and opened, the player as a spectator, the sidecar's auth mode for paid steps, and the spend ledger.
// Never kills a process it did not start; never modifies the 6a-run seed worlds (they were cloned into the run worktree).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './devclient.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MAIN = path.resolve(root, '..', 'architect-mc');
export const RUN = process.env.GATE6B_RUN ? path.resolve(process.env.GATE6B_RUN) : path.resolve(root, '..', 'architect-mc-6b-run');
export const OUT = process.env.GATE6B_OUT ? path.resolve(process.env.GATE6B_OUT) : path.join(MAIN, 'artifacts', 'gate6b');
export const PORT = Number(process.env.GATE6B_DEV_PORT || 8891);
export const SIDECAR_PORT = Number(process.env.GATE6B_SIDECAR_PORT || 8890);
export const GAME_DIR = path.join(RUN, 'mod', 'run');
export const SAVES = path.join(GAME_DIR, 'saves');
export const LIBRARY = path.join(GAME_DIR, 'architect', 'library');
export const SIDECAR_DATA = path.join(GAME_DIR, 'architect', 'sidecar-data');
fs.mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logFile = path.join(OUT, 'all.log');
export const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
};

/** Credentials that must never be present (a paid step runs on the claude login only). */
export const KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];
export function refuseKeys() {
  const set = KEY_VARS.filter((k) => process.env[k]?.trim());
  if (set.length) throw new Error(`refused: ${set.join(', ')} is set; the 6b gate runs on the claude login only, never an API key`);
}
/** The environment for the client: without any ANTHROPIC_* or CLAUDE* variable (the launcher script unsets them too). */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^ANTHROPIC_/.test(k) && !/^CLAUDE/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export const state = { dev: null };
export async function connect(timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), 'utf8').trim();
      state.dev = await DevClient.connect({ port: PORT, token, timeoutMs: 20_000 });
      return state.dev;
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`no DevBridge on ${PORT}: ${last}`);
}
export const call = (type, payload = {}, timeoutMs) => state.dev.call(type, payload, timeoutMs ? { timeoutMs } : {});

export function clientPids() {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(RUN)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Start the run worktree's client in `world` (created by AutoWorld when missing). `backend`: 'sim' (default) or 'claude'. */
export async function startClient(world, { backend = 'sim', env = {} } = {}) {
  if (clientPids().length) throw new Error(`a client of ${RUN} runs already: ${clientPids()}`);
  const opts = path.join(GAME_DIR, 'options.txt');
  // no vsync; no clouds (the gallery's cameras sit at cloud height; the graphics preset 'custom' lets renderClouds hold)
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false').replace(/^graphicsPreset:"[a-z]+"$/m, 'graphicsPreset:"custom"').replace(/^renderClouds:"[a-z]+"$/m, 'renderClouds:"false"'));
  fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  setClaudeLogin(backend === 'claude');
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(RUN, 'tools', 'run-gate6b-client.sh'), [], { cwd: RUN, detached: true, stdio: ['ignore', out, out],
    env: cleanEnv({ ARCHITECT_PORT: String(SIDECAR_PORT), ARCHITECT_DEV_PORT: String(PORT), ARCHITECT_AUTOWORLD_NAME: world, ARCHITECT_GATE6B_BACKEND: backend, ...env }) });
  p.unref();
  await connect(900_000);
  await waitInWorld();
  log(`client up (pid ${clientPids()}) in ${world}, backend ${backend}`);
}

/** The sidecar's opt-in to the local claude login (secrets.json), off for every sim run. */
export function setClaudeLogin(on) {
  fs.mkdirSync(SIDECAR_DATA, { recursive: true });
  const f = path.join(SIDECAR_DATA, 'secrets.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { s = {}; }
  delete s.apiKey;
  s.useClaudeLogin = !!on;
  fs.writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
}

export async function waitInWorld(timeoutMs = 900_000) {
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

export async function stopClient() {
  const pids = clientPids();
  if (!pids.length) return;
  try { await state.dev?.call('dev.quit', {}, { timeoutMs: 30_000 }); } catch { /* gone */ }
  for (let i = 0; i < 120 && clientPids().length; i++) await sleep(1000);
  for (const pid of clientPids()) if (pids.includes(pid)) { log(`killing my client pid ${pid}`); process.kill(pid, 'SIGTERM'); }
  for (let i = 0; i < 60 && clientPids().length; i++) await sleep(1000);
  try { state.dev?.close(); } catch { /* closed */ }
  state.dev = null;
}

export const cmd = async (c) => call('dev.command', { cmd: c }, 120_000);
export const settle = (ms = 3000) => call('dev.wait', { ms }, ms + 20_000);

export async function leaveWorld() {
  const st = await call('dev.state');
  if (!st.inWorld) return;
  await call('dev.world.leave', {}, 300_000);
  for (let i = 0; i < 600; i++) { if (!(await call('dev.state')).inWorld) return; await sleep(500); }
  throw new Error('still in the world');
}
export async function openWorld(name, opts = {}) {
  await leaveWorld();
  await call('dev.world.open', { name, ...opts }, 30_000);
  for (let i = 0; i < 1800; i++) {
    await sleep(500);
    const st = await call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) { await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {}); await sleep(2000); return; }
  }
  throw new Error(`world ${name} did not open`);
}
export function copyWorld(from, to) {
  const src = path.join(SAVES, from), dst = path.join(SAVES, to);
  if (!dst.startsWith(SAVES + path.sep) || !to.startsWith('G6B ')) throw new Error(`refusing to replace ${dst}`);
  fs.rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', src, dst]);
  fs.rmSync(path.join(dst, 'session.lock'), { force: true });
}
export async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
/** The player as a spectator at (x, y, z). */
export async function tp(x, y, z, yaw = 0, pitch = 30) {
  await cmd('/gamemode spectator');
  await cmd(`/tp @s ${x} ${y} ${z} ${yaw} ${pitch}`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1500);
}
/** Gamerule sets (CONTRACT 6b §8.1): exact (the 6a E-flat set) and gallery/default (default rules, time 6000, clear). */
export async function setRules(kind) {
  if (kind === 'exact') {
    for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'fire_spread_radius_around_player 0', 'spawn_mobs false', 'spawn_monsters false']) await cmd(`/gamerule ${r}`);
  }
  await cmd('/weather clear');
  await cmd('/time set 6000');
}

/** Plan a region through DevBridge; refused plans throw. */
export async function plan(program, claim, { params = {}, surveyLoad = 'loaded', check = true, seed } = {}) {
  const r = await call('dev.region.plan', { program, claim, params, surveyLoad, check, ...(seed ? { seed } : {}) }, 900_000);
  if (r.refused) throw new Error(`plan refused: ${r.refused}`);
  log(`  plan ${r.planId}: ${program} ir ${r.irSha?.slice(0, 12)} format ${r.irFormat}, ${r.lots?.length} lots, budget ${JSON.stringify(r.budget)}, ${Math.round(r.ms ?? 0)} ms; ${r.summary ?? ''}`);
  return r;
}
export async function prepare(planId) {
  const r = await call('dev.region.prepare', { planId, wait: true }, 4 * 3_600_000);
  if (r.refused) throw new Error(`prepare refused: ${r.refused}`);
  return r;
}
export async function realise(planId, opts = {}) {
  const r = await call('dev.region.realise', { planId, ...opts }, 300_000);
  if (r.refused) throw new Error(`realise refused: ${JSON.stringify(r.refused)}`);
  return r.region;
}
export async function waitRegion(region, timeoutMs = 3 * 3_600_000, onPoll = null) {
  const end = Date.now() + timeoutMs;
  let st;
  while (Date.now() < end) {
    st = await call('dev.region.state', { region }, 60_000);
    const v = st.view;
    log(`  ${region} ${v.state}: ${v.stages.map((s) => `${s.name} ${s.tilesDone}/${s.tilesTotal}`).join(', ')}; cells ${v.cellsWritten}; items ${JSON.stringify(st.items)}`);
    if (onPoll) await onPoll(st);
    if (['PLACED', 'PARTIAL', 'FAILED'].includes(v.state) || (st.batchStatus && st.batchStatus !== 'RUNNING')) return st;
    await sleep(Math.min(30_000, Math.max(5_000, end - Date.now())));
  }
  throw new Error(`region ${region} did not finish`);
}

// ---- spend (CONTRACT 6b §10): every design's cost, summed; the cap stops paid steps
export const SPEND = path.join(OUT, 'spend.json');
export const CAP_USD = 3;
export function spendRead() { try { return JSON.parse(fs.readFileSync(SPEND, 'utf8')); } catch { return { capUsd: CAP_USD, totalUsd: 0, runs: [] }; } }
export function spendAdd(entry) {
  const s = spendRead();
  s.runs.push({ at: new Date().toISOString(), ...entry });
  s.totalUsd = Math.round(s.runs.reduce((a, r) => a + (r.usd ?? 0), 0) * 1e6) / 1e6;
  fs.writeFileSync(SPEND, `${JSON.stringify(s, null, 2)}\n`);
  return s;
}
export function spendGuard(nextEstimateUsd = 0.05) {
  const s = spendRead();
  if (s.totalUsd + nextEstimateUsd > CAP_USD) throw new Error(`spend cap: $${s.totalUsd.toFixed(3)} spent, the next step could pass the $${CAP_USD} cap; ask the coordinator`);
}
/** The sidecar's auth mode, logged at each paid step (the gate-verifier reads the log). */
export async function logAuth(step) {
  const s = await call('dev.sidecar.state', {}, 30_000).catch((e) => ({ error: String(e) }));
  const st = s.status ?? {};
  const line = { step, auth: st.auth ?? null, authSource: st.authSource ?? null, useClaudeLogin: st.useClaudeLogin ?? null, keysInEnv: KEY_VARS.filter((k) => process.env[k]?.trim()) };
  fs.appendFileSync(path.join(OUT, 'auth.log'), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  log(`  auth at ${step}: ${JSON.stringify(line)}`);
  return line;
}

export const results = {};
let failures = 0;
export const fails = () => failures;
export function check(ok, m, data) {
  log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
}
export const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
