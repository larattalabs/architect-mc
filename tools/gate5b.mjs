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
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE5B_OUT ? path.resolve(process.env.GATE5B_OUT) : path.join(MAIN, 'artifacts', 'gate5b');
fs.mkdirSync(OUT, { recursive: true });
// the client runs from a separate worktree (compiling here never changes a running client's classes)
const RUN = process.env.GATE5B_RUN ? path.resolve(process.env.GATE5B_RUN) : path.resolve(root, '..', 'architect-mc-5b-run');
const V090 = path.resolve(root, '..', 'architect-mc-v090');
/** The two clients: the 0.10.0 gate client (run worktree) and the 0.9.0 one (tag v0.9.0, for the downgrade note). */
const CLIENTS = {
  new: { name: '0.10.0', dir: RUN, port: Number(process.env.ARCHITECT_DEV_PORT || 8891), script: 'tools/run-gate5b-client.sh', env: {} },
  old: { name: '0.9.0', dir: V090, port: 8893, script: 'tools/run-gate4e-client.sh',
    env: { ARCHITECT_PORT: '8892', ARCHITECT_DEV_PORT: '8893', ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots090') } },
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
    log(`  check v${c.from}->v${to}: ok ${c.ok} +${c.added} -${c.removed} ~${c.changed} writes ${c.writes} guards ${c.shapeGuards} growth ${c.growth} ${JSON.stringify(c.refusals)}`);
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
      check(!v4.ok && v4.refusals.some((r) => r.reason === 'FRAME_CHANGED'), 'chains: v4 (front changed) refuses FRAME_CHANGED', v4.refusals);
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
