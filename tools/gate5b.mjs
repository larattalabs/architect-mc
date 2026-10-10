#!/usr/bin/env node
// Phase 5b gate (docs/CONTRACT.md "Phase 5b gate", delta apply items 2-5, 8-9) against the dev client of the run worktree
// (tools/run-gate5b-client.sh: DevBridge 8891, sidecar 8890, the apitest mod). The API goes through apitest's /apitest steps
// (dev.larattalabs.architect.api only); DevBridge hooks hash regions, read the journal, arm kill points, switch worlds. Steps
// that restart the client (crash kill points, migration, the downgrade round trip, the 1.4.0 apitest jar) launch and stop it
// themselves, by PID. No Claude.
//
//   node tools/gate4e.mjs <step> [args]     steps at the end of this file; `all` runs the gate
//
// Evidence: artifacts/gate5b/<step>.json in the MAIN checkout (GATE5B_OUT overrides), all.log, bench.json, REPORT.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fromPlacementStats as ownTick, ownOk, describe as tickText } from './lib/tickbar.mjs';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE5B_OUT ? path.resolve(process.env.GATE5B_OUT) : path.join(MAIN, 'artifacts', 'gate5b');
fs.mkdirSync(OUT, { recursive: true });
// the client runs from a separate worktree (compiling here never changes a running client's classes)
const RUN = process.env.GATE5B_RUN ? path.resolve(process.env.GATE5B_RUN) : path.resolve(root, '..', 'architect-mc-5b-run');
const V090 = path.resolve(root, '..', 'architect-mc-v090');
// the old-version client's ports (8892/8893 unless another run holds them: ARCHITECT_GATE_OLD_SIDECAR_PORT / _DEV_PORT)
const OLD_SIDECAR_PORT = Number(process.env.ARCHITECT_GATE_OLD_SIDECAR_PORT || 8892);
const OLD_DEV_PORT = Number(process.env.ARCHITECT_GATE_OLD_DEV_PORT || 8893);
/** The two clients: the 0.10.0 gate client (run worktree) and the 0.9.0 one (tag v0.9.0, for the downgrade note). */
const CLIENTS = {
  new: { name: '0.10.0', dir: RUN, port: Number(process.env.ARCHITECT_DEV_PORT || 8891), script: 'tools/run-gate5b-client.sh', env: {} },
  old: { name: '0.9.0', dir: V090, port: OLD_DEV_PORT, script: 'tools/run-gate4e-client.sh',
    env: { ARCHITECT_PORT: String(OLD_SIDECAR_PORT), ARCHITECT_DEV_PORT: String(OLD_DEV_PORT), ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots090') } },
};
let CUR = CLIENTS.new;
let GAME_DIR = path.join(CUR.dir, 'mod', 'run');
let SAVES = path.join(GAME_DIR, 'saves');
let PORT = CUR.port;
/** Switches the helpers (connection, saves, PIDs) to the other client; the caller stops the current one first. */
function use(which) {
  CUR = CLIENTS[which];
  GAME_DIR = path.join(CUR.dir, 'mod', 'run');
  SAVES = path.join(GAME_DIR, 'saves');
  PORT = CUR.port;
}
const savesOf = (which) => path.join(CLIENTS[which].dir, 'mod', 'run', 'saves');

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
  port = port ?? PORT;
  gameDir = gameDir ?? GAME_DIR;
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

function clientPids(dir = CUR.dir) {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(dir)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** Starts the gate client (this worktree) on {@code world}; returns once it is in the world. */
async function startClient(world, env = {}) {
  if (clientPids().length) throw new Error(`a client of ${CUR.dir} runs already: ${clientPids()}`);
  const opts = path.join(GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  try {
    fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  } catch {
    // none
  }
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(CUR.dir, CUR.script), [], { cwd: CUR.dir, detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, ...CUR.env, ARCHITECT_AUTOWORLD_NAME: world, ...env } });
  p.unref();
  await connect(PORT, GAME_DIR, 600_000);
  await waitInWorld();
  log(`${CUR.name} client up (pid ${clientPids()}) in ${world}`);
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
async function stopClient(dir = CUR.dir) {
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
function copyWorld(from, to, saves = SAVES, fromSaves = saves) {
  const src = path.join(fromSaves, from);
  const dst = path.join(saves, to);
  if (!dst.startsWith(saves + path.sep) || !to.startsWith('G5B ')) throw new Error(`refusing to replace ${dst}`);
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

const FLAT = 'G5B Flat';
/** A flat meadow (grass top at y 64), creative, cheats, the gate rules, no entities. Made once. */
async function flatBase(force = false) {
  if (!force && fs.existsSync(path.join(SAVES, FLAT, 'level.dat'))) return;
  await leaveWorld();
  fs.rmSync(path.join(SAVES, FLAT), { recursive: true, force: true });
  await openWorld(FLAT, { mode: 'creative', preset: 'flat', cheats: true });
  await setRules();
  await tp(48.5, 70, 0.5);
  await cmd('/kill @e[type=!minecraft:player]');
  await cmd('/save-all flush');
  await leaveWorld();
}

const LIB = () => path.join(GAME_DIR, 'architect', 'library');
/** Installs a hand-written entry's version 1 (a folder of <id>.* files) as a user library entry, replacing an older copy. */
async function installEntry(id, dir) {
  const d = path.join(LIB(), id);
  if (!d.startsWith(LIB() + path.sep)) throw new Error('bad entry');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(d, f));
  await cmd('/architect reload');
}
const installVersion = async (entry, dir, summary = '') => call('dev.entry.installVersion', { entry, dir, summary }, 60_000);
const deltaCheck = async (site, version, opts = {}) => call('dev.site.delta.check', { site, version, ...opts }, 60_000);
const deltaApply = async (site, version, opts = {}) => call('dev.site.delta.apply', { site, version, ...opts }, 120_000);
const revert = async (site, version, opts = {}) => call('dev.site.revert', { site, version, ...opts }, 120_000);
const history = async (site) => call('dev.site.history', { site }, 30_000);

steps.smoke = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = process.env.G5B_VERSIONS ?? path.join(OUT, 'versions-smoke');
  await fresh('G5B Smoke', FLAT);
  await tp(-30.5, 90, -30.5);
  await installEntry('g5b_cabin', path.join(V, 'v1'));
  for (const v of ['v2', 'v3', 'v4', 'v5']) {
    const r = await installVersion('g5b_cabin', path.join(V, v), v);
    check(r.version >= 2, `smoke: installed ${v} as version ${r.version}`, r);
  }
  const vs = await call('dev.entry.versions', { entry: 'g5b_cabin' });
  log(`  versions: head ${vs.head}, folders ${vs.folders}`);
  const BOX = [0, 50, 0, 60, 90, 60];
  const h0 = await hash(BOX);
  const placed = await result(await api('place g5b_cabin 20 64 20 INSTANT unowned noactor 1'));
  check(placed.placed, `smoke: placed ${placed.siteId}`, placed);
  const site = placed.siteId;
  const hist0 = await history(site);
  log(`  history: ${JSON.stringify(hist0)}`);
  const seq = [2, 3, 5, 4, 1, 3];
  for (const to of seq) {
    const c = await deltaCheck(site, to);
    log(`  check v${c.from}->v${to}: applicable ${c.applicable} +${c.added} -${c.removed} ~${c.changed} writes ${c.writes} guards ${c.shapeGuards} growth ${c.growth} ${JSON.stringify(c.refusals)}`);
    const before = await hash(BOX);
    const a = await deltaApply(site, to);
    check(a.applied, `smoke: apply v${to}: written ${a.written}, reshaped ${a.reshaped}`, a);
    const after = await hash(BOX);
    const h = await history(site);
    const r = await revert(site, h.chain.at(-2));
    const back = await hash(BOX);
    check(back.sha256 === before.sha256, `smoke: revert of v${to} restores the world before it (E2)`, { r, before: before.sha256, back: back.sha256 });
    const again = await deltaApply(site, to);
    const after2 = await hash(BOX);
    check(again.applied && after2.sha256 === after.sha256, `smoke: re-apply v${to} gives the same world`, { again, after: after.sha256, after2: after2.sha256 });
  }
  const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
  check(rm.removed, `smoke: remove ${site}`, rm);
  const h1 = await hash(BOX);
  check(h1.sha256 === h0.sha256, 'smoke: Remove after the deltas restores the pre-site world (E3)', { h0: h0.sha256, h1: h1.sha256 });
};

/** Installs version {@code n} of a versioned entry as its own entry {@code <id>_v<n>} (the E1 reference: placement uses the head). */
async function installReference(id, n) {
  const src = path.join(LIB(), id, 'versions', String(n));
  const ref = `${id}_v${n}`;
  const tmp = path.join(OUT, 'refs', ref);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (!f.startsWith(id + '.')) continue;
    const to = path.join(tmp, ref + f.slice(id.length));
    if (f.endsWith('.blueprint.json')) {
      const j = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
      j.id = ref;
      j.name = ref;
      delete j.versions;
      delete j.version;
      fs.writeFileSync(to, JSON.stringify(j, null, 2));
    } else fs.copyFileSync(path.join(src, f), to);
  }
  await installEntry(ref, tmp);
  return ref;
}

/**
 * E1 in game (path independence against vanilla): every state a sequence of applies and reverts leaves equals a fresh placement
 * of that version at that origin (the reference entries are placed and removed one by one in the same world afterwards).
 * Also the fold (the 7th delta) and the stack depth, and E3 at the end.
 */
steps.e1 = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = process.env.G5B_VERSIONS ?? path.join(OUT, 'versions-smoke');
  const ID = process.env.G5B_ENTRY ?? 'g5b_cabin';
  const turns = Number(process.env.G5B_TURNS ?? 1);
  await fresh('G5B E1', FLAT);
  await tp(-30.5, 90, -30.5);
  await installEntry(ID, path.join(V, 'v1'));
  const vdirs = fs.readdirSync(V).filter((d) => /^v\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of vdirs.slice(1)) await installVersion(ID, path.join(V, v), v);
  const nv = vdirs.length;
  for (let n = 1; n <= nv; n++) await installReference(ID, n);
  const BOX = [-10, 50, -10, 70, 95, 70];
  const h0 = await hash(BOX);
  const placed = await result(await api(`place ${ID} 20 64 20 INSTANT unowned noactor ${turns}`));
  check(placed.placed, `e1: placed ${placed.siteId} (rotation ${turns})`, placed);
  const site = placed.siteId;
  const states = [];
  const record = async (what) => {
    const h = await history(site);
    const hh = await hash(BOX);
    const top = h.versioning.history.at(-1);
    states.push({ what, version: h.version, origin: top.origin, sha: hh.sha256 });
  };
  await record('placed');
  const seed = Number(process.env.G5B_SEED ?? 7);
  let r = seed;
  const rnd = (n) => {
    r = (r * 1103515245 + 12345) % 2147483648;
    return r % n;
  };
  let applies = 0;
  for (let op = 0; op < 14; op++) {
    const h = await history(site);
    if (process.env.G5B_APPLY_ONLY || rnd(3) > 0 || h.chain.length < 2) {
      let to = 1 + rnd(nv);
      if (to === h.version) to = (to % nv) + 1;
      const a = await deltaApply(site, to);
      check(a.applied, `e1: apply v${h.version}->v${to}: written ${a.written}`, a.applied ? undefined : a);
      applies++;
      await record(`apply v${to}`);
    } else {
      const k = h.chain[rnd(h.chain.length - 1)];
      const rv = await revert(site, k);
      check(rv.applied, `e1: revert to v${k}`, rv.applied ? undefined : rv);
      await record(`revert v${k}`);
    }
  }
  const js = await journal();
  const mine = (js.entries ?? []).filter((e) => e.site === site && e.status !== 'UNDONE');
  log(`  journal: ${mine.map((e) => `${e.id}:${e.kind}`).join(' ')}`);
  check(mine.filter((e) => e.kind === 'delta').length <= 6, `e1: at most 6 delta entries stand (${mine.filter((e) => e.kind === 'delta').length})`);
  const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
  check(rm.removed, `e1: remove ${site}`, rm);
  const h1 = await hash(BOX);
  check(h1.sha256 === h0.sha256, 'e1: Remove after the sequence restores the pre-site world (E3)', { h0: h0.sha256, h1: h1.sha256 });
  // the references: each state's version placed fresh at its origin
  const cache = {};
  for (const st of states) {
    const key = `${st.version}@${st.origin.join(',')}`;
    if (!cache[key]) {
      const ref = await result(await api(`place ${ID}_v${st.version} ${st.origin.join(' ')} INSTANT unowned noactor ${turns}`));
      if (!ref.placed) {
        check(false, `e1: reference ${key} placed`, ref);
        continue;
      }
      cache[key] = (await hash(BOX)).sha256;
      const rr = await result(await api(`remove ${ref.siteId} - noforce keep`), 300_000);
      if (!rr.removed) check(false, `e1: reference ${key} removed`, rr);
    }
    check(cache[key] === st.sha, `e1: ${st.what} equals a fresh placement of v${st.version} (E1)`, { ref: cache[key], got: st.sha });
  }
  return { states, applies };
};

/** Copies kit fixture version folders ({@code <src>/v<n>/<from>.*}) renamed to entry {@code to} into {@code dest/v<n>/}. */
function stageVersions(src, from, to, dest) {
  for (const v of fs.readdirSync(src).filter((d) => /^v\d+$/.test(d))) {
    const d = path.join(dest, v);
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(path.join(src, v))) {
      if (!f.startsWith(from + '.')) continue;
      const target = path.join(d, to + f.slice(from.length));
      if (f.endsWith('.blueprint.json')) {
        const j = JSON.parse(fs.readFileSync(path.join(src, v, f), 'utf8'));
        j.id = to;
        j.name = to;
        j.source = to + '.mjs';
        fs.writeFileSync(target, JSON.stringify(j, null, 2));
      } else fs.copyFileSync(path.join(src, v, f), target);
    }
  }
  return dest;
}

/** The tavern versions v1..v5 (kit/tools/delta-fixtures.mjs) as entry g5b_tavern in artifacts/gate5b/versions-tavern. */
function tavernVersions() {
  const fx = path.join(OUT, 'fixtures');
  fs.rmSync(fx, { recursive: true, force: true });
  execFileSync('node', [path.join(root, 'kit', 'tools', 'delta-fixtures.mjs'), '--out', fx, '--no-previews'], { stdio: 'ignore' });
  return stageVersions(path.join(fx, 'versions', 'tavern'), 'tavern', 'g5b_tavern', path.join(OUT, 'versions-tavern'));
}

/** Installs v1 of an entry, places it (the head is v1 then), then installs v2..vN; returns the site. */
async function placeAtV1(ID, V, at, turns) {
  await installEntry(ID, path.join(V, 'v1'));
  const placed = await result(await api(`place ${ID} ${at.join(' ')} INSTANT unowned noactor ${turns}`));
  if (!placed.placed) throw new Error(`placing ${ID}: ${JSON.stringify(placed.refusals)}`);
  const vdirs = fs.readdirSync(V).filter((d) => /^v\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const v of vdirs.slice(1)) await installVersion(ID, path.join(V, v), v);
  return placed.siteId;
}

/**
 * Gate item 2 "Chains": a fixed 12-operation script and 20 seeded random scripts of apply and revert over v1, v2, v3 and v5,
 * each from a copy of one world: after every operation the region equals a fresh placement of that version at that spot (E1),
 * every revert equals the world before that apply (E2), and the final Remove gives the pre-site world back (E3). v4 refuses
 * FRAME_CHANGED.
 */
steps.chains = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  const turns = Number(process.env.G5B_TURNS ?? 0);
  const AT = [20, 64, 20];
  const BOX = [-12, 50, -12, 76, 100, 70];
  const scripts = [{ name: 'fixed', ops: ['a2', 'a3', 'r2', 'a5', 'a1', 'r5', 'r1', 'a3', 'a5', 'r3', 'a2', 'r1'] }];
  const nRandom = Number(process.env.G5B_SCRIPTS ?? 20);
  for (let k = 0; k < nRandom; k++) scripts.push({ name: `seed${k + 1}`, seed: 1000 + k });
  const states = [];
  let first = true;
  for (const sc of scripts) {
    await fresh('G5B Chain', FLAT);
    await tp(-30.5, 90, -30.5);
    const h0 = await hash(BOX);
    const site = await placeAtV1(ID, V, AT, turns);
    if (first) {
      const v4 = await deltaCheck(site, 4);
      check(!v4.applicable && v4.refusals.some((r) => r.reason === 'FRAME_CHANGED'), 'chains: v4 (front changed) refuses FRAME_CHANGED', v4.refusals);
      first = false;
    }
    let r = sc.seed ?? 1;
    const rnd = (n) => {
      r = (r * 1103515245 + 12345) % 2147483648;
      return Math.floor(r / 65536) % n;
    };
    const ops = sc.ops ?? Array.from({ length: 12 }, () => null);
    const stack = []; // hashes before each standing apply (for E2)
    const record = async (what, hh) => {
      const h = await history(site);
      states.push({ script: sc.name, what, version: h.version, origin: h.versioning.history.at(-1).origin, sha: hh.sha256 });
    };
    await record('placed', await hash(BOX));
    for (let i = 0; i < ops.length; i++) {
      const h = await history(site);
      let op = ops[i];
      if (!op) {
        const canRevert = h.chain.length > 1;
        if (canRevert && rnd(3) === 0) op = 'r' + h.chain[rnd(h.chain.length - 1)];
        else {
          let to = [1, 2, 3, 5][rnd(4)];
          if (to === h.version) to = to === 5 ? 1 : to + 1 === 4 ? 5 : to + 1;
          op = 'a' + to;
        }
      }
      const v = Number(op.slice(1));
      if (op[0] === 'a') {
        const pre = await hash(BOX);
        const a = await deltaApply(site, v);
        if (!check(a.applied, `chains ${sc.name}: apply v${h.version}->v${v} (${a.written} cells)`, a.applied ? undefined : a)) continue;
        stack.push({ version: h.version, sha: pre.sha256 });
        await record(op, await hash(BOX));
      } else {
        const a = await revert(site, v);
        if (!check(a.applied, `chains ${sc.name}: revert to v${v}`, a.applied ? undefined : a)) continue;
        const now = await hash(BOX);
        // E2: a revert of the top delta (one step back) gives the world before that apply back
        const top = stack.at(-1);
        if (top && top.version === v) {
          check(now.sha256 === top.sha, `chains ${sc.name}: revert to v${v} equals the world before its apply (E2)`, { want: top.sha, got: now.sha256 });
          stack.pop();
        } else {
          while (stack.length && stack.at(-1).version !== v) stack.pop();
          stack.pop();
        }
        await record(op, now);
      }
    }
    const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
    check(rm.removed, `chains ${sc.name}: remove`, rm.removed ? undefined : rm);
    const h1 = await hash(BOX);
    check(h1.sha256 === h0.sha256, `chains ${sc.name}: Remove restores the pre-site world (E3)`, { h0: h0.sha256, h1: h1.sha256 });
  }
  // E1: every state equals a fresh placement of its version at its spot (references placed one by one in a fresh world)
  await fresh('G5B ChainRef', FLAT);
  await tp(-30.5, 90, -30.5);
  await installEntry(ID, path.join(V, 'v1'));
  for (const v of ['v2', 'v3', 'v4', 'v5']) await installVersion(ID, path.join(V, v), v);
  for (const n of [1, 2, 3, 5]) await installReference(ID, n);
  const cache = {};
  let ok = 0;
  for (const st of states) {
    const key = `${st.version}@${st.origin.join(',')}`;
    if (!cache[key]) {
      const ref = await result(await api(`place ${ID}_v${st.version} ${st.origin.join(' ')} INSTANT unowned noactor ${turns}`));
      if (!check(ref.placed, `chains: reference ${key} placed`, ref.placed ? undefined : ref)) continue;
      cache[key] = (await hash(BOX)).sha256;
      await result(await api(`remove ${ref.siteId} - noforce keep`), 300_000);
    }
    if (cache[key] === st.sha) ok++;
    else check(false, `chains ${st.script}: ${st.what} equals a fresh placement of v${st.version} (E1)`, { ref: cache[key], got: st.sha });
  }
  check(ok === states.length, `chains: E1 holds for ${ok} of ${states.length} states over ${scripts.length} scripts`);
  return { states: states.length, scripts: scripts.length };
};

/** The world cells of a box as "x,y,z" -> state string (dev.region.hash cells). */
async function cellsIn(box) {
  const h = await call('dev.region.hash', { box, cells: true }, 300_000);
  const m = new Map();
  for (const l of h.list ?? h.cells ?? []) {
    const i = l.indexOf(' ');
    m.set(l.slice(0, i), canonical(l.slice(i + 1)));
  }
  return m;
}
/** dev.region.hash's SNBT cell value ({id:"minecraft:x",properties:{k:"v"},nbt:...}) as "minecraft:x[k=v,...]" (+ " nbt" when it has data). */
function canonical(v) {
  const id = (/id:"([^"]+)"/.exec(v) ?? [])[1] ?? v;
  const pm = /properties:\{([^}]*)\}/.exec(v);
  const props = pm ? pm[1].split(',').filter(Boolean).map((kv) => kv.replace(/:"?([^"]*)"?$/, '=$1')).join(',') : '';
  return `${id}${props ? `[${props}]` : ''}${/nbt:/.test(v) ? ' nbt' : ''}`;
}
const blockOf = (st) => st.split(/[[ ]/)[0];
const propsOf = (st) => (/\[(.*)\]/.exec(st) ?? [])[1] ?? '';
const setState = (pos, st) => cmd(`/setblock ${pos.replaceAll(',', ' ')} ${blockOf(st)}${propsOf(st) ? '[' + propsOf(st) + ']' : ''}`);

/**
 * Gate item 2 "Minimality" and "Player edits": dev.writes.count equals |Δ'| plus the reshaped guards; a chest with items in an
 * unchanged part keeps them; a door opened in an unchanged part stays open; a block placed in a removed part's cell is kept
 * (KEEP, reported), replaced (OVERWRITE), or refuses (REFUSE); a filled chest in a changed cell refuses BLOCK_ENTITIES; an opened
 * door in a changed cell counts as the site's. Remove at the end gives the pre-site world back, the edits included (E3).
 */
steps.edits = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  const AT = [20, 64, 20];
  const BOX = [-12, 50, -12, 76, 100, 70];
  await fresh('G5B Edits', FLAT);
  await tp(-30.5, 90, -30.5);
  const h0 = await hash(BOX);
  const site = await placeAtV1(ID, V, AT, 0);
  const c2 = await deltaCheck(site, 2, { cells: true });
  const inDelta = new Set([...(c2.ghost?.added ?? []), ...(c2.ghost?.removed ?? []), ...(c2.ghost?.changed ?? [])]);
  const world = await cellsIn(BOX);
  // a chest and a door in parts v2 leaves alone
  const chest = [...world.entries()].find(([p, st]) => blockOf(st) === 'minecraft:chest' && !inDelta.has(p));
  const doorLow = [...world.entries()].find(([p, st]) => /_door/.test(blockOf(st)) && /half=lower/.test(st) && !inDelta.has(p) && blockOf(st) !== 'minecraft:oak_door');
  check(!!chest && !!doorLow, `edits: a chest (${chest?.[0]}) and a door (${doorLow?.[0]}) outside the delta`);
  await cmd(`/item replace block ${chest[0].replaceAll(',', ' ')} container.0 with minecraft:diamond 7`);
  const [dx, dy, dz] = doorLow[0].split(',').map(Number);
  const upPos = `${dx},${dy + 1},${dz}`;
  await setState(upPos, world.get(upPos).replace('open=false', 'open=true'));
  await setState(doorLow[0], doorLow[1].replace('open=false', 'open=true'));
  // minimality: the writes of the apply, counted
  const box = c2.box;
  const grownBox = [box[0] - 2, box[1] - 2, box[2] - 2, box[3] + 2, box[4] + 2, box[5] + 2];
  await call('dev.writes.count', { box: grownBox });
  const a2 = await deltaApply(site, 2);
  const wc = await call('dev.writes.count', { box: grownBox, cells: true });
  check(a2.applied && wc.count === a2.written + a2.reshaped, `edits: block writes ${wc.count} = |Δ'| ${a2.written} + reshaped guards ${a2.reshaped}`, { wc: wc.count, a2 });
  const after = await cellsIn(BOX);
  check(/open=true/.test(after.get(doorLow[0])), 'edits: the door opened in an unchanged part stays open');
  const items = await cmd(`/data get block ${chest[0].replaceAll(',', ' ')} Items`);
  check(JSON.stringify(items.messages).includes('diamond'), 'edits: the chest with items in an unchanged part keeps them', items.messages);
  // back to v1 for the edit cases
  check((await revert(site, 1)).applied, 'edits: revert to v1');
  // an opened door in a changed cell (the yard's gate door, oak in v1, spruce in v2) counts as the site's: written, not kept
  const w1 = await cellsIn(BOX);
  const gate = [...w1.entries()].find(([p, st]) => blockOf(st) === 'minecraft:oak_door' && /half=lower/.test(st));
  const [gx, gy, gz] = gate[0].split(',').map(Number);
  await setState(`${gx},${gy + 1},${gz}`, w1.get(`${gx},${gy + 1},${gz}`).replace('open=false', 'open=true'));
  await setState(gate[0], gate[1].replace('open=false', 'open=true'));
  const cg = await deltaCheck(site, 2, { cells: true });
  check(!(cg.ghost?.kept ?? []).includes(gate[0]) && (cg.ghost?.changed ?? []).includes(gate[0]), 'edits: an opened door in a changed cell counts as ours (written, not kept)');
  // a block placed in a removed part's cell (the porch)
  const removedCell = (cg.ghost?.removed ?? []).find((p) => w1.get(p) && !/air/.test(blockOf(w1.get(p))));
  await cmd(`/setblock ${removedCell.replaceAll(',', ' ')} minecraft:gold_block`);
  const refuse = await deltaCheck(site, 2, { playerEdits: 'REFUSE' });
  check(!refuse.applicable && refuse.refusals.some((r) => r.reason === 'PLAYER_EDITS'), 'edits: REFUSE refuses PLAYER_EDITS', refuse.refusals);
  const keep = await deltaApply(site, 2, { playerEdits: 'KEEP' });
  const wk = await cellsIn(BOX);
  check(keep.applied && keep.kept.some((k) => k.pos === removedCell) && blockOf(wk.get(removedCell)) === 'minecraft:gold_block',
    'edits: KEEP keeps the player\'s block and reports it', keep.kept);
  check(blockOf(wk.get(gate[0])) === 'minecraft:spruce_door', 'edits: the opened gate door was replaced (spruce)');
  check((await revert(site, 1)).applied, 'edits: revert to v1 again');
  const wr = await cellsIn(BOX);
  check(blockOf(wr.get(removedCell)) === 'minecraft:gold_block', 'edits: the kept cell is untouched by the revert');
  const over = await deltaApply(site, 2, { playerEdits: 'OVERWRITE' });
  const wo = await cellsIn(BOX);
  check(over.applied && blockOf(wo.get(removedCell)) !== 'minecraft:gold_block', `edits: OVERWRITE replaces it (${blockOf(wo.get(removedCell))})`);
  check((await revert(site, 1)).applied, 'edits: revert to v1 a third time');
  // a filled chest in a changed cell refuses BLOCK_ENTITIES (any mode)
  const cc = await deltaCheck(site, 2, { cells: true });
  const changedCell = (cc.ghost?.changed ?? []).find((p) => !/door/.test(blockOf(wr.get(p) ?? '')));
  await cmd(`/setblock ${changedCell.replaceAll(',', ' ')} minecraft:chest`);
  await cmd(`/item replace block ${changedCell.replaceAll(',', ' ')} container.0 with minecraft:emerald 3`);
  for (const mode of ['KEEP', 'OVERWRITE']) {
    const be = await deltaCheck(site, 2, { playerEdits: mode });
    check(!be.applicable && be.refusals.some((r) => r.reason === 'BLOCK_ENTITIES'), `edits: a filled chest in a changed cell refuses BLOCK_ENTITIES (${mode})`, be.refusals);
  }
  // Remove keeps 4e's blockers (filled containers): empty both chests first, the player's block edits stay
  // (a container the site didn't place blocks Remove even empty: the player's chest goes; the gold block edit stays)
  for (const c of [changedCell, chest[0]]) await cmd(`/data merge block ${c.replaceAll(',', ' ')} {Items:[]}`);
  await cmd(`/setblock ${changedCell.replaceAll(',', ' ')} minecraft:air`);
  const rm = await result(await api(`remove ${site} - force keep`), 300_000);
  check(rm.removed, 'edits: remove (the chests emptied; the player\'s blocks still there)', rm.removed ? undefined : rm);
  const h1 = await hash(BOX);
  check(h1.sha256 === h0.sha256, 'edits: Remove restores the pre-site world, the edits included (E3)', { h0: h0.sha256, h1: h1.sha256 });
};

function permutations(a) {
  if (a.length <= 1) return [a];
  const out = [];
  a.forEach((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).forEach((p) => out.push([x, ...p])));
  return out;
}

/**
 * Gate item 2 "Layered and leaves" and "Covered": the tavern LAYERed on a cell-site pad T next to a worldgen tree, its deltas
 * growing over T and into the tree's leaves (held leaves, the ring), a revert exact (E2); X (a cabin) LAYERed over the tavern's
 * east side: a delta touching X's cells refuses COVERED naming X, one that doesn't applies; then every removal order of
 * {T, tavern, X} (6, each from a copy of the same world) ends at the world before T, every cell and block entity.
 */
steps.layers = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  const BOX = [-20, 50, -20, 80, 100, 75];
  await fresh('G5B Layers', FLAT);
  await tp(-30.5, 95, -30.5);
  // a worldgen oak west of the tavern, off the pad: v3's west wing (x 15..19) grows into its canopy (x 11..15)
  const tree = await cmd('/place feature minecraft:oak 13 65 25');
  check(tree.success !== false, 'layers: a worldgen oak west of the tavern', tree.messages);
  await settle(2000);
  const h0 = await hash(BOX);
  const T = await call('dev.cells.place', { kind: 'gate5b:pad', pad: { minX: 17, maxX: 62, minZ: 4, maxZ: 52, y: 66, top: 'minecraft:coarse_dirt', depth: 3, clear: 10 } },
    600_000);
  check(T.placed, `layers: pad T placed (${T.siteId})`, T.placed ? undefined : T);
  // the tavern v1, LAYERed on T
  await installEntry(ID, path.join(V, 'v1'));
  const placed = await result(await api(`place ${ID} 20 67 20 INSTANT unowned noactor 0 layer`));
  check(placed.placed, `layers: tavern placed on T (${placed.siteId})`, placed.placed ? undefined : placed);
  const site = placed.siteId;
  for (const v of ['v2', 'v3', 'v4', 'v5']) await installVersion(ID, path.join(V, v), v);
  const pre2 = await hash(BOX);
  const a2 = await deltaApply(site, 2, { overlap: 'LAYER' });
  check(a2.applied, `layers: apply v2 over T (${a2.written} cells)`, a2.applied ? undefined : a2);
  const pre3 = await hash(BOX);
  const a3 = await deltaApply(site, 3, { overlap: 'LAYER' });
  check(a3.applied, `layers: apply v3, growing west into the oak's leaves (${a3.written} cells)`, a3.applied ? undefined : a3);
  const js = await journal();
  const leaves = (js.entries ?? []).filter((e) => e.site === site && e.kind === 'leaves' && e.status !== 'UNDONE');
  log(`  layers: ${leaves.length} leaves entr(ies) held by ${site}`);
  const r2 = await revert(site, 2);
  const back2 = await hash(BOX);
  check(r2.applied && back2.sha256 === pre3.sha256, 'layers: revert of v3 (the growth into leaves) restores the world before it (E2)', { want: pre3.sha256,
    got: back2.sha256 });
  check((await deltaApply(site, 3, { overlap: 'LAYER' })).applied, 'layers: apply v3 again');
  const a5 = await deltaApply(site, 5, { overlap: 'LAYER' });
  check(a5.applied, 'layers: apply v5 (shrinks)', a5.applied ? undefined : a5);
  // X: a cabin LAYERed over the tavern's east side (cells the tavern's earlier wing growth still owns)
  const X = await result(await api('place cabin 36 67 20 INSTANT unowned noactor 0 layer'));
  check(X.placed, `layers: X layered over the tavern's east side (${X.siteId})`, X.placed ? undefined : X);
  const cov = await deltaCheck(site, 2, { overlap: 'LAYER' });
  check(!cov.applicable && cov.refusals.some((r) => r.reason === 'COVERED' && r.message.includes(X.siteId)), `layers: a delta touching X's cells refuses COVERED naming ${X.siteId}`,
    cov.refusals);
  const free = await deltaApply(site, 1, { overlap: 'LAYER' });
  check(free.applied, `layers: a delta that leaves X's cells alone applies (v5 -> v1, ${free.written} cells)`, free.applied ? undefined : free);
  void pre2;
  // every removal order of {T, tavern, X}, each from a copy of this world
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G5B Layers', 'G5B LayersBase');
  const ids = { T: T.siteId, H: site, X: X.siteId };
  for (const order of permutations(['T', 'H', 'X'])) {
    await fresh('G5B LayersOrder', 'G5B LayersBase');
    for (const k of order) {
      const rm = await result(await api(`remove ${ids[k]} - noforce keep`), 300_000);
      check(rm.removed, `layers ${order.join('')}: remove ${k}`, rm.removed ? undefined : rm);
      await settle(1000);
    }
    const h = await hash(BOX);
    check(h.sha256 === h0.sha256, `layers ${order.join('')}: the world before T is back exactly`, { h0: h0.sha256, h: h.sha256 });
  }
};

/** Arms {@code point}, runs {@code action} in a fresh copy of {@code base}, waits for the halt, restarts the client into that copy. */
async function killRun(point, base, action) {
  await fresh('G5B Crash', base);
  await tp(-30.5, 90, -30.5);
  await cmd('/save-all flush');
  await settle(1000);
  await call('dev.journal.killAt', { point });
  const t0 = Date.now();
  action().catch(() => {});
  const died = await waitDead(180_000);
  check(died, `crash ${point}: the JVM halted at the kill point (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  if (!died) {
    await connect();
    await call('dev.journal.killAt', { point: null });
    return false;
  }
  await sleep(2000);
  await startClient('G5B Crash');
  await tp(-30.5, 90, -30.5);
  await settle(5000);
  const j = await journal();
  check(j.open && !j.unavailable, `crash ${point}: the journal opens`, { open: j.open, unavailable: j.unavailable });
  return true;
}

/**
 * Gate item 2 "Crash": D1-D8 of an apply and K5-K7 of a revert, each by dev.journal.killAt and a restart: the states the
 * contract's table promises (before D3 nothing written and the record at a; D4-D6 an unclean stop rolls back to a; D7-D8 the
 * journal wins, b; K5 nothing changed; K6 the undo never reached the disk: the deltas come back; K7 the revert settles), and a
 * final Remove exact.
 */
steps.crash = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  const BOX = [-12, 50, -12, 76, 100, 70];
  await fresh('G5B CrashBase', FLAT);
  await tp(-30.5, 90, -30.5);
  const h0 = await hash(BOX);
  const site = await placeAtV1(ID, V, [20, 64, 20], 0);
  const H1 = (await hash(BOX)).sha256;
  check((await deltaApply(site, 2)).applied, 'crash: reference apply v1 -> v2');
  const H2 = (await hash(BOX)).sha256;
  check((await revert(site, 1)).applied, 'crash: back to v1 (the base world)');
  check((await hash(BOX)).sha256 === H1, 'crash: the base world is at v1 again');
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G5B CrashBase', 'G5B CrashV1');
  const out = {};
  const expect = { D1: 1, D2: 1, D3: 1, D4: 1, D5: 1, D6: 1, D7: 2, D8: 2, 'D7+save': 2, 'D8+save': 2 };
  for (const point of Object.keys(expect)) {
    if (!(await killRun(point, 'G5B CrashV1', () => deltaApply(site, 2)))) continue;
    const h = await history(site);
    const now = (await hash(BOX)).sha256;
    const j = await journal();
    const placing = (j.entries ?? []).filter((e) => e.site === site && e.status === 'PLACING');
    // D1-D6: rolled back to v1. D7-D8 (ACTIVE committed): the journal wins when the world kept the writes; a halt loses the
    // block writes since the last world save, so the lost-writes settle undoes the update and the record follows the world.
    const consistent = (h.version === 1 && now === H1) || (h.version === 2 && now === H2);
    // the "+save" variants save the world's chunks just before the halt (an autosave): the journal wins, v2 and its world
    const ok = expect[point] === 1 ? h.version === 1 && now === H1 : point.endsWith('+save') ? h.version === 2 && now === H2 : consistent;
    check(ok && placing.length === 0, `crash ${point}: the site is at v${h.version} and the world matches it${expect[point] === 2 ? ` (journal ACTIVE; the world ${now === H2 ? 'kept' : 'lost'} the writes)` : ''}`,
      { version: h.version, now, H1, H2, placing, versioning: h.versioning });
    out[point] = { version: h.version, ok, world: now === H2 ? 2 : now === H1 ? 1 : null };
    const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
    check(rm.removed && (await hash(BOX)).sha256 === h0.sha256, `crash ${point}: a final Remove matches the pre-site world`, rm.removed ? undefined : rm);
  }
  // a clean stop never runs the lost-writes undo: v2 with the player's demolition of its added cells stays v2
  await fresh('G5B CrashClean', 'G5B CrashV1');
  const cc = await deltaCheck(site, 2, { cells: true });
  check((await deltaApply(site, 2)).applied, 'crash clean: v2 applied');
  for (const q of (cc.ghost?.added ?? [])) await cmd(`/setblock ${q.replaceAll(',', ' ')} minecraft:air`);
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G5B CrashClean');
  await tp(-30.5, 90, -30.5);
  await settle(3000);
  const hc = await history(site);
  check(hc.version === 2, `crash clean: after a clean stop the site stays at v2 though its ${(cc.ghost?.added ?? []).length} added cells were mined (no lost-writes undo)`, hc);
  await result(await api(`remove ${site} - force keep`), 300_000);
  await leaveWorld();
  // the revert's kill points: from v2
  await fresh('G5B CrashV2', 'G5B CrashV1');
  check((await deltaApply(site, 2)).applied, 'crash: the v2 base for the revert points');
  await cmd('/save-all flush');
  await leaveWorld();
  const rexpect = { K5: 2, K6: 2, K7: 1 };
  for (const point of Object.keys(rexpect)) {
    if (!(await killRun(point, 'G5B CrashV2', () => revert(site, 1)))) continue;
    await settle(3000);
    const h = await history(site);
    const now = (await hash(BOX)).sha256;
    // K5/K6: the undo never reached the disk, v2. K7 (the undo committed, the record reverting): settled on evidence, so the
    // record follows what the world holds (the halt may have lost the restore's block writes).
    const consistent = (h.version === 1 && now === H1) || (h.version === 2 && now === H2);
    const ok = rexpect[point] === 2 && point !== 'K7' ? h.version === 2 && now === H2 : consistent;
    check(ok, `crash ${point}: after the restart the site is at v${h.version} and the world matches it`, { version: h.version, now, H1, H2, versioning: h.versioning });
    out[point] = { version: h.version, ok, world: now === H2 ? 2 : now === H1 ? 1 : null };
    const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
    check(rm.removed && (await hash(BOX)).sha256 === h0.sha256, `crash ${point}: a final Remove matches the pre-site world`, rm.removed ? undefined : rm);
  }
  return out;
};

/**
 * Gate item 2 "History": 8 deltas in a row on the same cells (v1 <-> v2): the stack depth stays at most 8, the 7th folds the
 * oldest into the base, every retained version is reached by a revert exactly (v1 and v2 hashes), and Remove is exact.
 */
steps.history = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  const BOX = [-12, 50, -12, 76, 100, 70];
  await fresh('G5B History', FLAT);
  await tp(-30.5, 90, -30.5);
  const h0 = await hash(BOX);
  const site = await placeAtV1(ID, V, [20, 64, 20], 0);
  const want = { 1: (await hash(BOX)).sha256 };
  const c = await deltaCheck(site, 2, { cells: true });
  const roofCell = (c.ghost?.changed ?? [])[0];
  let maxDepth = 0;
  let folded = false;
  for (let i = 0; i < 8; i++) {
    const to = i % 2 === 0 ? 2 : 1;
    const a = await deltaApply(site, to);
    check(a.applied, `history: delta ${i + 1} (v${to})`, a.applied ? undefined : a);
    if (a.notes.some((n) => n.startsWith('history folded'))) folded = true;
    want[to] = want[to] ?? (await hash(BOX)).sha256;
    const [x, y, z] = roofCell.split(',').map(Number);
    const st = await call('dev.journal.at', { x, y, z });
    const depth = (st.stack ?? st.layers ?? []).length;
    maxDepth = Math.max(maxDepth, depth);
  }
  check(maxDepth <= 8, `history: the stack at a changed cell stays at most 8 deep (max ${maxDepth})`);
  check(folded, 'history: the 7th delta folded the oldest into the base (a note says so)');
  const js = await journal();
  const deltas = (js.entries ?? []).filter((e) => e.site === site && e.kind === 'delta' && e.status !== 'UNDONE');
  check(deltas.length <= 6, `history: ${deltas.length} delta entries stand (at most 6)`);
  const h = await history(site);
  const chain = h.chain.slice(0, -1).reverse();
  for (const k of chain) {
    const r = await revert(site, k);
    const now = (await hash(BOX)).sha256;
    check(r.applied && now === want[k], `history: revert to retained v${k} is exact`, { got: now, want: want[k], r: r.applied ? undefined : r });
  }
  const rm = await result(await api(`remove ${site} - noforce keep`), 300_000);
  check(rm.removed && (await hash(BOX)).sha256 === h0.sha256, 'history: Remove is exact', rm.removed ? undefined : rm);
  return { maxDepth, folded, deltas: deltas.length, chain: h.chain };
};

/** Gate item 2 "Ghost": the delta preview with ADDED, REMOVED, CHANGED and KEPT tints, in a screenshot (looked at by the builder). */
steps.ghost = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = tavernVersions();
  const ID = 'g5b_tavern';
  await fresh('G5B Ghost', FLAT);
  await tp(-30.5, 90, -30.5);
  const site = await placeAtV1(ID, V, [20, 64, 20], 0);
  check((await deltaApply(site, 2)).applied && (await revert(site, 1)).applied, 'ghost: v2 applied and reverted (a history)');
  const c = await deltaCheck(site, 3, { cells: true });
  // a player block in a cell the update writes (the porch's top front cell, in view): KEEP keeps it (yellow)
  const byTop = (c.ghost?.removed ?? []).map((p) => p.split(',').map(Number)).sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  const kept = byTop[0].join(',');
  await cmd(`/setblock ${kept.replaceAll(',', ' ')} minecraft:gold_block`);
  const g = await call('dev.site.delta.preview', { site, version: 3 }, 60_000);
  log(`  ghost: +${g.added} -${g.removed} ~${g.changed} kept ${g.kept.length}`);
  await settle(2500);
  const st = await call('dev.composite.state', {}, 20_000);
  check(JSON.stringify(st).includes('architect:delta'), 'ghost: the delta composite shows', st);
  await call('dev.camera', { x: 50, y: 82, z: 52, lookAt: { x: 26, y: 68, z: 25 }, mode: 'spectator' }, 30_000);
  const shot = await call('dev.screenshot', { name: 'gate5b-delta-ghost', frames: 10 }, 180_000);
  log(`  ghost screenshot: ${shot.path}`);
  // close up on the front: the porch (REMOVED), the kept cell (KEPT), the changed windows and roof (CHANGED), the wings (ADDED)
  const [kx, ky, kz] = byTop[0];
  await call('dev.camera', { x: kx + 9, y: ky + 6, z: kz + 13, lookAt: { x: kx, y: ky, z: kz }, mode: 'spectator' }, 30_000);
  const close = await call('dev.screenshot', { name: 'gate5b-delta-ghost-close', frames: 10 }, 180_000);
  log(`  ghost close-up: ${close.path} (kept cell ${kept})`);
  await call('dev.release', {}, 20_000);
  return { shot: shot.path, preview: g };
};

// ------------------------------------------------------------------ survival helpers (as gate4e's)

const addTo = (m, k, n) => { m[k] = (m[k] ?? 0) + n; };

/** A chest on a hopper on the crate of {@code site}; returns the feed cells. */
async function hopperFor(site) {
  const c = (await siteState(site)).crate;
  const hop = [c.x, c.y + 1, c.z];
  const chest = [c.x, c.y + 2, c.z];
  await cmd(`/setblock ${hop.join(' ')} minecraft:hopper[facing=down]`);
  await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
  return { crate: c, hop, chest };
}
/** Puts what the site still misses into its feed chest (27 stacks at most); counts it into {@code into}. */
async function refill(site, feedCells, into) {
  const st = await siteState(site);
  const stacks = [];
  for (const r of st.rows ?? []) {
    let left = Math.max(0, (r.missing ?? 0) - (r.stock ?? 0));
    const max = /bed$|banner$/.test(r.item) ? 1 : /_door$|sign$/.test(r.item) ? 16 : 64;
    while (left > 0 && stacks.length < 27) {
      const n = Math.min(max, left);
      stacks.push([r.item, n]);
      left -= n;
    }
  }
  const inChest = await containerItems(feedCells.chest);
  if (Object.keys(inChest).length) return 0; // still feeding
  for (let i = 0; i < stacks.length; i++) {
    await cmd(`/item replace block ${feedCells.chest.join(' ')} container.${i} with ${stacks[i][0]} ${stacks[i][1]}`);
    addTo(into, stacks[i][0], stacks[i][1]);
  }
  return stacks.length;
}
/** Items in a container block (/data get block). */
async function containerItems(p) {
  const r = await cmd(`/data get block ${p.join(' ')} Items`);
  const text = (r.messages ?? []).join(' ');
  const out = {};
  for (const m of text.matchAll(/id: "([^"]+)"[^}]*?count: (\d+)|count: (\d+)[^}]*?id: "([^"]+)"/g)) {
    const id = m[1] ?? m[4];
    const n = Number(m[2] ?? m[3]);
    addTo(out, id, n);
  }
  return out;
}
async function buildUntilDone(sites0, feeds, into, minutes = 20) {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    let done = 0;
    for (const s0 of sites0) {
      const st = await siteState(s0);
      if (st.state === 'built' || st.percent === 100) {
        done++;
        continue;
      }
      if (st.state === 'building') await refill(s0, feeds[s0], into);
    }
    if (done === sites0.length) return true;
    await sleep(3000);
  }
  return false;
}

/** Builds kit design {@code design} with {@code args} as entry {@code id} into {@code dir} (a hand-written version). */
function buildKitVersion(design, id, dir, args = []) {
  const tmp = path.join(OUT, 'kitbuild', id + '-' + path.basename(dir));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync('node', [path.join(root, 'kit', 'build.mjs'), design, '--out', tmp, ...args], { stdio: 'ignore' });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(tmp)) {
    if (!f.startsWith(design + '.')) continue;
    const target = path.join(dir, id + f.slice(design.length));
    if (f.endsWith('.blueprint.json')) {
      const j = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
      j.id = id;
      j.name = id;
      j.source = id + '.mjs';
      fs.writeFileSync(target, JSON.stringify(j, null, 2));
    } else fs.copyFileSync(path.join(tmp, f), target);
  }
  return dir;
}

/**
 * Gate item 3 "Survival": a cabin construction site built from hoppers, then a construction delta v1 -> v2 (the BOM of the
 * delta in dev.site.state equals its queued cells' bill; changed cells keep the old block until their swap; fed exactly that,
 * it finishes identical to an instant apply at the same spot in a creative copy; the refunds are the paid removed and swapped
 * cells), "Rebuild as v1" (a paid forward delta) fed and identical to an instant v1, a deconstruct; items delivered = items
 * returned per item id. A second run mines 3 blocks: returned = delivered - 3. A delta on a site still building refuses
 * SITE_BUSY, and a queued one waits.
 */
steps.survival = async () => {
  if (!dev) await connect();
  await flatBase();
  const ID = 'g5b_scabin';
  const V = path.join(OUT, 'versions-scabin');
  buildKitVersion('cabin', ID, path.join(V, 'v1'));
  buildKitVersion('cabin', ID, path.join(V, 'v2'), ['--values', '{"width":10,"porch":false}']);
  const AT = [28, 65, -19];
  const BOX = [0, 55, -45, 70, 90, 15];
  const out = {};
  for (const mine of (process.env.GATE5B_SURV_MINE ?? '0,3').split(',').map(Number)) {
    await fresh('G5B Surv', FLAT);
    await tp(40.5, 80, 20.5);
    const h0 = (await hash(BOX)).sha256;
    await installEntry(ID, path.join(V, 'v1'));
    await call('dev.survival.set', { on: true });
    await mark();
    const qid = await queue({ id: 'S', proximity: false, items: [{ key: 'S', bp: ID, at: AT, rot: 0, mode: 'CONSTRUCTION', force: true }] });
    const ev = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.batch === qid, 120_000, 'S placed');
    const S = ev.site;
    const itemsInBox = async () => ((await cmd(`/execute as @e[type=minecraft:item,x=${BOX[0]},y=${BOX[1]},z=${BOX[2]},dx=${BOX[3] - BOX[0]},` +
      `dy=${BOX[4] - BOX[1]},dz=${BOX[5] - BOX[2]}] run data get entity @s Item`)).messages ?? []).filter((m) => /entity data/.test(m));
    // no item lies in the box beyond the refunds a step dropped (deltaRefunds grew by them; it counts per site): a door, bed or
    // lantern popped by a clear would be one more. Fewer is fine: refunds dropped on the crate's cell before the feed hopper
    // goes there are pulled into the crate. Checked, then the player picks them up.
    let refundsSoFar = {};
    const pickUpRefunds = async (what) => {
      const lying = {};
      for (const m of await itemsInBox()) {
        const id = m.match(/id: "([^"]+)"/)?.[1];
        if (id) addTo(lying, id, Number(m.match(/count: (\d+)/)?.[1] ?? 1));
      }
      const now = (await siteState(S)).deltaRefunds ?? {};
      const step = {};
      for (const [k, n] of Object.entries(now)) if (n - (refundsSoFar[k] ?? 0)) step[k] = n - (refundsSoFar[k] ?? 0);
      const ids = [...new Set([...Object.keys(lying), ...Object.keys(step)])];
      const extra = ids.filter((k) => (lying[k] ?? 0) > (step[k] ?? 0)).map((k) => [k, lying[k] ?? 0, step[k] ?? 0]);
      const total = (m) => Object.values(m).reduce((x, y) => x + y, 0);
      check(extra.length === 0, `survival${mine ? ' (mined)' : ''}: no item lies in the box ${what} beyond its refunds (${total(lying)} lying, ${total(step)} refunded)`,
        extra.length ? { lyingVsRefunds: extra } : undefined);
      refundsSoFar = now;
      await cmd('/kill @e[type=minecraft:item]');
      return now;
    };
    // the conversion clears the instant placement's cells without popping anything (a door, bed or lantern item lying here
    // while the builder places the block again would be a free item)
    const placedPops = await itemsInBox();
    out[`placePops${mine}`] = placedPops;
    check(placedPops.length === 0, `survival${mine ? ' (mined)' : ''}: no item entities in or around the box after the construction placement (${placedPops.length})`,
      placedPops.length ? placedPops : undefined);
    await installVersion(ID, path.join(V, 'v2'), 'v2');
    // a delta on a site still building refuses SITE_BUSY; a queued one waits
    const busy = await deltaCheck(S, 2, { construction: true });
    check(!busy.applicable && busy.refusals.some((r) => r.reason === 'SITE_BUSY'), 'survival: a delta on a site still BUILDING refuses SITE_BUSY', busy.refusals);
    const into = {};
    const feeds = { [S]: await hopperFor(S) };
    check(await buildUntilDone([S], feeds, into), 'survival: the cabin construction site is built from its hopper');
    // items in = blocks placed: nothing lies in or around the box after the base build (the conversion's clear once popped a
    // door, a bed and a lantern here, while the builder placed them again: free items)
    const popped = await itemsInBox();
    out[`pops${mine}`] = popped;
    check(popped.length === 0, `survival${mine ? ' (mined)' : ''}: no item entities in or around the box after the base build (${popped.length})`, popped.length ? popped : undefined);
    // the instant reference: a creative copy of this world gets the instant apply
    await cmd('/save-all flush');
    await leaveWorld();
    copyWorld('G5B Surv', 'G5B SurvRef');
    // the construction delta v1 -> v2
    await openWorld('G5B Surv');
    await tp(40.5, 80, 20.5);
    const pre = await cellsIn(BOX);
    const c = await deltaCheck(S, 2, { construction: true, cells: true });
    check(c.applicable, `survival: the construction delta v1 -> v2 is allowed (bill ${JSON.stringify(c.bom)}, refunds ${JSON.stringify(c.refund)})`, c.applicable ? undefined : c);
    const a = await deltaApply(S, 2, { construction: true });
    check(a.applied, 'survival: the construction delta started', a.applied ? undefined : a);
    const st = await siteState(S);
    const missing = Object.fromEntries((st.rows ?? []).filter((r) => r.missing > 0).map((r) => [r.item, r.missing]));
    const bomEq = JSON.stringify(Object.entries(missing).sort()) === JSON.stringify(Object.entries(c.bom).sort());
    check(bomEq, 'survival: the BOM in dev.site.state equals the delta\'s queued cells\' bill', { missing, bom: c.bom });
    const now = await cellsIn(BOX);
    const moved = (c.ghost?.changed ?? []).filter((p) => blockOf(now.get(p) ?? '') !== blockOf(pre.get(p) ?? ''));
    // the player picks up the refunds of the removed cells (counted in deltaRefunds) before they lie in a later delta's box
    const refunds1 = await pickUpRefunds('after the delta started');
    feeds[S] = await hopperFor(S);
    check(await buildUntilDone([S], feeds, into), 'survival: the construction delta finished from its hopper');
    await pickUpRefunds('after the delta finished'); // the swaps' refunds
    // a changed cell whose v2 value is air is a removal (written at once, refunded); every other changed cell kept its old block
    const w2 = await cellsIn(BOX);
    const swapped = moved.filter((p) => !/:air$|:cave_air$/.test(blockOf(w2.get(p) ?? '')));
    check(st.swaps > 0 && swapped.length === 0, `survival: ${st.swaps} changed cells kept the old block until their swap (${moved.length - swapped.length} changed-to-air cells removed at once)`, swapped.slice(0, 5));
    const feedCells = Object.values(feeds).flatMap((f) => [f.hop, f.chest]);
    const ex = feedCells.map((p) => [...p, ...p]);
    const built2 = (await hash(BOX, ex)).sha256;
    const built2Cells = await cellsIn(BOX);
    // mined cells: the second run takes 3 of the site's blocks before the deconstruct
    // "Rebuild as v1": a paid forward delta
    const stD = await siteState(S);
    const itemsAt = await cmd('/execute as @e[type=minecraft:item] run data get entity @s Pos');
    const recD = (await sites()).find((x) => x.id === S);
    log(`  survival: after the delta: box ${JSON.stringify(recD?.box)}, restore ${JSON.stringify(recD?.snapshotBox)}, crate ${JSON.stringify(stD.crate ?? stD.construction?.crate)}; items ${JSON.stringify(itemsAt.messages).slice(0, 600)}`);
    const r1 = await deltaApply(S, 1, { construction: true });
    check(r1.applied, 'survival: "Rebuild as v1" (a forward construction delta) started', r1.applied ? undefined : r1);
    feeds[S] = await hopperFor(S);
    check(await buildUntilDone([S], feeds, into), 'survival: the rebuild as v1 finished from its hopper');
    await pickUpRefunds('after the rebuild as v1');
    const built1 = (await hash(BOX, ex)).sha256;
    const built1Cells = await cellsIn(BOX);
    const refunds = (await siteState(S)).deltaRefunds ?? {};
    let mined = 0;
    if (mine) {
      const w = await cellsIn(BOX);
      const solid = [...w.entries()].filter(([p, st2]) => /planks|log/.test(blockOf(st2)) && Number(p.split(',')[1]) > AT[1] + 2).slice(0, mine);
      for (const [p] of solid) {
        await call('dev.site.mine', { pos: p.split(',').map(Number), pickup: true }, 30_000);
        mined++;
      }
      await cmd('/clear @s');
    }
    // deconstruct: refunds counted
    const out1 = {};
    for (const f of Object.values(feeds)) {
      for (const [k, n] of Object.entries(await containerItems(f.chest))) addTo(out1, k, n);
      for (const [k, n] of Object.entries(await containerItems(f.hop))) addTo(out1, k, n);
    }
    for (const [k, n] of Object.entries(refunds)) addTo(out1, k, n);
    const rm = await result(await api(`remove ${S} - noforce keep`), 600_000);
    check(rm.removed, 'survival: deconstruct', rm.removed ? undefined : rm);
    for (const [k, n] of Object.entries(rm.refund ?? {})) addTo(out1, k, n);
    for (const f of Object.values(feeds)) {
      await cmd(`/setblock ${f.chest.join(' ')} minecraft:air`);
      await cmd(`/setblock ${f.hop.join(' ')} minecraft:air`);
    }
    await cmd('/kill @e[type=minecraft:item]');
    const deliveredN = Object.values(into).reduce((x, y) => x + y, 0);
    const returnedN = Object.values(out1).reduce((x, y) => x + y, 0);
    if (!mine) {
      const ids = new Set([...Object.keys(into), ...Object.keys(out1)]);
      const mism = [...ids].filter((k) => (into[k] ?? 0) !== (out1[k] ?? 0)).map((k) => [k, into[k] ?? 0, out1[k] ?? 0]);
      check(mism.length === 0, `survival: items delivered = items returned per item id (${deliveredN} items)`, mism);
    } else {
      check(returnedN === deliveredN - mined, `survival (mined ${mined}): returned ${returnedN} = delivered ${deliveredN} - ${mined}`);
    }
    check((await hash(BOX)).sha256 === h0, `survival${mine ? ' (mined)' : ''}: the terrain is exact after the deconstruct`);
    out[mine ? 'mined' : 'plain'] = { into, out: out1, refunds1, refunds, deconstruct: rm.refund ?? null, deconstructAll: rm };
    await call('dev.survival.set', { on: false });
    if (!mine) {
      // the instant references in the creative copy
      await leaveWorld();
      await openWorld('G5B SurvRef');
      await call('dev.survival.set', { on: false });
      const ia = await deltaApply(S, 2);
      check(ia.applied, 'survival: the instant apply in the creative copy', ia.applied ? undefined : ia);
      const ref2 = (await hash(BOX, ex)).sha256;
      const feedSet = new Set(feedCells.map((q) => q.join(',')));
      const cellDiff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((q) => !feedSet.has(q) && a.get(q) !== b.get(q)).slice(0, 12).map((q) => `${q}: ${a.get(q)} | ${b.get(q)}`);
      check(ref2 === built2, 'survival: the construction delta finished identical to an instant apply at the same spot', { ref2, built2, diff: cellDiff(built2Cells, await cellsIn(BOX)) });
      const ib = await deltaApply(S, 1);
      const ref1 = (await hash(BOX, ex)).sha256;
      check(ib.applied && ref1 === built1, 'survival: "Rebuild as v1" finished identical to an instant v1', { ref1, built1, diff: cellDiff(built1Cells, await cellsIn(BOX)) });
    }
  }
  return out;
};

// ------------------------------------------------------------------ gates 4 and 5: the village's delta batch, MSPT

const KINDS = ['cabin', 'gatehouse', 'tavern', 'tower'];
const VKIND = (k) => `g5b_v_${k}`;
const VOX = 0;
const VOZ = 100;
/** Lot i of the 4x3 village on the flat meadow (22 x 30 lots, 4-block gaps, an 8-block street north of each row; gate4d's). */
function vLot(i) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x0 = VOX + col * 26;
  const z0 = VOZ + row * 38 + 8;
  return [x0, 64, z0, x0 + 21, 104, z0 + 29];
}
/** The streets' roads (one per row, the street's middle) and one road north-south through the gap between columns 1 and 2. */
function vRoads() {
  const out = [];
  for (let row = 0; row < 3; row++) {
    const z = VOZ + row * 38 + 8 - 4;
    out.push({ key: `R${row}`, road: { points: [[VOX - 6, 65, z], [VOX + 3 * 26 + 27, 65, z]], width: 3 } });
  }
  out.push({ key: 'RX', road: { points: [[VOX + 26 + 24, 65, VOZ - 2], [VOX + 26 + 24, 65, VOZ + 2 * 38 + 4]], width: 3 } });
  return out;
}
const V_BOX = [VOX - 14, 54, VOZ - 12, VOX + 3 * 26 + 36, 110, VOZ + 3 * 38 + 16];

/** The fits (approach into the street) of the 12 lots in the current world. */
async function vFits() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const lot = vLot(i);
    const f = await api(`fit ${VKIND(KINDS[i % 4])} ${lot.join(',')} north into`);
    out.push({ key: `L${i}`, bp: VKIND(KINDS[i % 4]), lot, at: f.at, rot: f.rot, predicted: f.predictedRestoreBox, refusals: (f.refusals ?? []).map((r) => r.reason) });
  }
  return out;
}

/** The village's versioned entries: each kit example as g5b_v_<kind> v1, and a hand-written v2 (another palette, the cabin without its porch). */
async function installVillageEntries() {
  const dir = path.join(OUT, 'versions-village');
  const v2args = { cabin: ['--palette', 'birch'], gatehouse: ['--palette', 'rustic'], tavern: ['--palette', 'dark'],
    tower: ['--palette', 'birch'] };
  for (const k of KINDS) {
    buildKitVersion(k, VKIND(k), path.join(dir, k, 'v1'));
    buildKitVersion(k, VKIND(k), path.join(dir, k, 'v2'), v2args[k]);
    await installEntry(VKIND(k), path.join(dir, k, 'v1'));
  }
  return dir;
}
async function installVillageV2(dir) {
  for (const k of KINDS) await installVersion(VKIND(k), path.join(dir, k, 'v2'), 'v2');
}

/** The village base: the 12 lots placed (v1) as one group, saved as G5B VBase; returns {ids, group, h0, hPlaced}. */
async function villageBase() {
  if (ctx.village5 && fs.existsSync(path.join(SAVES, 'G5B VBase', 'level.dat'))) return ctx.village5;
  await fresh('G5B VBase', FLAT);
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  const dir = await installVillageEntries();
  const h0 = (await hash(V_BOX)).sha256;
  const fits = await vFits();
  await mark();
  const id = await queue({ id: 'vplace', proximity: false, items: fits.map((f) => ({ key: f.key, bp: f.bp, at: f.at, rot: f.rot, mode: 'INSTANT', force: true,
    stage: 'lots' })), stages: [{ name: 'lots', items: fits.map((f) => f.key) }], autoApprove: true });
  const done = await waitBatch(id, 30 * 60_000);
  const ids = {};
  for (const i of done.items) if (i.status === 'PLACED') ids[i.key] = i.site;
  check(Object.keys(ids).length === 12, `village: the 12 lots placed (group ${done.group})`, done);
  const hPlaced = (await hash(V_BOX)).sha256;
  await cmd('/save-all flush');
  await leaveWorld();
  ctx.village5 = { ids, group: done.group, h0, hPlaced, dir };
  saveCtx();
  return ctx.village5;
}

/** The delta batch: 12 delta items (each lot to its entry's v2) as stage "upgrade" of the village's group. */
async function upgradeBatch(v, budget, label) {
  await cmd(`/architect budget ${budget}`);
  await call('dev.placement.stats', { reset: true });
  await mark();
  const keys = Object.keys(v.ids);
  const t0 = Date.now();
  const id = await queue({ id: label, group: v.group, proximity: false, autoApprove: true, items: keys.map((k) => ({ key: `U${k}`, stage: 'upgrade',
    delta: { site: v.ids[k], version: 2 } })), stages: [{ name: 'upgrade', items: keys.map((k) => `U${k}`) }] });
  return { id, t0 };
}

/**
 * Gate item 4: the village's 12 lots get a batch of 12 delta items (hand-written v2s of the 4 kit examples) as stage "upgrade":
 * identical to atomic applies, a relog mid-batch resumes identically, cancelBatch keeps exactly the applied deltas,
 * undoStage("upgrade") reverts all 12 exactly, and removeGroup afterwards is exact. Gate item 5: the batch at 1, 4 and 10 ms
 * (MSPT, throughput) and the size-cap fixture with every cell changed, applied and reverted with no tick over 50 ms.
 */
steps.village = async () => {
  if (!dev) await connect();
  await flatBase();
  const v = await villageBase();
  const out = {};
  // the reference: atomic applies one by one
  await fresh('G5B VAtomic', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  for (const k of Object.keys(v.ids)) check((await deltaApply(v.ids[k], 2)).applied, `village: atomic apply ${k}`);
  const hAtomic = (await hash(V_BOX)).sha256;
  // the batch at 1, 4 and 10 ms
  for (const ms of [4, 1, 10]) {
    await fresh(`G5B VBatch${ms}`, 'G5B VBase');
    await tp(VOX + 50.5, 120, VOZ + 60.5);
    await installVillageV2(v.dir);
    const b = await upgradeBatch(v, ms, `up${ms}`);
    const done = await waitBatch(b.id, 30 * 60_000);
    const wall = (Date.now() - b.t0) / 1000;
    const stats = await call('dev.placement.stats', {});
    const h = (await hash(V_BOX)).sha256;
    const failed = done.items.filter((i) => i.status !== 'PLACED');
    check(failed.length === 0 && h === hAtomic, `village ${ms} ms: the delta batch equals the atomic applies (wall ${wall.toFixed(1)} s, MSPT max ${stats.msptMax?.toFixed(1)} ms, over 50 ms: ${stats.ticksOver50ms})`,
      { failed, h, hAtomic });
    if (ms === 4) check(ownOk(ownTick(stats), 25), `village 4 ms: ${tickText(ownTick(stats), 25)}`, ownTick(stats));
    check(ownOk(ownTick(stats)), `village ${ms} ms: ${tickText(ownTick(stats))}`, ownTick(stats));
    out[`batch${ms}`] = { wall, stats };
    if (ms === 4) {
      // undoStage("upgrade") reverts all 12 exactly; removeGroup afterwards is exact
      const u = await api(`sundo ${v.group} upgrade`);
      const ur = await result(u, 600_000);
      await settle(3000);
      const hu = (await hash(V_BOX)).sha256;
      check(hu === v.hPlaced, 'village: undoStage("upgrade") reverts all 12 deltas exactly', { ur, hu, want: v.hPlaced });
      const rg = await result(await api(`sgremove ${v.group}`), 900_000);
      await settle(3000);
      const hr = (await hash(V_BOX)).sha256;
      check(hr === v.h0, 'village: removeGroup afterwards is exact', { rg, hr, want: v.h0 });
    }
    await leaveWorld();
  }
  // a relog mid-batch resumes identically
  await fresh('G5B VRelog', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  // two ticks per delta item: leaving right after the queue call saves the world mid-batch
  const rb = await upgradeBatch(v, 1, 'uprelog');
  await sleep(350);
  const mid = await api(`batch ${rb.id}`);
  const placedMid = (mid.items ?? []).filter((i) => i.status === 'PLACED').length;
  await leaveWorld();
  await openWorld('G5B VRelog');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await mark();
  const now0 = await api(`batch ${rb.id}`);
  const dr = now0.status === 'DONE' ? now0 : await waitBatch(rb.id, 30 * 60_000);
  const hr = (await hash(V_BOX)).sha256;
  check(dr.items.every((i) => i.status === 'PLACED') && hr === hAtomic, `village: a relog mid-batch (${placedMid} of 12 applied) resumes identically`, { hr, hAtomic });
  await leaveWorld();
  // cancelBatch: the applied deltas stay, the rest never start (an instant delta has no in-flight state at a tick boundary)
  await fresh('G5B VCancel', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  const cb = await upgradeBatch(v, 1, 'upcancel');
  await sleep(300);
  const cancelled = await result(await api(`bcancel ${cb.id}`), 300_000);
  await settle(3000);
  const applied = (cancelled.items ?? []).filter((i) => i.status === 'PLACED').map((i) => i.key.slice(1));
  const hc = (await hash(V_BOX)).sha256;
  await leaveWorld();
  await fresh('G5B VCancelRef', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  for (const k of applied) await deltaApply(v.ids[k], 2);
  const hcRef = (await hash(V_BOX)).sha256;
  check(hc === hcRef, `village: cancelBatch keeps exactly the ${applied.length} applied deltas (no half delta)`, { hc, hcRef, applied });
  await leaveWorld();
  return out;
};

/** Gate item 5: the size-cap fixture (96x64x96, every cell changed) applied and reverted over ticks, no tick over 50 ms. */
steps.sizecap = async () => {
  if (!dev) await connect();
  await flatBase();
  const V = path.join(OUT, 'versions-cap');
  execFileSync('node', [path.join(root, 'tools', 'gate5b-sizecap.mjs'), V], { stdio: 'ignore' });
  await fresh('G5B Cap', FLAT);
  await tp(-40.5, 140, -40.5);
  const BOX = [-10, 50, -10, 110, 140, 110];
  const h0 = (await hash(BOX)).sha256;
  await installEntry('g5b_cap', path.join(V, 'v1'));
  await cmd('/architect budget 4');
  await mark();
  const q = await queue({ id: 'cap', proximity: false, items: [{ key: 'C', bp: 'g5b_cap', at: [0, 64, 0], rot: 0, mode: 'INSTANT', force: true }] });
  await waitBatch(q, 30 * 60_000);
  const site = (await since()).find((e) => e.event === 'ITEM_PLACED' && e.batch === q).site;
  await installVersion('g5b_cap', path.join(V, 'v2'), 'v2');
  const h1 = (await hash(BOX)).sha256;
  await call('dev.placement.stats', { reset: true });
  const t0 = Date.now();
  const a = await call('dev.site.delta.apply', { site, version: 2 }, 30 * 60_000);
  const sa = await call('dev.placement.stats', {});
  check(a.applied, `sizecap: the delta of every cell (${a.written} cells) applied over ticks in ${((Date.now() - t0) / 1000).toFixed(1)} s`, a.applied ? sa : a);
  check(ownOk(ownTick(sa)), `sizecap: apply: ${tickText(ownTick(sa))}`, ownTick(sa));
  await call('dev.placement.stats', { reset: true });
  const r = await call('dev.site.revert', { site, version: 1 }, 30 * 60_000);
  const sr = await call('dev.placement.stats', {});
  const hb = (await hash(BOX)).sha256;
  check(r.applied && hb === h1, 'sizecap: the revert gives the v1 world back exactly', { r: r.applied ? undefined : r, hb, h1 });
  check(ownOk(ownTick(sr)), `sizecap: revert: ${tickText(ownTick(sr))}`, ownTick(sr));
  const rm = await result(await api(`remove ${site} - noforce keep`), 30 * 60_000);
  await settle(3000);
  check(rm.removed && (await hash(BOX)).sha256 === h0, 'sizecap: Remove is exact', rm.removed ? undefined : rm);
  return { apply: sa, revert: sr };
};

/** Debug: the survival cabin's v1 -> v2 as an instant apply (the cells in front of the door). */
steps.scabindbg = async () => {
  if (!dev) await connect();
  await flatBase();
  const ID = 'g5b_scabin';
  const V = path.join(OUT, 'versions-scabin');
  const AT = [28, 65, -19];
  await fresh('G5B ScDbg', FLAT);
  await tp(40.5, 80, 20.5);
  await installEntry(ID, path.join(V, 'v1'));
  const p = await result(await api(`place ${ID} ${AT.join(' ')} INSTANT unowned noactor 0`));
  const show = async (label) => {
    const w = await cellsIn([31, 63, -11, 35, 67, -7]);
    log(`  ${label}: ` + [...w.entries()].filter(([q]) => /,-(9|10|8),/.test(',' + q.split(',').slice(1).join(',') + ',') || true).filter(([q]) => q.startsWith('32,') || q.startsWith('33,')).map(([q, v]) => `${q}=${v.replace('minecraft:', '')}`).join(' '));
  };
  await show('v1');
  await installVersion(ID, path.join(V, 'v2'), 'v2');
  const c = await deltaCheck(p.siteId, 2, { cells: true });
  log(`  check: kept ${JSON.stringify(c.kept)} changed has 32,64,-9: ${(c.ghost?.changed ?? []).includes('32,64,-9')} added: ${(c.ghost?.added ?? []).includes('32,64,-9')} removed: ${(c.ghost?.removed ?? []).includes('32,65,-9')}`);
  const a = await deltaApply(p.siteId, 2);
  log(`  apply: written ${a.written} kept ${JSON.stringify(a.kept)}`);
  await show('v2');
};

/** Debug: the village delta batch at 4 ms once (timings in the client log). */
steps.vprobe = async () => {
  if (!dev) await connect();
  await flatBase();
  const v = await villageBase();
  await fresh('G5B VProbe', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  const b = await upgradeBatch(v, 4, 'probe');
  const done = await waitBatch(b.id, 10 * 60_000);
  const stats = await call('dev.placement.stats', {});
  log(`  vprobe: ${done.items.map((i) => i.status).join(',')} msptMax ${stats.msptMax} over50 ${stats.ticksOver50ms}`);
  const rg = await result(await api(`sgremove ${v.group}`), 900_000);
  await settle(3000);
  const h = await hash(V_BOX, [], true);
  log(`  vprobe: removeGroup ${JSON.stringify(rg).slice(0, 300)}; exact ${h.sha256 === v.h0}`);
  if (h.sha256 !== v.h0) {
    fs.writeFileSync(path.join(OUT, 'vprobe-after.json'), JSON.stringify(h.list ?? []));
  }
  await leaveWorld();
};

steps.vcheck = async () => {
  if (!dev) await connect();
  const v = ctx.village5;
  await fresh('G5B VProbe', 'G5B VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await installVillageV2(v.dir);
  for (const k of Object.keys(v.ids)) {
    const t0 = Date.now();
    const c = await deltaCheck(v.ids[k], 2);
    const t1 = Date.now();
    const c2 = await deltaCheck(v.ids[k], 2);
    log(`  ${k}: check ms ${c.ms} (${t1 - t0} wall), again ${c2.ms}`);
  }
  await leaveWorld();
};

/**
 * Gate item 9: the unchanged 1.6.0 (v0.9.0) and 1.5.0 (v0.8.0) apitest jars pass their own `tools/apitest.mjs survival`
 * against this build (the apitest mod off the classpath, the old jar in mods/), in a fresh survival world each.
 */
steps.apijars = async () => {
  const runs = [
    { api: '1.6.0', dir: path.join(OUT, 'v090'), jar: 'architect_apitest-0.9.0.jar', world: 'G5B Api16' },
    { api: '1.5.0', dir: path.join(MAIN, 'artifacts', 'gate5a', 'v080'), jar: 'architect_apitest-0.8.0.jar', world: 'G5B Api15' },
  ];
  const mods = path.join(GAME_DIR, 'mods');
  const out = {};
  for (const r of runs) {
    if (dev) await stopClient();
    else if (clientPids().length) {
      await connect(PORT, GAME_DIR, 10_000).catch(() => null);
      await stopClient();
    }
    fs.mkdirSync(mods, { recursive: true });
    fs.copyFileSync(path.join(r.dir, r.jar), path.join(mods, r.jar));
    const outDir = path.join(OUT, `api${r.api.replace(/\./g, '')}jar`);
    let code = 0;
    let text = '';
    try {
      fs.rmSync(path.join(SAVES, r.world), { recursive: true, force: true });
      await startClient(r.world, { ARCHITECT_APITEST: '0', ARCHITECT_AUTOWORLD_MODE: 'survival' });
      try {
        text = execFileSync('node', [path.join(r.dir, 'tools', 'apitest.mjs'), 'survival'], {
          env: { ...process.env, APITEST_API_VERSION: r.api, ARCHITECT_DEV_PORT: String(PORT), ARCHITECT_GAME_DIR: GAME_DIR, APITEST_OUT: outDir,
            APITEST_GAME_DIR: GAME_DIR }, timeout: 3_600_000 }).toString();
      } catch (e) {
        code = e.status ?? 1;
        text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
    } finally {
      await stopClient();
      fs.rmSync(path.join(mods, r.jar), { force: true });
    }
    fs.writeFileSync(path.join(OUT, `api${r.api.replace(/\./g, '')}jar.log`), text);
    const fails = text.split('\n').filter((l) => l.startsWith('FAIL'));
    const oks = text.split('\n').filter((l) => l.startsWith('ok')).length;
    check(code === 0 && fails.length === 0, `apijars: the ${r.api} apitest jar (unchanged) passes its tools/apitest.mjs survival against 0.10.0 (${oks} ok, ${fails.length} FAIL)`, fails);
    out[r.api] = { code, oks, fails: fails.length };
  }
  await startClient('G5B Smoke');
  return out;
};

/** Gate item 3: a queued delta item for a site still BUILDING waits (SITE_BUSY), and starts once the site is built. */
steps.survqueue = async () => {
  if (!dev) await connect();
  await flatBase();
  const ID = 'g5b_scabin';
  const V = path.join(OUT, 'versions-scabin');
  if (!fs.existsSync(path.join(V, 'v2'))) {
    buildKitVersion('cabin', ID, path.join(V, 'v1'));
    buildKitVersion('cabin', ID, path.join(V, 'v2'), ['--values', '{"width":10,"porch":false}']);
  }
  await fresh('G5B SurvQ', FLAT);
  await tp(40.5, 80, 20.5);
  await installEntry(ID, path.join(V, 'v1'));
  await call('dev.survival.set', { on: true });
  await mark();
  const qid = await queue({ id: 'SQ', proximity: false, items: [{ key: 'S', bp: ID, at: [28, 65, -19], rot: 0, mode: 'CONSTRUCTION', force: true }] });
  const ev = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.batch === qid, 120_000, 'S placed');
  const S = ev.site;
  await installVersion(ID, path.join(V, 'v2'), 'v2');
  const did = await queue({ id: 'SQD', proximity: false, items: [{ key: 'D', delta: { site: S, version: 2 } }] });
  await settle(3000);
  const b1 = await api(`batch ${did}`);
  const it = (b1.items ?? [])[0] ?? {};
  check(it.status === 'WAITING' && it.reason === 'SITE_BUSY', `survqueue: the queued delta waits while ${S} builds (${it.status} ${it.reason})`, b1);
  const fin = await cmd(`/architect site finish ${S}`);
  log(`  survqueue: finish: ${JSON.stringify(fin.messages).slice(0, 200)}`);
  const done = await waitBatch(did, 300_000);
  const st = await siteState(S);
  check(done.items[0].status === 'PLACED' && st.version === 2, `survqueue: once built, the queued delta starts (${done.items[0].status}; the site at v${st.version}, a construction delta of ${st.swaps} swaps)`, { done, st });
  await call('dev.survival.set', { on: false });
};

const which = process.argv[2];
if (!which || !steps[which]) {
  console.log(`steps: ${Object.keys(steps).join(', ')}`);
  process.exit(2);
}
await run(which);
log(failures ? `FAILED (${failures})` : 'OK');
try {
  dev?.close();
} catch {
  // closed
}
process.exit(failures ? 1 : 0);
