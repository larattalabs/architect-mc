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
const V070 = path.resolve(root, '..', 'architect-mc-v070');
/** The two clients: the 0.8.0 gate client (run worktree) and the 0.7.0 one (tag v0.7.0, for the migration and the downgrade). */
const CLIENTS = {
  new: { name: '0.8.0', dir: RUN, port: Number(process.env.ARCHITECT_DEV_PORT || 8891), script: 'tools/run-gate4e-client.sh', env: {} },
  old: { name: '0.7.0', dir: V070, port: 8893, script: 'tools/run-gate4d-client.sh',
    env: { ARCHITECT_PORT: '8892', ARCHITECT_DEV_PORT: '8893', ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots070') } },
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

// ------------------------------------------------------------------ the flat base world and the 4-site fixture

const FLAT = 'G4E Flat';
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

/** The fixture's fixed hash box (the union of the four sites + 8 must lie inside it). */
const FIX_BOX = [0, 50, -44, 100, 110, 40];
/** Places the fixture: T (a raised CELL pad), R (a road across T), H (a cabin LAYERed on T facing R), X (a gatehouse LAYERed over H's east wall). */
async function placeFixture() {
  const T = await call('dev.cells.place', { kind: 'gate4e:pad', pad: { minX: 20, maxX: 59, minZ: -24, maxZ: 15, y: 66, top: 'minecraft:coarse_dirt', depth: 3, clear: 8 } },
    600_000);
  const R = await call('dev.road.place', { points: [[10, 67, 0], [80, 67, 0]], width: 3 }, 180_000);
  const H = await result(await api('place cabin 28 67 -19 INSTANT unowned noactor 0 layer'));
  const X = await result(await api('place gatehouse 37 67 -19 INSTANT unowned noactor 0 layer'));
  return { T: { ...T, siteId: T.siteId }, R, H, X };
}
const verify = async (site, list = false) => call('dev.site.verify', { site, list, max: 20 }, 120_000);
/** The owned cells of each site as "pos" -> world value (dev.site.verify list). */
async function ownedNow(ids) {
  const out = {};
  for (const id of ids) {
    const v = await verify(id, true);
    out[id] = { owned: v.owned, afterMismatches: v.mismatches, firstAfter: v.first, cells: new Map(v.list.map((l) => [l.slice(0, l.indexOf(' ')), l])) };
  }
  return out;
}
/**
 * Cells a standing site owned before and still owns that changed away from what the site placed (its entry's after), per site:
 * the shape leak. A cell that changed back to the site's after (a neighbour's placement had reshaped it, its removal undid that)
 * is not one.
 */
function leaks(before, after) {
  const out = {};
  for (const id of Object.keys(after)) {
    const b = before[id];
    if (!b) continue;
    const changed = [];
    for (const [p, v] of after[id].cells) {
      if (b.cells.has(p) && b.cells.get(p) !== v && v.endsWith(' !after')) changed.push({ was: b.cells.get(p), now: v });
    }
    if (changed.length) out[id] = { count: changed.length, first: changed.slice(0, 10) };
  }
  return out;
}

steps.smoke = async () => {
  if (!dev) await connect();
  await flatBase();
  await fresh('G4E SmokeF', FLAT);
  await tp(48.5, 80, 20.5);
  const h0 = await hash(FIX_BOX);
  const f = await placeFixture();
  for (const k of ['T', 'R', 'H', 'X']) check(f[k].placed, `smoke: ${k} placed (${f[k].siteId})`, f[k]);
  const all = await sites();
  log(JSON.stringify(all.map((x) => ({ id: x.id, kind: x.kind, covers: x.covers, coveredBy: x.coveredBy, rb: x.restoreBox }))));
  const ids = { T: f.T.siteId, R: f.R.siteId, H: f.H.siteId, X: f.X.siteId };
  let standing = Object.keys(ids);
  let snap = await ownedNow(standing.map((k) => ids[k]));
  for (const k of standing) log(`  ${k}: owns ${snap[ids[k]].owned}, ${snap[ids[k]].afterMismatches} differ from the recorded after ${JSON.stringify(snap[ids[k]].firstAfter.slice(0, 2))}`);
  for (const k of ['H', 'R', 'X', 'T']) {
    const r = await result(await api(`remove ${ids[k]} - noforce keep`), 300_000);
    check(r.removed, `smoke: remove ${k}: restored ${r.restored}, handed ${JSON.stringify(r.handedDown)}`, r);
    standing = standing.filter((x) => x !== k);
    await settle();
    const now = await ownedNow(standing.map((x) => ids[x]));
    const l = leaks(snap, now);
    check(Object.keys(l).length === 0, `smoke: after ${k}, ${standing.join(',') || 'none'} unchanged on the cells they own`, l);
    snap = now;
  }
  const h1 = await hash(FIX_BOX, [], true);
  const ok = check(h1.sha256 === h0.sha256, 'smoke: the fixture box is back exactly after removing H, R, X, T', { h0: h0.sha256, h1: h1.sha256 });
  if (!ok) {
    await leaveWorld();
    copyWorld(FLAT, 'G4E SmokeRef');
    await openWorld('G4E SmokeRef');
    const ref = await hash(FIX_BOX, [], true);
    results.diff = { ok: false, data: diff(ref.list, h1.list, 40) };
  }
  return { f, ids };
};

// ------------------------------------------------------------------ gate 2: any-order exactness

const PAD = { minX: 20, maxX: 59, minZ: -24, maxZ: 15, y: 66, top: 'minecraft:coarse_dirt', depth: 3, clear: 8 };
const FIXTURE = {
  id: 'fix', overlap: 'LAYER', items: [
    { key: 'T', cells: { kind: 'gate4e:pad', pad: PAD } },
    { key: 'R', road: { points: [[10, 67, 0], [80, 67, 0]], width: 3 }, after: ['T'] },
    { key: 'H', bp: 'cabin', at: [28, 67, -19], rot: 0, mode: 'INSTANT', after: ['R'] },
    { key: 'X', bp: 'gatehouse', at: [37, 67, -19], rot: 0, mode: 'INSTANT', after: ['H'] },
  ],
};
function perms(a) {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}
/** A deterministic shuffle (mulberry32). */
function shuffled(a, seed) {
  let t = seed >>> 0;
  const rnd = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}
const inside = (a, outer) => a[0] >= outer[0] && a[1] >= outer[1] && a[2] >= outer[2] && a[3] <= outer[3] && a[4] <= outer[4] && a[5] <= outer[5];

/** The fixture's base worlds: G4E OrdBase (T, R, H, X through one LAYER batch) and G4E OrdBaseL (plus L over R's edge). */
async function ordersBase() {
  await flatBase();
  await fresh('G4E OrdBase', FLAT);
  await tp(48.5, 80, 30.5);
  const h0 = await hash(FIX_BOX);
  await mark();
  const id = await queue(FIXTURE);
  const done = await waitBatch(id, 600_000);
  const ev = await since();
  const ids = {};
  for (const e of ev.filter((x) => x.event === 'ITEM_PLACED' && x.batch === id)) ids[e.key] = e.site;
  check(Object.keys(ids).length === 4, `orders: the LAYER batch placed T, R, H, X (${JSON.stringify(ids)})`, { done, ids });
  const all = await sites();
  const ub = all.map((x) => box6(x.restoreBox)).reduce(union);
  check(inside(grow(ub, 8), FIX_BOX), `orders: the union box + 8 ${JSON.stringify(grow(ub, 8))} lies inside the hashed box`, { ub, FIX_BOX });
  // the seam between H and X: which blocks meet there (shape-sensitive ones make the no-leak check bite)
  const seam = await call('dev.region.hash', { box: [36, 65, -19, 39, 78, -4], cells: true }, 60_000);
  const seamKinds = [...new Set(seam.list.map((l) => /id:"([^"]+)"/.exec(l)?.[1]))].sort();
  log(`  seam blocks: ${seamKinds.join(' ')}`);
  await cmd('/save-all flush');
  await settle(2000);
  const j = await journal();
  const act = (j.entries ?? []).filter((e) => e.status === 'ACTIVE');
  check(act.length >= 4 && (j.unreferenced ?? []).length === 0, `orders: the journal holds ${act.length} ACTIVE entries, nothing unreferenced`, j);
  const base = await ownedNow(Object.values(ids));
  // L: a cabin LAYERed over R's edge, east of the pad
  await leaveWorld();
  copyWorld('G4E OrdBase', 'G4E OrdBaseL');
  await openWorld('G4E OrdBaseL');
  const L = await result(await api('place cabin 63 65 -8 INSTANT unowned noactor 0 layer'));
  check(L.placed, `orders: L layered over R's edge (${L.siteId})`, L);
  const allL = await sites();
  const lSite = allL.find((x) => x.id === L.siteId);
  check(lSite && (lSite.covers ?? []).includes(ids.R), `orders: L covers R (covers ${JSON.stringify(lSite?.covers)})`, lSite);
  const ubL = allL.map((x) => box6(x.restoreBox)).reduce(union);
  check(inside(grow(ubL, 8), FIX_BOX), 'orders: with L the union box + 8 lies inside the hashed box', { ubL });
  await cmd('/save-all flush');
  await leaveWorld();
  ctx.orders = { h0: h0.sha256, ids, L: L.siteId, group: done.group, seamKinds };
  saveCtx();
  return { h0, ids, done, L, seamKinds, owned: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v.owned])) };
}

/** Removes {@code order} (keys) one by one in a fresh copy of {@code world}; checks the no-leak rule after each and the hash at the end. */
async function removeInOrder(world, ids, order, h0, label) {
  copyWorld(world, 'G4E Ord');
  await openWorld('G4E Ord');
  let standing = Object.keys(ids);
  let snap = await ownedNow(standing.map((k) => ids[k]));
  const steps0 = [];
  let leaked = {};
  let refused = null;
  for (const k of order) {
    const r = await result(await api(`remove ${ids[k]} - noforce keep`), 300_000);
    steps0.push({ k, removed: r.removed, restored: r.restored, handedDown: r.handedDown, blockers: r.blockers });
    if (!r.removed) {
      refused = { k, r };
      break;
    }
    standing = standing.filter((x) => x !== k);
    await settle(1500);
    const now = await ownedNow(standing.map((x) => ids[x]));
    const l = leaks(snap, now);
    if (Object.keys(l).length) leaked[k] = l;
    snap = now;
  }
  const h = await hash(FIX_BOX);
  const exact = h.sha256 === h0;
  const ok = !refused && Object.keys(leaked).length === 0 && exact;
  check(ok, `${label} ${order.join('')}: ${refused ? `refused at ${refused.k}` : 'all removed'}, ${Object.keys(leaked).length ? 'LEAK' : 'no leak'}, `
    + `${exact ? 'box + 8 exact' : 'NOT exact'}`, { steps: steps0, leaked, refused, h: h.sha256, h0 });
  if (!exact) {
    const now = await hash(FIX_BOX, [], true);
    await leaveWorld();
    copyWorld(FLAT, 'G4E OrdRef');
    await openWorld('G4E OrdRef');
    const ref = await hash(FIX_BOX, [], true);
    results[`${label} ${order.join('')} diff`] = { ok: false, data: diff(ref.list, now.list, 30) };
  }
  await leaveWorld();
  return ok;
}

steps.orders = async () => {
  if (!dev) await connect();
  const b = await ordersBase();
  const h0 = b.h0.sha256;
  let passed = 0;
  const all = perms(['T', 'R', 'H', 'X']);
  for (const o of all) if (await removeInOrder('G4E OrdBase', b.ids, o, h0, 'orders')) passed++;
  check(passed === 24, `orders: ${passed}/24 removal orders exact with no leak`);
  // one group removal of all four
  copyWorld('G4E OrdBase', 'G4E Ord');
  await openWorld('G4E Ord');
  const g = await result(await api(`sgremove ${b.done.group}`), 600_000);
  const hg = await hash(FIX_BOX);
  check(g.removed === true && hg.sha256 === h0, `orders: the group removal of all four is exact (${JSON.stringify(g).slice(0, 160)})`, { g, h: hg.sha256, h0 });
  await leaveWorld();
  // L: 6 random orders of five
  const idsL = { ...b.ids, L: b.L.siteId };
  let passedL = 0;
  for (let i = 0; i < 6; i++) {
    if (await removeInOrder('G4E OrdBaseL', idsL, shuffled(['T', 'R', 'H', 'X', 'L'], 4242 + i), h0, 'orders+L')) passedL++;
  }
  check(passedL === 6, `orders: ${passedL}/6 random orders with L exact with no leak`);
  return { ids: b.ids, L: b.L.siteId, seam: b.seamKinds };
};

// ------------------------------------------------------------------ gate 3: player edits

const cellsOf = async (b) => (await call('dev.region.hash', { box: b, cells: true }, 300_000)).list;
function cellMap(list) {
  return new Map(list.map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
}

steps.edits = async () => {
  if (!dev) await connect();
  await flatBase();
  await fresh('G4E Edits', FLAT);
  await tp(48.5, 80, 30.5);
  const h0 = await hash(FIX_BOX);
  const T = await call('dev.cells.place', { kind: 'gate4e:pad', pad: PAD }, 600_000);
  const R = await call('dev.road.place', { points: [[10, 67, 0], [80, 67, 0]], width: 3 }, 180_000);
  check(T.placed && R.placed, `edits: T and R placed (${T.siteId}, ${R.siteId})`);
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E Edits', 'G4E EditsChest');
  await openWorld('G4E Edits');
  const s1 = cellMap(await cellsOf(FIX_BOX));
  const H = await result(await api('place cabin 28 67 -19 INSTANT unowned noactor 0 layer'));
  check(H.placed, `edits: H layered on T (${H.siteId})`, H);
  const hBox = box6((await sites()).find((x) => x.id === H.siteId).restoreBox);
  // a block placed on R: a road cell outside every building (the top of R's stack at x 70)
  let roadCell = null;
  for (let y = 67; y >= 62 && !roadCell; y--) {
    const st = await call('dev.journal.at', { x: 70, y, z: 0 });
    const top = (st.stack ?? []).at(-1);
    if (top && top.site === R.siteId && top.after && !/air/.test(top.after)) roadCell = [70, y, 0];
  }
  check(!!roadCell, `edits: R's surface cell at x 70 is ${JSON.stringify(roadCell)}`);
  await cmd(`/setblock ${roadCell.join(' ')} minecraft:cobblestone`);
  // the door of H, opened (the kit has no lever: a door's "open" is the same volatile-property rule)
  const hc = await cellsOf(hBox);
  const door = hc.find((l) => /_door",properties:\{[^}]*half:"lower"/.test(l));
  check(!!door, `edits: H's door ${door?.slice(0, 120)}`);
  const dp = door.slice(0, door.indexOf(' ')).split(',').map(Number);
  await cmd(`/setblock ${dp.join(' ')} ${/id:"([^"]+)"/.exec(door)[1]}[${[...door.matchAll(/(\w+):"(\w+)"/g)].filter((m) => m[1] !== 'id').map((m) => `${m[1]}=${m[1] === 'open' ? 'true' : m[2]}`).join(',')}]`);
  await settle(1500);
  const opened = (await cellsOf([dp[0], dp[1], dp[2], dp[0], dp[1] + 1, dp[2]]));
  check(opened.every((l) => /open:"true"/.test(l)), 'edits: the door is open (both halves)', opened);
  // H's removal: a safe remove (the open door counts as ours), its box back as before H
  const rh = await result(await api(`remove ${H.siteId} - noforce keep`), 300_000);
  check(rh.removed, `edits: H's removal is not refused by its opened door (${JSON.stringify(rh.blockers)})`, rh);
  const s2 = cellMap(await cellsOf(FIX_BOX));
  const inH = (k) => { const [x, y, z] = k.split(',').map(Number); return x >= hBox[0] && x <= hBox[3] && y >= hBox[1] && y <= hBox[4] && z >= hBox[2] && z <= hBox[5]; };
  const hDiff = [...s1.keys()].filter((k) => inH(k) && s1.get(k) !== s2.get(k));
  check(hDiff.length === 0, `edits: H's box is back exactly as before H (${hDiff.length} cells differ)`, hDiff.slice(0, 10).map((k) => [k, s1.get(k), s2.get(k)]));
  // R's removal keeps the block and reports it
  const rr = await result(await api(`remove ${R.siteId} - noforce keep`), 300_000);
  const kept = cellMap(await cellsOf([...roadCell, ...roadCell]));
  check(rr.removed && rr.kept >= 1 && /cobblestone/.test([...kept.values()][0]), `edits: R's removal keeps the placed block and reports it (kept ${rr.kept})`, rr);
  const rt = await result(await api(`remove ${T.siteId} - noforce keep`), 300_000);
  const h1 = await hash(FIX_BOX, [[...roadCell, ...roadCell]]);
  const h0x = await (async () => { await leaveWorld(); copyWorld(FLAT, 'G4E EditsRef'); await openWorld('G4E EditsRef'); return hash(FIX_BOX, [[...roadCell, ...roadCell]]); })();
  check(rt.removed && h1.sha256 === h0x.sha256, 'edits: after T, the box is the original but for the kept block', { h1: h1.sha256, h0x: h0x.sha256 });
  await leaveWorld();
  // a filled chest in T refuses H's LAYER without force
  await openWorld('G4E EditsChest');
  await cmd('/setblock 33 67 -12 minecraft:chest');
  await cmd('/item replace block 33 67 -12 container.0 with minecraft:diamond 5');
  const v = await result(await api('place cabin 28 67 -19 INSTANT unowned noactor 0 layer'));
  const reasons = (v.refusals ?? []).map((r) => r.reason ?? r);
  check(!v.placed && reasons.length > 0, `edits: a filled chest in T refuses H's LAYER without force (${JSON.stringify(reasons)})`, v);
  await leaveWorld();
  return { h0: h0.sha256, roadCell, door: dp };
};

// ------------------------------------------------------------------ gates 6 and 8: roads plus the village, MSPT

const KINDS = ['cabin', 'gatehouse', 'tavern', 'tower'];
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
    const f = await api(`fit ${KINDS[i % 4]} ${lot.join(',')} north into`);
    out.push({ key: `L${i}`, bp: KINDS[i % 4], lot, at: f.at, rot: f.rot, predicted: f.predictedRestoreBox, refusals: (f.refusals ?? []).map((r) => r.reason) });
  }
  return out;
}
const intersects = (a, b) => a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];

async function village(order, budget, name) {
  await fresh(name, 'G4E VBase');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  await cmd(`/architect budget ${budget}`);
  await call('dev.placement.stats', { reset: true });
  const roads = vRoads();
  const lots = ctx.village.fits.map((f) => ({ key: f.key, bp: f.bp, at: f.at, rot: f.rot, mode: 'INSTANT', force: true }));
  const items = order === 'A' ? [...roads, ...lots.map((l) => ({ ...l, after: roads.map((r) => r.key) }))]
    : [...lots, ...roads.map((r) => ({ ...r, after: lots.map((l) => l.key) }))];
  await mark();
  const t0 = Date.now();
  const id = await queue({ id: `v${order}${budget}`, proximity: false, items });
  const done = await waitBatch(id, 30 * 60_000);
  const wall = (Date.now() - t0) / 1000;
  const stats = await call('dev.placement.stats', {});
  const ev = await since();
  const ids = {};
  for (const e of ev.filter((x) => x.event === 'ITEM_PLACED' && x.batch === id)) ids[e.key] = e.site;
  const failed = done.items.filter((i) => i.status !== 'PLACED').map((i) => `${i.key}:${i.status}:${i.reason}`);
  return { id, done, wall, stats, ids, failed };
}

/** `village <A|B> <ms>`: one village run (throughput probing). */
steps.village = async () => {
  if (!dev) await connect();
  const r = await village(process.argv[3] ?? 'A', Number(process.argv[4] ?? 4), 'G4E VProbe');
  log(`  village ${process.argv[3] ?? 'A'} at ${process.argv[4] ?? 4} ms: wall ${r.wall.toFixed(2)} s, ${Math.round(r.stats.cellsPerSecond)} cells/s, ticks ${r.stats.ticks}, `
    + `MSPT max ${r.stats.msptMax?.toFixed(2)}, failed ${r.failed.length}`);
  await leaveWorld();
  return { wall: r.wall, stats: r.stats };
};

steps.roads = async () => {
  if (!dev) await connect();
  await flatBase();
  // the base: the village's fits with no roads (the approach runs into the street), and the pre-hash
  await fresh('G4E VBase', FLAT);
  await tp(VOX + 50.5, 100, VOZ + 60.5);
  const fits = await vFits();
  const h0 = (await hash(V_BOX)).sha256;
  await leaveWorld();
  ctx.village = { fits, h0 };
  saveCtx();
  const out = {};
  // (A) roads first, then the lots (REFUSE)
  const a = await village('A', 4, 'G4E VA');
  out.A = { wall: a.wall, stats: a.stats, failed: a.failed };
  check(a.failed.length === 0, `roads (A): 4 roads then 12 lots placed with REFUSE, 0 refusals (${a.failed.join(' ') || 'none'})`, a.done);
  const all = await sites();
  const roadBoxes = Object.fromEntries(vRoads().map((r) => [r.key, box6(all.find((x) => x.id === a.ids[r.key]).restoreBox)]));
  const stops = [];
  for (const f of fits) {
    const sb = box6(all.find((x) => x.id === a.ids[f.key]).restoreBox);
    const row = Math.floor(Number(f.key.slice(1)) / 4);
    const rb = roadBoxes[`R${row}`];
    stops.push({ key: f.key, minZ: sb[2], roadMaxZ: rb[5], fitMinZ: f.predicted?.[2], meets: sb[2] === rb[5] + 1, intoRoad: intersects(sb, rb) });
  }
  check(stops.every((x) => x.meets && !x.intoRoad), `roads (A): every approach stops at the road (restore box starts right after the road: ${stops.filter((x) => x.meets).length}/12)`, stops);
  let roadOwned = 0;
  let roadBad = 0;
  for (const r of vRoads()) {
    const v = await verify(a.ids[r.key]);
    roadOwned += v.owned;
    roadBad += v.mismatches;
  }
  check(roadBad === 0, `roads (A): no approach cell is a road cell (the roads own all their ${roadOwned} cells, as placed)`);
  const fitsRoad = await vFits();
  check(fitsRoad.every((f, i) => f.predicted[2] > fits[i].predicted[2]), 'roads (A): fitToLot facing a road predicts the shorter box',
    fitsRoad.map((f, i) => [f.key, fits[i].predicted[2], f.predicted[2]]));
  check(a.stats.ticksOver50ms === 0 && a.stats.msptMax <= 25, `roads (A) at 4 ms: MSPT max ${a.stats.msptMax?.toFixed(2)} ms (<= 25), no tick over 50 ms`, a.stats);
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E VA', 'G4E VA1');
  await openWorld('G4E VA');
  await tp(VOX + 50.5, 120, VOZ + 60.5); // out of every site's box (a player inside one makes a removal wait)
  // the group undo
  const ga = await result(await api(`sgremove ${a.done.group}`), 20 * 60_000);
  const ha = (await hash(V_BOX)).sha256;
  check(ga.removed && ha === h0, `roads (A): the group undo is exact (${ga.restored} cells)`, ga);
  await leaveWorld();
  // removing one road (RX) while the lots stand
  await openWorld('G4E VA1');
  await tp(VOX + 50.5, 100, VOZ + 60.5);
  const lotIds = fits.map((f) => a.ids[f.key]);
  const before = await ownedNow([...lotIds, a.ids.R0, a.ids.R1, a.ids.R2]);
  const preCells = cellMap(await cellsOf(roadBoxes.RX));
  const rx = await result(await api(`remove ${a.ids.RX} - noforce keep`), 300_000);
  const after = await ownedNow([...lotIds, a.ids.R0, a.ids.R1, a.ids.R2]);
  const lk = leaks(before, after);
  const gained = ['R0', 'R1', 'R2'].map((k) => after[a.ids[k]].owned - before[a.ids[k]].owned);
  check(rx.removed && Object.keys(lk).length === 0, `roads: removing RX leaves the lots and the other roads unchanged (${JSON.stringify(lk).slice(0, 200)})`, { rx, lk });
  check(gained.every((g) => g > 0), `roads: RX's crossing cells went to the other roads (+${gained.join(', +')} cells)`, gained);
  // RX's own (uncovered) cells: back to the flat meadow
  await leaveWorld();
  copyWorld(FLAT, 'G4E VRef');
  await openWorld('G4E VRef');
  const refCells = cellMap(await cellsOf(roadBoxes.RX));
  await leaveWorld();
  await openWorld('G4E VA1');
  const nowCells = cellMap(await cellsOf(roadBoxes.RX));
  const otherRoad = (k) => { const z = Number(k.split(',')[2]); return [0, 1, 2].some((row) => Math.abs(z - (VOZ + row * 38 + 4)) <= 2); };
  const wrong = [...nowCells.keys()].filter((k) => !otherRoad(k) && nowCells.get(k) !== refCells.get(k));
  check(wrong.length === 0, `roads: RX's uncovered cells are restored (${wrong.length} differ)`, wrong.slice(0, 10).map((k) => [k, preCells.get(k), nowCells.get(k), refCells.get(k)]));
  await leaveWorld();
  // (B) lots first, then the roads: they skip lot cells
  const b = await village('B', 4, 'G4E VB');
  await tp(VOX + 50.5, 120, VOZ + 60.5);
  out.B = { wall: b.wall, stats: b.stats, failed: b.failed };
  check(b.failed.length === 0, `roads (B): 12 lots then 4 roads placed (${b.failed.join(' ') || 'none'})`, b.done);
  const lotsB = await ownedNow(fits.map((f) => b.ids[f.key]));
  let badB = 0;
  for (const r of vRoads()) badB += (await verify(b.ids[r.key])).mismatches;
  const lotChanged = Object.values(lotsB).reduce((n, v) => n + [...v.cells.values()].filter((c) => c.endsWith(' !after') && !/dirt_path|"minecraft:dirt"/.test(c)).length, 0);
  check(badB === 0 && lotChanged === 0, `roads (B): the roads skip lot cells (lots untouched: ${lotChanged} changed cells)`);
  const gb = await result(await api(`sgremove ${b.done.group}`), 20 * 60_000);
  const hb = (await hash(V_BOX)).sha256;
  check(gb.removed && hb === h0, `roads (B): the group undo is exact (${gb.restored} cells)`, gb);
  await leaveWorld();
  // gate 8: the village plus roads at 1 and 10 ms
  const tp0 = [{ budgetMs: 4, wallSeconds: a.wall, ...a.stats }];
  for (const ms of [1, 10]) {
    const t = await village('A', ms, `G4E VT${ms}`);
    tp0.push({ budgetMs: ms, wallSeconds: t.wall, failed: t.failed, ...t.stats });
    check(t.failed.length === 0 && t.stats.ticksOver50ms === 0, `throughput ${ms} ms: village + roads ${Math.round(t.stats.cellsPerSecond)} cells/s, wall ${t.wall.toFixed(1)} s, `
      + `MSPT max ${t.stats.msptMax?.toFixed(2)} mean ${t.stats.msptMean?.toFixed(2)}, no tick over 50 ms`, t.stats);
    await cmd('/architect budget 4');
    await leaveWorld();
  }
  tp0.sort((x, y) => x.budgetMs - y.budgetMs);
  const at4 = tp0.find((x) => x.budgetMs === 4);
  check(at4.cellsPerSecond >= 15_000, `throughput: ${Math.round(at4.cellsPerSecond)} cells/s at 4 ms, journal included (budget >= 15k)`, at4);
  fs.writeFileSync(path.join(OUT, 'throughput.json'), JSON.stringify(tp0, null, 2));
  return out;
};

// ------------------------------------------------------------------ gate 7: survival layering

const S_AT = [28, 65, -19];
const U_AT = [37, 65, -19];
const SU_BOX = [10, 55, -35, 65, 90, 10];
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

steps.survival = async () => {
  if (!dev) await connect();
  await flatBase();
  await fresh('G4E Surv', FLAT);
  await tp(40.5, 80, 10.5);
  const h0 = (await hash(SU_BOX)).sha256;
  await call('dev.survival.set', { on: true });
  await mark();
  const sId = await queue({ id: 'S', proximity: false, items: [{ key: 'S', bp: 'cabin', at: S_AT, rot: 0, mode: 'CONSTRUCTION', force: true }] });
  const sEv = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.batch === sId, 120_000, 'S placed');
  const S = sEv.site;
  const into = {};
  const feeds = { [S]: await hopperFor(S) };
  await refill(S, feeds[S], into);
  await sleep(4000);
  // U, LAYERed over S's wall, queued while S builds: it waits (OVERLAP_BUSY), then proceeds
  const uId = await queue({ id: 'U', proximity: false, overlap: 'LAYER', items: [{ key: 'U', bp: 'gatehouse', at: U_AT, rot: 0, mode: 'CONSTRUCTION', force: true }] });
  await sleep(4000);
  const uView = await api(`batch ${uId}`);
  const uItem = (uView.items ?? [])[0] ?? {};
  check(JSON.stringify(uItem).includes('OVERLAP_BUSY'), `survival: U queued while S builds waits with OVERLAP_BUSY (${JSON.stringify(uItem).slice(0, 200)})`, uView);
  check(await buildUntilDone([S], feeds, into), 'survival: S finished from its hopper');
  const uEv = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.batch === uId, 300_000, 'U placed');
  const U = uEv.site;
  feeds[U] = await hopperFor(U);
  check(await buildUntilDone([U], feeds, into), `survival: U (${U}) proceeded after S and finished from its hopper`);
  const all = await sites();
  const ub = union(box6(all.find((x) => x.id === S).restoreBox), box6(all.find((x) => x.id === U).restoreBox));
  const feedCells = Object.values(feeds).flatMap((f) => [f.hop, f.chest]);
  const builtHash = (await hash(ub, feedCells.map((c) => [...c, ...c]))).sha256;
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E Surv', 'G4E Surv2');
  // the instant LAYER reference
  await fresh('G4E SurvRef', FLAT);
  const rs = await result(await api(`place cabin ${S_AT.join(' ')} INSTANT unowned noactor 0 force`));
  const ru = await result(await api(`place gatehouse ${U_AT.join(' ')} INSTANT unowned noactor 0 layer force`));
  const refHash = (await hash(ub, feedCells.map((c) => [...c, ...c]))).sha256;
  check(rs.placed && ru.placed && refHash === builtHash, 'survival: S and U finished identical to instant LAYER placements', { builtHash, refHash });
  await leaveWorld();
  // deconstruct in both orders: items out = items in, terrain exact
  const res = {};
  for (const [w, order] of [['G4E Surv', [S, U]], ['G4E Surv2', [U, S]]]) {
    await openWorld(w);
    await tp(40.5, 80, 10.5);
    const out = {};
    for (const f of Object.values(feeds)) {
      for (const [k, n] of Object.entries(await containerItems(f.chest))) addTo(out, k, n);
      for (const [k, n] of Object.entries(await containerItems(f.hop))) addTo(out, k, n);
    }
    for (const id of order) {
      const r = await result(await api(`remove ${id} - noforce keep`), 600_000);
      check(r.removed, `survival: deconstruct ${id} (order ${order.join(', ')})`, r);
      for (const [k, n] of Object.entries(r.refund ?? {})) addTo(out, k, n);
    }
    for (const f of Object.values(feeds)) {
      await cmd(`/setblock ${f.chest.join(' ')} minecraft:air`);
      await cmd(`/setblock ${f.hop.join(' ')} minecraft:air`);
    }
    await cmd('/kill @e[type=minecraft:item]');
    const ids = new Set([...Object.keys(into), ...Object.keys(out)]);
    const mism = [...ids].filter((k) => (into[k] ?? 0) !== (out[k] ?? 0)).map((k) => [k, into[k] ?? 0, out[k] ?? 0]);
    check(mism.length === 0, `survival (${order.join(' then ')}): items out = items in for every item id (${Object.values(into).reduce((a, b) => a + b, 0)} items)`, mism);
    const h = (await hash(SU_BOX)).sha256;
    check(h === h0, `survival (${order.join(' then ')}): the terrain is exact`);
    res[order.join(',')] = { mism };
    await leaveWorld();
  }
  return { into, res };
};

// ------------------------------------------------------------------ gate 8: the size-cap fixture, random ticks, a sliced cell site

function installKeep() {
  execFileSync('node', [path.join(root, 'tools', 'gate4e-sizecap.mjs'), GAME_DIR], { stdio: 'pipe' });
}
async function placeQueued(spec, label) {
  await call('dev.placement.stats', { reset: true });
  await mark();
  const t0 = Date.now();
  const id = await queue(spec);
  const done = await waitBatch(id, 30 * 60_000);
  const stats = await call('dev.placement.stats', {});
  const site = done.items[0]?.site;
  log(`  ${label}: ${done.items.map((i) => `${i.key}:${i.status}${i.reason ? ':' + i.reason : ''}`).join(' ')} in ${((Date.now() - t0) / 1000).toFixed(1)} s, `
    + `MSPT max ${stats.msptMax?.toFixed(2)} ms`);
  return { done, stats, site, wall: (Date.now() - t0) / 1000 };
}
async function removeTimed(id) {
  await call('dev.placement.stats', { reset: true });
  const t0 = Date.now();
  const r = await result(await api(`remove ${id} - force keep`), 30 * 60_000);
  // a ticked restore: wait until the site is gone
  for (let i = 0; i < 600 && (await sites()).some((x) => x.id === id); i++) await sleep(1000);
  const stats = await call('dev.placement.stats', {});
  return { r, stats, wall: (Date.now() - t0) / 1000 };
}

steps.sizecap = async () => {
  if (!dev) await connect();
  installKeep();
  await flatBase();
  const out = {};
  // (a) on the flat meadow at 4 ms
  await fresh('G4E Keep', FLAT);
  await tp(48.5, 140, 150.5);
  const KB = [-10, 54, -10, 106, 130, 110];
  const h0 = (await hash(KB)).sha256;
  const pa = await placeQueued({ id: 'keep', proximity: false, items: [{ key: 'K', bp: 'g4e_keep', at: [0, 65, 0], rot: 0, mode: 'INSTANT', force: true }] }, 'keep (flat)');
  check(pa.done.items[0].status === 'PLACED' && pa.stats.ticksOver50ms === 0, `sizecap: the 96x64x96 keep placed at 4 ms, no tick over 50 ms (max ${pa.stats.msptMax?.toFixed(2)} ms, `
    + `${Math.round(pa.stats.cellsPerSecond)} cells/s)`, pa.stats);
  const ra = await removeTimed(pa.site);
  check(ra.r.removed && ra.stats.ticksOver50ms === 0, `sizecap: its Remove, no tick over 50 ms (max ${ra.stats.msptMax?.toFixed(2)} ms, ${ra.wall.toFixed(1)} s)`, ra.stats);
  check((await hash(KB)).sha256 === h0, 'sizecap: the keep\'s Remove is exact (box + 8)');
  out.flat = { place: pa.stats, remove: ra.stats, wallPlace: pa.wall, wallRemove: ra.wall };
  await leaveWorld();
  // (b) worldgen trees (the oak and birch features, placed by /place feature) along the keep's box, randomTickSpeed 300
  await fresh('G4E KeepTree', FLAT);
  const w = { x: 0, z: 0, mean: 64 };
  const trees = [];
  for (const [x, z, f] of [[-4, 20, 'oak'], [-4, 60, 'birch'], [100, 30, 'oak'], [100, 70, 'fancy_oak'], [40, -4, 'oak'], [70, 101, 'birch']]) {
    await tp(x + 0.5, 90, z + 0.5);
    const r = await cmd(`/place feature minecraft:${f} ${x} 65 ${z}`);
    trees.push({ x, z, f, r: (r.messages ?? []).join(' ') });
  }
  log(`  trees: ${JSON.stringify(trees.map((t) => [t.x, t.z, t.f, t.r.slice(0, 40)]))}`);
  check(trees.length === 6, 'sizecap: six worldgen-feature trees beside the keep\'s box', trees);
  const at = [w.x, w.mean + 1, w.z];
  const KB2 = [w.x - 10, w.mean - 30, w.z - 10, w.x + 106, w.mean + 80, w.z + 110];
  await tp(w.x + 48.5, 140, w.z + 150.5);
  const h2 = (await hash(KB2)).sha256;
  await cmd('/gamerule random_tick_speed 300');
  const pb = await placeQueued({ id: 'keept', proximity: false, items: [{ key: 'K', bp: 'g4e_keep', at, rot: 0, mode: 'INSTANT', force: true }] }, 'keep (trees, rts 300)');
  await cmd('/gamerule random_tick_speed 0');
  check(pb.done.items[0].status === 'PLACED' && pb.stats.ticksOver50ms === 0, `sizecap: placed by a worldgen tree with randomTickSpeed 300, no tick over 50 ms (max ${pb.stats.msptMax?.toFixed(2)} ms)`, pb.stats);
  const rb = await removeTimed(pb.site);
  const hb = await hash(KB2, [], true);
  const exact = hb.sha256 === h2;
  check(rb.r.removed && exact, 'sizecap: its Remove is exact (box + 8, every cell and BE)', { r: rb.r });
  out.tree = { place: pb.stats, remove: rb.stats, window: w };
  // (c) a sliced 300k-cell cell site with change tracking, randomTickSpeed 300
  const c0 = [w.x, w.mean, w.z];
  const CB = [c0[0] - 8, c0[1] - 12, c0[2] - 8, c0[0] + 108, c0[1] + 40, c0[2] + 108];
  const h3 = (await hash(CB)).sha256;
  await cmd('/gamerule random_tick_speed 300');
  await call('dev.placement.stats', { reset: true });
  const t0 = Date.now();
  const cs = await call('dev.cells.place', { kind: 'gate4e:big', pad: { minX: c0[0] + 1, maxX: c0[0] + 96, minZ: c0[2] + 1, maxZ: c0[2] + 96, y: c0[1] + 2, depth: 4, clear: 28, top: 'minecraft:stone', fill: 'minecraft:cobblestone' }, force: true }, 1_200_000);
  const cst = await call('dev.placement.stats', {});
  await cmd('/gamerule random_tick_speed 0');
  const j = await journal();
  const ce = (j.entries ?? []).find((e) => e.site === cs.siteId);
  check(cs.placed && ce?.cells >= 300_000 && cst.ticksOver50ms === 0, `sizecap: a ${ce?.cells}-cell cell site placed sliced in ${((Date.now() - t0) / 1000).toFixed(1)} s, `
    + `no tick over 50 ms (max ${cst.msptMax?.toFixed(2)} ms)`, { cs, cst });
  const drift = await verify(cs.siteId);
  log(`  the cell site before its removal: ${drift.mismatches} of ${drift.owned} cells differ from its after ${JSON.stringify(drift.first.slice(0, 5))}`);
  const rc = await removeTimed(cs.siteId);
  check(rc.r.removed && (await hash(CB)).sha256 === h3 && rc.stats.ticksOver50ms === 0, `sizecap: its Remove is exact, no tick over 50 ms (max ${rc.stats.msptMax?.toFixed(2)} ms)`, rc);
  out.cells = { place: cst, remove: rc.stats, cells: ce?.cells };
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ gate 10: mega-lite, bench.json

/** The mega-lite generator over an n x n pad: a CELL terrain pad, stub lots LAYERed on it, roads between the rows and columns. */
function megaSpec(n, id) {
  const cols = Math.max(1, Math.floor(n / 32));
  const rows = Math.max(1, Math.floor(n / 50));
  const want = Math.round(40 * (n / 256) ** 2);
  // the pad in tiles of at most 256x256 (a cell site is at most 1M cells); 256x256 is one tile, P
  const items = [];
  const tile = 256;
  const tiles = Math.ceil(n / tile);
  for (let tx = 0; tx < tiles; tx++) {
    for (let tz = 0; tz < tiles; tz++) {
      const key = tiles === 1 ? 'P' : `P${tx}_${tz}`;
      items.push({ key, cells: { kind: 'gate4e:terrain', pad: { minX: tx * tile, maxX: Math.min(n, (tx + 1) * tile) - 1, minZ: tz * tile,
        maxZ: Math.min(n, (tz + 1) * tile) - 1, y: 66, depth: 3, clear: 6 } } });
    }
  }
  const padKeys = items.map((i) => i.key);
  const roads = [];
  for (let r = 0; r < rows - 1 && roads.length < Math.round(4 * n / 256); r++) {
    const z = 10 + r * 50 + 33;
    roads.push({ key: `RE${r}`, road: { points: [[2, 67, z], [n - 3, 67, z]], width: 3 }, after: padKeys });
  }
  for (let c = 0; c < cols && roads.length < Math.round(8 * n / 256); c += 2) {
    const x = 8 + c * 31 + 20;
    roads.push({ key: `RN${c}`, road: { points: [[x, 67, 2], [x, 67, n - 3]], width: 3 }, after: padKeys });
  }
  items.push(...roads);
  let k = 0;
  for (let r = 0; r < rows && k < want; r++) {
    for (let c = 0; c < cols && k < want; c++) {
      items.push({ key: `L${k++}`, bp: 'cabin', at: [8 + c * 31, 67, 10 + r * 50], rot: 0, mode: 'INSTANT', force: true, after: roads.map((x) => x.key) });
    }
  }
  return { id, overlap: 'LAYER', proximity: false, loadChunks: 64, items };
}
const MEGA_BOX = [-8, 54, -8, 263, 90, 263];

async function megaRun(name, budget, opts = {}) {
  await fresh(name, FLAT);
  await tp(128.5, 160, 128.5);
  await cmd(`/architect budget ${budget}`);
  await call('dev.heap', { reset: true });
  await call('dev.placement.stats', { reset: true });
  const spec = megaSpec(opts.n ?? 256, `mega${budget}`);
  await mark();
  const t0 = Date.now();
  const id = await queue(spec);
  let relog = null;
  let done;
  if (opts.relog) {
    // a clean stop mid-batch (the pad and a few lots placed), then the queue resumes after the restart
    let before = 0;
    for (let i = 0; i < 2400; i++) {
      before = (await api(`batch ${id}`)).items?.filter((x) => x.status === 'PLACED').length ?? 0;
      if (before >= 12) break;
      await sleep(100);
    }
    await stopClient();
    await startClient(name);
    await tp(128.5, 160, 128.5);
    relog = { placedBefore: before };
    for (let i = 0; i < 7200; i++) {
      const b = await api(`batch ${id}`);
      if (b.status === 'DONE' || b.status === 'STOPPED' || b.status === 'CANCELLED') {
        done = b;
        break;
      }
      await sleep(500);
    }
  } else {
    done = await waitBatch(id, 120 * 60_000);
  }
  const wall = (Date.now() - t0) / 1000;
  const stats = await call('dev.placement.stats', {});
  const heap = await call('dev.heap', {});
  const j = await journal();
  const cells = (j.entries ?? []).reduce((a, e) => a + (e.cells ?? 0), 0);
  const failed = done.items.filter((i) => i.status !== 'PLACED').map((i) => `${i.key}:${i.status}:${i.reason}`);
  return { id, done, wall, stats, heap, journalBytes: j.bytesOnDisk, cells, bytesPerCell: j.bytesOnDisk / cells, failed, relog, items: spec.items.length };
}

steps.megalite = async () => {
  if (!dev) await connect();
  await flatBase();
  await fresh('G4E MegaPre', FLAT);
  await tp(128.5, 160, 128.5);
  const h0 = (await hash(MEGA_BOX)).sha256;
  await leaveWorld();
  const runs = {};
  const r4 = await megaRun('G4E Mega4', 4, { relog: true });
  runs[4] = r4;
  check(r4.failed.length === 0, `megalite: the 256x256 pad, ${r4.items - 9} lots LAYERed on it and 8 roads placed through the queue (LOAD_BOUNDED), `
    + `${r4.cells} cells (${r4.failed.join(' ') || 'none failed'})`, r4.done);
  check(!!r4.relog, `megalite: resumed across a relog (${r4.relog?.placedBefore} items placed before it)`);
  const pad = r4.done.items.find((i) => i.key === 'P').site;
  const lot = r4.done.items.find((i) => i.key === 'L7').site;
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E Mega4', 'G4E Mega4b');
  // one lot's undo leaves the pad exact
  await openWorld('G4E Mega4b');
  await tp(128.5, 160, 128.5);
  const pv0 = await verify(pad);
  await call('dev.placement.stats', { reset: true });
  const t1 = Date.now();
  const rl = await result(await api(`remove ${lot} - noforce keep`), 600_000);
  const lotUndo = (Date.now() - t1) / 1000;
  const lst = await call('dev.placement.stats', {});
  await settle(2000);
  const pv1 = await verify(pad);
  check(!(lst.ticksOver50ms > 0), `megalite: one lot's undo has no tick over 50 ms (max ${lst.msptMax?.toFixed(2) ?? '-'} ms)`, lst);
  check(rl.removed && pv1.mismatches === 0 && pv1.owned > pv0.owned, `megalite: one lot's undo leaves the pad exact (the pad owns ${pv0.owned} -> ${pv1.owned} cells, `
    + `${pv1.mismatches} differ from its after; ${lotUndo.toFixed(2)} s)`, { pv0, pv1, rl });
  await leaveWorld();
  // the group undo
  await openWorld('G4E Mega4');
  await tp(128.5, 160, 128.5);
  await call('dev.placement.stats', { reset: true });
  const t2 = Date.now();
  const g = await result(await api(`sgremove ${r4.done.group}`), 60 * 60_000);
  const groupUndo = (Date.now() - t2) / 1000;
  const gst = await call('dev.placement.stats', {});
  const h1 = (await hash(MEGA_BOX)).sha256;
  check(g.removed && h1 === h0, `megalite: the group undo is exact (${g.restored} cells in ${groupUndo.toFixed(1)} s)`, g);
  check(gst.ticksOver50ms === 0, `megalite: the group undo has no tick over 50 ms (max ${gst.msptMax?.toFixed(2)} ms)`, gst);
  await leaveWorld();
  for (const ms of [1, 10]) {
    runs[ms] = await megaRun(`G4E Mega${ms}`, ms);
    check(runs[ms].failed.length === 0 && runs[ms].stats.ticksOver50ms === 0, `megalite ${ms} ms: ${Math.round(runs[ms].stats.cellsPerSecond)} cells/s, `
      + `wall ${runs[ms].wall.toFixed(1)} s, MSPT max ${runs[ms].stats.msptMax?.toFixed(2)} ms`, runs[ms].stats);
    await leaveWorld();
  }
  check(r4.stats.ticksOver50ms === 0, `megalite 4 ms: ${Math.round(r4.stats.cellsPerSecond)} cells/s, wall ${r4.wall.toFixed(1)} s, MSPT max ${r4.stats.msptMax?.toFixed(2)} ms`, r4.stats);
  const rec = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { cellsPerSecond: r.stats.cellsPerSecond, wallSeconds: r.wall, msptMax: r.stats.msptMax,
    msptMean: r.stats.msptMean, ticksOver50ms: r.stats.ticksOver50ms, peakHeapMb: r.heap.peakMb, journalBytes: r.journalBytes, cells: r.cells, bytesPerCell: r.bytesPerCell }]));
  ctx.mega = { runs: rec, lotUndoSeconds: lotUndo, groupUndoSeconds: groupUndo, groupUndoMsptMax: gst.msptMax, relog: r4.relog };
  saveCtx();
  return ctx.mega;
};

/** `megabig`: the same generator at 1000x1000 (recorded for Steward's mega_bench, not gated). */
steps.megabig = async () => {
  if (!dev) await connect();
  await flatBase();
  const r = await megaRun('G4E Mega1000', 4, { n: 1000 });
  ctx.megaBig = { items: r.items, cells: r.cells, wallSeconds: r.wall, cellsPerSecond: r.stats.cellsPerSecond, msptMax: r.stats.msptMax,
    ticksOver50ms: r.stats.ticksOver50ms, peakHeapMb: r.heap.peakMb, journalBytes: r.journalBytes, bytesPerCell: r.bytesPerCell, failed: r.failed };
  saveCtx();
  log(`  1000x1000: ${JSON.stringify(ctx.megaBig)}`);
  await leaveWorld();
  return ctx.megaBig;
};

steps.bench = async () => {
  if (!dev) await connect();
  await flatBase();
  // journal bytes per cell: the 256x256 pad alone
  await fresh('G4E BenchPad', FLAT);
  await tp(128.5, 160, 128.5);
  const pad = await call('dev.cells.place', { kind: 'gate4e:terrain', pad: { minX: 0, maxX: 255, minZ: 0, maxZ: 255, y: 66, depth: 3, clear: 6 } }, 1_200_000);
  await settle(3000);
  const j = await journal();
  const e = (j.entries ?? []).find((x) => x.site === pad.siteId);
  const padBytes = { cells: e?.cells, bytes: j.bytesOnDisk, bytesPerCell: j.bytesOnDisk / e?.cells };
  await leaveWorld();
  // Sites.stack() at depth 4: the fixture with a second extension over H and X
  copyWorld('G4E OrdBase', 'G4E BenchStack');
  await openWorld('G4E BenchStack');
  await tp(48.5, 80, 30.5);
  const x2 = await result(await api('place gatehouse 33 67 -19 INSTANT unowned noactor 0 layer'));
  const st = await call('dev.journal.stackBench', { box: [33, 63, -19, 43, 78, -4], depth: 4, n: 5000 }, 120_000);
  const st3 = await call('dev.journal.stackBench', { box: [20, 63, -24, 59, 78, 15], depth: 1, n: 5000 }, 120_000);
  await leaveWorld();
  const bench = {
    journalBytesPerCell: { pad256: padBytes, megaLite: ctx.mega ? { bytesPerCell: ctx.mega.runs[4]?.bytesPerCell, cells: ctx.mega.runs[4]?.cells,
      bytes: ctx.mega.runs[4]?.journalBytes } : null, mega1000: ctx.megaBig ? { bytesPerCell: ctx.megaBig.bytesPerCell, cells: ctx.megaBig.cells } : null },
    stack: { depth4: st, depth1: st3, placedX2: x2.placed },
    megaLite: ctx.mega ?? null,
    mega1000: ctx.megaBig ?? null,
  };
  check(padBytes.bytesPerCell <= 10, `bench: the 256x256 pad's journal is ${padBytes.bytesPerCell.toFixed(2)} bytes/cell (${padBytes.cells} cells)`, padBytes);
  check(st.cells > 0, `bench: Sites.stack() at depth 4: p50 ${st.p50us?.toFixed(1)} µs, p99 ${st.p99us?.toFixed(1)} µs over ${st.cells} cells`, st);
  fs.writeFileSync(path.join(OUT, 'bench.json'), JSON.stringify(bench, null, 2));
  return bench;
};

// ------------------------------------------------------------------ gate 11: the 1.5.0 API through apitest

const reasonsOf = (v) => (v.refusals ?? []).map((r) => r.reason ?? r);
const j1 = (o) => JSON.stringify(o);

steps.api = async () => {
  if (!dev) await connect();
  await flatBase();
  await fresh('G4E Api', FLAT);
  await tp(48.5, 90, 30.5);
  const v = await api('api15');
  const want = ['journal', 'overlapLayer', 'roads', 'cellSites', 'stackQuery'];
  check(v.version === '1.5.0' && want.every((f) => v.features.includes(f)), `api: version ${v.version}, features ${want.filter((f) => v.features.includes(f)).join(' ')}`, v);
  check(j1(v.overlapPolicies) === j1(['REFUSE', 'LAYER']) && j1(v.coveredPolicies) === j1(['KEEP', 'CASCADE', 'REFUSE']), 'api: OverlapPolicy and CoveredPolicy values', v);
  const reasons = await api('reasons');
  const NEW = ['OVERLAP_BUSY', 'OVERLAP_OWNED', 'LAYER_DEPTH', 'COVERED', 'TOO_STEEP', 'DEEP_WATER', 'TOO_LARGE', 'JOURNAL_UNAVAILABLE'];
  check(j1(reasons.slice(-NEW.length)) === j1(NEW), `api: the 1.5.0 reasons are appended (${reasons.length} in all)`, reasons);
  // placeCells / checkCells
  const padReq = { kind: 'apitest:pad', pad: PAD, tag: 'T', owner: 'apitest:a' };
  const cc = await api(`cellscheck ${j1(padReq)}`);
  check(cc.ok && cc.cells === 19200, `api: checkCells verdict ok, ${cc.cells} cells`, cc);
  const T = await result(await api(`cells ${j1(padReq)}`), 600_000);
  check(T.placed, `api: placeCells -> ${T.siteId}`, T);
  // placeRoad / checkRoad over it (the road's owner is the pad's: it layers)
  const roadReq = { points: [[10, 67, 0], [80, 67, 0]], width: 3, tag: 'R', owner: 'apitest:a' };
  const rc = await api(`roadcheck ${j1(roadReq)}`);
  check(rc.ok && rc.cells > 0 && (rc.overlaps ?? []).some((o) => o.site === T.siteId), `api: checkRoad ok, ${rc.cells} cells, over ${T.siteId}`, rc);
  const R = await result(await api(`road ${j1(roadReq)}`), 300_000);
  check(R.placed, `api: placeRoad -> ${R.siteId}`, R);
  // OVERLAP_OWNED: another owner's road over the pad
  const ro = await api(`roadcheck ${j1({ ...roadReq, points: [[30, 67, -20], [30, 67, 10]], owner: 'apitest:b' })}`);
  check(reasonsOf(ro).includes('OVERLAP_OWNED'), `api: a road over another owner's cells refuses OVERLAP_OWNED (${reasonsOf(ro)})`, ro);
  // a LAYER placement, the stack, the site views
  const H = await result(await api('place cabin 28 67 -19 INSTANT unowned noactor 0 layer'));
  const st = await api('stack 30 67 -10');
  check(H.placed && st.length >= 2 && st.at(-1).site === H.siteId && st.at(-1).top && st[0].site === T.siteId,
    `api: Sites.stack() bottom first: ${st.map((x) => `${x.site}/${x.kind}/${x.policy}/L${x.layer}${x.top ? '/top' : ''}`).join(' ')}`, st);
  const views = await sites();
  const vt = views.find((x) => x.id === T.siteId);
  const vh = views.find((x) => x.id === H.siteId);
  check(vt?.kind?.startsWith('cells:') && vt.policy === 'CELL' && vt.coveredBy.includes(H.siteId) && vh.covers.includes(T.siteId) && vh.policy === 'BOX',
    'api: SiteView kind, policy, covers, coveredBy', { vt, vh });
  // COVERED: removing the pad under H with REFUSE
  const rr = await result(await api(`remove ${T.siteId} - noforce refuse`), 120_000);
  check(!rr.removed && rr.blockers.some((b) => /COVERED/.test(b)), `api: CoveredPolicy.REFUSE refuses a covered site (${rr.blockers})`, rr);
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E Api', 'G4E Api2');
  await openWorld('G4E Api');
  const rk = await result(await api(`remove ${T.siteId} - noforce keep`), 300_000);
  check(rk.removed && Object.keys(rk.handedDown).length > 0 && rk.restored > 0, `api: KEEP removes the pad, hands cells down (${j1(rk.handedDown)}), restored ${rk.restored}`, rk);
  await leaveWorld();
  await openWorld('G4E Api2');
  const rcas = await result(await api(`remove ${T.siteId} - noforce cascade`), 300_000);
  check(rcas.removed && rcas.cascaded.includes(H.siteId) && rcas.cascaded.includes(R.siteId), `api: CASCADE removes the covering sites first (${rcas.cascaded})`, rcas);
  // LAYER_DEPTH: nine cell sites on one cell
  const one = (i) => ({ kind: `apitest:d${i}`, cells: [[100, 70, 100, i % 2 ? 'minecraft:stone' : 'minecraft:dirt']], overlap: 'LAYER' });
  let depthRefusal = null;
  for (let i = 0; i < 9; i++) {
    const r = await result(await api(`cells ${j1({ ...one(i), tag: `d${i}` })}`), 60_000);
    if (!r.placed) {
      depthRefusal = { i, reasons: reasonsOf(r) };
      break;
    }
  }
  check(depthRefusal?.i === 8 && depthRefusal.reasons.includes('LAYER_DEPTH'), `api: the 9th layer on a cell refuses LAYER_DEPTH (${j1(depthRefusal)})`);
  // TOO_STEEP and DEEP_WATER
  await cmd('/fill 120 65 -10 130 75 10 minecraft:stone');
  const steep = await api(`roadcheck ${j1({ points: [[110, 66, 0], [140, 66, 0]], width: 3 })}`);
  check(reasonsOf(steep).includes('TOO_STEEP'), `api: a road over a 11-block cliff refuses TOO_STEEP (${reasonsOf(steep)})`, steep);
  await cmd('/fill 150 58 -10 160 64 10 minecraft:water');
  const wet = await api(`roadcheck ${j1({ points: [[145, 65, 0], [165, 65, 0]], width: 3 })}`);
  check(reasonsOf(wet).includes('DEEP_WATER'), `api: a road across 7-deep water refuses DEEP_WATER (${reasonsOf(wet)})`, wet);
  // TOO_LARGE
  const big = await api(`cellscheck ${j1({ kind: 'apitest:big', fill: { min: [200, 0, 200], max: [300, 99, 299], id: 'minecraft:stone' } })}`);
  check(reasonsOf(big).includes('TOO_LARGE'), `api: a cell site over 1M cells refuses TOO_LARGE (${reasonsOf(big)})`, big);
  // OVERLAP_BUSY: a check over a site still being placed
  await cmd('/architect budget 1');
  await mark();
  const bq = await queue({ id: 'busy', proximity: false, items: [{ key: 'b', bp: 'tavern', at: [60, 65, 40], rot: 0, mode: 'INSTANT', force: true }] });
  await sleep(1500);
  const busy = await api(`cellscheck ${j1({ kind: 'apitest:busy', fill: { min: [62, 66, 42], max: [64, 66, 44], id: 'minecraft:stone' }, overlap: 'LAYER' })}`);
  check(reasonsOf(busy).includes('OVERLAP_BUSY'), `api: layering over a site still being placed refuses OVERLAP_BUSY (${reasonsOf(busy)})`, busy);
  await waitBatch(bq, 300_000);
  await cmd('/architect budget 4');
  // undoStage(RemoveOptions)
  await mark();
  const sg = await queue({ id: 'st2', autoApprove: true, items: [{ key: 'a', bp: 'cabin', at: [0, 65, 60], rot: 0, mode: 'INSTANT', force: true, stage: 's1' },
    { key: 'b', bp: 'cabin', at: [20, 65, 60], rot: 0, mode: 'INSTANT', force: true, stage: 's2' }], stages: [{ name: 's1', items: ['a'] }, { name: 's2', items: ['b'] }] });
  const sgd = await waitBatch(sg, 300_000);
  const u2 = await result(await api(`sundo2 ${sgd.group} s2 keep`), 300_000);
  check(u2.removed, `api: undoStage(group, stage, RemoveOptions) (${u2.restored} cells)`, u2);
  await cmd('/save-all flush');
  await leaveWorld();
  // JOURNAL_UNAVAILABLE: an unreadable index refuses every change and is not touched
  copyWorld('G4E Api', 'G4E ApiBad');
  const ix = path.join(SAVES, 'G4E ApiBad', 'architect-journal', 'journal.json');
  fs.writeFileSync(ix, '{"version":1,"entries":[');
  await openWorld('G4E ApiBad');
  const un = await api(`cellscheck ${j1({ kind: 'apitest:x', fill: { min: [0, 66, 200], max: [2, 66, 202], id: 'minecraft:stone' } })}`);
  const pl = await result(await api('place cabin 0 65 200 INSTANT unowned noactor 0'));
  check(reasonsOf(un).includes('JOURNAL_UNAVAILABLE') && reasonsOf(pl).includes('JOURNAL_UNAVAILABLE'), `api: an unreadable journal refuses with JOURNAL_UNAVAILABLE (${reasonsOf(un)}; ${reasonsOf(pl)})`, { un, pl });
  await leaveWorld();
  check(fs.readFileSync(ix, 'utf8') === '{"version":1,"entries":[', 'api: the unreadable index was not touched');
  return {};
};

/** `api14`: the 1.4.0 apitest jar (0.7.0), unchanged, against 0.8.0 - tools/apitest.mjs survival of v0.7.0. */
steps.api14 = async () => {
  const jar = path.join(V070, 'apitest', 'build', 'libs', 'architect_apitest-0.7.0.jar');
  const mods = path.join(GAME_DIR, 'mods');
  if (dev) await stopClient();
  else if (clientPids().length) {
    await connect(PORT, GAME_DIR, 10_000).catch(() => null);
    await stopClient();
  }
  fs.mkdirSync(mods, { recursive: true });
  fs.copyFileSync(jar, path.join(mods, 'architect_apitest-0.7.0.jar'));
  const outDir = path.join(OUT, 'api14');
  let code = 0;
  let text = '';
  try {
    await startClient('G4E Api14', { ARCHITECT_APITEST: '0' });
    try {
      text = execFileSync('node', [path.join(V070, 'tools', 'apitest.mjs'), 'survival'], {
        env: { ...process.env, ARCHITECT_DEV_PORT: String(PORT), APITEST_OUT: outDir, APITEST_GAME_DIR: GAME_DIR }, timeout: 3_600_000 }).toString();
    } catch (e) {
      code = e.status ?? 1;
      text = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
  } finally {
    await stopClient();
    fs.rmSync(path.join(mods, 'architect_apitest-0.7.0.jar'), { force: true });
  }
  fs.writeFileSync(path.join(OUT, 'api14.log'), text);
  const fails = text.split('\n').filter((l) => l.startsWith('FAIL'));
  check(code === 0 && fails.length === 0, `api14: the 1.4.0 apitest jar (unchanged) passes tools/apitest.mjs survival (v0.7.0) against 0.8.0 (${fails.length} FAIL)`, fails);
  await startClient('G4E Smoke');
  return { code, fails };
};

// ------------------------------------------------------------------ gate 9 additions: adjacent lots with the toggle, held leaves

/** Cells that differ between two lists, split into persistent-leaf-only diffs and others. */
function leafSplit(a, b) {
  const ma = cellMap(a);
  const mb = cellMap(b);
  const leaf = [];
  const other = [];
  for (const [k, v] of ma) {
    const w = mb.get(k);
    if (v === w) continue;
    const norm = (x) => (x ?? '').replace(/persistent:"(true|false)"/, '').replace(/distance:"\d"/, '');
    if (/_leaves"/.test(v) && /_leaves"/.test(w ?? '') && norm(v) === norm(w)) leaf.push([k, v, w]);
    else other.push([k, v, w]);
  }
  return { leaf, other };
}

steps.leaves = async () => {
  if (!dev) await connect();
  const NW = 'G4E Normal';
  if (!fs.existsSync(path.join(SAVES, NW, 'level.dat'))) {
    await openWorld(NW, { mode: 'creative', preset: 'normal', seed: '4e', cheats: true });
    await setRules();
    await cmd('/save-all flush');
    await leaveWorld();
  }
  await fresh('G4E Leaves', NW);
  await setRules();
  const cols = await surveyAround(160, 4);
  // a tree with dry ground west and east of it
  const trees = [...cols.values()].filter((c) => c.tree);
  let t = null;
  for (const c of trees) {
    const ok = [-16, -12, -8, 8, 12, 16].every((dx) => { const g = cols.get(`${c.x + dx},${c.z}`); return g && !g.water; });
    if (ok) {
      t = c;
      break;
    }
  }
  check(!!t, `leaves: a worldgen tree at ${t?.x},${t?.z}`);
  await tp(t.x + 0.5, t.h + 30, t.z + 20.5);
  const yA = await groundAt(t.x - 8, t.z);
  const yB = await groundAt(t.x + 6, t.z);
  const A = { bp: 'cabin', at: [t.x - 13, yA + 1, t.z - 6] };
  const B = { bp: 'cabin', at: [t.x + 2, yB + 1, t.z - 6] };
  const R = [t.x - 24, Math.min(yA, yB) - 12, t.z - 20, t.x + 24, Math.max(yA, yB) + 30, t.z + 30];
  const pre = await cellsOf(R);
  await cmd('/save-all flush');
  await leaveWorld();
  // held leaves, both orders
  const res = {};
  for (const [w, order] of [['G4E LeavesAB', ['A', 'B']], ['G4E LeavesBA', ['B', 'A']]]) {
    copyWorld('G4E Leaves', w);
    await openWorld(w);
    await tp(t.x + 0.5, t.h + 40, t.z + 40.5);
    const pa = await result(await api(`place ${A.bp} ${A.at.join(' ')} INSTANT unowned noactor 0 force`));
    const ja = await journal();
    const held = (ja.entries ?? []).filter((e) => e.site === pa.siteId && e.kind === 'leaves');
    const pb = await result(await api(`place ${B.bp} ${B.at.join(' ')} INSTANT unowned noactor 0 force`));
    check(pa.placed && pb.placed, `leaves [${order.join('')}]: A (${pa.siteId}, ${held.reduce((n, e) => n + e.cells, 0)} held leaves) and B (${pb.siteId}) placed`, { pa, pb, held });
    const ids = { A: pa.siteId, B: pb.siteId };
    for (const k of order) {
      const r = await result(await api(`remove ${ids[k]} - noforce keep`), 300_000);
      check(r.removed, `leaves [${order.join('')}]: remove ${k}`, r);
    }
    await settle(3000);
    const post = await cellsOf(R);
    const d = leafSplit(pre, post);
    check(d.other.length === 0 && d.leaf.length === 0, `leaves [${order.join(' then ')}]: the region is back (${d.leaf.length} leaf-only diffs, ${d.other.length} others)`,
      { leaf: d.leaf.slice(0, 10), other: d.other.slice(0, 10) });
    res[order.join('')] = { leaf: d.leaf.length, other: d.other.length };
    await leaveWorld();
  }
  // the toggle step on adjacent (0-gap) lots by the tree: only persistent-leaf diffs allowed in the failed lot's region
  copyWorld('G4E Leaves', 'G4E LeavesT');
  await openWorld('G4E LeavesT');
  await tp(t.x + 0.5, t.h + 40, t.z + 40.5);
  const A2 = { ...A };
  const fa = await result(await api(`check ${A.bp} ${A.at.join(' ')} INSTANT unowned noactor 0 force`)).catch(() => null);
  const aBox = fa?.restoreBox ? box6(fa.restoreBox) : [A.at[0], 0, A.at[2], A.at[0] + 10, 0, A.at[2] + 15];
  const B2 = { bp: 'cabin', at: [aBox[3] + 1, yB + 1, A.at[2]] };
  const preT = await cellsOf(R);
  await call('dev.placement.slow', { on: true });
  await mark();
  const id = await queue({ id: 'tog', proximity: false, items: [{ key: 'A', ...A2, rot: 0, mode: 'INSTANT', force: true }, { key: 'B', ...B2, rot: 0, mode: 'INSTANT', force: true }] });
  for (let i = 0; i < 300; i++) {
    const j = await call('dev.placement.jobs');
    if ((j.jobs ?? []).some((x) => x.batch === id && x.progress > 0)) break;
    await sleep(100);
  }
  await call('dev.survival.set', { on: true });
  await call('dev.placement.slow', { on: false });
  const done = await waitBatch(id, 300_000);
  const st = done.items.map((i) => `${i.key}:${i.status}${i.reason ? ':' + i.reason : ''}`);
  await call('dev.survival.set', { on: false });
  const aSite = done.items[0].site;
  const ab = box6((await sites()).find((x) => x.id === aSite).restoreBox);
  const inA = (k) => { const [x, y, z] = k.split(',').map(Number); return x >= ab[0] && x <= ab[3] && y >= ab[1] && y <= ab[4] && z >= ab[2] && z <= ab[5]; };
  const dS = leafSplit(preT, await cellsOf(R));
  const outside = dS.other.filter(([k]) => !inA(k));
  check(outside.length === 0, `leaves: with A standing, B's side (everything outside A's box) has only persistent-leaf diffs (${dS.leaf.length} leaf, ${outside.length} other)`,
    { leaf: dS.leaf.slice(0, 10), other: outside.slice(0, 10) });
  const ra = await result(await api(`remove ${aSite} - noforce keep`), 300_000);
  await settle(3000);
  const postT = await cellsOf(R);
  const dT = leafSplit(preT, postT);
  check(done.items[0].status === 'PLACED' && done.items[1].reason === 'NOT_ALLOWED' && ra.removed && dT.other.length === 0,
    `leaves: the toggle on adjacent 0-gap lots (${st.join(' ')}): after A's removal only persistent-leaf diffs remain (${dT.leaf.length} leaf, ${dT.other.length} other)`,
    { st, leaf: dT.leaf.slice(0, 10), other: dT.other.slice(0, 10) });
  await leaveWorld();
  return { tree: t, res, toggle: { st, leaf: dT.leaf.length, other: dT.other.length } };
};

// ------------------------------------------------------------------ gate 6: the client ghost of a lot facing a road

async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator' }, 30_000);
  await sleep(1500);
  const r = await call('dev.screenshot', { name }, 120_000);
  await call('dev.release', {}).catch(() => {});
  return r.path;
}

steps.ghost = async () => {
  if (!dev) await connect();
  if (!ctx.village) throw new Error('run `roads` first');
  const f = ctx.village.fits[1];
  const out = {};
  for (const withRoad of [false, true]) {
    await fresh(withRoad ? 'G4E GhostR' : 'G4E Ghost', 'G4E VBase');
    if (withRoad) {
      const r = await call('dev.road.place', vRoads()[0].road, 180_000);
      check(r.placed, `ghost: road R0 placed (${r.siteId})`);
    }
    await tp(f.lot[0] + 10.5, 80, f.lot[2] - 14.5);
    await settle(2000);
    await call('dev.build.start', { blueprint: f.bp, origin: f.at, turns: f.rot }, 30_000);
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = await call('dev.build.state');
      if (st.ready || st.serverVerdict) break;
      await sleep(250);
    }
    await sleep(1500);
    const cx = f.lot[0] + 11;
    const p = await shot(withRoad ? 'g4e-ghost-road' : 'g4e-ghost-noroad', [cx + 0.5, 92, f.lot[2] - 14.5], [cx, 64, f.lot[2] + 2]);
    out[withRoad ? 'road' : 'noRoad'] = { shot: p, approach: st?.conflicts?.approach ?? st?.approach ?? null, box: st?.box };
    await call('dev.build.cancel', {}).catch(() => {});
    await leaveWorld();
  }
  log(`  ghost: ${JSON.stringify(out)}`);
  check(!!out.road.shot && !!out.noRoad.shot, `ghost: screenshots ${path.basename(out.noRoad.shot)} (no road) and ${path.basename(out.road.shot)} (road) taken: look at them`, out);
  return out;
};

// ------------------------------------------------------------------ gate 5: crash mid-write (K1-K8)

/** Every file the on-disk index names exists; the files it does not name (orphans). Read straight from the world folder. */
function journalFiles(world) {
  const dir = path.join(SAVES, world, 'architect-journal');
  const ix = path.join(dir, 'journal.json');
  const idx = fs.existsSync(ix) ? JSON.parse(fs.readFileSync(ix, 'utf8')) : { entries: [], none: true };
  const named = new Set();
  const missing = [];
  for (const e of idx.entries ?? []) {
    for (const [k, gen] of Object.entries(e.files ?? {})) {
      const f = k === 'head' ? `head.${gen}.nbt` : `${k.replace(',', '.')}.${gen}.nbt`;
      const rel = path.join('e', e.id, f);
      named.add(rel);
      if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
    }
  }
  const orphans = [];
  const edir = path.join(dir, 'e');
  for (const id of fs.existsSync(edir) ? fs.readdirSync(edir) : []) {
    for (const f of fs.readdirSync(path.join(edir, id))) {
      const rel = path.join('e', id, f);
      if (!named.has(rel)) orphans.push(rel);
    }
  }
  return { index: !idx.none, entries: (idx.entries ?? []).map((e) => `${e.id}:${e.site}:${e.status}`), missing, orphans };
}

/** Removes every site and road standing (top of the stacks first), then hashes the fixture box. */
async function removeAll() {
  const out = [];
  for (let round = 0; round < 10; round++) {
    const all = await sites();
    if (!all.length) break;
    const tops = all.filter((x) => !(x.coveredBy ?? []).length);
    for (const t of tops.length ? tops : all) {
      const r = await result(await api(`remove ${t.id} - force keep`), 300_000);
      out.push({ id: t.id, removed: r.removed, blockers: r.blockers });
    }
  }
  await settle(2000);
  return { removed: out, left: (await sites()).map((x) => x.id), h: (await hash(FIX_BOX)).sha256 };
}

/** Runs {@code action} with kill point {@code point} armed in a fresh copy of {@code base}; restarts the client into that world. */
async function killRun(point, base, action, pre) {
  await leaveWorld();
  copyWorld(base, 'G4E Crash');
  await openWorld('G4E Crash');
  await tp(48.5, 80, 30.5);
  const standing = (await sites()).map((x) => x.id);
  const before = { sites: standing, journal: journalFiles('G4E Crash'), owned: standing.length ? await ownedNow(standing) : {} };
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
    return null;
  }
  await sleep(2000);
  const disk = journalFiles('G4E Crash');
  check(disk.missing.length === 0, `crash ${point}: no file the index names is lost (orphans on disk: ${disk.orphans.length})`, disk);
  await startClient('G4E Crash');
  await tp(48.5, 80, 30.5);
  await settle(5000);
  const j = await journal();
  check(j.open && !j.unavailable, `crash ${point}: the journal opens`, { open: j.open, unavailable: j.unavailable });
  const after = journalFiles('G4E Crash');
  return { before, disk, j, after, pre };
}

async function finalExact(point, pre) {
  const f = await removeAll();
  check(f.left.length === 0 && f.h === pre, `crash ${point}: a final full removal matches the pre-hash`, f);
}

steps.crash = async () => {
  if (!dev) await connect();
  if (!ctx.orders) throw new Error('run `orders` first (its base world and pre-hash)');
  const pre = ctx.orders.h0;
  const ids = ctx.orders.ids;
  const out = {};
  const placeAtomic = () => api('place cabin 28 65 -40 INSTANT unowned noactor 0');
  // K1: inside the P3 commit (files written, index not) - nothing changed, the files are orphans
  let r = await killRun('K1', FLAT, placeAtomic, pre);
  if (r) {
    const all = await sites();
    check(all.length === 0 && (r.j.entries ?? []).length === 0, `crash K1: no site and no entry (orphans after the start: ${r.after.orphans.length})`, { all, r });
    check((await hash(FIX_BOX)).sha256 === pre, 'crash K1: the world is unchanged');
    await finalExact('K1', pre);
    out.K1 = r;
  }
  // K2: after P3, before the record - the PLACING entry is released at the start and nothing is written
  r = await killRun('K2', FLAT, placeAtomic, pre);
  if (r) {
    const all = await sites();
    check(all.length === 0 && (r.j.entries ?? []).length === 0, 'crash K2: the PLACING entry is released, no record', { all, entries: r.j.entries });
    check((await hash(FIX_BOX)).sha256 === pre, 'crash K2: nothing was written');
    await finalExact('K2', pre);
    out.K2 = r;
  }
  // K3: during the ticked block writes (unclean) - rolled back by the undo of the PLACING entry
  r = await killRun('K3', FLAT, async () => {
    await cmd('/architect budget 1');
    return queue({ id: 'k3', items: [{ key: 'a', bp: 'cabin', at: [28, 65, -40], rot: 0, mode: 'INSTANT' }] });
  }, pre);
  if (r) {
    await settle(8000);
    const all = await sites();
    const j = await journal();
    check(all.length === 0 && (j.entries ?? []).every((e) => e.status === 'UNDONE'), 'crash K3: the unclean stop rolled the placement back (no site, its entry undone)',
      { all, entries: j.entries });
    check((await hash(FIX_BOX)).sha256 === pre, 'crash K3: the rollback wrote the before exactly');
    await finalExact('K3', pre);
    await cmd('/architect budget 4');
    out.K3 = r;
  }
  // K4: after the ACTIVE commit, before the record is placed - the journal wins
  r = await killRun('K4', FLAT, placeAtomic, pre);
  if (r) {
    const all = await sites();
    const j = await journal();
    check(all.length === 1 && all[0].state === 'BUILT' && (j.entries ?? []).some((e) => e.status === 'ACTIVE' && e.site === all[0].id),
      `crash K4: the record is placed (${JSON.stringify(all.map((x) => [x.id, x.state]))})`, { all, entries: j.entries });
    await finalExact('K4', pre);
    out.K4 = r;
  }
  // K5: before the R2 commit - nothing changed
  r = await killRun('K5', 'G4E OrdBase', () => api(`remove ${ids.H} - noforce keep`), pre);
  if (r) {
    const all = (await sites()).map((x) => x.id).sort();
    check(JSON.stringify(all) === JSON.stringify(Object.values(ids).sort()), `crash K5: all four sites stand (${all})`, { all });
    const lk = await ownedNow(Object.values(ids));
    const bad = Object.keys(lk).filter((k) => lk[k].owned !== r.before.owned[k].owned || [...lk[k].cells].some(([p, v]) => r.before.owned[k].cells.get(p) !== v));
    check(bad.length === 0, 'crash K5: every site\'s owned cells are as before the kill', bad);
    await finalExact('K5', pre);
    out.K5 = r;
  }
  // K6: after R2, before the records go pending - the evidence finds H standing: reactivated, the record back
  r = await killRun('K6', 'G4E OrdBase', () => api(`remove ${ids.H} - noforce keep`), pre);
  if (r) {
    const all = (await sites()).map((x) => x.id).sort();
    const j = await journal();
    const hEntries = (j.entries ?? []).filter((e) => e.site === ids.H);
    check(all.includes(ids.H) && hEntries.every((e) => e.status === 'ACTIVE'), `crash K6: H is back (record and ACTIVE entries: ${hEntries.map((e) => e.status)})`,
      { all, hEntries });
    await finalExact('K6', pre);
    out.K6 = r;
  }
  // K7: during the ticked restore of a group removal - re-run at the start, settled at the next
  r = await killRun('K7', 'G4E OrdBase', async () => {
    await cmd('/architect budget 1');
    return api(`sgremove ${ctx.orders.group}`);
  }, pre);
  if (r) {
    for (let i = 0; i < 120 && (await sites()).length; i++) await sleep(1000);
    const all = await sites();
    const h = (await hash(FIX_BOX)).sha256;
    check(all.length === 0 && h === pre, `crash K7: the restore re-ran at the start: no site, the box exact (${all.length} left)`, { all });
    // settled at the next start
    await stopClient();
    await startClient('G4E Crash');
    const j = await journal();
    check((j.entries ?? []).length === 0, `crash K7: the next start settles the group (${(j.entries ?? []).length} entries left)`, j.entries);
    check((await hash(FIX_BOX)).sha256 === pre, 'crash K7: still exact after settling');
    await cmd('/architect budget 4');
    out.K7 = r;
  }
  // K8: inside the R2 commit that hands H's cells down to X - nothing changed (the index was not written)
  r = await killRun('K8', 'G4E OrdBase', () => api(`remove ${ids.H} - noforce keep`), pre);
  if (r) {
    const all = (await sites()).map((x) => x.id).sort();
    const j = await journal();
    check(JSON.stringify(all) === JSON.stringify(Object.values(ids).sort()) && (j.entries ?? []).every((e) => e.status === 'ACTIVE'),
      `crash K8: the hand-down did not half apply: all four stand, all entries ACTIVE`, { all, entries: j.entries });
    check(r.after.orphans.length === 0, `crash K8: the half-written generations were deleted at the start (${r.disk.orphans.length} before, ${r.after.orphans.length} after)`,
      { before: r.disk.orphans, after: r.after.orphans });
    await finalExact('K8', pre);
    out.K8 = r;
  }
  // K3, clean: a clean stop mid-placement resumes from the cursor
  await leaveWorld();
  copyWorld(FLAT, 'G4E Crash');
  await openWorld('G4E Crash');
  await tp(48.5, 80, 30.5);
  await cmd('/architect budget 1');
  await mark();
  const bid = await queue({ id: 'k3c', items: [{ key: 'a', bp: 'cabin', at: [28, 65, -40], rot: 0, mode: 'INSTANT' }] });
  await sleep(300);
  await stopClient();
  await startClient('G4E Crash');
  await mark();
  await cmd('/architect budget 4');
  for (let i = 0; i < 120 && !(await sites()).some((x) => x.state === 'BUILT'); i++) await sleep(1000);
  const all = await sites();
  check(all.length === 1 && all[0].state === 'BUILT', `crash K3 clean: the placement resumed after a clean stop (${JSON.stringify(all.map((x) => [x.id, x.state]))})`,
    { bid, all });
  await finalExact('K3-clean', pre);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ gate 4: migration from a 0.7.0 world, the downgrade round trip

/** dev.box.hash (both versions have it): the migration's hashes are comparable across 0.7.0 and 0.8.0. */
async function bhash(b, cells = false) {
  await settle(2000);
  return call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells }, 300_000);
}
/** The migration lots on the flat meadow (origin y 65): a lot's hash region holds its restore box + 7. */
const MIG = {
  A1: { bp: 'cabin', at: [0, 65, -120] },
  A2: { bp: 'tower', at: [45, 65, -120] },
  A3: { bp: 'gatehouse', at: [90, 65, -120] },
  C: { bp: 'cabin', at: [135, 65, -120] },
  D: { bp: 'cabin', at: [180, 65, -120] },
  G1: { bp: 'tavern', at: [0, 65, -190] },
  G2: { bp: 'cabin', at: [45, 65, -190] },
  P: { bp: 'tavern', at: [90, 65, -190] },
  T: { bp: 'cabin', at: [135, 65, -190] },
  N: { bp: 'cabin', at: [180, 65, -190] }, // the downgrade's 0.7.0 site
};
const TREE = [148, 65, -183]; // an oak by the worldgen feature, its canopy over T's east wall
const ROAD_D = { points: [[-20, 65, -150], [220, 65, -150]], width: 3 }; // the downgrade's road, between the rows
const ROAD_BOX = [-28, 55, -158, 228, 80, -142];
const migRegion = (k) => [MIG[k].at[0] - 10, 56, MIG[k].at[2] - 10, MIG[k].at[0] + 30, 100, MIG[k].at[2] + 40];

/** Fills a construction site's crate with up to {@code maxStacks} stacks of what it still misses (or of its bill). */
async function feed(site, fraction = 1, maxStacks = 27) {
  const st = await siteState(site);
  const c = st.crate;
  const rows = (st.rows ?? []).filter((r) => (r.missing ?? 0) > 0 || (r.needed ?? 0) > (r.placed ?? 0) + (r.stock ?? 0));
  const stacks = [];
  for (const r of rows) {
    let left = Math.ceil(Math.max(r.missing ?? 0, (r.needed ?? 0) - (r.placed ?? 0) - (r.stock ?? 0)) * fraction);
    const max = /bed$|banner$/.test(r.item) ? 1 : /_door$|sign$|ender_pearl|snowball|egg$/.test(r.item) ? 16 : 64;
    while (left > 0 && stacks.length < maxStacks) {
      const n = Math.min(max, left);
      stacks.push([r.item, n]);
      left -= n;
    }
  }
  for (let i = 0; i < stacks.length; i++) await cmd(`/item replace block ${c.x} ${c.y} ${c.z} container.${i} with ${stacks[i][0]} ${stacks[i][1]}`);
  return { stacks: stacks.length, percent: st.percent, crate: c };
}

/** Makes the 0.7.0 world (gate 4's fixture) with the 0.7.0 client; records the pre-placement hashes. */
async function mig070() {
  await stopClient();
  use('old');
  await startClient('G4E Title070').catch(async (e) => {
    throw e;
  });
  await leaveWorld();
  fs.rmSync(path.join(SAVES, 'G4E MigPre070'), { recursive: true, force: true });
  await openWorld('G4E MigPre070', { mode: 'creative', preset: 'flat', cheats: true });
  await setRules();
  await tp(TREE[0] - 6.5, 70, TREE[2] + 10.5);
  const tree = await cmd(`/place feature minecraft:oak ${TREE.join(' ')}`);
  await settle(2000);
  const pre = {};
  for (const k of Object.keys(MIG)) {
    await tp(MIG[k].at[0] + 10.5, 80, MIG[k].at[2] + 30.5);
    pre[k] = (await bhash(migRegion(k))).sha256;
  }
  await tp(100.5, 80, -150.5);
  const preRoad = (await bhash(ROAD_BOX)).sha256;
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G4E MigPre070', 'G4E Mig070');
  await openWorld('G4E Mig070');
  await tp(90.5, 90, -150.5);
  const ids = {};
  for (const k of ['A1', 'A2', 'A3', 'T', 'D']) {
    await tp(MIG[k].at[0] + 5.5, 85, MIG[k].at[2] + 30.5);
    const r = await result(await api(`place ${MIG[k].bp} ${MIG[k].at.join(' ')} INSTANT unowned noactor 0 force`));
    check(r.placed, `mig 0.7.0: ${k} (${MIG[k].bp}) placed instant (${r.siteId})`, r);
    ids[k] = r.siteId;
  }
  const tSite = await siteState(ids.T);
  log(`  T held leaves: ${JSON.stringify(tSite.heldLeaves ?? tSite.held ?? tSite.leaves ?? null)}`);
  // D: removed, not yet settled (its record stays pending until the next world start)
  const rd = await result(await api(`remove ${ids.D} - noforce`), 120_000);
  check(rd.removed, 'mig 0.7.0: D removed (pending until the next start)', rd);
  // G: a group with two stages
  await mark();
  const gid = await queue({ id: 'mig-g', autoApprove: true, items: [{ key: 'G1', bp: MIG.G1.bp, at: MIG.G1.at, rot: 0, mode: 'INSTANT', force: true, stage: 's1' },
    { key: 'G2', bp: MIG.G2.bp, at: MIG.G2.at, rot: 0, mode: 'INSTANT', force: true, stage: 's2' }], stages: [{ name: 's1', items: ['G1'] }, { name: 's2', items: ['G2'] }] });
  const gdone = await waitBatch(gid, 300_000);
  for (const e of (await since()).filter((x) => x.event === 'ITEM_PLACED' && x.batch === gid)) ids[e.key] = e.site;
  check(!!ids.G1 && !!ids.G2, `mig 0.7.0: group ${gdone.group} with stages s1, s2 placed (${ids.G1}, ${ids.G2})`, gdone);
  // C: a construction site, half built (toggle on, half its bill in the crate)
  await call('dev.survival.set', { on: true });
  await mark();
  const cid = await queue({ id: 'mig-c', proximity: false, items: [{ key: 'C', bp: MIG.C.bp, at: MIG.C.at, rot: 0, mode: 'CONSTRUCTION', force: true }] });
  const cev = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.batch === cid, 120_000, 'C construction site');
  ids.C = cev.site;
  await tp(MIG.C.at[0] + 5.5, 85, MIG.C.at[2] + 30.5);
  const f1 = await feed(ids.C, 0.5);
  let pc = 0;
  for (let i = 0, still = 0; i < 150; i++) {
    await sleep(2000);
    const st = await siteState(ids.C);
    still = st.percent === pc ? still + 1 : 0;
    pc = st.percent;
    if (pc > 0 && still >= 3) break; // it built what the half bill allows
  }
  check(pc > 0 && pc < 100, `mig 0.7.0: C half built (${pc}%, ${f1.stacks} stacks fed)`, { pc, f1 });
  // P: a tavern placing over ticks at 1 ms (a creative actor), then a clean stop mid-placement
  await cmd('/architect budget 1');
  await tp(MIG.P.at[0] + 5.5, 85, MIG.P.at[2] + 30.5);
  await call('dev.placement.slow', { on: true }); // P is caught mid-placement for sure
  await mark();
  const pid = await queue({ id: 'mig-p', items: [{ key: 'P', bp: MIG.P.bp, at: MIG.P.at, rot: 0, mode: 'INSTANT', force: true, actor: true }] });
  for (let i = 0; i < 40; i++) {
    const b = await api(`batch ${pid}`);
    const it = (b.items ?? [])[0];
    if (it?.site) {
      ids.P = it.site;
      break;
    }
    await sleep(250);
  }
  await sleep(1200);
  const placing = (await sites()).filter((x) => x.state === 'PLACING').map((x) => x.id);
  check(!!ids.P && placing.includes(ids.P), `mig 0.7.0: P placing at the stop (${ids.P}, placing: ${placing})`, { placing });
  const before = await sites();
  await stopClient(); // a clean stop: the world and the queue are saved mid-placement
  use('new');
  ctx.mig = { pre, preRoad, ids, group: gdone.group, sites070: before.map((x) => ({ id: x.id, state: x.state, bp: x.blueprint ?? x.bp })), tree };
  saveCtx();
  return ctx.mig;
}

/** Opens a 0.8.0 copy of the 0.7.0 world (optionally with a migration kill point armed) and checks the import. */
async function migOpen(name, kill = null) {
  copyWorld('G4E Mig070', name, SAVES, savesOf('old'));
  if (!clientPids().length) await startClient('G4E Smoke');
  await leaveWorld();
  if (kill) {
    await call('dev.journal.killAt', { point: kill });
    call('dev.world.open', { name }, 30_000).catch(() => {});
    const died = await waitDead(300_000);
    check(died, `mig ${kill}: the JVM halted at the kill point`);
    const disk = journalFiles(name);
    check(disk.missing.length === 0, `mig ${kill}: no file the index names is lost`, disk);
    await startClient(name);
  } else {
    await openWorld(name);
  }
  const dir = path.join(SAVES, name);
  const j = await journal();
  const legacy = path.join(dir, 'architect-journal', 'legacy', 'architect-sites');
  const legacyFiles = fs.existsSync(legacy) ? fs.readdirSync(legacy) : [];
  const oldDir = fs.existsSync(path.join(dir, 'architect-sites')) ? fs.readdirSync(path.join(dir, 'architect-sites')) : [];
  const label = kill ? `mig ${kill}` : 'mig';
  check(j.open && !j.unavailable && fs.existsSync(path.join(dir, 'architect-journal', 'journal.json')), `${label}: the index is made (${(j.entries ?? []).length} entries, `
    + `${j.imported ?? '?'} imported)`, { entries: j.entries, notes: j.importNotes, flagged: j.importFlagged });
  check(legacyFiles.length > 0 && oldDir.length === 0, `${label}: legacy/ holds the 0.7.0 snapshots (${legacyFiles.length} files), architect-sites/ is empty`,
    { legacyFiles: legacyFiles.length, oldDir });
  return j;
}

/** Removes the lots' sites one by one; each lot region must match its 0.7.0 pre-hash. */
async function migRemoves(keys, label) {
  const m = ctx.mig;
  let ok = 0;
  for (const k of keys) {
    await tp(MIG[k].at[0] + 10.5, 85, MIG[k].at[2] + 30.5);
    const r = await result(await api(`remove ${m.ids[k]} - force keep`), 600_000);
    await settle(2000);
    const h = (await bhash(migRegion(k))).sha256;
    if (check(r.removed && h === m.pre[k], `${label}: Remove ${k} (${m.ids[k]}) matches its 0.7.0 pre-hash`, { r, h, pre: m.pre[k] })) ok++;
    else results[`${label} ${k} diff`] = { ok: false, data: await migDiff(k) };
  }
  return ok;
}
async function migDiff(k) {
  const now = await bhash(migRegion(k), true);
  return { now: now.cells?.length ?? now.list?.length };
}

steps.migration = async () => {
  if (!dev) await connect().catch(() => null);
  if (!ctx.mig || process.argv[3] === 'remake') await mig070();
  const m = ctx.mig;
  // 1. a plain open
  const j = await migOpen('G4E Mig');
  const all = await sites();
  check(!all.some((x) => x.id === m.ids.D) && !(j.entries ?? []).some((e) => e.site === m.ids.D && e.status !== 'UNDONE'),
    `mig: the pending site D settled (${m.ids.D} gone)`, { all: all.map((x) => [x.id, x.state]) });
  await tp(MIG.D.at[0] + 10.5, 85, MIG.D.at[2] + 30.5);
  check((await bhash(migRegion('D'))).sha256 === m.pre.D, 'mig: D\'s lot is its pre-hash');
  await tp(MIG.P.at[0] + 10.5, 85, MIG.P.at[2] + 30.5);
  await cmd('/architect budget 4');
  let pState = null;
  for (let i = 0; i < 120; i++) {
    pState = (await sites()).find((x) => x.id === m.ids.P)?.state;
    if (pState === 'BUILT') break;
    await sleep(1000);
  }
  check(pState === 'BUILT', `mig: the placing site P resumed and finished (${pState})`);
  // the construction site finishes, identical to an instant placement
  await tp(MIG.C.at[0] + 5.5, 85, MIG.C.at[2] + 30.5);
  let cState = null;
  for (let i = 0; i < 40; i++) {
    const st = await siteState(m.ids.C);
    cState = st.state;
    if (st.state === 'built' || st.percent === 100) break;
    await feed(m.ids.C, 1);
    await sleep(5000);
  }
  check(cState === 'built' || (await siteState(m.ids.C)).percent === 100, `mig: the construction site C finished (${cState})`);
  const cBox = box6((await sites()).find((x) => x.id === m.ids.C).restoreBox);
  const cHash = (await bhash(cBox)).sha256;
  // a LAYER placement over a migrated site (its foreign-BE check falls back to the pin), removed in both orders, in copies
  await leaveWorld();
  copyWorld('G4E Mig', 'G4E MigL1');
  copyWorld('G4E Mig', 'G4E MigL2');
  copyWorld('G4E Mig', 'G4E MigDown');
  await openWorld('G4E Mig');
  await call('dev.survival.set', { on: false });
  const okRemoves = await migRemoves(['A1', 'A2', 'A3', 'T', 'G1', 'G2', 'P', 'C'], 'mig');
  check(okRemoves === 8, `mig: ${okRemoves}/8 Removes match their pre-hashes`);
  await leaveWorld();
  // the instant reference for C, in the pristine 0.7.0 world opened by 0.8.0
  copyWorld('G4E MigPre070', 'G4E MigRef', SAVES, savesOf('old'));
  await openWorld('G4E MigRef');
  await tp(MIG.C.at[0] + 5.5, 85, MIG.C.at[2] + 30.5);
  const ref = await result(await api(`place ${MIG.C.bp} ${MIG.C.at.join(' ')} INSTANT unowned noactor 0 force`));
  const refHash = (await bhash(cBox)).sha256;
  check(ref.placed && refHash === cHash, 'mig: C finished identical to an instant placement (restore box, BE NBT)', { cHash, refHash });
  await leaveWorld();
  for (const [w, order] of [['G4E MigL1', ['A1', 'X']], ['G4E MigL2', ['X', 'A1']]]) {
    await openWorld(w);
    await call('dev.survival.set', { on: false });
    await tp(MIG.A1.at[0] + 10.5, 85, MIG.A1.at[2] + 30.5);
    const x = await result(await api(`place gatehouse ${MIG.A1.at[0] + 9} 65 ${MIG.A1.at[2]} INSTANT unowned noactor 0 layer`));
    check(x.placed, `mig: a LAYER placement over migrated A1 works (${x.siteId}) [${w}]`, x);
    const ids = { A1: m.ids.A1, X: x.siteId };
    const steps0 = [];
    for (const k of order) steps0.push(await result(await api(`remove ${ids[k]} - noforce keep`), 300_000));
    const h = (await bhash(migRegion('A1'))).sha256;
    check(steps0.every((r) => r.removed) && h === m.pre.A1, `mig: removing A1 and X in order ${order.join(', ')} is exact`, { steps0, h });
    await leaveWorld();
  }
  // 2. kills before and after the migration commit
  for (const k of ['migrate-before-commit', 'migrate-after-commit']) {
    const name = k === 'migrate-before-commit' ? 'G4E MigKb' : 'G4E MigKa';
    const jk = await migOpen(name, k);
    check((jk.entries ?? []).length === (j.entries ?? []).length, `mig ${k}: the same ${(jk.entries ?? []).length} entries as the plain import`);
    const allK = await sites();
    check(!allK.some((x) => x.id === m.ids.D), `mig ${k}: D settled`);
    await call('dev.survival.set', { on: false });
    const okK = await migRemoves(['A1', 'A2', 'A3', 'T', 'G1', 'G2'], `mig ${k}`);
    check(okK === 6, `mig ${k}: ${okK}/6 instant Removes match their pre-hashes`);
    await leaveWorld();
  }
  return { ids: m.ids };
};

steps.downgrade = async () => {
  if (!ctx.mig) throw new Error('run `migration` first');
  const m = ctx.mig;
  if (!dev) await connect().catch(() => null);
  if (!clientPids().length) await startClient('G4E Smoke');
  // 0.8.0: the migrated world gets a road
  await openWorld('G4E MigDown');
  await tp(100.5, 85, -150.5);
  const road = await call('dev.road.place', ROAD_D, 300_000);
  check(road.placed, `downgrade: a road placed on 0.8.0 (${road.siteId})`, road);
  const roadId = road.siteId;
  await leaveWorld();
  await stopClient();
  // 0.7.0: place a site (it saves the record file) and try to Remove a migrated site (refused, nothing written)
  use('old');
  copyWorld('G4E MigDown', 'G4E MigDown070', SAVES, savesOf('new'));
  await startClient('G4E MigDown070');
  await tp(MIG.N.at[0] + 5.5, 85, MIG.N.at[2] + 30.5);
  const n = await result(await api(`place ${MIG.N.bp} ${MIG.N.at.join(' ')} INSTANT unowned noactor 0 force`));
  check(n.placed, `downgrade: 0.7.0 places a site (${n.siteId})`, n);
  await tp(MIG.A1.at[0] + 10.5, 85, MIG.A1.at[2] + 30.5);
  const hA = (await bhash(migRegion('A1'))).sha256;
  const r = await result(await api(`remove ${m.ids.A1} - noforce`), 120_000).catch((e) => ({ error: String(e) }));
  const hA2 = (await bhash(migRegion('A1'))).sha256;
  check(r.removed !== true && hA === hA2, `downgrade: 0.7.0 refuses to Remove migrated A1 and writes nothing (${JSON.stringify(r).slice(0, 200)})`, r);
  await cmd('/save-all flush');
  await stopClient();
  use('new');
  // back to 0.8.0
  copyWorld('G4E MigDown070', 'G4E MigBack', SAVES, savesOf('old'));
  await startClient('G4E MigBack');
  const all = await sites();
  const j = await journal();
  check(all.some((x) => x.id === roadId), `downgrade: the road's record is back (${roadId})`, all.map((x) => x.id));
  check((j.entries ?? []).some((e) => e.site === n.siteId), `downgrade: the 0.7.0 site ${n.siteId} is late-imported`, j.entries);
  await call('dev.survival.set', { on: false });
  m.ids.N = n.siteId;
  const ok = await migRemoves(['A1', 'A2', 'A3', 'T', 'G1', 'G2', 'N'], 'downgrade');
  const rr = await result(await api(`remove ${roadId} - force keep`), 300_000);
  await tp(100.5, 85, -150.5);
  const hr = (await bhash(ROAD_BOX)).sha256;
  check(rr.removed && hr === m.preRoad, 'downgrade: removing the road restores its strip exactly', { rr, hr });
  check(ok === 7, `downgrade: ${ok}/7 Removes exact after the round trip`);
  await leaveWorld();
  return { roadId, n: n.siteId };
};

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

/** The loaded ground around the player (apitest heights, step 4): "x,z" -> {x, z, h, water, tree}. */
async function surveyAround(r = 160, step = 4) {
  const p = (await call('dev.state')).player;
  const x0 = Math.floor(p.x / step) * step;
  const z0 = Math.floor(p.z / step) * step;
  const s = await result(await api(`heights ${x0 - r} ${z0 - r} ${x0 + r} ${z0 + r} ${step}`), 300_000);
  const cols = new Map();
  for (const [x, z, h, w, t] of s) cols.set(`${x},${z}`, { x, z, h, water: !!w, tree: !!t });
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
          if (!c || c.water) {
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

/** `scout <seed>...`: the flattest dry windows near spawn of fresh worlds (picks the gate's base seed). */
steps.scout = async () => {
  if (!dev) await connect();
  const out = [];
  for (const seed of process.argv.slice(3)) {
    const name = 'G4E Scout';
    await leaveWorld();
    fs.rmSync(path.join(SAVES, name), { recursive: true, force: true });
    await openWorld(name, { mode: 'creative', preset: 'normal', seed, cheats: true });
    await sleep(8000);
    const cols = await surveyAround(176, 4);
    const r = { seed, columns: cols.size, village: flattest(cols, 120, 128), fixture: flattest(cols, 72, 72) };
    log(JSON.stringify(r));
    out.push(r);
  }
  return out;
};

/** Debugging: `node tools/gate4e.mjs eval '<async js>'` with the helpers in scope; prints the value. */
steps.eval = async () => {
  if (!dev) await connect();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const helpers = { megaRun, fresh, leaveWorld, openWorld, FLAT, placeQueued, removeTimed, installKeep, surveyAround, flattest, call, cmd, api, result, hash, sites, siteState, journal, groundAt, tp, sleep, mark, since, queue, waitBatch, ctx };
  const f = new AsyncFunction(...Object.keys(helpers), process.argv[3]);
  const v = await f(...Object.values(helpers));
  console.log(JSON.stringify(v, null, 1));
  return v;
};

steps.all = async () => {
  for (const s of ['orders', 'edits', 'crash', 'roads', 'ghost', 'survival', 'sizecap', 'leaves', 'megalite', 'bench', 'api', 'migration', 'downgrade', 'api14']) {
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
