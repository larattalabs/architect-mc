#!/usr/bin/env node
// Phase 6c slice Y1 gate (docs/CONTRACT.md "Phase 6c slice Y: settlement stockpile (C24-C26)", gate items 2-9 and 12-13 with
// Steward's two additions: the unloaded-frontier reservation and dissolveStockpile) against a dev client of the Y1 run worktree
// (`../architect-mc-Y1-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no Claude,
// apitest on the classpath). Ports 8930 (sidecar) / 8931 (DevBridge) unless the runner gives others. $0: no Claude call anywhere.
//
//   node tools/gate6cy.mjs <step>
//     start [world] | stop | base   the client (GATE6CY_REF: another build, e.g. v0.17.0 for the migration) and the survival base world
//     unit                          item 1 (Y1's part, no game): StockpileTest, FeedOrderTest, Api118Test
//     store                         item 2 + 4: one storehouse (3 crates) feeds 3 houses, a batch road, a standalone construction road,
//                                   an update delta and a survival revert; 0 other crates; each BUILT target equals its INSTANT twin;
//                                   the conservation sum at 10+ checkpoints
//     order                         item 3: setFeedOrder puts house 3 first; the exact BOM fed shuffled: BUILT in feed order; house 3
//                                   blocked by a player: the others build only from surplus
//     unloaded                      Steward S-Y-1: the first target entirely in unloaded chunks reserves nothing (the second builds);
//                                   once its chunks load, its reservation returns
//     refunds                       item 5: deconstruct a built house and undo the road: returned = each one's Refunds tally; the
//                                   player's blocks drop at the site; conservation 0
//     overflow                      item 6: capacity full of credit; a deconstruct returns up to capacity, drops the rest: refundOverflow
//                                   = the counted entities; conservation 0
//     once                          item 7: dev.undo.failRestore mid-removal, retry: every refund credited once; conservation 0
//     restart a|b|kill|c            item 8: clean stop while hoppers feed and the builder places (a: run, stop; b: reload, compare);
//                                   kill: kill -9 after an autosave, c: reload, the drift recorded against the units moved since that save
//     gone                          item 9: /setblock air on a crate: nothing lost, missingCrates, capacity drops; removeStockpileCrate
//                                   with excess refused, with force drops exactly the excess
//     dissolve                      Steward's addition: dissolve with reserved stock and a building target: conservation exact, crates
//                                   restored, the target waits with no stockpile (C25's "waiting" itself is Y2's)
//     migrate a|b                   item 12: a: on 0.17.0 (GATE6CY_REF=v0.17.0 start) a half-built sharedCrate group and a per-site crate;
//                                   b: this build: loads unchanged, builds finish as before (copy 1); adoptCrates moves the stock in with
//                                   difference 0, cells restored (copy 2); downgrade (c/d) recorded
//     apicompat                     item 14: tools/api-compat.mjs against the 0.17.0, 0.16.0, 0.15.0 apitest jars and the 0.17.0 surface
//     report                        REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-y1/<step>.json in the main checkout (GATE6CY_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-Y1-run');
process.env.GATE6B_OUT = process.env.GATE6CY_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-y1');
process.env.GATE6B_SIDECAR_PORT ??= '8930';
process.env.GATE6B_DEV_PORT ??= '8931';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, GAME_DIR, MAIN, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, startClient,
  state, stopClient, write, copyWorld, clientPids } = L;

refuseKeys();
const SURV = 'G6B Y Survival';
const OWNER = 'test:settle';
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

// ---- the apitest mod (public API only)
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 120_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const later = async (args, t) => result(await api(args), t);

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) {
    const sub = process.argv[3] && !['start'].includes(name) ? `-${process.argv[3]}` : '';
    write(`${name}${sub}.json`, { step: name, part: process.argv[3] ?? null, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
  }
}
const ensure = async () => { if (!state.dev) await connect(); };
async function fresh(name, from = SURV) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
  await call('dev.survival.set', { on: true });
}
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice Y1 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}
/** The feet y of a column (the survey's height + 1). */
async function feet(x, z) {
  const h = await later(`heights ${x} ${z} ${x} ${z} 1`);
  return h[0][2] + 1;
}
/** The player at (x, y, z): creative (stands in cells, picks nothing up while far from drops), or spectator. */
async function stand(x, y, z, mode = 'creative') {
  await cmd(`/gamemode ${mode}`);
  await cmd(`/tp @s ${x} ${y} ${z} 0 60`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1000);
}

// ------------------------------------------------------------------ the stockpile through the DevBridge and the API

const pile = async (op, payload = {}) => call(`dev.stockpile.${op}`, { owner: OWNER, ...payload }, 120_000);
const pstate = async () => (await pile('state')).stockpile;
const siteState = async (id) => call('dev.site.state', { site: id }, 60_000);
const sites = async () => (await api('sites')).all;

/**
 * The conservation ledger of a fixture (CONTRACT Y §8): per item, the player's inventory + containers (hoppers, chests) + item
 * entities in the area + stockpile stock + paid cells standing + legacy crates' stock + the driver's hand-placed blocks standing
 * + item entities the driver counted and cleared - what the driver injected (dev.crate.insert, /item into a chest). Constant.
 */
class Conservation {
  constructor(area) {
    this.area = area;
    this.injected = {};
    this.cleared = {};
    this.hand = {};
    this.base = null;
    this.points = [];
  }
  add(m, into) { for (const [k, v] of Object.entries(m ?? {})) into[k] = (into[k] ?? 0) + v; }
  async parts() { return pile('audit', { min: this.area.min, max: this.area.max }); }
  total(a) {
    const t = {};
    for (const m of [a.inventory, a.containers, a.entities, a.stock, a.paidStanding, a.legacyCrateStock, this.hand, this.cleared]) this.add(m, t);
    for (const [k, v] of Object.entries(this.injected)) t[k] = (t[k] ?? 0) - v;
    for (const k of Object.keys(t)) if (t[k] === 0) delete t[k];
    return t;
  }
  async start() {
    const a = await this.parts();
    this.base = this.total(a);
    return a;
  }
  /** One checkpoint: the per-item difference from the start (0 for every item passes). */
  async point(label) {
    const a = await this.parts();
    const t = this.total(a);
    const diff = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(this.base)])) {
      const d = (t[k] ?? 0) - (this.base[k] ?? 0);
      if (d !== 0) diff[k] = d;
    }
    const p = { label, diff, identity: a.identity !== false, stock: sum(a.stock), paid: sum(a.paidStanding), entities: sum(a.entities), injected: sum(this.injected), t: a.gameTime };
    this.points.push(p);
    return p;
  }
  /** Inserts through dev.crate.insert (a hopper's rule): what went in counts as injected. */
  async insert(target, items) {
    const r = await call('dev.crate.insert', { site: target, items }, 120_000);
    this.add(r.accepted ?? {}, this.injected);
    return r.accepted ?? {};
  }
  /** Clears the item entities in the area (counted first, so they stay in the sum). */
  async clear() {
    const a = await this.parts();
    this.add(a.entities, this.cleared);
    await cmd(`/kill @e[type=minecraft:item,x=${this.area.min[0]},y=${this.area.min[1]},z=${this.area.min[2]},dx=${this.area.max[0] - this.area.min[0]},dy=${this.area.max[1] - this.area.min[1]},dz=${this.area.max[2] - this.area.min[2]}]`);
    return a.entities;
  }
}
const exact = (p) => Object.keys(p.diff).length === 0 && p.identity;

/** Waits until every listed target is BUILT (or the time runs out); returns the order they finished in. */
async function waitBuilt(ids, timeoutMs = 240_000, onPoll = null) {
  const end = Date.now() + timeoutMs;
  const done = [];
  while (Date.now() < end) {
    const all = await sites();
    for (const id of ids) {
      const s = all.find((x) => x.id === id);
      if (s?.state === 'BUILT' && !done.includes(id)) done.push(id);
    }
    if (onPoll) await onPoll(done);
    if (done.length === ids.length) return done;
    await sleep(1000);
  }
  return done;
}

/** Feeds a target set's whole outstanding bill from the stockpile view, in waves that fit, until nothing is outstanding. */
async function feedAll(cons, target, { shuffle = false, chunk = 0, timeoutMs = 300_000, onWave = null } = {}) {
  const end = Date.now() + timeoutMs;
  let waves = 0;
  while (Date.now() < end) {
    const st = await pstate();
    const need = {};
    for (const [k, v] of Object.entries(st.outstanding ?? {})) {
      const n = v - (st.stock?.[k] ?? 0);
      if (n > 0) need[k] = n;
    }
    if (!Object.keys(need).length) {
      if (!Object.keys(st.outstanding ?? {}).length) return waves;
      await sleep(1000);
      continue;
    }
    let keys = Object.keys(need);
    if (shuffle) keys = keys.sort(() => Math.random() - 0.5);
    for (const k of keys) {
      const n = chunk > 0 ? Math.min(chunk, need[k]) : need[k];
      await cons.insert(target, { [k]: n });
    }
    waves++;
    if (onWave) await onWave(waves);
    await sleep(500);
  }
  throw new Error('feedAll: the outstanding bill did not reach 0');
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const ref = process.env.GATE6CY_REF ?? 'HEAD';
  const head = execFileSync('git', ['-C', root, 'rev-parse', ref]).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? SURV, { backend: 'sim', env: { ARCHITECT_TRACE_STOCKPILE: '1' } });
  spendZero();
  return { head, ref };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  if (!fs.existsSync(path.join(SAVES, SURV, 'level.dat'))) {
    await openWorld(SURV, { mode: 'survival', preset: 'flat', seed: '2026101100', cheats: true });
    for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'spawn_mobs false', 'spawn_monsters false',
      'fire_spread_radius_around_player 0']) await cmd(`/gamerule ${r}`).catch(() => {});
    await cmd('/time set 6000');
    await call('dev.survival.set', { on: true });
    await cmd('/kill @e[type=!minecraft:player]');
    await stand(0.5, 0, 0.5, 'spectator');
    await cmd('/save-all flush');
    await leaveWorld();
  }
  spendZero();
  return { worlds: [SURV] };
};

/** A quick look: a stockpile, one house fed and built (development aid, not a gate item). */
steps.smoke = async () => {
  await ensure();
  await fresh('G6B Y Smoke');
  const X = 200, Z = 200;
  await stand(X + 0.5, 0, Z - 20.5, 'spectator');
  const y = await feet(X, Z);
  const crates = [[X - 6, y, Z - 12], [X - 4, y, Z - 12], [X - 2, y, Z - 12]];
  const c = await pile('create', { crates });
  check(!c.refused && c.stockpile?.crates?.length === 3, `smoke: a 3-crate stockpile (${json(c.refused ?? c.stockpile?.crates)})`);
  const p = await later(`place cabin ${X} ${y} ${Z} CONSTRUCTION owned noactor 0 owner=${OWNER}`);
  check(p.placed, `smoke: a construction cabin of ${OWNER} (${json(p.refusals ?? p.siteId)})`);
  const st = await siteState(p.siteId);
  check(st.stockpile === OWNER && st.crate?.x === undefined, `smoke: it draws from the stockpile, no crate of its own (${st.stockpile}, crate ${json(st.crate)})`);
  const cons = new Conservation({ min: [X - 20, y - 8, Z - 30], max: [X + 30, y + 30, Z + 30] });
  await cons.start();
  const ps = await pstate();
  log(`  outstanding ${json(ps.outstanding)} (${sum(ps.outstanding)} items)`);
  await feedAll(cons, `stockpile:${OWNER}`);
  const done = await waitBuilt([p.siteId]);
  check(done.length === 1, `smoke: built (${json(done)})`);
  const pt = await cons.point('built');
  check(exact(pt), `smoke: conservation exact (${json(pt.diff)})`);
  return { stockpile: await pstate(), points: cons.points };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cy.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
