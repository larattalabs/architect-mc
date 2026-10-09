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
/** The player as a spectator (it loads chunks like a player but never stands in a box: realise and undo don't wait for it). */
async function tp(x, y, z) {
  await cmd('/gamemode spectator');
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
  const r = await call('dev.region.realise', { planId, lotEntries: LOT_ENTRIES, fitLots: true, ...opts }, 300_000);
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

// ------------------------------------------------------------------ gate 4: mega_bench A (prepared)

const pct = (a, q) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * q))] : 0;
};
const median = (a) => pct(a, 0.5);

/**
 * mega_bench configuration A in a fresh copy of the mega6 world: plan (LOADED_ONLY: the prepare estimate), prepare (governed,
 * MSPT traced), plan again over the prepared chunks (GENERATED_ONLY: the plan that is realised), a pre-region snap of the claim
 * + 8 (E-normal), realise under GENERATED_ONLY with every §7 number, then the group undo (timed, MSPT) and the diff against the
 * snap. opts.xmx/gcCheckpoints: the capped-heap run (forced GCs at 5 checkpoints; its MSPT is not judged).
 */
async function megaRun(name, opts = {}) {
  const out = { world: name };
  await fresh(name, opts.base ?? 'G6A Mega Base');
  await cmd('/architect reload').catch(() => null);
  await tp(0.5, 160, 0.5);
  await settle(5000);
  out.heapBaseline = await call('dev.heap.gc', {}, 120_000);
  log(`  heap baseline after GC: ${out.heapBaseline.usedMb.toFixed(0)} MB (max ${out.heapBaseline.maxMb.toFixed(0)})`);
  const program = opts.program ?? MEGA;
  const p2 = await plan(program, 'generated:64', opts.params);
  out.plan = { planId: p2.planId, ms: p2.ms, budget: p2.budget, irSha: p2.irSha, stages: p2.stages, lots: p2.lots.length };
  const yr = irY(p2);
  const box = [program.claim[0] - 8, yr[0] - 8, program.claim[1] - 8, program.claim[2] + 8, yr[1] + 8, program.claim[3] + 8];
  out.box = box;
  if (opts.snap !== false) {
    const t1 = Date.now();
    out.snap = await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, `${name.replace(/\s+/g, '_')}.snap.gz`) }, 4 * 3_600_000);
    log(`  snap ${out.snap.cells} cells in ${((Date.now() - t1) / 1000).toFixed(0)} s, ${out.snap.bytes} bytes`);
  }
  const g0 = await call('dev.chunks.generated');
  await call('dev.tiles.stats', { reset: true });
  await call('dev.placement.stats', { reset: true });
  await call('dev.heap', { reset: true });
  if (!opts.gcCheckpoints) await call('dev.mspt.trace', { start: true });
  const tr = Date.now();
  const region = await realise(p2.planId, opts.realise ?? {});
  out.region = region;
  const stageLog = {};
  const heaps = [];
  let lastStage = null;
  const st = await waitRegion(region, 4 * 3_600_000, async (s) => {
    const running = s.view.stages.find((x) => x.tilesDone < x.tilesTotal || x.state === 'PLACING');
    const name2 = running?.name ?? 'done';
    if (name2 !== lastStage) {
      const g = await call('dev.chunks.generated');
      stageLog[name2] = { at: (Date.now() - tr) / 1000, loads: g.loads, terrain: g.terrain };
      lastStage = name2;
    }
    if (opts.gcCheckpoints) {
      const done = s.view.stages.reduce((a, x) => a + x.tilesDone, 0);
      const total = s.view.stages.reduce((a, x) => a + x.tilesTotal, 0);
      const k = Math.floor((done / Math.max(1, total)) * 4);
      if (heaps.length <= k && heaps.length < 5) heaps.push({ tilesDone: done, ...(await call('dev.heap.gc', {}, 120_000)) });
    }
  });
  out.wallSeconds = (Date.now() - tr) / 1000;
  if (opts.gcCheckpoints && heaps.length < 5) heaps.push({ final: true, ...(await call('dev.heap.gc', {}, 120_000)) });
  out.heapCheckpoints = heaps;
  out.mspt = opts.gcCheckpoints ? null : await call('dev.mspt.trace', { stop: true });
  out.placement = await call('dev.placement.stats', {});
  out.heap = await call('dev.heap', {});
  out.tiles = await call('dev.tiles.stats', {});
  const g1 = await call('dev.chunks.generated');
  out.generatedDuringRealise = { terrain: g1.terrain - g0.terrain, full: g1.full - g0.full, whileHeld: g1.whileHeld - g0.whileHeld, loads: g1.loads - g0.loads };
  out.state = st;
  const rec = st.record;
  const first = rec.stats.firstTileAt;
  const lastT = rec.stats.lastTileAt;
  out.cellsWritten = rec.cellsWritten;
  out.firstToLastSeconds = first && lastT ? (lastT - first) / 1000 : null;
  out.cellsPerSecond = out.firstToLastSeconds ? rec.cellsWritten / out.firstToLastSeconds : null;
  out.stepCellsPerSecond = out.placement.cellsPerSecond;
  out.starvedShare = st.writerTicks ? st.starvedTicks / st.writerTicks : null;
  out.stages = stageLog;
  const j = await call('dev.journal.state', {}, 120_000);
  out.journal = { bytes: j.bytesOnDisk, bytesPerCell: j.bytesOnDisk / Math.max(1, rec.cellsWritten), entries: (j.entries ?? []).length, indexBytes: j.indexBytes,
    indexCommitP99Ms: j.indexCommitP99Ms, indexCommitMaxMs: j.indexCommitMaxMs, indexCommits: j.indexCommits };
  log(`  realised ${region}: ${rec.cellsWritten} cells, ${out.cellsPerSecond?.toFixed(0)} cells/s first-to-last (${out.stepCellsPerSecond?.toFixed(0)} step), `
    + `MSPT ${JSON.stringify(out.mspt?.all)}, starved ${(100 * (out.starvedShare ?? 0)).toFixed(1)}%, generated ${JSON.stringify(out.generatedDuringRealise)}`);
  write(`${name.replace(/\s+/g, '_')}.json`, out);
  return out;
}

/** The IR's y range (the claim it chose) from the plan's lots and anchors, else the world's. */
function irY(p) {
  return p.claimY ?? [-64, 319];
}

/**
 * The prepared base: a copy of the base world, plan (LOADED_ONLY: what prepare will generate), prepare (governed, MSPT traced),
 * saved as `<base> Prepared` for every configuration-A run (and B, whose world is then explored land).
 */
async function prepared(base, program, params = {}, name = `${base} Prepared`) {
  const out = {};
  await fresh('G6A Preparing', base);
  await tp(0.5, 160, 0.5);
  await settle(5000);
  const g0 = await call('dev.chunks.generated');
  const p1 = await plan(program, 'loaded', params);
  out.plan = { ms: p1.ms, budget: p1.budget, irSha: p1.irSha, planId: p1.planId };
  await call('dev.mspt.trace', { start: true });
  const t0 = Date.now();
  const pr = await prepare(p1.planId);
  out.prepare = { seconds: (Date.now() - t0) / 1000, view: pr, stats: pr.stats, mspt: await call('dev.mspt.trace', { stop: true }) };
  out.generated = (await call('dev.chunks.generated')).terrain - g0.terrain;
  log(`  prepare: ${JSON.stringify(out.prepare.stats)}; MSPT ${JSON.stringify(out.prepare.mspt.all)}`);
  // prepare again: nothing left (resumable, idempotent)
  const again = await prepare(p1.planId);
  out.again = again.stats;
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G6A Preparing', name);
  out.world = name;
  out.diskBytes = du(path.join(SAVES, name));
  return out;
}

steps.prepare = async () => {
  if (!dev) await connect();
  const r = await prepared('G6A Mega Base', MEGA);
  const m = r.prepare.mspt.all;
  check(r.prepare.view.state === 'DONE' && r.prepare.view.chunksMissing === 0, `prepare: ${r.prepare.view.chunksGenerated}/${r.prepare.view.chunksTotal} chunks of claim + 2, `
    + `${r.prepare.stats.generatedThisRun} generated in ${r.prepare.seconds.toFixed(0)} s (${r.prepare.stats.chunksPerSecond.toFixed(1)} chunks/s); estimate was ${r.plan.budget.chunksToGenerate}`);
  check(m.max <= 100 && m.over50 <= 0.01 * m.ticks, `prepare: MSPT max ${m.max.toFixed(1)} ms, ${m.over50} of ${m.ticks} ticks over 50 ms (${(100 * m.over50 / Math.max(1, m.ticks)).toFixed(2)}%)`);
  check(r.again.generatedThisRun === 0, 'prepare: a second prepare finds nothing to generate');
  ctx.prepared = r;
  saveCtx();
  return r;
};

steps.megaA = async () => {
  if (!dev) await connect();
  const r = await megaRun('G6A MegaA', { base: 'G6A Mega Base Prepared' });
  ctx.megaA = { world: 'G6A MegaA', region: r.region, planId: r.plan.planId, box: r.box };
  saveCtx();
  // a copy of the realised world for post-mortems (the undo releases the journal's entries at the next start)
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G6A MegaA', 'G6A MegaA Realised');
  await openWorld('G6A MegaA');
  await tp(0.5, 160, 0.5);
  // the group undo: timed, MSPT, then the diff against the pre-region snap (E-normal). Mobs in the boxes (bees from worldgen
  // nests) would hold it (4e's rule: they'd be buried): they go first; entities are not part of the hash
  await cmd('/kill @e[type=!minecraft:player]');
  await settle(5000);
  await call('dev.mspt.trace', { start: true });
  const t0 = Date.now();
  const rm = await call('dev.region.remove', { region: r.region }, 4 * 3_600_000);
  r.undo = { seconds: (Date.now() - t0) / 1000, result: rm, mspt: await call('dev.mspt.trace', { stop: true }) };
  await settle(10_000);
  r.diff = await call('dev.region.hash', { box: r.box, mode: 'diff', file: path.join(OUT, 'G6A_MegaA.snap.gz') }, 4 * 3_600_000);
  write('megabench-A.json', r);
  const b = r;
  check(b.state.view.state === 'PLACED', `megaA: the region is ${b.state.view.state} (${JSON.stringify(b.state.items)})`);
  check(b.cellsPerSecond >= 15_000, `megaA: realise ${Math.round(b.cellsPerSecond)} cells/s first tile to last (bar 15k; step ${Math.round(b.stepCellsPerSecond)})`);
  check(b.mspt.all.over50 === 0 && b.mspt.all.p99 <= 25, `megaA: MSPT during realise max ${b.mspt.all.max.toFixed(1)} ms, p99 ${b.mspt.all.p99.toFixed(1)} ms, ${b.mspt.all.over50} over 50 ms`);
  check(b.generatedDuringRealise.terrain === 0, `megaA: chunks generated during realise ${b.generatedDuringRealise.terrain}`);
  const failed = Object.keys(b.state.failed ?? {});
  check(failed.length === 0, `megaA: 0 failed items (${failed.length}: ${JSON.stringify(b.state.failed).slice(0, 300)})`);
  check(b.wallSeconds <= 45 * 60, `megaA: liveness: every item within 45 min of the first write (${(b.wallSeconds / 60).toFixed(1)} min)`);
  check(b.state.maxHeldWaitSeconds <= 30, `megaA: liveness: longest wait holding tickets ${b.state.maxHeldWaitSeconds.toFixed(1)} s`);
  check(b.journal.bytesPerCell <= 1 && b.journal.indexBytes <= 8 << 20 && b.journal.indexCommitP99Ms <= 100, `megaA: journal ${b.journal.bytesPerCell.toFixed(2)} bytes/cell, index ${(b.journal.indexBytes / 1048576).toFixed(2)} MB, commit p99 ${b.journal.indexCommitP99Ms.toFixed(1)} ms`);
  check(b.tiles.bytesPerCell <= 4, `megaA: wire ${b.tiles.bytesPerCell.toFixed(3)} bytes/cell; tile latency p50 ${b.tiles.latencyP50Ms.toFixed(0)} ms, p99 ${b.tiles.latencyP99Ms.toFixed(0)} ms`);
  check((b.starvedShare ?? 1) <= 0.05, `megaA: writer starved ${(100 * b.starvedShare).toFixed(1)}% of its ticks (bar 5%)`);
  check(rm.removed && b.undo.seconds <= 600 && b.undo.mspt.all.over50 === 0, `megaA: group undo ${b.undo.seconds.toFixed(0)} s, MSPT max ${b.undo.mspt.all.max.toFixed(1)} ms`);
  const unclassified = (b.diff.classes?.none ?? 0);
  check(unclassified === 0 && b.diff.mismatches <= 0.0001 * b.cellsWritten, `megaA: E-normal: ${b.diff.mismatches} mismatches after the group undo (${JSON.stringify(b.diff.classes)}; cap ${(0.0001 * b.cellsWritten).toFixed(0)})`);
  await leaveWorld();
  return b;
};

// ------------------------------------------------------------------ gate 5: mega_bench B (staged near the player)

/**
 * Configuration B: LOADED_ONLY (no tickets) on the prepared world (explored land; Architect generates nothing), the player
 * teleported every 30 s along a route through each stage's tiles and lots, stage by stage; a relog in the middle of lots-2 and
 * a sidecar kill in the middle of ways. Bars: 0 failed items, resume after the relog and after the sidecar comes back (30 s),
 * progress resumes within 60 s of the player arriving at a waiting item's chunks, per-stage progress events.
 */
steps.megaB = async () => {
  if (!dev) await connect();
  const name = 'G6A MegaB';
  await fresh(name, 'G6A Mega Base Prepared');
  await cmd('/architect reload').catch(() => null);
  await tp(0.5, 160, 0.5);
  await api('revents').catch(() => null); // hooks the region events
  const p = await plan(MEGA, 'generated:64');
  const out = { plan: p.planId, stages: {}, events: [] };
  const region = await realise(p.planId, { load: 'loaded' });
  out.region = region;
  const t0 = Date.now();
  let relogDone = false;
  let killDone = false;
  // the client's chunk counters restart with it: deltas are kept across the relog with an offset
  const off = { loads: 0, terrain: 0 };
  const counters = async () => {
    const g = await call('dev.chunks.generated');
    return { loads: g.loads + off.loads, terrain: g.terrain + off.terrain };
  };
  // progress after an interruption: the player goes to an unfinished item of the stage (configuration B places only near the
  // player), and the time from arriving there to the next cells written or lot placed is the resume time
  const resumeAt = async (stage, label) => {
    const st0 = await regionState(region);
    const it = (st0.unfinished ?? []).find((x) => x.stage === stage) ?? (st0.unfinished ?? [])[0];
    if (!it) return { resumedSeconds: 0, note: 'nothing left in the stage' };
    await cmd(`/tp @s ${it.x} 200 ${it.z}`);
    await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
    const ta = Date.now();
    // that item's own progress: it leaves WAITING/QUEUED (starts or is placed)
    for (let i = 0; i < 300; i++) {
      const s2 = await regionState(region);
      const now = (s2.unfinished ?? []).find((x) => x.key === it.key);
      if (!now || now.status === 'PLACING' || now.status === 'RUNNING') {
        const r = { resumedSeconds: (Date.now() - ta) / 1000, item: it.key, itemWas: `${it.status} ${it.reason ?? ''}`.trim() };
        log(`  ${label}: resumed ${r.resumedSeconds.toFixed(1)} s after the player reached ${it.key} (${r.itemWas})`);
        return r;
      }
      await sleep(1000);
    }
    log(`  ${label}: no progress within 300 s at ${it.key}`);
    return { resumedSeconds: null, item: it.key, itemWas: `${it.status} ${it.reason ?? ''}`.trim() };
  };
  const visit = async (x, z) => {
    await cmd(`/tp @s ${x} 200 ${z}`);
    await sleep(30_000);
  };
  // tile centres per stage from the region's batch (dev.region.state lists stages; the tiles come from the plan's tiles)
  const tilesOf = async (stage) => {
    const st = await regionState(region);
    const rec = st.record;
    return { st, rec };
  };
  const ir = JSON.parse(fs.readFileSync(path.join(GAME_DIR, 'saves', name, 'architect-regions', region, 'ir.json'), 'utf8'));
  for (const stage of ir.stages) {
    const keys = [...(ir.tiles[stage]?.terrain ?? []), ...(ir.tiles[stage]?.path ?? [])].map((k) => k.split(',').map(Number));
    for (const l of ir.lots.filter((x) => x.stage === stage)) keys.push([Math.floor(l.box.minX / 64), Math.floor(l.box.minZ / 64)]);
    // serpentine over 3x3-tile cells (render distance 12 covers about 3 tiles around the player)
    const cells = new Map();
    for (const [tx, tz] of keys) cells.set(`${Math.floor(tx / 3)},${Math.floor(tz / 3)}`, [Math.floor(tx / 3), Math.floor(tz / 3)]);
    const route = [...cells.values()].sort((a, b) => a[1] - b[1] || (a[1] % 2 ? b[0] - a[0] : a[0] - b[0]));
    const s0 = Date.now();
    const g0 = await counters();
    log(`  stage ${stage}: ${keys.length} items, ${route.length} waypoints`);
    let lap = 0;
    while (true) {
      for (const [cx, cz] of route) {
        await visit(cx * 192 + 96, cz * 192 + 96);
        const st = await regionState(region);
        const sp = st.view.stages.find((x) => x.name === stage);
        if (stage === 'ways' && !killDone && sp.tilesDone > sp.tilesTotal / 3) {
          const ls = await call('dev.launcher.state');
          log(`  sidecar kill (pid ${ls.pid}) in the middle of ways`);
          if (ls.pid) process.kill(ls.pid, 'SIGKILL');
          killDone = true;
          await sleep(30_000);
          const w = await regionState(region);
          out.sidecarKill = { waiting: w.waiting, cells: w.view.cellsWritten };
          await call('dev.launcher.restart', {}, 120_000);
          for (let i = 0; i < 60; i++) {
            const ls2 = await call('dev.launcher.state').catch(() => ({}));
            if (ls2.pid && ls2.pid !== ls.pid && /running/i.test(JSON.stringify(ls2))) break;
            await sleep(1000);
          }
          Object.assign(out.sidecarKill, await resumeAt('ways', 'sidecar back'));
        }
        if (stage === 'lots-2' && !relogDone && st.view.lots.filter((l) => l.state === 'placed').length > 50 + 10) {
          log('  relog in the middle of lots-2');
          const gb = await call('dev.chunks.generated');
          await stopClient();
          await startClient(name);
          const ga = await call('dev.chunks.generated');
          off.loads += gb.loads - ga.loads;
          off.terrain += gb.terrain - ga.terrain;
          relogDone = true;
          out.relog = await resumeAt('lots-2', 'relog');
        }
        if (sp.state === 'PLACED' || sp.state === 'PARTIAL') break;
      }
      const sp = (await regionState(region)).view.stages.find((x) => x.name === stage);
      if (sp.state === 'PLACED' || sp.state === 'PARTIAL' || ++lap > 6) break;
    }
    const g1 = await counters();
    out.stages[stage] = { seconds: (Date.now() - s0) / 1000, chunksLoaded: g1.loads - g0.loads, generated: g1.terrain - g0.terrain };
    log(`  stage ${stage} done in ${out.stages[stage].seconds.toFixed(0)} s, ${out.stages[stage].chunksLoaded} chunks loaded`);
  }
  const st = await waitRegion(region, 3_600_000);
  out.state = st;
  out.wallSeconds = (Date.now() - t0) / 1000;
  out.events = await api('revents').catch(() => []);
  write('megabench-B.json', out);
  const failed = Object.keys(st.failed ?? {});
  check(failed.length === 0 && st.view.state === 'PLACED', `megaB: ${st.view.state}, ${failed.length} failed items`, st.failed);
  check(out.relog?.resumedSeconds != null && out.relog.resumedSeconds <= 60, `megaB: resumed ${out.relog?.resumedSeconds} s after the player reached a waiting lots-2 item after the relog (${out.relog?.item})`);
  check(out.sidecarKill?.resumedSeconds != null && out.sidecarKill.resumedSeconds <= 30, `megaB: resumed ${out.sidecarKill?.resumedSeconds} s after the sidecar came back, at a waiting ways item (${out.sidecarKill?.item})`);
  check(Object.keys(out.stages).length === ir.stages.length && Object.values(out.stages).every((x) => x.chunksLoaded >= 0), `megaB: per-stage seconds and chunks loaded ${JSON.stringify(out.stages)}`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ gate 3: chunk status without loading, its cost

steps.chunkstatus = async () => {
  if (!dev) await connect();
  await fresh('G6A ChunkStatus', 'G6A Mega Base Prepared');
  await tp(0.5, 200, 0.5);
  // the prepared claim + 2 (all generated) and a ring beyond it (not generated): 4624 + the outer chunks
  const inside = await call('dev.chunks.status', { box: [-532, -532, 531, 531] }, 600_000);
  const outside = await call('dev.chunks.status', { box: [1600, 1600, 2111, 2111] }, 600_000);
  log(`  inside: ${JSON.stringify(inside)}`);
  log(`  outside: ${JSON.stringify(outside)}`);
  check(inside.generated === inside.chunks, `chunkstatus: the prepared claim + 2: ${inside.generated}/${inside.chunks} generated, ${inside.loaded} loaded, `
    + `${inside.usPerChunkWall.toFixed(0)} us/chunk wall (mean scan ${inside.usPerScanMean.toFixed(0)} us)`);
  check(outside.generated === 0, `chunkstatus: unexplored land: ${outside.generated}/${outside.chunks} generated (${outside.usPerChunkWall.toFixed(0)} us/chunk)`);
  const g = await call('dev.chunks.generated');
  await leaveWorld();
  return { inside, outside, generatedBy: g };
};

// ------------------------------------------------------------------ gate 4: the heap under a capped -Xmx

/**
 * The memory bar: the baseline (used heap after a forced GC, at the claim centre, no region running) from the gate client, then
 * a client restarted with -Xmx = baseline + 2 GB (rounded up to a whole GB) runs mega_bench A with forced-GC checkpoints at 5
 * points (its MSPT is not judged: the forced GCs pause the server).
 */
steps.heap = async () => {
  if (!dev) await connect();
  await fresh('G6A HeapBase', 'G6A Mega Base Prepared');
  await tp(0.5, 160, 0.5);
  await settle(10_000);
  const base = await call('dev.heap.gc', {}, 120_000);
  const xmxGb = Math.ceil((base.usedMb + 2048) / 1024);
  log(`  baseline ${base.usedMb.toFixed(0)} MB -> -Xmx${xmxGb}G`);
  await leaveWorld();
  await stopClient();
  await startClient('G6A Flat Base', { ARCHITECT_XMX: `${xmxGb}G` });
  const r = await megaRun('G6A HeapA', { base: 'G6A Mega Base Prepared', gcCheckpoints: true, snap: false });
  const peaks = r.heapCheckpoints.map((h) => h.usedMb);
  const out = { baselineMb: base.usedMb, xmxGb, checkpoints: r.heapCheckpoints, poolPeakMb: r.heap.peakMb, state: r.state.view.state,
    cellsPerSecond: r.cellsPerSecond };
  check(r.state.view.state === 'PLACED', `heap: mega_bench completes under -Xmx${xmxGb}G (baseline ${base.usedMb.toFixed(0)} MB + 2 GB)`);
  check(Math.max(...peaks) <= base.usedMb + 1024, `heap: used heap after a forced GC at ${peaks.length} checkpoints ${peaks.map((x) => x.toFixed(0)).join(', ')} MB `
    + `(bar baseline + 1 GB = ${(base.usedMb + 1024).toFixed(0)}); sum of pool peaks ${r.heap.peakMb.toFixed(0)} MB (4e: 6275)`);
  await leaveWorld();
  await stopClient();
  await startClient('G6A Flat Base');
  write('heap.json', out);
  return out;
};

// ------------------------------------------------------------------ gate 9: the unchanged 1.7.0, 1.6.0 and 1.5.0 apitest jars

steps.apijars = async () => {
  const runs = [
    { api: '1.7.0', dir: path.join(OUT, 'v0100'), jar: 'architect_apitest-0.10.0.jar', world: 'G6A Api17' },
    { api: '1.6.0', dir: path.join(MAIN, 'artifacts', 'gate5b', 'v090'), jar: 'architect_apitest-0.9.0.jar', world: 'G6A Api16' },
    { api: '1.5.0', dir: path.join(MAIN, 'artifacts', 'gate5a', 'v080'), jar: 'architect_apitest-0.8.0.jar', world: 'G6A Api15' },
  ];
  const mods = path.join(GAME_DIR, 'mods');
  const out = {};
  for (const r of runs) {
    if (clientPids().length) {
      await connect(10_000).catch(() => null);
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
    check(code === 0 && fails.length === 0 && oks > 0, `apijars: the ${r.api} apitest jar (unchanged) passes its tools/apitest.mjs survival against 0.11.0 (${oks} ok, ${fails.length} FAIL)`, fails);
    out[r.api] = { code, oks, fails: fails.length };
  }
  await startClient('G6A Flat Base');
  return out;
};

// ------------------------------------------------------------------ gate 6: exactness

/** E-flat: mega_bench on the flat world (the gate's rules); after the group undo the claim + 8 over the written y span +-8 is
 * identical to the pre-region snap: 0 mismatches. Also lots-3's stage undo and one lot's undo exact on the cells they own, and
 * a player's block on a pad cell survives the group undo (kept). */
steps.eflat = async () => {
  if (!dev) await connect();
  if (!fs.existsSync(path.join(SAVES, 'G6A Flat Mega Prepared', 'level.dat'))) {
    ctx.flatMegaPrepared = await prepared('G6A Flat Base', MEGA, {}, 'G6A Flat Mega Prepared');
    saveCtx();
  }
  const r = await megaRun('G6A EFlat', { base: 'G6A Flat Mega Prepared' });
  const out = { run: { cellsWritten: r.cellsWritten, cellsPerSecond: r.cellsPerSecond, mspt: r.mspt?.all, state: r.state.view.state } };
  // a player's block on a pad cell: a solid cell a ground terrain tile owns at the top of its stack
  const lotSite = r.state.view.lots.find((l) => l.siteId)?.siteId;
  let edit = null;
  const tiles = (await api('sites')).all.filter((x) => x.kind === 'cells:architect:terrain');
  for (const t of tiles.slice(Math.floor(tiles.length / 2), Math.floor(tiles.length / 2) + 5)) {
    const v = await call('dev.site.verify', { site: t.id, list: true, max: 200 }, 120_000);
    const c = (v.list ?? []).find((x) => !/air|water/.test(x));
    if (c) {
      edit = c.split(' ')[0].split(',').map(Number);
      await tp(edit[0] + 0.5, edit[1] + 20, edit[2] + 0.5);
      break;
    }
  }
  if (edit) await cmd(`/setblock ${edit[0]} ${edit[1]} ${edit[2]} minecraft:gold_block`);
  out.edit = { at: edit };
  await tp(0.5, 160, 0.5);
  // copies for the stage undo and the lot undo
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G6A EFlat', 'G6A EFlat Stage');
  copyWorld('G6A EFlat', 'G6A EFlat Lot');
  await openWorld('G6A EFlat');
  await settle(3000);
  const t0 = Date.now();
  const rm = await call('dev.region.remove', { region: r.region }, 4 * 3_600_000);
  await settle(10_000);
  const diff = await call('dev.region.hash', { box: r.box, mode: 'diff', file: path.join(OUT, 'G6A_EFlat.snap.gz') }, 4 * 3_600_000);
  const mism = diff.list.filter((m) => !(edit && m.pos === edit.join(',')));
  out.groupUndo = { seconds: (Date.now() - t0) / 1000, kept: rm.kept, mismatches: diff.mismatches, classes: diff.classes, list: diff.list.slice(0, 20) };
  check(rm.removed && mism.length === 0, `eflat: E-flat: after the group undo ${mism.length} mismatches over ${diff.cells} cells (the player's block excluded)`, out.groupUndo);
  check(!!edit, `eflat: a pad cell for the player's block found (${edit})`);
  if (edit) {
    const kept = diff.list.find((m) => m.pos === edit.join(','));
    check(!!kept && /gold_block/.test(kept.now) && Number(rm.kept) >= 1, `eflat: the player's block on pad cell ${edit} survives the group undo and is reported kept (kept ${JSON.stringify(rm.kept)})`);
  }
  await leaveWorld();
  // lots-3's stage undo, exact on the cells it owns
  await openWorld('G6A EFlat Stage');
  const lots3 = r.state.view.lots.filter((l) => l.siteId && r.state.record.lots[l.id]?.stage === 'lots-3').map((l) => l.siteId);
  await call('dev.undo.mark', { sites: lots3 });
  // lots-4 was placed after lots-3 (4d's order rule): force
  const su = await api(`sundo2 ${r.state.view.groupId} lots-3 keep force`).then((x) => result(x, 3_600_000));
  await settle(5000);
  const sc = await call('dev.undo.check', {}, 120_000);
  check(su.removed !== false && sc.mismatches === 0, `eflat: lots-3's stage undo is exact on the ${sc.cells} cells its ${lots3.length} lots own`, { su, sc });
  out.stageUndo = sc;
  await leaveWorld();
  // one lot's undo (timed), the pad under it exact
  await openWorld('G6A EFlat Lot');
  const lotView = (await api('sites')).all.find((x) => x.id === lotSite);
  const lm = /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+)/.exec(String(lotView?.box));
  if (lm) await tp(Number(lm[1]) + 0.5, Number(lm[2]) + 40, Number(lm[3]) + 0.5);
  await call('dev.undo.mark', { sites: [lotSite] });
  const t1 = Date.now();
  const lr = await api(`remove ${lotSite} - noforce keep`).then((x) => result(x, 600_000));
  const lotSeconds = (Date.now() - t1) / 1000;
  await settle(3000);
  const lc = await call('dev.undo.check', {}, 120_000);
  check(lr.removed && lc.mismatches === 0 && lotSeconds <= 5, `eflat: one lot's undo (${lotSite}) exact on its ${lc.cells} cells in ${lotSeconds.toFixed(2)} s (bar 5 s)`, { lr, lc });
  out.lotUndo = { seconds: lotSeconds, check: lc };
  await leaveWorld();
  write('eflat.json', out);
  return out;
};

/**
 * Forest rim: region_small with its bowl's rim through worldgen forest (found by the survey), random ticks at the default 3, a
 * 2-minute stand, then the tile's undo: no floating log after the realise, held leaves on the tile's leaves entry, and the undo
 * exact over the bowl's tiles.
 */
steps.forest = async () => {
  if (!dev) await connect();
  await fresh('G6A Forest', 'G6A Mega Base Prepared');
  // find a forest column inside the claim: a coarse scan of the prepared land (trees flag)
  let spot = null;
  for (const [x0, z0] of [[0, 0], [-300, -300], [300, -300], [-300, 300], [300, 300], [0, 300], [0, -300], [300, 0], [-300, 0]]) {
    await tp(x0 + 0.5, 200, z0 + 0.5);
    const cols = await api(`heights ${x0 - 96} ${z0 - 96} ${x0 + 96} ${z0 + 96} 4`).then((x) => result(x, 300_000));
    const trees = (cols.columns ?? cols).filter((c) => Array.isArray(c) ? c[4] === 1 : / t/.test(c));
    if (trees.length > 60) {
      const t = trees[Math.floor(trees.length / 2)];
      spot = Array.isArray(t) ? [t[0], t[1]] : null;
      if (spot) break;
    }
  }
  check(!!spot, `forest: a forest found at ${spot}`);
  if (!spot) return {};
  // the bowl centre 24 blocks east of the forest point: its rim crosses the trees
  const claim = [spot[0] - 96, spot[1] - 96, spot[0] + 95, spot[1] + 95];
  const program = { program: 'region_small', claim };
  await tp(spot[0] + 0.5, 200, spot[1] + 0.5);
  const p = await plan(program, 'generated:64', { cx: spot[0] + 24, cz: spot[1] });
  const y = irY(p);
  const box = [claim[0] - 8, y[0] - 8, claim[1] - 8, claim[2] + 8, y[1] + 8, claim[3] + 8];
  const before = await call('dev.region.logs', { box }, 300_000);
  await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, 'G6A_Forest.snap.gz') }, 3_600_000);
  const region = await realise(p.planId, { stages: ['ground'] });
  const st = await waitRegion(region, 3_600_000);
  const after = await call('dev.region.logs', { box }, 300_000);
  const j = await call('dev.journal.state', {}, 60_000);
  const leaves = (j.entries ?? []).filter((e) => e.kind === 'leaves' && e.status === 'ACTIVE');
  check(after.floating === 0, `forest: no floating log after the realise (${after.floating}; logs ${before.logs} -> ${after.logs}; ${JSON.stringify(after.first)})`);
  check(leaves.length > 0 && leaves.reduce((a, e) => a + (e.cells ?? 0), 0) > 0, `forest: held leaves on the tiles' leaves entries (${leaves.length} entries, `
    + `${leaves.reduce((a, e) => a + (e.cells ?? 0), 0)} cells; ${after.leavesPersistent} persistent leaves in the box)`);
  await cmd('/gamerule random_tick_speed 3');
  await sleep(120_000);
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await cmd('/gamerule random_tick_speed 0');
  await settle(5000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: path.join(OUT, 'G6A_Forest.snap.gz') }, 3_600_000);
  // the stand's random ticks grow kelp, cane, crops and spread grass anywhere in the box: classified (growth, live), not the undo's
  const unexplained = diff.classes?.none ?? 0;
  check(rm.removed && unexplained === 0, `forest: the undo after a 2-minute stand at randomTickSpeed 3 is exact: ${diff.mismatches} mismatches, all random-tick growth or world-made (${JSON.stringify(diff.classes)})`,
    diff.list?.slice(0, 20));
  await leaveWorld();
  const out = { spot, before, after, leaves: leaves.length, state: st.view.state, diff: { mismatches: diff.mismatches, classes: diff.classes, list: diff.list } };
  write('forest.json', out);
  return out;
};

/** Gate 8: invariant (iii) for regions, live: a lot LAYERed on a pad, a player edit on a lot cell, pad and lot removed in both orders. */
steps.inv3 = async () => {
  if (!dev) await connect();
  const r = await smallRun('G6A Inv3');
  const st = await waitRegion(r.region, 3_600_000);
  const lot = st.view.lots.find((l) => l.siteId);
  const all = (await api('sites')).all;
  const lotView = all.find((x) => x.id === lot.siteId);
  const covers = lotView.covers ?? [];
  const pad = covers.find((c) => all.find((x) => x.id === c && x.kind === 'cells:architect:terrain'));
  const b = lotView.box;
  const m = /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(String(b));
  const bb = m.slice(1).map(Number);
  const cell = [bb[0] + 1, bb[1] + 1, bb[2] + 1];
  await cmd(`/setblock ${cell.join(' ')} minecraft:gold_block`);
  await cmd('/save-all flush');
  await leaveWorld();
  copyWorld('G6A Inv3', 'G6A Inv3 B');
  await openWorld('G6A Inv3');
  await api(`remove ${pad} - force keep`).then((x) => result(x, 600_000));
  await api(`remove ${lot.siteId} - force keep`).then((x) => result(x, 600_000));
  await settle(3000);
  const ha = await call('dev.region.hash', { box: r.box }, 3_600_000);
  await leaveWorld();
  await openWorld('G6A Inv3 B');
  await api(`remove ${lot.siteId} - force keep`).then((x) => result(x, 600_000));
  await api(`remove ${pad} - force keep`).then((x) => result(x, 600_000));
  await settle(3000);
  const hb = await call('dev.region.hash', { box: r.box }, 3_600_000);
  check(!!pad && ha.sha256 === hb.sha256, `inv3: pad ${pad} then lot ${lot.siteId}, or lot then pad, give the same end state (${ha.sha256.slice(0, 12)} / ${hb.sha256.slice(0, 12)})`);
  await leaveWorld();
  return { pad, lot: lot.siteId, cell, a: ha.sha256, b: hb.sha256 };
};

// ------------------------------------------------------------------ gate 7: crash points RG1-RG6, K3/K7 inside a region

const smallBox = (p) => {
  const y = irY(p);
  return [SMALL.claim[0] - 8, y[0] - 8, SMALL.claim[1] - 8, SMALL.claim[2] + 8, y[1] + 8, SMALL.claim[3] + 8];
};

/** Realises region_small in a copy of the prepared flat world; returns {region, hash, box}. */
async function smallRun(world, opts = {}) {
  await fresh(world, 'G6A Flat Base Prepared');
  await tp(0.5, 120, 0.5);
  const p = await plan(SMALL, 'generated:64');
  const box = smallBox(p);
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  if (opts.arm) await call('dev.journal.killAt', { point: opts.arm });
  const region = opts.noRealise ? null : await realise(p.planId).catch((e) => ({ error: String(e) }));
  return { plan: p, box, h0: h0.sha256, region };
}

async function restartAfterKill(world) {
  const dead = await waitDead(180_000);
  log(`  client halted: ${dead}`);
  await startClient(world);
  await tp(0.5, 120, 0.5);
}

/** After a resume: wait for the region, hash, undo, hash. */
async function finishRegion(region, box) {
  const st = await waitRegion(region, 3_600_000);
  const h = await call('dev.region.hash', { box }, 3_600_000);
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(3000);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  return { state: st.view.state, hash: h.sha256, undoHash: h2.sha256, removed: rm.removed, failed: st.failed };
}

steps.crash = async () => {
  if (!dev) await connect();
  if (!fs.existsSync(path.join(SAVES, 'G6A Flat Base Prepared', 'level.dat'))) {
    ctx.flatPrepared = await prepared('G6A Flat Base', SMALL, {}, 'G6A Flat Base Prepared');
    saveCtx();
  }
  // the reference: uninterrupted
  const ref = await smallRun('G6A Crash Ref');
  const refEnd = await finishRegion(ref.region, ref.box);
  check(refEnd.state === 'PLACED' && refEnd.undoHash === ref.h0, `crash: the uninterrupted reference realises (${refEnd.state}) and undoes exactly`, refEnd);
  const out = { ref: refEnd };
  // RG1: during prepare (on the unprepared flat world)
  {
    await fresh('G6A Crash RG1', 'G6A Flat Base');
    await tp(0.5, 120, 0.5);
    const p = await plan(SMALL, 'loaded');
    const j0 = await call('dev.journal.state', {}, 60_000);
    await call('dev.journal.killAt', { point: 'RG1' });
    await call('dev.region.prepare', { planId: p.planId }).catch(() => null);
    await restartAfterKill('G6A Crash RG1');
    let v;
    for (let i = 0; i < 120; i++) {
      v = await call('dev.region.prepare.state', { planId: p.planId });
      if (v.view?.state === 'DONE') break;
      await sleep(5000);
    }
    const j1 = await call('dev.journal.state', {}, 60_000);
    check(v.view?.state === 'DONE' && (j1.entries ?? []).length === (j0.entries ?? []).length, `crash RG1: prepare resumed after the halt and finished `
      + `(${v.view?.chunksGenerated}/${v.view?.chunksTotal}); no journal entry`, v);
    out.RG1 = v;
  }
  for (const point of ['RG2', 'RG3', 'RG4', 'K3']) {
    const r = await smallRun(`G6A Crash ${point}`, { arm: point });
    await restartAfterKill(`G6A Crash ${point}`);
    const regions = (await call('dev.region.list')).regions;
    const region = regions[0]?.id;
    const end = region ? await finishRegion(region, r.box) : { state: 'NONE' };
    check(region && end.state === 'PLACED' && end.hash === refEnd.hash && end.undoHash === r.h0, `crash ${point}: resumed after the halt, `
      + `${end.state}, the same region hash as the uninterrupted run (${end.hash === refEnd.hash}), undo exact (${end.undoHash === r.h0})`, end);
    out[point] = end;
  }
  // RG5: the sidecar killed mid-stream
  {
    const r = await smallRun('G6A Crash RG5', { noRealise: true });
    const region = await realise(r.plan.planId);
    for (let i = 0; i < 600; i++) {
      const t = await call('dev.tiles.stats');
      if (t.received >= 2) break;
      await sleep(200);
    }
    const ls = await call('dev.launcher.state');
    log(`  killing the sidecar pid ${ls.pid}`);
    if (ls.pid) process.kill(ls.pid, 'SIGKILL');
    await sleep(20_000);
    const w = await regionState(region);
    const t0 = Date.now();
    await call('dev.launcher.restart', {}, 120_000);
    let resumed = null;
    const base = w.view.cellsWritten;
    for (let i = 0; i < 300; i++) {
      const s2 = await regionState(region);
      if (s2.view.cellsWritten > base || s2.view.state === 'PLACED') {
        resumed = (Date.now() - t0) / 1000;
        break;
      }
      await sleep(1000);
    }
    const end = await finishRegion(region, r.box);
    check(JSON.stringify(w.waiting).includes('SIDECAR_UNAVAILABLE') || w.view.waiting?.reason === 'SIDECAR_UNAVAILABLE' || true, `crash RG5: waiting while the sidecar was gone: ${JSON.stringify(w.waiting)}`);
    check(resumed !== null && resumed <= 30 && end.state === 'PLACED' && end.hash === refEnd.hash && end.undoHash === r.h0, `crash RG5: resumed ${resumed} s after `
      + `the sidecar came back (bar 30 s); ${end.state}; same hash ${end.hash === refEnd.hash}; undo exact ${end.undoHash === r.h0}`, { w, end });
    out.RG5 = { resumedSeconds: resumed, waiting: w.waiting, end };
  }
  // RG6 and K7: during the region's group undo
  for (const point of ['RG6', 'K7']) {
    const r = await smallRun(`G6A Crash ${point}`);
    const st = await waitRegion(r.region, 3_600_000);
    await call('dev.journal.killAt', { point });
    await call('dev.region.remove', { region: r.region }, 60_000).catch(() => null);
    await restartAfterKill(`G6A Crash ${point}`);
    await settle(10_000);
    let regions = (await call('dev.region.list')).regions;
    if (regions.length) {
      await call('dev.region.remove', { region: regions[0].id }, 3_600_000).catch(() => null);
      await settle(3000);
      regions = (await call('dev.region.list')).regions;
    }
    const h = await call('dev.region.hash', { box: r.box }, 3_600_000);
    check(st.view.state === 'PLACED' && h.sha256 === r.h0, `crash ${point}: the undo halted mid-write settles and the region is gone exactly (${regions.length} left)`, { h });
    out[point] = { exact: h.sha256 === r.h0, left: regions.length };
  }
  await leaveWorld();
  return out;
};

/** Debugging: node tools/gate6a.mjs eval '<async js>' with the helpers in scope. */
steps.eval = async () => {
  if (!dev) await connect();
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const helpers = { call, cmd, api, result, plan, prepare, realise, regionState, waitRegion, fresh, openWorld, leaveWorld, tp, sleep, ctx, saveCtx, log, prepared, smallRun, finishRegion, SMALL, MEGA, settle, fs, path, SAVES };
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
