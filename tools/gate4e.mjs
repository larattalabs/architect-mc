#!/usr/bin/env node
// Phase 4e gate (docs/CONTRACT.md "Phase 4e gate" + Steward's additions) against the dev client of the run worktree
// (tools/run-gate4e-client.sh: DevBridge 8891, sidecar 8890, the apitest mod). The API goes through apitest's /apitest steps
// (dev.larattalabs.architect.api only); DevBridge hooks hash regions, read the journal, arm kill points, switch worlds. Steps
// that restart the client (crash kill points, migration, the downgrade round trip, the 1.4.0 apitest jar) launch and stop it
// themselves, by PID. No Claude.
//
//   node tools/gate4e.mjs <step> [args]     steps at the end of this file; `all` runs the gate
//
// Evidence: artifacts/gate4e/<step>.json in the MAIN checkout (GATE4E_OUT overrides), all.log, bench.json, REPORT.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE4E_OUT ? path.resolve(process.env.GATE4E_OUT) : path.join(MAIN, 'artifacts', 'gate4e');
fs.mkdirSync(OUT, { recursive: true });
// the client runs from a separate worktree (compiling here never changes a running client's classes)
const RUN = process.env.GATE4E_RUN ? path.resolve(process.env.GATE4E_RUN) : path.resolve(root, '..', 'architect-mc-4e-run');
const GAME_DIR = path.join(RUN, 'mod', 'run');
const SAVES = path.join(GAME_DIR, 'saves');
const PORT = Number(process.env.ARCHITECT_DEV_PORT || 8891);
const V070 = path.resolve(root, '..', 'architect-mc-v070');
const V070_PORT = 8893;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failures = 0;
const logFile = path.join(OUT, 'all.log');
const log = (...a) => {
  const line = a.join(' ');
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

// ------------------------------------------------------------------ the client (launched by PID)

let dev = null;
async function connect(port = PORT, gameDir = GAME_DIR, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(path.join(gameDir, 'architect', 'devbridge.token'), 'utf8').trim();
      dev = await DevClient.connect({ port, token, timeoutMs: 20_000 });
      return dev;
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`no DevBridge on ${port}: ${last}`);
}
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});

function clientPids(dir = RUN) {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(dir)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Starts the gate client (this worktree) on {@code world}; returns once it is in the world. */
async function startClient(world, env = {}) {
  if (clientPids().length) throw new Error(`a client of ${RUN} runs already: ${clientPids()}`);
  try {
    fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  } catch {
    // none
  }
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(RUN, 'tools', 'run-gate4e-client.sh'), [], { cwd: RUN, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, ARCHITECT_AUTOWORLD_NAME: world, ...env } });
  p.unref();
  await connect(PORT, GAME_DIR, 600_000);
  await waitInWorld();
  log(`client up (pid ${clientPids()}) in ${world}`);
}

async function waitInWorld(timeoutMs = 600_000) {
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

/** Stops the gate client: a clean quit, then (only this worktree's java, by PID) a kill. */
async function stopClient(dir = RUN) {
  const pids = clientPids(dir);
  if (!pids.length) return;
  try {
    await dev?.call('dev.quit', {}, { timeoutMs: 30_000 });
  } catch {
    // it may already be gone
  }
  for (let i = 0; i < 120 && clientPids(dir).length; i++) await sleep(1000);
  for (const pid of clientPids(dir)) {
    if (pids.includes(pid)) {
      log(`killing my client pid ${pid}`);
      process.kill(pid, 'SIGTERM');
    }
  }
  for (let i = 0; i < 60 && clientPids(dir).length; i++) await sleep(1000);
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
}

/** Waits for the client to die (a kill point halted it). */
async function waitDead(timeoutMs = 120_000) {
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

// ------------------------------------------------------------------ commands, apitest, hashes

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
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${key}`);
};
let eventMark = 0;
const events = async (from = 0) => api(`events ${from}`);
const since = async () => events(eventMark);
const mark = async () => {
  eventMark = (await events(0)).length;
};
const waitEvent = async (pred, timeoutMs = 120_000, what = 'event') => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const e = (await since()).find(pred);
    if (e) return e;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
};
async function queue(spec) {
  const r = await result(await api(`bqueue ${JSON.stringify(spec)}`));
  if (typeof r !== 'string') throw new Error(`queue refused: ${JSON.stringify(r)}`);
  return r;
}
async function waitBatch(id, timeoutMs = 600_000) {
  return waitEvent((e) => e.event === 'BATCH_DONE' && e.batch === id, timeoutMs, `BATCH_DONE ${id}`);
}
const settle = (ms = 3000) => call('dev.wait', { ms }, 20_000);
async function hash(box, exclude = [], cells = false) {
  await settle();
  return call('dev.region.hash', { box, exclude, cells }, 300_000);
}
const grow = (b, n) => [b[0] - n, b[1] - n, b[2] - n, b[3] + n, b[4] + n, b[5] + n];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
function box6(s) {
  if (Array.isArray(s)) return s;
  if (typeof s === 'string' && /^-?\d+,/.test(s)) return s.split(',').map(Number);
  const m = /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(s);
  return m.slice(1).map(Number);
}
function diff(a, b, max = 20) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) if (a[i] !== b[i]) out.push({ a: a[i], b: b[i] });
  return out;
}
const sites = async () => (await api('sites')).all;
const siteState = async (id) => call('dev.site.state', { site: id }, 60_000);
const journal = async () => call('dev.journal.state', {}, 60_000);

async function setRules(extra = []) {
  for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'fire_spread_radius_around_player 0',
    'spawn_mobs false', 'spawn_monsters false', ...extra]) {
    await cmd(`/gamerule ${r}`);
  }
  await cmd('/weather clear');
  await cmd('/time set 6000');
}
async function groundAt(x, z) {
  let s;
  for (let i = 0; i < 40; i++) {
    s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
    if (s.columns?.length) break;
    await sleep(500);
  }
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  if (!m) throw new Error(`no ground at ${x},${z}`);
  return Number(m[1]);
}

// ------------------------------------------------------------------ worlds

async function leaveWorld() {
  const st = await call('dev.state');
  if (!st.inWorld) return;
  await call('dev.world.leave', {}, 180_000);
  for (let i = 0; i < 240; i++) {
    if (!(await call('dev.state')).inWorld) return;
    await sleep(500);
  }
  throw new Error('still in the world');
}
async function openWorld(name, opts = {}) {
  await leaveWorld();
  await call('dev.world.open', { name, ...opts }, 30_000);
  for (let i = 0; i < 600; i++) {
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
function copyWorld(from, to, saves = SAVES) {
  const src = path.join(saves, from);
  const dst = path.join(saves, to);
  if (!dst.startsWith(saves + path.sep) || !to.startsWith('G4E ')) throw new Error(`refusing to replace ${dst}`);
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

// ------------------------------------------------------------------ owned cells (the shape-leak check)

/** The cells a site owns now and their states (dev.site.owned). */
async function owned(site) {
  return call('dev.site.owned', { site }, 120_000);
}
/** Cells of {@code before} (owned before a removal) that still are the site's and changed. */
function ownedChanged(before, after) {
  const now = new Map(after.cells.map((c) => [c.p, c.v]));
  const changed = [];
  for (const c of before.cells) {
    if (now.has(c.p) && now.get(c.p) !== c.v) changed.push({ p: c.p, was: c.v, now: now.get(c.p) });
  }
  return changed;
}

export { };

// ------------------------------------------------------------------ steps (defined below)

const steps = {};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data;
  let error;
  log(`== ${name} (${new Date().toISOString()})`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    failures++;
  }
  if (!['all', 'eval', 'stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, error, results: { ...results }, data });
}

// ================================================================== the steps

steps.smoke = async () => {
  if (!dev) await connect();
  await setRules();
  const p = (await call('dev.state')).player;
  const cx = Math.floor(p.x) + 40;
  const cz = Math.floor(p.z);
  const y = await groundAt(cx, cz);
  const area = [cx - 30, y - 20, cz - 30, cx + 30, y + 40, cz + 30];
  const h0 = await hash(area);
  const T = await call('dev.cells.place', { kind: 'apitest:pad', pad: { minX: cx - 20, maxX: cx + 19, minZ: cz - 20, maxZ: cz + 19, y, depth: 3, clear: 12 } },
    600_000);
  check(T.placed, `smoke: pad T placed (${T.siteId})`, T);
  const R = await call('dev.road.place', { points: [[cx - 25, y + 1, cz], [cx + 25, y + 1, cz]], width: 3 }, 180_000);
  check(R.placed, `smoke: road R placed (${R.siteId})`, R);
  const H = await result(await api(`place cabin ${cx - 10} ${y + 1} ${cz - 15} INSTANT unowned noactor 0 layer`));
  check(H.placed, `smoke: cabin H layered on T (${H.siteId})`, H);
  const X = await result(await api(`place gatehouse ${cx - 1} ${y + 1} ${cz - 15} INSTANT unowned noactor 0 layer`));
  check(X.placed, `smoke: gatehouse X layered over H (${X.siteId})`, X);
  const all = await sites();
  log(JSON.stringify(all.map((s) => ({ id: s.id, kind: s.kind, covers: s.covers, coveredBy: s.coveredBy, rb: s.restoreBox }))));
  for (const id of [H.siteId, R.siteId, X.siteId, T.siteId]) {
    if (!id) continue;
    const r = await result(await api(`remove ${id} - noforce keep`), 300_000);
    log(`removed ${id}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  const h1 = await hash(area);
  check(h1.sha256 === h0.sha256, 'smoke: the area is back exactly after removing H, R, X, T', { h0: h0.sha256, h1: h1.sha256 });
  return { area, T, R, H, X };
};

/** Surveys the loaded ground around the player (step 4): {x, z} -> {h, top}. */
async function surveyAround(r = 160, step = 4) {
  const p = (await call('dev.state')).player;
  const x0 = Math.floor(p.x);
  const z0 = Math.floor(p.z);
  const s = await result(await api(`survey ${x0 - r} ${z0 - r} ${x0 + r} ${z0 + r} ${step}`), 300_000);
  const cols = new Map();
  for (const c of s.columns ?? []) {
    const m = /^(-?\d+),(-?\d+) h(-?\d+) floor(-?\d+) (\S+)/.exec(c);
    if (m) cols.set(`${m[1]},${m[2]}`, { x: +m[1], z: +m[2], h: +m[3], floor: +m[4], top: m[5] });
  }
  return cols;
}
/** The flattest dry w x d window (step 4) among surveyed columns: {x, z (min corner), range, mean}. */
function flattest(cols, w, d, step = 4) {
  let best = null;
  const xs = [...new Set([...cols.values()].map((c) => c.x))].sort((a, b) => a - b);
  const zs = [...new Set([...cols.values()].map((c) => c.z))].sort((a, b) => a - b);
  for (const x of xs) {
    for (const z of zs) {
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      let n = 0;
      let ok = true;
      for (let dx = 0; dx <= w && ok; dx += step) {
        for (let dz = 0; dz <= d && ok; dz += step) {
          const c = cols.get(`${x + dx},${z + dz}`);
          if (!c || /water|lava|ice|leaves|log/.test(c.top)) {
            ok = false;
            break;
          }
          lo = Math.min(lo, c.h);
          hi = Math.max(hi, c.h);
          sum += c.h;
          n++;
        }
      }
      if (ok && (best === null || hi - lo < best.range)) best = { x, z, range: hi - lo, mean: Math.round(sum / n) };
    }
  }
  return best;
}

/** `stop`: quits the gate client (by PID if it hangs). `start [world]`: moves the run worktree to this worktree's HEAD and starts it. */
steps.stop = async () => {
  try {
    await connect(PORT, GAME_DIR, 10_000);
  } catch {
    // not answering: killed by PID below
  }
  await stopClient();
  return { pids: clientPids() };
};
steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  await startClient(process.argv[3] ?? 'G4E Smoke');
  return { head, pids: clientPids() };
};

/** Debugging: `node tools/gate4e.mjs eval '<async js>'` with the helpers in scope; prints the value. */
steps.eval = async () => {
  if (!dev) await connect();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const helpers = { surveyAround, flattest, call, cmd, api, result, hash, sites, siteState, journal, groundAt, tp, sleep, mark, since, queue, waitBatch, ctx };
  const f = new AsyncFunction(...Object.keys(helpers), process.argv[3]);
  const v = await f(...Object.values(helpers));
  console.log(JSON.stringify(v, null, 1));
  return v;
};

steps.all = async () => {
  for (const s of ['orders', 'edits', 'roads', 'survival', 'crash', 'migration', 'downgrade', 'mspt', 'adjacent', 'leaves', 'megalite', 'bench', 'api']) {
    await run(s);
  }
};

const which = process.argv[2] ?? 'smoke';
await run(which);
log(failures === 0 ? `ALL OK (${which})` : `${failures} FAILURE(S) (${which})`);
try {
  dev?.close();
} catch {
  // closed
}
process.exit(failures === 0 ? 0 : 1);
