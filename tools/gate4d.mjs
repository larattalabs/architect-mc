#!/usr/bin/env node
// Phase 4d gate (docs/CONTRACT.md "Phase 4d gate" + "Gate additions") against a running dev client with the apitest mod
// (tools/run-gate4d-client.sh, DevBridge on ARCHITECT_DEV_PORT, 8891 by default here). The API is driven through the apitest
// mod's /apitest steps (it uses only dev.larattalabs.architect.api); DevBridge hooks hash boxes, read the placement stats,
// switch worlds and move the player. No Claude.
//
//   node tools/gate4d.mjs probe           one cabin: atomic vs ticked (1 ms) at the same spot, box+7 hashes
//   node tools/gate4d.mjs <step> ...      see the steps at the end of this file; `all` runs the gate
//
// Evidence: artifacts/gate4d/<step>.json in the MAIN checkout (GATE4D_OUT overrides), REPORT.md written by hand from them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE4D_OUT ? path.resolve(process.env.GATE4D_OUT)
  : fs.existsSync(path.join(MAIN, 'artifacts')) ? path.join(MAIN, 'artifacts', 'gate4d') : path.join(root, 'artifacts', 'gate4d');
fs.mkdirSync(OUT, { recursive: true });
const GAME_DIR = process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : path.join(root, 'mod', 'run');
const SAVES = path.join(GAME_DIR, 'saves');
const PORT = Number(process.env.ARCHITECT_DEV_PORT || 8891);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let dev = await DevClient.connect({ port: PORT, timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const results = {};
let failures = 0;
const log = (...a) => console.log(...a);
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const cmd = async (c) => call('dev.command', { cmd: c }, 60_000);
/** Runs /apitest <args> and parses its JSON answer. */
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
/** An async step: waits until /apitest get <key> has a value. */
const result = async (pending, timeoutMs = 60_000) => {
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
/** Events since the last mark(). */
const since = async () => (await events(eventMark));
const mark = async () => {
  eventMark = (await events(0)).length;
};
const waitEvent = async (pred, timeoutMs = 120_000, what = 'event') => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await assertRunning();
    const e = (await since()).find(pred);
    if (e) return e;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
};
/** A paused game stops the integrated server (and every batch with it). */
async function assertRunning() {
  const st = await call('dev.state');
  if (st.paused) throw new Error('the game is paused: the integrated server is not ticking');
}
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));

/** Lets block ticks a change scheduled settle (leaf distances propagate one block per tick) before a hash. */
const settle = () => call('dev.wait', { ms: 3000 }, 20_000);
async function hash(box, cells = false) {
  await settle();
  const r = await call('dev.box.hash', { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]], cells }, 120_000);
  return r;
}
const grow = (b, n) => [b[0] - n, b[1] - n, b[2] - n, b[3] + n, b[4] + n, b[5] + n];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])];
/** "BoundingBox{minX=.., ...}" or [..] -> [minX, minY, minZ, maxX, maxY, maxZ]. */
function box6(s) {
  if (Array.isArray(s)) return s;
  const m = /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(s);
  return m.slice(1).map(Number);
}
/** The first differing cells of two cell lists (dev.box.hash cells:true). */
function diff(a, b, max = 12) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < max; i++) {
    if (a[i] !== b[i]) out.push({ a: a[i], b: b[i] });
  }
  return out;
}

async function setRules() {
  const rules = ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'fire_spread_radius_around_player 0',
    'spawn_mobs false', 'spawn_monsters false'];
  const out = {};
  for (const r of rules) {
    const x = await cmd(`/gamerule ${r}`);
    out[r] = (x.messages ?? []).join(' ');
  }
  await cmd('/weather clear');
  await cmd('/time set 6000');
  return out;
}

async function playerPos() {
  const st = await call('dev.state');
  return st.player;
}

async function groundAt(x, z) {
  let s;
  for (let i = 0; i < 40; i++) {
    s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
    if (s.columns?.length) break;
    await sleep(500);
  }
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  if (!m) throw new Error(`no ground at ${x},${z}: ${JSON.stringify(s)}`);
  return Number(m[1]);
}

/** Queues a batch and waits for its id. */
async function queue(spec) {
  const r = await result(await api(`bqueue ${JSON.stringify(spec)}`));
  if (typeof r !== 'string') throw new Error(`queue refused: ${JSON.stringify(r)}`);
  return r;
}
const batchView = async (id) => api(`batch ${id}`);
async function waitBatch(id, timeoutMs = 300_000) {
  return waitEvent((e) => e.event === 'BATCH_DONE' && e.batch === id, timeoutMs, `BATCH_DONE ${id}`);
}

// ------------------------------------------------------------------ probe: one cabin, atomic vs ticked

async function probe() {
  const rules = await setRules();
  const p = await playerPos();
  const x = Math.floor(p.x) + 24;
  const z = Math.floor(p.z) - 6;
  const y = await groundAt(x + 5, z + 6) - 1;
  const bp = process.argv[3] ?? 'cabin';
  const region = [x - 10, y - 12, z - 10, x + 30, y + 30, z + 34];
  const h0 = await hash(region);
  // atomic
  const placed = await result(await api(`place ${bp} ${x} ${y} ${z} INSTANT unowned noactor 0`));
  log('atomic', JSON.stringify(placed).slice(0, 300));
  const hAtomic = await hash(region, true);
  const site = placed.siteId ?? placed.site;
  const rem = await result(await api(`remove ${site} - noforce`));
  const hBack = await hash(region);
  check(hBack.sha256 === h0.sha256, 'probe: remove restores the region exactly', { h0: h0.sha256, back: hBack.sha256, rem });
  // ticked at 1 ms
  await cmd('/architect budget 1');
  await call('dev.placement.stats', { reset: true });
  await mark();
  const id = await queue({ items: [{ key: 'a', bp, at: [x, y, z], rot: 0, mode: 'INSTANT' }] });
  const done = await waitBatch(id);
  const stats = await call('dev.placement.stats', {});
  const hTicked = await hash(region, true);
  const same = hTicked.sha256 === hAtomic.sha256;
  check(same, 'probe: ticked (1 ms) equals atomic over the region', { atomic: hAtomic.sha256, ticked: hTicked.sha256,
    diff: same ? [] : diff(hAtomic.cells, hTicked.cells) });
  write('probe.json', { rules, at: [x, y, z], bp, region, stats, done, results });
  await cmd('/architect budget 4');
}

// ------------------------------------------------------------------ worlds: a base world, byte-copied per scenario

import { execFileSync } from 'node:child_process';

const CTX = path.join(OUT, 'context.json');
const ctx = fs.existsSync(CTX) ? JSON.parse(fs.readFileSync(CTX, 'utf8')) : {};
const saveCtx = () => fs.writeFileSync(CTX, JSON.stringify(ctx, null, 2));
const BASE = 'G4D Base';

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

/** A byte copy of a saved world (the game is out of it). Only worlds under the dev client's saves dir. */
function copyWorld(from, to) {
  const src = path.join(SAVES, from);
  const dst = path.join(SAVES, to);
  if (!dst.startsWith(SAVES + path.sep) || !to.startsWith('G4D ')) throw new Error(`refusing to replace ${dst}`);
  fs.rmSync(dst, { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', src, dst]);
  fs.rmSync(path.join(dst, 'session.lock'), { force: true });
}

async function fresh(name) {
  await leaveWorld();
  copyWorld(BASE, name);
  await openWorld(name);
  await tpCenter();
}

async function tpCenter() {
  const c = ctx.center;
  await cmd(`/tp @s ${c[0]} ${c[1]} ${c[2]} 0 20`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1500);
}

const KINDS = ['cabin', 'gatehouse', 'tavern', 'tower'];
/** Lot i of the 4x3 village (24 x 30 lots, 4-block gaps, an 8-block street north of each row). */
function lotBox(i, ox, oz) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  const x0 = ox + col * (22 + 4);
  const z0 = oz + row * (30 + 8) + 8;
  return [x0, 0, z0, x0 + 21, 0, z0 + 29];
}
/** The hash region of a lot: its lot rectangle and its predicted restore box, grown by 7 (Remove is exact over box + 7). */
function region(l) {
  const r = l.predicted ? union(l.box, l.predicted) : l.box;
  return grow([Math.min(r[0], l.lot[0]), r[1], Math.min(r[2], l.lot[2]), Math.max(r[3], l.lot[3]), r[4], Math.max(r[5], l.lot[5])], 7);
}
const villageRegion = () => ctx.lots.map(region).reduce(union);

async function median3(pts) {
  const ys = [];
  for (const [x, z] of pts) ys.push(await groundAt(x, z));
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)];
}

async function fit(bp, lot, side, extra = '') {
  return api(`fit ${bp} ${lot.join(',')} ${side} ${extra}`.trim());
}

const item = (l, extra = {}) => ({ key: l.key, bp: l.bp, at: l.at, rot: l.rot, mode: 'INSTANT', force: l.force, ...extra });

async function base() {
  await leaveWorld();
  fs.rmSync(path.join(SAVES, BASE), { recursive: true, force: true });
  await openWorld(BASE, { mode: 'creative', preset: 'normal', cheats: true });
  const rules = await setRules();
  const p = await playerPos();
  // far lots for the unloaded-chunk and LOAD_BOUNDED checks: generate them once here, then they are unloaded in every copy
  const far = {};
  for (const [k, x] of [['B', 800], ['C', -800]]) {
    await cmd(`/tp @s ${x} 200 0`);
    await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
    await sleep(3000);
    const y = await median3([[x - 3, 3], [x, 6], [x + 3, 9]]);
    const f = await fit('cabin', [x - 11, y, -15, x + 11, y + 30, 15], 'north');
    far[k] = { key: k, bp: 'cabin', lot: [x - 11, y, -15, x + 11, y + 30, 15], at: f.at, rot: f.rot, box: f.box, force: true, fit: f };
  }
  await cmd(`/tp @s ${p.x} ${p.y + 2} ${p.z}`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(3000);
  const ox = Math.floor(p.x) - 50;
  const oz = Math.floor(p.z) - 57;
  const center = [ox + 26 * 2 - 2 + 0.5, 0, oz + 38 + 4 + 0.5]; // the column gap between columns 1 and 2, in row 1's street
  center[1] = (await groundAt(Math.floor(center[0]), Math.floor(center[2]))) + 0;
  ctx.center = center;
  await tpCenter();
  // animals and stray drops in a lot make it wait (OCCUPIED): the gate's base world has none (mob spawning is off)
  await cmd('/kill @e[type=!minecraft:player]');
  await sleep(1000);
  await cmd('/kill @e[type=minecraft:item]');
  await cmd('/kill @e[type=minecraft:experience_orb]');
  await sleep(500);
  const lots = [];
  for (let i = 0; i < 12; i++) {
    const b = lotBox(i, ox, oz);
    const cx = Math.floor((b[0] + b[3]) / 2);
    const y = await median3([[cx, b[2] + 6], [cx - 3, b[2] + 9], [cx + 3, b[2] + 9]]);
    const lot = [b[0], y, b[2], b[3], y + 40, b[5]];
    const bp = KINDS[i % 4];
    const f = await fit(bp, lot, 'north');
    const reasons = (f.refusals ?? []).map((r) => r.reason);
    lots.push({ key: `L${i}`, i, bp, lot, at: f.at, rot: f.rot, box: f.box, predicted: f.predictedRestoreBox ?? null, force: true,
      refusals: f.refusals });
    check(reasons.every((r) => r === 'BLOCK_ENTITIES'), `base: lot L${i} (${bp}) fits and checks (${reasons.join(',') || 'ok'})`, f);
  }
  ctx.lots = lots;
  ctx.far = far;
  ctx.rules = rules;
  saveCtx();
  await cmd('/save-all flush');
  await leaveWorld();
  return { rules, center, lots, far };
}

// ------------------------------------------------------------------ the 12-lot village: queue vs atomic, MSPT, group undo

/** Lot hashes with their cell lists (for a diff when a check fails). */
async function hashLotsCells(lots) {
  const out = {};
  for (const l of lots) out[l.key] = await hash(region(l), true);
  return out;
}
const cellDiff = (a, b) => Object.fromEntries(Object.keys(a).filter((k) => a[k].sha256 !== b[k].sha256).map((k) => [k, diff(a[k].cells, b[k].cells, 20)]));

async function hashLots(lots) {
  const out = {};
  for (const l of lots) out[l.key] = (await hash(region(l))).sha256;
  return out;
}

async function village(name, budget, opts = {}) {
  await fresh(name);
  await cmd(`/architect budget ${budget}`);
  await cmd('/save-off');
  const pre = opts.pre ? await hashLots(ctx.lots) : null;
  const preAll = opts.pre ? (await hash(villageRegion())).sha256 : null;
  await call('dev.placement.stats', { reset: true });
  await mark();
  const id = await queue({ id: opts.id ?? 'village', items: ctx.lots.map((l) => item(l, opts.actor ? { actor: true } : {})) });
  const done = await waitBatch(id, 20 * 60_000);
  const stats = await call('dev.placement.stats', {});
  const ev = await since();
  const order = ev.filter((e) => e.event === 'ITEM_PLACED' && e.batch === id).map((e) => e.key);
  return { id, done, stats, ev, order, pre, preAll };
}

async function equality() {
  const v = await village('G4D Queue', 4, { pre: true });
  const post = await hashLots(ctx.lots);
  const postAll = (await hash(villageRegion())).sha256;
  check(v.order.length === 12, 'queue: all 12 lots placed', { order: v.order, failed: v.done.items.filter((i) => i.status !== 'PLACED') });
  check(v.stats.ticksOver50ms === 0, `ticks: no tick over 50 ms during the batch (max ${v.stats.msptMax.toFixed(2)} ms, mean ${v.stats.msptMean.toFixed(2)} ms)`,
    v.stats);
  const wall = (v.done.doneAt - v.done.createdAt) / 1000;
  // group undo: every site, last placed first, the whole region back exactly
  const group = v.done.group;
  await mark();
  const rm = await result(await api(`sgremove ${group}`), 10 * 60_000);
  const rev = (await since()).filter((e) => e.event === 'SITE_REMOVED');
  const placedSites = v.ev.filter((e) => e.event === 'ITEM_PLACED' && e.batch === v.id).map((e) => e.site);
  check(rm.removed === true, 'group undo: removeGroup completes', rm);
  check(JSON.stringify(rev.map((e) => e.id)) === JSON.stringify([...placedSites].reverse()), 'group undo: sites removed in reverse placement order',
    { removed: rev.map((e) => e.id), placed: placedSites });
  const back = await hashLots(ctx.lots);
  const backAll = (await hash(villageRegion())).sha256;
  check(Object.keys(back).every((k) => back[k] === v.pre[k]) && backAll === v.preAll, 'group undo: every lot region (box + 7) and the whole village are back exactly',
    { pre: v.pre, back, preAll: v.preAll, backAll });
  await cmd('/save-on');
  // the atomic reference, one by one in the order the batch placed them, in another copy of the same world
  await fresh('G4D Atomic');
  await cmd('/save-off');
  await call('dev.placement.stats', { reset: true });
  const atomicPlaced = [];
  for (const k of v.order) {
    const l = ctx.lots.find((x) => x.key === k);
    const r = await result(await api(`place ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} INSTANT unowned noactor ${l.rot} force`));
    atomicPlaced.push({ key: k, placed: r.placed, site: r.siteId, refusals: r.refusals });
  }
  const atomic = await hashLots(ctx.lots);
  const atomicAll = (await hash(villageRegion())).sha256;
  const same = Object.keys(post).filter((k) => post[k] === atomic[k]);
  check(same.length === 12 && postAll === atomicAll, `equality: ${same.length}/12 lot regions (box + 7, states and BE NBT) and the whole village identical to atomic`,
    { post, atomic, postAll, atomicAll, atomicPlaced });
  if (same.length !== 12) {
    for (const k of Object.keys(post).filter((k) => post[k] !== atomic[k]).slice(0, 2)) {
      const l = ctx.lots.find((x) => x.key === k);
      const a = await hash(region(l), true);
      results[`diff ${k}`] = { ok: false, data: diff(a.cells, ctx.queueCells?.[k] ?? []) };
    }
  }
  await cmd('/save-on');
  await leaveWorld();
  ctx.order = v.order;
  ctx.queuePost = post;
  ctx.queuePostAll = postAll;
  ctx.throughput4 = { budgetMs: 4, wallSeconds: wall, ...v.stats };
  saveCtx();
  return { wallSeconds: wall, order: v.order, stats: v.stats, done: v.done };
}

async function throughput() {
  const runs = [];
  for (const b of [1, 10]) {
    const v = await village(`G4D T${b}`, b, { id: `t${b}` });
    runs.push({ budgetMs: b, wallSeconds: (v.done.doneAt - v.done.createdAt) / 1000, placed: v.order.length, ...v.stats });
    await cmd('/save-on');
  }
  await leaveWorld();
  runs.splice(1, 0, ctx.throughput4);
  for (const r of runs) {
    check(r.ticksOver50ms === 0, `throughput ${r.budgetMs} ms: ${Math.round(r.cellsPerSecond)} cells/s, 12-lot wall ${r.wallSeconds.toFixed(1)} s, MSPT max ${r.msptMax.toFixed(2)}`
      + ` mean ${r.msptMean.toFixed(2)}, no tick over 50 ms`, r);
  }
  const out = { measuredAt: new Date().toISOString(), village: '12 lots (cabin, gatehouse, tavern, tower x3), LOADED_ONLY, player in the middle',
    runs: runs.map((r) => ({ budgetMs: r.budgetMs, cellsPerSecond: r.cellsPerSecond, cells: r.cells, workSeconds: r.workSeconds, wallSeconds: r.wallSeconds,
      msptMax: r.msptMax, msptMean: r.msptMean, serverMsptMax: r.serverMsptMax, ticksOver50ms: r.ticksOver50ms, placementMsMax: r.placementMsMax,
      placementMsMean: r.placementMsMean })) };
  fs.writeFileSync(path.join(OUT, 'throughput.json'), JSON.stringify(out, null, 2));
  return out;
}

// ------------------------------------------------------------------ relog mid-batch (the actor gone), MSPT measure check

async function placingMid(batchId) {
  for (let i = 0; i < 600; i++) {
    const j = await call('dev.placement.jobs');
    const pj = (j.jobs ?? []).find((x) => x.kind === 'place' && x.batch === batchId && x.progress > 0 && x.progress < x.total);
    const placed = (await since()).filter((e) => e.event === 'ITEM_PLACED' && e.batch === batchId).length;
    if (pj && placed >= (i > 300 ? 0 : 2)) return { job: pj, placed };
    await sleep(200);
  }
  throw new Error('no item mid-placement');
}

async function relog() {
  await fresh('G4D Relog');
  await call('dev.placement.slow', { on: true });
  await call('dev.placement.stats', { reset: true });
  await mark();
  const id = await queue({ id: 'relog', items: ctx.lots.map((l) => item(l, { actor: true })) });
  const mid = await placingMid(id);
  const slowStats = await call('dev.placement.stats', {});
  check(slowStats.msptMax >= slowStats.serverMsptMax, `MSPT measure: full tick (${slowStats.msptMax.toFixed(2)} ms max) >= the server's own tick time `
    + `(${slowStats.serverMsptMax.toFixed(2)} ms, which leaves out end-of-tick handlers)`, slowStats);
  await leaveWorld();
  const qf = JSON.parse(fs.readFileSync(path.join(SAVES, 'G4D Relog', 'architect-queue.json'), 'utf8'));
  const savedJob = qf.jobs.find((j) => j.kind === 'place');
  check(qf.clean === true && !!savedJob, `relog: the queue file kept the job (clean stop, ${savedJob?.siteId} template cursor ${savedJob?.writer?.cursor} of its cells)`,
    { clean: qf.clean, job: savedJob && { siteId: savedJob.siteId, phase: savedJob.phase, cursor: savedJob.cursor, writer: savedJob.writer?.cursor } });
  await openWorld('G4D Relog');
  await call('dev.placement.slow', { on: false });
  const done = await waitBatch(id, 20 * 60_000);
  const order = (await since()).filter((e) => e.event === 'ITEM_PLACED' && e.batch === id).map((e) => e.key);
  const post = await hashLots(ctx.lots);
  const same = Object.keys(post).filter((k) => post[k] === ctx.queuePost[k]);
  check(done.placed === 12, 'relog: the batch resumed and placed all 12 (actor stored as a UUID only)', { done: done.status, placed: done.placed });
  check(same.length === 12, `relog: ${same.length}/12 lot regions identical to the uninterrupted batch (and so to atomic)`,
    { order, queueOrder: ctx.order, mid });
  await leaveWorld();
  return { mid, order, slowStats };
}

// ------------------------------------------------------------------ waiting: player in a lot, unloaded chunks, LOAD_BOUNDED

async function waiting() {
  await fresh('G4D Wait');
  const A = ctx.lots[5];
  const B = ctx.far.B;
  const C = ctx.far.C;
  const ab = A.box;
  await cmd(`/tp @s ${(ab[0] + ab[3]) / 2} ${A.lot[1] + 1} ${(ab[2] + ab[5]) / 2}`);
  await sleep(1500);
  await mark();
  const id = await queue({ id: 'wait', proximity: false, items: [item(A), item(B)] });
  const wA = await waitEvent((e) => e.event === 'ITEM_WAITING' && e.key === A.key, 20_000, 'A waiting');
  const wB = await waitEvent((e) => e.event === 'ITEM_WAITING' && e.key === B.key, 20_000, 'B waiting');
  check(wA.reason === 'PLAYER_IN_BOX', `waiting: a lot with the player in it waits (${wA.reason})`, wA);
  check(wB.reason === 'NOT_LOADED', `waiting: a lot in unloaded chunks waits (${wB.reason})`, wB);
  await sleep(4000);
  check(!(await since()).some((e) => e.event === 'ITEM_PLACED' && e.key === A.key), 'waiting: still not placed while the player stands in it');
  await tpCenter();
  const pA = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.key === A.key, 30_000, 'A placed');
  check(!!pA, 'waiting: placed once the player left', pA);
  await sleep(3000);
  check(!(await since()).some((e) => e.event === 'ITEM_PLACED' && e.key === B.key), 'waiting: the far lot still waits while nobody is near');
  await cmd(`/tp @s ${B.box[0] - 30} ${B.lot[1] + 20} ${B.box[2] - 30}`);
  const pB = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.key === B.key, 120_000, 'B placed');
  check(!!pB, 'waiting: the far lot placed once the player walked near', pB);
  await waitBatch(id, 30_000);
  await tpCenter();
  // LOAD_BOUNDED: short-lived tickets load a far lot without a player
  await mark();
  const id2 = await queue({ id: 'bounded', loadChunks: 64, items: [item(C)] });
  const pC = await waitEvent((e) => e.event === 'ITEM_PLACED' && e.key === C.key, 120_000, 'C placed');
  check(!!pC, 'waiting: LOAD_BOUNDED(64) placed a far lot with no player near', pC);
  await waitBatch(id2, 30_000);
  return { wA, wB, pA, pB, pC };
}

// ------------------------------------------------------------------ stages, lot fitting, 0-gap and OVERLAP (same world)

async function stages() {
  await openWorld('G4D Wait');
  await tpCenter();
  const [l1, l2, l3] = [ctx.lots[0], ctx.lots[1], ctx.lots[2]];
  const pre = await hashLots([l1, l2, l3]);
  await mark();
  const id = await queue({ id: 'staged', proximity: false, items: [item(l1, { stage: 's1' }), item(l2, { stage: 's2' }), item(l3, { stage: 's3' })] });
  const g = (await batchView(id)).group;
  const st = async () => (await api(`sgroup ${g}`)).stages.map((s) => `${s.name}:${s.state}`).join(' ');
  const s0 = await st();
  check(s0 === 's1:PLANNED s2:PLANNED s3:PLANNED', `stages: queued planned (${s0})`);
  await sleep(2000);
  check(!(await since()).some((e) => e.event === 'ITEM_PLACED'), 'stages: nothing places before approval');
  await api(`sapprove ${g} s1`);
  await waitEvent((e) => e.event === 'STAGE_STATE' && e.name === 's1' && e.state === 'PLACED', 120_000, 's1 placed');
  await api(`sskip ${g} s2`);
  await api(`sapprove ${g} s3`);
  await waitEvent((e) => e.event === 'STAGE_STATE' && e.name === 's3' && e.state === 'PLACED', 120_000, 's3 placed');
  await waitBatch(id, 30_000);
  const refused = await result(await api(`sundo ${g} s1`), 30_000);
  check(!!refused.error && /s3/.test(refused.error), `stages: undoing s1 while s3 is placed is refused (${refused.error})`, refused);
  const u3 = await result(await api(`sundo ${g} s3`), 120_000);
  const u1 = await result(await api(`sundo ${g} s1`), 120_000);
  const back = await hashLots([l1, l2, l3]);
  const seq = (await since()).filter((e) => e.event === 'STAGE_STATE').map((e) => `${e.name}:${e.state}`);
  const want = ['s1:PLANNED', 's2:PLANNED', 's3:PLANNED', 's1:APPROVED', 's1:PLACING', 's1:PLACED', 's2:SKIPPED', 's3:APPROVED', 's3:PLACING',
    's3:PLACED', 's3:UNDONE', 's1:UNDONE'];
  check(JSON.stringify(seq) === JSON.stringify(want), `stages: every state change observed in order (${seq.join(' ')})`, seq);
  check(u3.removed && u1.removed && back[l1.key] === pre[l1.key] && back[l3.key] === pre[l3.key] && back[l2.key] === pre[l2.key],
    'stages: undo 3 then undo 1 restore their lots exactly (box + 7); skipped 2 never placed', { u3, u1, pre, back });
  return { seq };
}

async function lotfit() {
  // a flat world: on a slope the approach legitimately extends past the lot edge (up to extendMax) until it meets the ground
  await leaveWorld();
  fs.rmSync(path.join(SAVES, 'G4D Flat'), { recursive: true, force: true });
  await openWorld('G4D Flat', { mode: 'creative', preset: 'flat', cheats: true });
  await setRules();
  await cmd('/kill @e[type=!minecraft:player]');
  await cmd('/tp @s 60 66 60');
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(2000);
  await cmd('/kill @e[type=minecraft:item]');
  const feet = await groundAt(60, 60);
  const sides = ['north', 'east', 'south', 'west'];
  const turns = { north: 2, east: 3, south: 0, west: 1 }; // the kit designs' entrances face south unrotated
  const rows = [];
  const items = [];
  for (const [r, side] of sides.entries()) {
    for (const [c, bp] of KINDS.entries()) {
      const lot = [c * 36, feet, r * 36, c * 36 + 23, feet + 40, r * 36 + 23];
      const d = await fit(bp, lot, side);
      const into = await fit(bp, lot, side, 'into');
      const pr = d.predictedRestoreBox;
      const inLot = !!pr && pr[0] >= lot[0] && pr[3] <= lot[3] && pr[2] >= lot[2] && pr[5] <= lot[5];
      const ip = into.predictedRestoreBox;
      const out = !!ip && (side === 'north' ? ip[2] < lot[2] : side === 'south' ? ip[5] > lot[5] : side === 'west' ? ip[0] < lot[0] : ip[3] > lot[3]);
      const key = `F${r}${c}`;
      rows.push({ key, side, bp, lot, rot: d.rot, at: d.at, predicted: pr, inLot, intoStreet: out, refusals: d.refusals.map((x) => x.reason) });
      items.push({ key, bp, at: d.at, rot: d.rot, mode: 'INSTANT', force: true });
    }
  }
  check(rows.every((r) => r.rot === turns[r.side]), 'fitToLot: 4 lots x 4 street sides, the entrance faces the street', rows.map((r) => `${r.key} ${r.side} rot ${r.rot}`));
  check(rows.every((r) => r.inLot), 'fitToLot: the predicted restore box (approach included) stays inside the lot by default', rows.filter((r) => !r.inLot));
  check(rows.every((r) => r.intoStreet), 'fitToLot: with approachIntoStreet the approach runs out into the street', rows.filter((r) => !r.intoStreet));
  const tiny = await fit('tavern', [0, feet, 200, 9, feet + 30, 209], 'north');
  check(tiny.refusals.some((r) => r.reason === 'LOT_TOO_SMALL'), 'fitToLot: a lot too small refuses LOT_TOO_SMALL', tiny.refusals);
  const margin = await api('margin cabin');
  check(margin.front === 4 + 8 && margin.sides === 0 && margin.back === 0, `overlapMargin(cabin) = front ${margin.front}, sides 0, back 0`, margin);
  // place all 16 from their fits; each placed site must face its street with its restore box inside its lot
  await mark();
  const id = await queue({ id: 'fits', proximity: false, items });
  const done = await waitBatch(id, 300_000);
  const sitesNow = (await api('sites')).all;
  const placed = rows.map((r) => {
    const it = done.items.find((i) => i.key === r.key);
    const st = sitesNow.find((x) => x.id === it.site);
    const rb = st ? box6(st.restoreBox) : null;
    return { key: r.key, side: r.side, status: it.status, reason: it.reason, rotation: st?.rotation, restoreBox: rb,
      inLot: !!rb && rb[0] >= r.lot[0] && rb[3] <= r.lot[3] && rb[2] >= r.lot[2] && rb[5] <= r.lot[5],
      matchesPrediction: JSON.stringify(rb) === JSON.stringify(r.predicted) };
  });
  check(placed.every((p) => p.status === 'PLACED' && p.inLot && p.matchesPrediction),
    'fitToLot: the 16 placed from their fits, each restore box inside its lot and equal to predictedRestoreBox', placed);
  await shot('g4d-lotfit', [60, feet + 60, -30], [60, feet, 60]);
  await leaveWorld();
  return { rows, placed };
}

async function shot(name, eye, at) {
  try {
    await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator' }, 30_000);
    const r = await call('dev.screenshot', { name }, 120_000);
    await call('dev.release', {});
    return r.path;
  } catch (e) {
    return String(e);
  }
}

async function gap0() {
  await openWorld('G4D Wait');
  await tpCenter();
  const L = ctx.lots[8];
  const A = { key: 'GA', bp: 'cabin', at: L.at.slice(), rot: 2, force: true };
  const fa = await fit('cabin', L.lot, 'north');
  A.at = fa.at;
  const abox = fa.box;
  const yB = await groundAt(abox[3] + 6, abox[2] + 4);
  const B = { key: 'GB', bp: 'cabin', at: [abox[3] + 1, yB - 1, abox[2]], rot: 2, force: true };
  // C faces south, north of A across the street: its approach runs into A's front (A's approach strip)
  const yC = await groundAt(A.at[0] + 5, abox[2] - 10);
  const C = { key: 'GC', bp: 'cabin', at: [A.at[0], yC - 1, abox[2] - 6 - 12 + 1], rot: 0, force: true };
  await mark();
  const id = await queue({ id: 'gap0', proximity: false, items: [A, B, C].map((x) => ({ ...x, mode: 'INSTANT' })) });
  const done = await waitBatch(id, 120_000);
  const st = Object.fromEntries(done.items.map((i) => [i.key, `${i.status}${i.reason ? ':' + i.reason : ''}`]));
  const sitesNow = (await api('sites')).all;
  const ra = box6(sitesNow.find((s) => s.id === done.items[0].site)?.restoreBox ?? [0, 0, 0, 0, 0, 0]);
  const rbx = box6(sitesNow.find((s) => s.id === done.items[1].site)?.restoreBox ?? [0, 0, 0, 0, 0, 0]);
  check(done.items[0].status === 'PLACED' && done.items[1].status === 'PLACED' && rbx[0] === ra[3] + 1,
    `0-gap: two lots touching side by side both place (A restore maxX ${ra[3]}, B restore minX ${rbx[0]})`, { st, ra, rbx });
  check(st.GC === 'FAILED:OVERLAP', `0-gap: a third whose approach crosses A's front refuses OVERLAP (${st.GC})`, done.items[2]);
  return { st, ra, rbx };
}

// ------------------------------------------------------------------ survival: shared crate, stock, actorless refused

async function survival() {
  await fresh('G4D Surv');
  await call('dev.survival.set', { on: true });
  await cmd('/defaultgamemode survival');
  await mark();
  const no = await queue({ id: 'nopatron', items: [item(ctx.lots[11])] });
  const nf = await waitEvent((e) => e.event === 'ITEM_FAILED' && e.batch === no, 20_000, 'actorless refused');
  check(nf.reason === 'NOT_ALLOWED', `actorless INSTANT in a survival world (toggle on) fails NOT_ALLOWED at queue (${nf.reason})`, nf);
  const lots = [ctx.lots[0], ctx.lots[1], ctx.lots[2]];
  await call('dev.placement.stats', { reset: true });
  await mark();
  const id = await queue({ id: 'crate', proximity: false, sharedCrate: true, items: lots.map((l) => ({ ...item(l), mode: 'CONSTRUCTION' })) });
  for (const l of lots) await waitEvent((e) => e.event === 'ITEM_PLACED' && e.key === l.key, 60_000, `${l.key} construction site`);
  const bv = await batchView(id);
  const g = await api(`sgroup ${bv.group}`);
  const sites = bv.items.map((i) => i.site);
  const crate = g.crate.split(',').map(Number);
  const sitesNow = (await api('sites')).all.filter((s) => sites.includes(s.id));
  const inBox = sitesNow.some((s) => { const b = box6(s.restoreBox); return crate[0] >= b[0] && crate[0] <= b[3] && crate[1] >= b[1] && crate[1] <= b[4]
    && crate[2] >= b[2] && crate[2] <= b[5]; });
  check(!inBox, `shared crate: one crate at ${g.crate} (default cell), outside every site's restore box`, { crate: g.crate, sites });
  const stock0 = await api(`stock ${bv.group}`);
  const bom = {};
  for (const s of sites) {
    const st = await call('dev.site.state', { site: s });
    for (const [k, v] of Object.entries(st.bom)) bom[k] = (bom[k] ?? 0) + v;
  }
  check(JSON.stringify(sortObj(stock0.outstanding)) === JSON.stringify(sortObj(bom)), 'stock: the outstanding total equals the three sites\' bills of materials',
    { outstanding: stock0.outstanding, bom });
  // a hopper chain: chests on hoppers on every free side of the crate
  const restore = sitesNow.map((s) => box6(s.restoreBox));
  const free = (x, y, z) => !restore.some((b) => x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]);
  const feeds = [];
  const [cx, cy, cz] = crate;
  if (free(cx, cy + 1, cz) && free(cx, cy + 2, cz)) feeds.push({ hopper: [cx, cy + 1, cz], facing: 'down', chest: [cx, cy + 2, cz] });
  for (const [dx, dz, f] of [[1, 0, 'west'], [-1, 0, 'east'], [0, 1, 'north'], [0, -1, 'south']]) {
    if (free(cx + dx, cy, cz + dz) && free(cx + dx, cy + 1, cz + dz)) feeds.push({ hopper: [cx + dx, cy, cz + dz], facing: f, chest: [cx + dx, cy + 1, cz + dz] });
  }
  for (const f of feeds) {
    await cmd(`/setblock ${f.hopper.join(' ')} minecraft:hopper[facing=${f.facing}]`);
    await cmd(`/setblock ${f.chest.join(' ')} minecraft:chest`);
  }
  // spread the bill over the chests, a stack per slot
  const stacks = [];
  for (const [k, v] of Object.entries(stock0.outstanding)) {
    let left = v;
    const max = /bed$|_door$|sign$|banner$/.test(k) ? (k.endsWith('door') || k.endsWith('sign') ? 16 : 1) : 64;
    while (left > 0) {
      const n = Math.min(max, left);
      stacks.push([k, n]);
      left -= n;
    }
  }
  let slot = 0;
  const per = Math.ceil(stacks.length / feeds.length);
  check(per <= 27, `hopper chain: ${feeds.length} hoppers fed by chests holding ${stacks.length} stacks (${Object.values(stock0.outstanding).reduce((a, b) => a + b, 0)} items)`,
    { feeds });
  for (const [k, n] of stacks) {
    const f = feeds[Math.floor(slot / per)];
    await cmd(`/item replace block ${f.chest.join(' ')} container.${slot % per} with ${k} ${n}`);
    slot++;
  }
  // feed and build
  const end = Date.now() + 25 * 60_000;
  let built = [];
  while (Date.now() < end) {
    built = (await since()).filter((e) => e.event === 'SITE_BUILT').map((e) => e.id);
    if (sites.every((s) => built.includes(s))) break;
    await sleep(3000);
  }
  const stats = await call('dev.placement.stats', {});
  check(sites.every((s) => built.includes(s)), 'shared crate: the 3 construction sites finished from one hopper chain', { built });
  check(stats.ticksOver50ms === 0, `survival: no tick over 50 ms (max ${stats.msptMax.toFixed(2)} ms, mean ${stats.msptMean.toFixed(2)} ms)`, stats);
  const stock1 = await api(`stock ${bv.group}`);
  check(Object.keys(stock1.outstanding).length === 0 && JSON.stringify(sortObj(stock1.delivered)) === JSON.stringify(sortObj(stock0.outstanding)),
    'stock: afterwards nothing outstanding and delivered equals the bill', { stock0, stock1 });
  const survHashes = {};
  for (const s of sitesNow) survHashes[s.id] = (await hash(box6(s.restoreBox))).sha256;
  await leaveWorld();
  // the instant reference at the same spots
  await fresh('G4D SurvRef');
  const ref = {};
  for (const [k, l] of lots.entries()) {
    const r = await result(await api(`place ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} INSTANT unowned noactor ${l.rot} force`));
    const s = sitesNow.find((x) => x.id === sites[k]);
    ref[sites[k]] = { placed: r.placed, sha: (await hash(box6(s.restoreBox))).sha256 };
  }
  const same = sites.filter((s) => ref[s].sha === survHashes[s]);
  check(same.length === 3, `shared crate: ${same.length}/3 built sites identical to instant placement (restore box, BE NBT)`, { survHashes, ref });
  await leaveWorld();
  return { crate: g.crate, feeds, stats };
}

function sortObj(o) {
  return Object.fromEntries(Object.entries(o ?? {}).sort());
}

// ------------------------------------------------------------------ Patron (actorless, creative), toggle on mid-batch, cancel, append

async function patron() {
  await fresh('G4D Patron');
  await call('dev.survival.set', { on: true });
  await mark();
  const lots = [ctx.lots[0], ctx.lots[1]];
  const id = await queue({ id: 'patron', proximity: false, items: lots.map((l) => item(l)) });
  const done = await waitBatch(id, 120_000);
  const h = await hashLots(lots);
  check(done.placed === 2, 'Patron: an actorless INSTANT batch in a creative world with the toggle on places', done.items);
  await fresh('G4D PatronRef');
  for (const l of lots) await result(await api(`place ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} INSTANT unowned noactor ${l.rot} force`));
  const r = await hashLots(lots);
  check(lots.every((l) => h[l.key] === r[l.key]), 'Patron: identical to atomic (box + 7)', { h, r });
  await leaveWorld();
}

async function toggle() {
  await fresh('G4D Toggle');
  // lots far apart: a placed site holds the leaves within 6 of it (LeafGuard), which a neighbour's box + 7 would include
  const lots = [ctx.lots[0], ctx.lots[2], ctx.lots[9], ctx.lots[11]];
  const preCells = await hashLotsCells(lots);
  const pre = Object.fromEntries(Object.entries(preCells).map(([k, v]) => [k, v.sha256]));
  await call('dev.placement.slow', { on: true });
  await mark();
  const id = await queue({ id: 'toggle', proximity: false, items: lots.map((l) => item(l)) });
  const mid = await (async () => {
    for (let i = 0; i < 300; i++) {
      const j = await call('dev.placement.jobs');
      const pj = (j.jobs ?? []).find((x) => x.batch === id && x.progress > 0);
      if (pj) return pj;
      await sleep(100);
    }
    throw new Error('nothing placing');
  })();
  await call('dev.survival.set', { on: true });
  await call('dev.placement.slow', { on: false });
  const done = await waitBatch(id, 120_000);
  const st = done.items.map((i) => `${i.key}:${i.status}${i.reason ? ':' + i.reason : ''}`);
  const failed = done.items.filter((i) => i.status === 'FAILED');
  const sites = (await api('sites')).all;
  const postCells = await hashLotsCells(lots);
  const post = Object.fromEntries(Object.entries(postCells).map(([k, v]) => [k, v.sha256]));
  check(failed.length === 3 && failed.every((i) => i.reason === 'NOT_ALLOWED') && done.items[0].status === 'PLACED',
    `toggle on mid-batch: the placing item finishes, the 3 queued INSTANT items fail NOT_ALLOWED (${st.join(' ')})`, { mid, st });
  check(!sites.some((s) => s.state === 'PLACING') && failed.every((i) => post[i.key] === pre[i.key]), 'toggle on mid-batch: nothing half-placed (failed lots unchanged)',
    { pre, post, diff: cellDiff(Object.fromEntries(failed.map((i) => [i.key, preCells[i.key]])), postCells) });
  await call('dev.survival.set', { on: false });
  // cancel mid-item
  // the placed item is far from the cancelled one, so its own changes (leaf holds within 6) never reach that region
  const cl = [ctx.lots[3], ctx.lots[5], ctx.lots[10]];
  const preCC = await hashLotsCells(cl);
  const preC = Object.fromEntries(Object.entries(preCC).map(([k, v]) => [k, v.sha256]));
  await call('dev.placement.slow', { on: true });
  await mark();
  const cid = await queue({ id: 'cancel', proximity: false, items: cl.map((l) => item(l)) });
  let midC;
  for (let i = 0; i < 1200 && !midC; i++) {
    const placed = (await since()).some((e) => e.event === 'ITEM_PLACED' && e.batch === cid);
    const j = await call('dev.placement.jobs');
    const pj = (j.jobs ?? []).find((x) => x.batch === cid && x.kind === 'place' && x.progress > 0 && x.progress < x.total);
    if (placed && pj) midC = pj;
    else await sleep(100);
  }
  const cancelled = await result(await api(`bcancel ${cid}`), 120_000);
  await call('dev.placement.slow', { on: false });
  const postCC = await hashLotsCells(cl);
  const postC = Object.fromEntries(Object.entries(postCC).map(([k, v]) => [k, v.sha256]));
  const cst = cancelled.items.map((i) => `${i.key}:${i.status}${i.reason ? ':' + i.reason : ''}`);
  check(cancelled.status === 'CANCELLED' && cancelled.items[0].status === 'PLACED' && cancelled.items.slice(1).every((i) => i.reason === 'CANCELLED'),
    `cancelBatch: placed stays, the one placing and the rest fail CANCELLED (${cst.join(' ')})`, { midC, cst });
  check(postC[cl[1].key] === preC[cl[1].key] && postC[cl[2].key] === preC[cl[2].key],
    `cancelBatch mid-item: ${cl[1].key}'s region (box + 7) is exactly as before (it was at ${midC?.progress}/${midC?.total})`,
    { preC, postC, diff: cellDiff({ [cl[1].key]: preCC[cl[1].key], [cl[2].key]: preCC[cl[2].key] }, postCC) });
  // growing a group
  const al = [ctx.lots[8], ctx.lots[9]];
  const preA = await hashLots(al);
  const owner = 'apitest:village/1';
  await mark();
  const a1 = await queue({ id: 'ap1', owner, autoApprove: true, items: [item(al[0], { stage: 'walls' })] });
  const d1 = await waitBatch(a1, 120_000);
  const g = d1.group;
  const a2 = await queue({ id: 'ap2', owner, group: g, autoApprove: true, items: [item(al[1], { stage: 'roofs' })] });
  await waitBatch(a2, 120_000);
  const grp = await api(`sgroup ${g}`);
  check(JSON.stringify(grp.stages.map((s) => s.name)) === '["walls","roofs"]' && grp.sites.length === 2,
    `append: a second batch appends its stage after the group's and its site to the group (${grp.stages.map((s) => s.name)}, ${grp.sites})`, grp);
  const dup = await result(await api(`bqueue ${JSON.stringify({ id: 'ap3', owner, group: g, items: [item(ctx.lots[10], { stage: 'walls' })] })}`));
  check(typeof dup === 'object' && /already exists/.test(dup.error ?? ''), 'append: a duplicate stage name refuses the batch', dup);
  const other = await result(await api(`bqueue ${JSON.stringify({ id: 'ap4', owner: 'other_mod:x', group: g, items: [item(ctx.lots[10])] })}`));
  check(typeof other === 'object' && /owned by/.test(other.error ?? ''), 'append: another owner refuses the batch', other);
  const rm = await result(await api(`sgremove ${g} noforce ${owner}`), 120_000);
  const postA = await hashLots(al);
  check(rm.removed && al.every((l) => postA[l.key] === preA[l.key]), 'append: removeGroup takes both batches\' sites down exactly (box + 7)', { rm, preA, postA });
  await leaveWorld();
}

async function undodebug() {
  await fresh('G4D Dbg');
  const keys = (process.argv[3] ?? 'L0,L2').split(',');
  const ls = ctx.lots.filter((l) => keys.includes(l.key));
  const pre = {};
  for (const l of ls) pre[l.key] = await hash(region(l), true);
  await mark();
  let rm;
  if (process.argv[4] === 'atomic') {
    const sites = [];
    for (const k of ctx.order) {
      const l = ctx.lots.find((x) => x.key === k);
      sites.push((await result(await api(`place ${l.bp} ${l.at[0]} ${l.at[1]} ${l.at[2]} INSTANT unowned noactor ${l.rot} force`))).siteId);
    }
    rm = [];
    for (const s of sites.reverse()) rm.push(await result(await api(`remove ${s} - noforce`)));
  } else {
    const id = await queue({ id: 'dbg', items: ctx.lots.map((l) => item(l)) });
    const done = await waitBatch(id, 600_000);
    rm = await result(await api(`sgremove ${done.group}`), 600_000);
  }
  const out = {};
  for (const l of ls) {
    const b = await hash(region(l), true);
    out[l.key] = diff(pre[l.key].cells, b.cells, 40);
  }
  const events = (await since()).filter((e) => /SITE_|ITEM_PLACED/.test(e.event)).map((e) => `${e.event} ${e.id ?? e.site} ${e.key ?? ''}`);
  await leaveWorld();
  return { rm, out, events };
}

async function all() {
  for (const s of ['base', 'equality', 'relog', 'waiting', 'stages', 'lotfit', 'gap0', 'survival', 'patron', 'toggle', 'throughput']) {
    log(`== ${s}`);
    await run(s);
  }
}

const steps = { probe, undodebug, base, equality, relog, waiting, stages, lotfit, gap0, survival, patron, toggle, throughput, all };

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data;
  let error;
  try {
    data = await steps[name]();
  } catch (e) {
    console.error(e);
    error = String(e?.stack ?? e);
    failures++;
  }
  if (name !== 'all') write(name === 'throughput' ? 'throughput-step.json' : `${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, error, results: { ...results }, data });
}

const which = process.argv[2] ?? 'probe';
await run(which);
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
dev.close();
process.exit(failures === 0 ? 0 : 1);
