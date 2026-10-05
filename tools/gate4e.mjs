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

// ------------------------------------------------------------------ gate 5: crash mid-write (K1-K8)

/** Every file the on-disk index names exists; the files it does not name (orphans). Read straight from the world folder. */
function journalFiles(world) {
  const dir = path.join(SAVES, world, 'architect-journal');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));
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
  return { entries: (idx.entries ?? []).map((e) => `${e.id}:${e.site}:${e.status}`), missing, orphans };
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
  const before = { sites: (await sites()).map((x) => x.id), journal: journalFiles('G4E Crash') };
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
    check(all.length === 1 && all[0].state !== 'placing' && (j.entries ?? []).some((e) => e.status === 'ACTIVE' && e.site === all[0].id),
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
    const bad = Object.entries(lk).filter(([, v]) => [...v.cells.values()].some((c) => c.endsWith(' !after') && !/dirt_path|"minecraft:dirt"/.test(c)));
    check(bad.length === 0, 'crash K5: every site holds its after', bad.map(([k]) => k));
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
  for (let i = 0; i < 120 && !(await sites()).some((x) => x.state === 'placed'); i++) await sleep(1000);
  const all = await sites();
  check(all.length === 1 && all[0].state === 'placed', `crash K3 clean: the placement resumed after a clean stop (${JSON.stringify(all.map((x) => [x.id, x.state]))})`,
    { bid, all });
  await finalExact('K3-clean', pre);
  await leaveWorld();
  return out;
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
