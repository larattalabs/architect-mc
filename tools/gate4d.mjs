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

const steps = { probe };
const which = process.argv[2] ?? 'probe';
try {
  await steps[which]();
} catch (e) {
  console.error(e);
  failures++;
}
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
dev.close();
process.exit(failures === 0 ? 0 : 1);
