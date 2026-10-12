#!/usr/bin/env node
// Phase 6c slice Y1 gate (docs/CONTRACT.md "Phase 6c slice Y: settlement stockpile (C24-C26)", gate items 2-9 and 12-13 with
// Steward's two additions: the unloaded-frontier reservation and dissolveStockpile) against a dev client of the Y1 run worktree
// (`../architect-mc-Y1-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the sim sidecar, no Claude,
// apitest on the classpath). Ports 8930 (sidecar) / 8931 (DevBridge) unless the runner gives others. $0: no Claude call anywhere.
//
//   node tools/gate6cy.mjs <step>
//     start [world] | stop | base   the client (GATE6CY_REF: another build, e.g. v0.17.0 for the migration) and the survival base world
//     unit                          item 1 (Y1's part, no game): StockpileTest, FeedOrderTest, ApiY1Test
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
//                                   kill (manual): kill -9 after an autosave; then start, c: reload, the drift recorded against the units moved since that save
//     gone                          item 9: /setblock air on a crate: nothing lost, missingCrates, capacity drops; removeStockpileCrate
//                                   with excess refused, with force drops exactly the excess
//     dissolve                      Steward's addition: dissolve with reserved stock and a building target: conservation exact, crates
//                                   restored, the target waits with no stockpile (C25's "waiting" itself is Y2's)
//     migrate a|b                   item 12: a: on 0.17.0 (GATE6CY_REF=v0.17.0 start) a half-built sharedCrate group and a per-site crate;
//                                   b: this build: loads unchanged, builds finish as before (copy 1); adoptCrates moves the stock in with
//                                   difference 0, cells restored (copy 2); downgrade (c/d) recorded
//     apicompat                     item 14: tools/api-compat.mjs against the 0.19.0, 0.18.0, 0.17.0 apitest jars (each built from its tag) and the 0.19.0 surface
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
const json = (o) => String(JSON.stringify(o)).replaceAll(' ', '');
/** JSON with every object's keys sorted (API maps are unordered). */
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
/** Two item maps equal per item (key order aside; zero counts ignored). */
const same = (a, b) => { const k = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]); for (const x of k) if ((a?.[x] ?? 0) !== (b?.[x] ?? 0)) return false; return true; };

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
    const r = await call('dev.crate.insert', { site: target, items, exact: true }, 120_000);
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
  await startClient(process.argv[3] ?? 'G6B Y Boot', { backend: 'sim', env: { ARCHITECT_TRACE_STOCKPILE: '1' } });
  spendZero();
  return { head, ref };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  const mark = path.join(SAVES, SURV, 'gate6cy-base.json');
  if (!fs.existsSync(mark)) {
    await leaveWorld();
    fs.rmSync(path.join(SAVES, SURV), { recursive: true, force: true });
    await openWorld(SURV, { mode: 'survival', preset: 'flat', seed: '2026101100', cheats: true });
    for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'advance_weather false', 'spawn_mobs false', 'spawn_monsters false',
      'fire_spread_radius_around_player 0']) await cmd(`/gamerule ${r}`).catch(() => {});
    await cmd('/time set 6000');
    await call('dev.survival.set', { on: true });
    await cmd('/kill @e[type=!minecraft:player]');
    await stand(0.5, 0, 0.5, 'spectator');
    await cmd('/save-all flush');
    await leaveWorld();
    fs.writeFileSync(mark, JSON.stringify({ made: new Date().toISOString() }));
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

// ------------------------------------------------------------------ fixtures

const MAIN_ART = path.join(MAIN, 'artifacts');
const V5B = process.env.G5B_VERSIONS ?? path.join(MAIN_ART, 'gate5b', 'versions-smoke');
const LIB = () => path.join(GAME_DIR, 'architect', 'library');
/** Installs a hand-written entry's version 1 (a folder of <id>.* files) as a user library entry (gate5b's helper). */
async function installEntry(id, dir) {
  const d = path.join(LIB(), id);
  if (!d.startsWith(LIB() + path.sep)) throw new Error('bad entry');
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(d, f));
  await cmd('/architect reload');
}
const installVersion = async (entry, dir, summary = '') => call('dev.entry.installVersion', { entry, dir, summary }, 60_000);

/** BoundingBox{minX=.., ...} -> {min, max}. */
function box(str) {
  const n = (k) => Number(new RegExp(`${k}=(-?\\d+)`).exec(str)[1]);
  return { min: [n('minX'), n('minY'), n('minZ')], max: [n('maxX'), n('maxY'), n('maxZ')] };
}
const shift = (b, dx, dz) => ({ min: [b.min[0] + dx, b.min[1], b.min[2] + dz], max: [b.max[0] + dx, b.max[1], b.max[2] + dz] });
const hash = async (b) => (await call('dev.box.hash', { min: b.min, max: b.max }, 300_000)).sha256;
const cellsOf = async (b) => (await call('dev.box.hash', { min: b.min, max: b.max, cells: true }, 300_000)).cells;
const siteOf = async (id) => (await sites()).find((x) => x.id === id);
/**
 * Whether two boxes hold the same blocks cell for cell (block states and block-entity NBT, the NBT's own x/y/z left out: the
 * box hash includes them, so it differs between two places). Returns the differing cells (at most 8).
 */
async function sameCells(a, b) {
  const norm = (line) => line.slice(line.indexOf(' ') + 1).replace(/,x:-?\d+,y:-?\d+,z:-?\d+/g, '');
  const ca = await cellsOf(a), cb = await cellsOf(b);
  const diff = [];
  if (ca.length !== cb.length) return [`sizes ${ca.length} / ${cb.length}`];
  for (let i = 0; i < ca.length && diff.length < 8; i++) if (norm(ca[i]) !== norm(cb[i])) diff.push(`${ca[i]} || ${cb[i]}`);
  return diff;
}

/** A paid road strip: stone under it (a gravel surface costs), one block of step at +20 (fill and slabs). */
async function strip(x0, y, z) {
  await cmd(`/fill ${x0 - 3} ${y - 1} ${z - 3} ${x0 + 42} ${y - 1} ${z + 3} minecraft:stone`);
  await cmd(`/fill ${x0 + 20} ${y} ${z - 3} ${x0 + 42} ${y} ${z + 3} minecraft:stone`);
  return [[x0, y, z], [x0 + 20, y, z], [x0 + 39, y + 1, z]];
}

/**
 * The common fixture: a fresh copy of the survival base, the player a spectator above it, the stockpile with {@code n} crates in a
 * row north-west of the houses. Returns {X, Z, y, crates, area}.
 */
async function fixture(world, { n = 3, X = 200, Z = 200 } = {}) {
  await ensure();
  await fresh(world);
  await stand(X + 40.5, 0, Z + 20.5, 'spectator');
  const y = await feet(X, Z);
  await stand(X + 40.5, y + 30, Z + 20.5, 'spectator');
  const crates = [];
  for (let i = 0; i < n; i++) crates.push([X - 10 + 2 * i, y, Z - 20]);
  const c = n > 0 ? await pile('create', { crates }) : null;
  if (c?.refused) throw new Error(`createStockpile refused: ${json(c.refused)}`);
  return { X, Z, y, crates, area: { min: [X - 40, y - 8, Z - 40], max: [X + 140, y + 40, Z + 160] } };
}

/** Queues a batch and waits until every item is PLACED or FAILED. */
async function batch(spec, timeoutMs = 180_000) {
  const bid = await later(`bqueue ${json(spec)}`);
  const end = Date.now() + timeoutMs;
  let bv;
  while (Date.now() < end) {
    bv = await api(`batch ${bid}`);
    if (bv.items?.every((it) => ['PLACED', 'FAILED', 'SKIPPED'].includes(it.status))) break;
    await sleep(1000);
  }
  return { id: bid, view: bv, items: Object.fromEntries((bv.items ?? []).map((it) => [it.key, it])), group: bv.group };
}
const cabin = (key, at, extra = {}) => ({ key, bp: 'cabin', at, mode: 'AUTO', ...extra });

/** Feeds a legacy construction site (its own crate) its missing items until it is built (no stockpile: the 0.17.0 path). */
async function feedLegacy(site, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = await siteState(site);
    if (st.state !== 'building') return st.state;
    const want = Object.fromEntries((st.rows ?? []).map((r) => [r.item, r.missing]).filter(([, n]) => n > 0));
    if (Object.keys(want).length) await call('dev.crate.insert', { site, items: want, exact: true }, 120_000);
    await sleep(1500);
  }
  return (await siteState(site)).state;
}
/** Cells that differ only between two soil blocks (grass_block and dirt: nature's change, Refunds.SOIL). */
const soilOnly = (d) => /\{id:"minecraft:(grass_block|dirt)"[^|]*\|\| \S+ \{id:"minecraft:(grass_block|dirt)"/.test(d);

// ------------------------------------------------------------------ item 2 + 4: one storehouse, conservation while feeding

steps.store = async () => {
  const f = await fixture('G6B Y Store');
  const { X, Z, y } = f;
  const out = {};
  const DZ = 150;
  await installEntry('g5b_cabin', path.join(V5B, 'v1'));
  // the twins first (INSTANT, owned by another owner, as the player with permission 2), then the targets
  const roadPts = await strip(X, y, Z + 70);
  const soloPts = await strip(X, y, Z + 90);
  const twinPts = await strip(X, y, Z + 70 + DZ);
  const twinSolo = await strip(X, y, Z + 90 + DZ);
  const twins = {};
  for (const [k, x] of [['h1', X], ['h2', X + 30], ['h3', X + 60]]) {
    const t = await later(`place cabin ${x} ${y} ${Z + DZ} INSTANT unowned actor 0 owner=test:twin`);
    check(t.placed, `store: INSTANT twin of ${k} (${json(t.refusals ?? t.siteId)})`);
    twins[k] = t.siteId;
  }
  const t4 = await later(`place g5b_cabin ${X + 100} ${y} ${Z + DZ} INSTANT unowned actor 0 owner=test:twin`);
  twins.h4 = t4.siteId;
  // and a legacy construction twin of the delta target (an owner with no stockpile: its own crate, the 0.17.0 path)
  const DL = 210;
  const t4l = await later(`place g5b_cabin ${X + 100} ${y} ${Z + DL} CONSTRUCTION unowned noactor 0 owner=test:legacy`);
  twins.h4legacy = t4l.siteId;
  for (const [k, pts] of [['r1', twinPts], ['r2', twinSolo]]) {
    const t = await later(`road ${json({ points: pts, width: 1, owner: 'test:twin', mode: 'INSTANT', actor: true, tag: `twin-${k}` })}`);
    check(t.placed, `store: INSTANT twin of road ${k} (${json(t.refusals ?? t.siteId)})`);
    twins[k] = t.siteId;
  }
  // the targets: a batch of 3 houses and a 40-cell C16 road (sharedCrate and crateAt are ignored), a standalone construction road,
  // a g5b_cabin (the delta and revert target)
  const b = await batch({ owner: OWNER, sharedCrate: true, autoApprove: true, crateAt: [X + 90, y, Z - 20], items: [
    cabin('h1', [X, y, Z]), cabin('h2', [X + 30, y, Z]), cabin('h3', [X + 60, y, Z]), { key: 'r1', road: { points: roadPts, width: 1, owner: OWNER, mode: 'AUTO' } }] });
  check(['h1', 'h2', 'h3', 'r1'].every((k) => b.items[k]?.status === 'PLACED'), `store: the batch placed (${json(b.view.items?.map((i) => [i.key, i.status, i.reason, i.message]))})`);
  const solo = await later(`road ${json({ points: soloPts, width: 1, owner: OWNER, mode: 'CONSTRUCTION', tag: 'solo' })}`);
  check(solo.placed, `store: a standalone CONSTRUCTION placeRoad of an owner with a stockpile is accepted (${json(solo.refusals ?? solo.siteId)})`);
  const h4 = await later(`place g5b_cabin ${X + 100} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
  check(h4.placed, `store: the delta target (g5b_cabin v1, construction) placed (${json(h4.refusals ?? h4.siteId)})`);
  const ids = { h1: b.items.h1.site, h2: b.items.h2.site, h3: b.items.h3.site, r1: b.items.r1.site, r2: solo.siteId, h4: h4.siteId };
  out.ids = ids;
  await settle(3000);
  // 0 crates placed besides the 3 named; every target draws from the stockpile
  const cons = new Conservation(f.area);
  const a0 = await cons.start();
  const named = f.crates.map((c) => c.join(','));
  const pid = (await pstate()).id; // crates carry the stockpile's own id, never the owner
  const blocks = (a0.crateBlocks ?? []).map((c) => c.pos);
  check(blocks.length === 3 && blocks.every((p) => named.includes(p)) && a0.crateBlocks.every((c) => c.owner === `stockpile:${pid}`),
    `store: 0 crates placed besides the 3 named (crate blocks in the area: ${json(a0.crateBlocks)})`);
  const g = await api(`sgroup ${b.group}`);
  check(!g?.crate, `store: the batch's group has no shared crate (sharedCrate ignored; ${json(g?.crate)})`);
  const st0 = await pstate();
  check(Object.values(ids).every((id) => st0.feedOrder.includes(id)), `store: all six targets are in the feed order (${json(st0.feedOrder)})`);
  check(st0.feedOrder.indexOf(ids.h1) < st0.feedOrder.indexOf(ids.h2) && st0.feedOrder.indexOf(ids.h2) < st0.feedOrder.indexOf(ids.h3)
    && st0.feedOrder.indexOf(ids.h3) < st0.feedOrder.indexOf(ids.r1), `store: the default order is the batch's item order (${json(st0.feedOrder)})`);
  out.bom = st0.outstanding;
  // feed the whole bill in waves (chunks of 40 per item), a checkpoint after every wave and while building
  await feedAll(cons, `stockpile:${OWNER}`, { chunk: 40, onWave: async (w) => { await cons.point(`wave ${w}`); } });
  const built = await waitBuilt(Object.values(ids), 300_000, async () => { if (cons.points.length < 14) await cons.point('building'); });
  check(built.length === 6, `store: all six targets BUILT from the stockpile (${json(built)})`);
  await settle(2000);
  await cons.point('built');
  // each target cell-identical to its INSTANT twin
  for (const k of ['h1', 'h2', 'h3', 'h4', 'r1', 'r2']) {
    const s0 = await siteOf(ids[k]);
    const bx = box(s0.restoreBox);
    const diff = await sameCells(bx, shift(bx, 0, DZ));
    check(diff.length === 0, `store: ${k} (${ids[k]}) BUILT equals its INSTANT twin cell for cell (block-entity NBT included${diff.length ? `; ${json(diff).slice(0, 300)}` : ''})`);
  }
  // the update delta (v1 -> v2) and the survival revert (forward delta back to v1), from the stockpile; the twin by the instant path
  // v1 -> v3 adds 140 cells, removes 16 and changes 81 (gate5b's versions): removed cells refund at the start, swaps as they happen
  await installVersion('g5b_cabin', path.join(V5B, 'v2'), 'v2');
  const v2 = await installVersion('g5b_cabin', path.join(V5B, 'v3'), 'v3');
  check(v2.version >= 3, `store: g5b_cabin v3 installed (${json(v2)})`);
  const Ps0 = await pstate();
  const Ld0 = Ps0.ledger;
  const Ld0Keys = Ps0.creditedKeys;
  const d = await later(`applydelta ${ids.h4} ${v2.version} ${OWNER}`, 120_000);
  check(d.applied, `store: the construction delta v1 -> v3 of ${ids.h4} (${json(d.refusals ?? d.to)}; refund ${json(d.refund)})`);
  check(await feedLegacy(twins.h4legacy) === 'built', 'store: the legacy twin (own crate) of the delta target is built at v1');
  const dl = await later(`applydelta ${twins.h4legacy} ${v2.version} test:legacy`, 120_000);
  const Ps1 = await pstate();
  const Ld1 = Ps1.ledger;
  const dret = {};
  for (const [k, v] of Object.entries(Ld1.returned)) if (v - (Ld0.returned[k] ?? 0)) dret[k] = v - (Ld0.returned[k] ?? 0);
  // the builder may already have swapped cells (their old blocks return as they happen): returned >= the delta's refund
  check(sum(d.refund) > 0 && Object.entries(d.refund).every(([k, v]) => (dret[k] ?? 0) >= v) && Ps1.creditedKeys === Ld0Keys + 1,
    `store: the delta's removed cells were credited into the stockpile under one key (refund ${sum(d.refund)}, returned ${sum(dret)}; keys ${Ld0Keys} -> ${Ps1.creditedKeys})`);
  out.delta = { refund: d.refund, returned: dret };
  const dt = await later(`applydelta ${twins.h4} ${v2.version} test:twin actor`, 120_000);
  check(dt.applied, `store: the twin's instant delta (${json(dt.refusals ?? dt.to)})`);
  await cons.point('delta applied');
  await feedAll(cons, `stockpile:${OWNER}`, { chunk: 40, onWave: async (w) => { await cons.point(`delta wave ${w}`); } });
  const bd = await waitBuilt([ids.h4]);
  check(bd.length === 1, `store: the delta target BUILT from the stockpile (${json(bd)})`);
  await settle(2000);
  const bx4 = box((await siteOf(ids.h4)).restoreBox);
  const big = { min: [bx4.min[0] - 4, bx4.min[1] - 2, bx4.min[2] - 4], max: [bx4.max[0] + 4, bx4.max[1] + 4, bx4.max[2] + 4] };
  check(dl.applied && await feedLegacy(twins.h4legacy) === 'built', `store: the legacy twin's construction delta is built (${json(dl.refusals ?? dl.to)})`);
  const dd = await sameCells(big, shift(big, 0, DZ));
  const ddl = await sameCells(big, shift(big, 0, DL));
  out.deltaTwin = { instant: dd, legacy: ddl };
  check(ddl.length === 0, `store: after the delta it equals the legacy construction twin (own crate) cell for cell${ddl.length ? ` (${json(ddl).slice(0, 300)})` : ''}`);
  check(dd.every(soilOnly), `store: after the delta it equals the instant twin cell for cell but for soil cells (grass/dirt: ${dd.length}; the same on the legacy construction path, 5b's, not Y1's)${dd.filter((x) => !soilOnly(x)).length ? ` (${json(dd).slice(0, 300)})` : ''}`);
  await cons.point('delta built');
  const Pr0 = await pstate();
  const Lr0 = Pr0.ledger;
  const rv = await later(`srevert ${ids.h4} 1`, 120_000);
  check(rv.applied, `store: the survival revert to v1 is a paid forward delta (${json(rv.refusals ?? rv.to)}; refund ${json(rv.refund)})`);
  const Pr1 = await pstate();
  const Lr1 = Pr1.ledger;
  const rret = {};
  for (const [k, v] of Object.entries(Lr1.returned)) if (v - (Lr0.returned[k] ?? 0)) rret[k] = v - (Lr0.returned[k] ?? 0);
  check(sum(rv.refund) > 0 && Object.entries(rv.refund).every(([k, v]) => (rret[k] ?? 0) >= v) && Pr1.creditedKeys === Pr0.creditedKeys + 1,
    `store: the revert's removed cells were credited into the stockpile under one key (refund ${sum(rv.refund)}, returned ${sum(rret)})`);
  out.revert = { refund: rv.refund, returned: rret };
  const rt = await later(`srevert ${twins.h4} 1 actor`, 120_000);
  check(rt.applied, `store: the twin's instant revert (${json(rt.refusals ?? rt.to)})`);
  const rl = await later(`srevert ${twins.h4legacy} 1`, 120_000);
  check(rl.applied && await feedLegacy(twins.h4legacy) === 'built', `store: the legacy twin's survival revert is built (${json(rl.refusals ?? rl.to)})`);
  await feedAll(cons, `stockpile:${OWNER}`, { chunk: 40, onWave: async (w) => { await cons.point(`revert wave ${w}`); } });
  const br = await waitBuilt([ids.h4]);
  check(br.length === 1, `store: the revert target BUILT from the stockpile (${json(br)})`);
  await settle(2000);
  const dr = await sameCells(big, shift(big, 0, DZ));
  const drl = await sameCells(big, shift(big, 0, DL));
  out.revertTwin = { instant: dr, legacy: drl };
  check(drl.length === 0, `store: after the revert it equals the legacy construction twin cell for cell${drl.length ? ` (${json(drl).slice(0, 300)})` : ''}`);
  check(dr.every(soilOnly), `store: after the revert it equals the instant twin (instant revert) cell for cell but for soil cells (${dr.length})${dr.filter((x) => !soilOnly(x)).length ? ` (${json(dr).slice(0, 300)})` : ''}`);
  const last = await cons.point('end');
  const bad = cons.points.filter((p) => !exact(p));
  out.points = cons.points;
  check(cons.points.length >= 10 && bad.length === 0, `item 4: the conservation sum is constant at ${cons.points.length} checkpoints during feeding and building (differences: ${json(bad.map((p) => [p.label, p.diff]))})`);
  const a1 = await cons.parts();
  check((a1.crateBlocks ?? []).length === 3, `store: still only the 3 named crates (${json(a1.crateBlocks)})`);
  out.stockpile = await pstate();
  out.last = last;
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 3: feed order

/** A solid cell of a site's target (from its INSTANT twin's cells, shifted back), at the lowest wall layer above the floor. */
async function solidCell(twinBox, dz) {
  const cells = await cellsOf(twinBox);
  const solid = [];
  for (const line of cells) {
    const sp = line.indexOf(' ');
    const [x, y, z] = line.slice(0, sp).split(',').map(Number);
    const b = line.slice(sp + 1);
    if (/spruce_log|planks|cobblestone$/.test(b) && !/slab|stairs/.test(b)) solid.push([x, y, z, b]);
  }
  const ys = [...new Set(solid.map((c) => c[1]))].sort((a, b) => a - b);
  const layer = solid.filter((c) => c[1] === (ys[1] ?? ys[0]));
  const c = layer[Math.floor(layer.length / 2)];
  return [c[0], c[1], c[2] - dz, c[3]];
}

steps.order = async () => {
  const f = await fixture('G6B Y Order');
  const { X, Z, y } = f;
  const out = {};
  const b = await batch({ owner: OWNER, autoApprove: true, items: [cabin('h1', [X, y, Z]), cabin('h2', [X + 30, y, Z]), cabin('h3', [X + 60, y, Z])] });
  const ids = { h1: b.items.h1.site, h2: b.items.h2.site, h3: b.items.h3.site };
  check(Object.values(ids).every(Boolean), `order: three houses placed (${json(ids)})`);
  const o1 = await api(`porder ${OWNER} ${ids.h3}`);
  check(json(o1) === json([ids.h3, ids.h1, ids.h2]), `order: setFeedOrder puts house 3 first, the others keep their order (${json(o1)})`);
  const bad = await api(`porder ${OWNER} s9999`);
  check(bad?.refused?.reason === 'FIELD_LIMIT' && /s9999/.test(bad.refused.message), `order: an unknown id refuses FIELD_LIMIT naming it (${json(bad)})`);
  const cons = new Conservation(f.area);
  await cons.start();
  const finished = [];
  const watch = async () => { for (const id of await waitBuilt(Object.values(ids), 1)) if (!finished.includes(id)) finished.push(id); };
  await feedAll(cons, `stockpile:${OWNER}`, { shuffle: true, chunk: 12, onWave: watch });
  const done = await waitBuilt(Object.values(ids), 240_000, async (d) => { for (const id of d) if (!finished.includes(id)) finished.push(id); });
  out.finished = finished;
  check(done.length === 3 && json(finished) === json([ids.h3, ids.h1, ids.h2]), `item 3: fed the exact total BOM in shuffled order, house 3 is BUILT first, then the rest in order (${json(finished)})`);
  const p1 = await cons.point('order built');
  check(exact(p1), `order: conservation exact (${json(p1.diff)})`);
  // ---- house 6 first and blocked by a player in one of its cells: the others build only from surplus
  const DZ = 150;
  const Z2 = Z + 50;
  const tw = await later(`place cabin ${X + 60} ${y} ${Z2 + DZ} INSTANT unowned actor 0 owner=test:twin`);
  const b2 = await batch({ owner: OWNER, autoApprove: true, items: [cabin('h4', [X, y, Z2]), cabin('h5', [X + 30, y, Z2]), cabin('h6', [X + 60, y, Z2])] });
  const id2 = { h4: b2.items.h4.site, h5: b2.items.h5.site, h6: b2.items.h6.site };
  await api(`porder ${OWNER} ${id2.h6}`);
  const tb = box((await siteOf(tw.siteId)).restoreBox);
  const cell = await solidCell(tb, DZ);
  out.blockedCell = cell;
  // the player (creative, no gravity) stands in that cell
  await cmd('/gamemode creative');
  await cmd('/attribute @s minecraft:gravity base set 0');
  await cmd(`/tp @s ${cell[0] + 0.5} ${cell[1]} ${cell[2] + 0.5}`);
  await sleep(1000);
  const st = await pstate();
  const bom6 = st.targets[id2.h6].outstanding;
  const E = { 'minecraft:cobblestone': 20, 'minecraft:spruce_planks': 20 };
  const feed = { ...bom6 };
  for (const [k, v] of Object.entries(E)) feed[k] = (feed[k] ?? 0) + v;
  const before = (await cons.parts()).paidByTarget;
  for (const [k, v] of Object.entries(feed)) await cons.insert(`stockpile:${OWNER}`, { [k]: v });
  await sleep(15_000);
  const mid = await cons.parts();
  const st2 = await pstate();
  const out6 = st2.targets[id2.h6]?.outstanding ?? {};
  const used = {};
  for (const id of [id2.h4, id2.h5]) for (const [k, v] of Object.entries(mid.paidByTarget[id] ?? {})) used[k] = (used[k] ?? 0) + v - (before[id]?.[k] ?? 0);
  out.blocked = { outstanding6: out6, usedByOthers: used, stock: st2.stock, reserved: st2.reserved };
  // C25 (Y2) through the stockpile: house 4 waits, and its nextNeeded sees the stock house 6 reserves as unavailable
  const w4 = await api(`waiting ${id2.h4}`);
  const need4 = sum(st2.targets[id2.h4]?.outstanding);
  const shown = sum(Object.fromEntries((w4?.nextNeeded ?? []).map((x) => [x.item, x.count]))) + (w4?.moreUnits ?? 0);
  out.blocked.wait4 = w4;
  check(w4?.waiting === true && shown === need4, `item 3 + C25: house 4 waits and its nextNeeded counts the reserved stock as unavailable (counts + moreUnits ${shown} = outstanding ${need4})`);
  const pw = await api(`pstate ${OWNER}`);
  check(pw?.waiting >= 1, `C25: Stockpile.waiting carries the targets' waits (${pw?.waiting})`);
  const surplusOnly = Object.entries(used).every(([k, v]) => v <= (E[k] ?? 0));
  check(surplusOnly && sum(used) > 0, `item 3: with house 6 blocked (a player in ${cell.slice(0, 3)}), the others used only the surplus (${json(used)} of ${json(E)})`);
  const held = Object.entries(out6).every(([k, v]) => (st2.stock[k] ?? 0) >= v);
  check(sum(out6) > 0 && held, `item 3: house 6 still holds its reservation for the blocked cells (outstanding ${json(out6)}, stock ${json(st2.stock)})`);
  await cmd('/attribute @s minecraft:gravity base set 0.08');
  await stand(X + 40.5, y + 30, Z + 20.5, 'spectator');
  const d6 = await waitBuilt([id2.h6], 120_000);
  check(d6.length === 1, `order: the player stepped out, house 6 is BUILT (${json(d6)})`);
  const p2 = await cons.point('blocked done');
  check(exact(p2), `order: conservation exact (${json(p2.diff)})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ Steward S-Y-1: a target whose whole frontier is unloaded

steps.unloaded = async () => {
  const f = await fixture('G6B Y Unloaded');
  const { X, Z, y } = f;
  const out = {};
  const FAR = X + 3000;
  // A far away (placed while the player is there), then B and C at home
  await stand(FAR + 0.5, y + 30, Z + 0.5, 'spectator');
  const a = await later(`place cabin ${FAR} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
  check(a.placed, `unloaded: A placed far away (${json(a.refusals ?? a.siteId)})`);
  await settle(3000);
  await stand(X + 40.5, y + 30, Z + 20.5, 'spectator');
  const bb = await later(`place cabin ${X} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
  const cc = await later(`place cabin ${X + 30} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
  const ids = { A: a.siteId, B: bb.siteId, C: cc.siteId };
  out.ids = ids;
  const o = await api(`porder ${OWNER} ${ids.A} ${ids.B} ${ids.C}`);
  check(json(o) === json([ids.A, ids.B, ids.C]), `unloaded: feed order A, B, C (${json(o)})`);
  // wait until A's chunks are unloaded (its frontier unloaded: it doesn't reserve)
  let st;
  const abox = box((await siteOf(ids.A)).restoreBox);
  const chunkBox = [abox.min[0], abox.min[2], abox.max[0], abox.max[2]];
  out.chunks = [];
  for (let i = 0; i < 120; i++) {
    st = await pstate();
    const cs = await call('dev.chunks.status', { box: chunkBox }, 60_000);
    if (i % 10 === 0) out.chunks.push([i, cs.loaded, st.targets[ids.A]?.frontierLoaded]);
    if (st.targets[ids.A]?.frontierLoaded === false) break;
    await sleep(1000);
  }
  log(`  A's chunks while waiting: ${json(out.chunks)}`);
  check(st.targets[ids.A]?.frontierLoaded === false && st.targets[ids.A]?.reserves === false, `unloaded: A's whole frontier is in unloaded chunks: it doesn't reserve (${json(st.targets[ids.A])})`);
  const cons = new Conservation(f.area);
  await cons.start();
  const bomB = st.targets[ids.B].outstanding;
  const aBefore = sum(st.targets[ids.A].outstanding);
  for (const [k, v] of Object.entries(bomB)) await cons.insert(`stockpile:${OWNER}`, { [k]: v });
  const db = await waitBuilt([ids.B], 120_000);
  check(db.length === 1, `unloaded: the loaded second target B is fed and builds while A (first) is unloaded (${json(db)})`);
  // C gets the surplus while A is unloaded
  await cons.insert(`stockpile:${OWNER}`, { 'minecraft:cobblestone': 10 });
  await sleep(4000);
  const c1 = (await cons.parts()).paidByTarget[ids.C] ?? {};
  check((c1['minecraft:cobblestone'] ?? 0) >= 1, `unloaded: with A unloaded, C (third) takes cobblestone A also needs (${json(c1)})`);
  // A's chunks load (forceload): its reservation returns, it is fed first again
  const ab = { min: [FAR - 10, y, Z - 10], max: [FAR + 30, y, Z + 40] };
  await cmd(`/forceload add ${ab.min[0]} ${ab.min[2]} ${ab.max[0]} ${ab.max[2]}`);
  for (let i = 0; i < 60; i++) {
    st = await pstate();
    if (st.targets[ids.A]?.reserves === true) break;
    await sleep(1000);
  }
  check(st.targets[ids.A]?.reserves === true, `unloaded: once A's chunks load, it reserves again (${json(st.targets[ids.A])})`);
  const cPaid0 = sum((await cons.parts()).paidByTarget[ids.C]);
  const needA = st.targets[ids.A].outstanding;
  for (const [k, v] of Object.entries(needA)) {
    const n = v - (st.stock[k] ?? 0);
    if (n > 0) await cons.insert(`stockpile:${OWNER}`, { [k]: n });
  }
  const da = await waitBuilt([ids.A], 180_000);
  const cPaid1 = sum((await cons.parts()).paidByTarget[ids.C]);
  out.A = { outstandingBefore: aBefore, c: [cPaid0, cPaid1] };
  check(da.length === 1 && cPaid1 === cPaid0, `unloaded: A (first, loaded) took its whole bill; C took nothing meanwhile (C paid ${cPaid0} -> ${cPaid1})`);
  await cmd(`/forceload remove ${ab.min[0]} ${ab.min[2]} ${ab.max[0]} ${ab.max[2]}`);
  const p = await cons.point('unloaded end');
  check(exact(p), `unloaded: conservation exact (${json(p.diff)})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 5: refunds

/** Air cells of a site's box (from its INSTANT twin's cells, shifted back): not queued (the queue is what an instant placement wrote). */
async function airCells(twinBox, dz, n) {
  const cells = await cellsOf(twinBox);
  const cx = (twinBox.min[0] + twinBox.max[0]) / 2, cz = (twinBox.min[2] + twinBox.max[2]) / 2;
  const air = [];
  for (const line of cells) {
    const sp = line.indexOf(' ');
    const [x, y, z] = line.slice(0, sp).split(',').map(Number);
    if (/^\{id:"minecraft:air"\}/.test(line.slice(sp + 1)) && y > twinBox.min[1] + 1 && y < twinBox.max[1] - 1) air.push([x, y, z - dz, Math.abs(x - cx) + Math.abs(z - cz)]);
  }
  air.sort((p, q) => p[3] - q[3] || p[1] - q[1]);
  return air.slice(0, n).map((c) => c.slice(0, 3));
}

steps.refunds = async () => {
  const f = await fixture('G6B Y Refunds');
  const { X, Z, y } = f;
  const out = {};
  const DZ = 150;
  const roadPts = await strip(X, y, Z + 70);
  const tw = await later(`place cabin ${X} ${y} ${Z + DZ} INSTANT unowned actor 0 owner=test:twin`);
  const b = await batch({ owner: OWNER, autoApprove: true, items: [cabin('h1', [X, y, Z]), cabin('h2', [X + 30, y, Z]),
    { key: 'r1', road: { points: roadPts, width: 1, owner: OWNER, mode: 'AUTO' } }] });
  const ids = { h1: b.items.h1.site, h2: b.items.h2.site, r1: b.items.r1.site };
  const cons = new Conservation(f.area);
  await cons.start();
  await feedAll(cons, `stockpile:${OWNER}`);
  check((await waitBuilt(Object.values(ids))).length === 3, 'refunds: two houses and the road BUILT');
  // the player's blocks: 3 stone in air cells of house 1 (not queued)
  const hand = await airCells(box((await siteOf(tw.siteId)).restoreBox), DZ, 3);
  check(hand.length === 3, `refunds: three air cells of house 1 for the player's blocks (${json(hand)})`);
  for (const c of hand) await cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:stone`);
  cons.add({ 'minecraft:stone': hand.length }, cons.injected);
  cons.add({ 'minecraft:stone': hand.length }, cons.hand);
  await settle(1000);
  const p0 = await cons.point('before the deconstruct');
  check(exact(p0), `refunds: conservation exact before (${json(p0.diff)})`);
  const a0 = await cons.parts();
  const L0 = (await pstate()).ledger;
  const paidH1 = a0.paidByTarget[ids.h1];
  // deconstruct house 1
  const rm = await later(`remove ${ids.h1} ${OWNER} noforce`, 300_000);
  await settle(2000);
  cons.hand = {}; // the player's blocks are no longer standing (they dropped)
  const L1 = (await pstate()).ledger;
  const ret1 = {};
  for (const [k, v] of Object.entries(L1.returned)) if (v - (L0.returned[k] ?? 0)) ret1[k] = v - (L0.returned[k] ?? 0);
  out.h1 = { paid: paidH1, returned: ret1, removeResult: rm.refund, hand };
  check(rm.removed && same(ret1, paidH1), `item 5: deconstruct ${ids.h1}: returned equals its Refunds tally (the paid cells standing) (${sum(ret1)} vs ${sum(paidH1)}; ${json(rm.blockers ?? [])})`);
  const near = await call('dev.items.near', { pos: [X + 5, y + 2, Z + 5], radius: 16 }, 30_000);
  check((near.items?.['minecraft:stone'] ?? 0) === hand.length, `item 5: the player's ${hand.length} blocks drop at the site (${json(near.items)})`);
  const p1 = await cons.point('h1 deconstructed');
  check(exact(p1), `item 5: conservation difference 0 after the deconstruct (${json(p1.diff)})`);
  // undo the road
  const paidR1 = (await cons.parts()).paidByTarget[ids.r1];
  const L2 = (await pstate()).ledger;
  const rr = await later(`remove ${ids.r1} ${OWNER} noforce`, 300_000);
  await settle(3000);
  const L3 = (await pstate()).ledger;
  const ret2 = {};
  for (const [k, v] of Object.entries(L3.returned)) if (v - (L2.returned[k] ?? 0)) ret2[k] = v - (L2.returned[k] ?? 0);
  out.r1 = { paid: paidR1, returned: ret2 };
  check(rr.removed && same(ret2, paidR1), `item 5: undo the road ${ids.r1}: returned equals its tally (${json(ret2)} vs ${json(paidR1)})`);
  const p2 = await cons.point('road undone');
  check(exact(p2), `item 5: conservation difference 0 after the road's undo (${json(p2.diff)})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 6: overflow

steps.overflow = async () => {
  const f = await fixture('G6B Y Overflow', { n: 1 });
  const { X, Z, y } = f;
  const out = {};
  const b = await batch({ owner: OWNER, autoApprove: true, items: [cabin('h1', [X, y, Z]), cabin('h2', [X + 30, y, Z])] });
  const ids = { h1: b.items.h1.site, h2: b.items.h2.site };
  const cons = new Conservation(f.area);
  await cons.start();
  await feedAll(cons, `stockpile:${OWNER}`, { timeoutMs: 600_000 });
  check((await waitBuilt(Object.values(ids))).length === 2, 'overflow: two houses BUILT through a one-crate (27 stacks) stockpile, fed in waves');
  out.removals = [];
  for (const id of [ids.h1, ids.h2]) {
    await cons.clear();
    const a = await cons.parts();
    const st0 = await pstate();
    const paid = a.paidByTarget[id];
    const rm = await later(`remove ${id} ${OWNER} noforce`, 300_000);
    await settle(2000);
    const st1 = await pstate();
    const d = (k) => {
      const m = {};
      for (const [i, v] of Object.entries(st1.ledger[k])) if (v - (st0.ledger[k][i] ?? 0)) m[i] = v - (st0.ledger[k][i] ?? 0);
      return m;
    };
    const ret = d('returned'), over = d('refundOverflow');
    const crate = f.crates[0];
    const ents = (await call('dev.items.near', { pos: [crate[0], crate[1] + 1, crate[2]], radius: 3 }, 30_000)).items ?? {};
    const both = { ...ret };
    for (const [k, v] of Object.entries(over)) both[k] = (both[k] ?? 0) + v;
    out.removals.push({ id, usedBefore: st0.usedStacks, usedAfter: st1.usedStacks, capacity: st1.capacityStacks, paid, returned: ret, overflow: over, entities: ents });
    check(rm.removed && same(both, paid), `item 6: ${id}: returned + refundOverflow = its tally (${sum(ret)} + ${sum(over)} = ${sum(paid)})`);
    check(st1.usedStacks <= st1.capacityStacks, `item 6: ${id}: returned up to capacity (${st1.usedStacks} of ${st1.capacityStacks} stacks)`);
    check(same(over, ents), `item 6: ${id}: refundOverflow equals the item entities counted at the crate (${json(over)} vs ${json(ents)})`);
    const p = await cons.point(`${id} removed`);
    check(exact(p), `item 6: ${id}: conservation difference 0 (${json(p.diff)})`);
  }
  check(out.removals.some((r) => sum(r.overflow) > 0), 'item 6: a deconstruct overflowed (capacity was full of credit)');
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 7: credited once

steps.once = async () => {
  const f = await fixture('G6B Y Once');
  const { X, Z, y } = f;
  const out = {};
  const W = 'G6B Y Once';
  const roadPts = await strip(X, y, Z + 70);
  // the road, an INSTANT house, then the construction house: the removal (last placed first) credits the construction house, then
  // the instant house's restore breaks (dev.undo.failRestore hits a site's restore job); the retry restores it and the road.
  // The instant house stands outside the counted area: a broken restore drops its attachables, which never were the stockpile's
  const b = await batch({ owner: OWNER, autoApprove: true, items: [{ key: 'r1', road: { points: roadPts, width: 1, owner: OWNER, mode: 'AUTO' } },
    cabin('i1', [X + 200, y, Z], { mode: 'INSTANT', actor: true, after: ['r1'] }), cabin('h1', [X, y, Z], { after: ['i1'] })] });
  check(['r1', 'i1', 'h1'].every((k) => b.items[k]?.status === 'PLACED'), `once: road, instant house and construction house placed (${json(b.view.items?.map((i) => [i.key, i.status, i.message]))})`);
  const ids = { h1: b.items.h1.site, r1: b.items.r1.site };
  const cons = new Conservation(f.area);
  await cons.start();
  await feedAll(cons, `stockpile:${OWNER}`);
  check((await waitBuilt(Object.values(ids))).length === 2, 'once: the house and the road BUILT');
  const a0 = await cons.parts();
  const paid = { h1: a0.paidByTarget[ids.h1], r1: a0.paidByTarget[ids.r1] };
  const L0 = (await pstate()).ledger;
  await call('dev.undo.failRestore', { skip: 0 });
  const r1 = await later(`sgremove ${b.group} noforce ${OWNER}`, 600_000);
  await call('dev.undo.failRestore', { skip: -1 });
  await settle(2000);
  const L1 = (await pstate()).ledger;
  const dret = (A, B) => { const m = {}; for (const [k, v] of Object.entries(B.returned)) if (v - (A.returned[k] ?? 0)) m[k] = v - (A.returned[k] ?? 0); return m; };
  out.first = { removed: r1.removed, blockers: r1.blockers, returned: dret(L0, L1) };
  check(r1.removed === false && /injected restore failure/.test(JSON.stringify(r1.blockers)), `item 7: the removal with an injected restore failure answers removed=false (${json(r1.blockers).slice(0, 160)})`);
  check(same(dret(L0, L1), paid.h1), `item 7: the construction house (restored before the break) was credited, the road not yet (${sum(dret(L0, L1))} vs ${sum(paid.h1)})`);
  const pm = await cons.point('after the failure');
  // the half-done state is the failed restore's: the road's blocks still stand (paid), its refund not credited: still exact
  check(exact(pm), `item 7: conservation difference 0 after the failed removal (${json(pm.diff)})`);
  // save, reload, retry: the removal resumes; the house's key is found, nothing credited twice
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld(W);
  const r2 = await later(`sgremove ${b.group} noforce ${OWNER}`, 600_000);
  await settle(3000);
  const L2 = (await pstate()).ledger;
  const tot = { ...paid.h1 };
  for (const [k, v] of Object.entries(paid.r1)) tot[k] = (tot[k] ?? 0) + v;
  out.retry = { removed: r2.removed, returned: dret(L0, L2) };
  check(r2.removed === true, `item 7: the retry after the reload resumes and answers removed=true (${json(r2.blockers ?? [])})`);
  check(same(dret(L0, L2), tot), `item 7: every refund credited once: returned = house + road exactly (${sum(dret(L0, L2))} vs ${sum(tot)})`);
  const again = await later(`sgremove ${b.group} noforce ${OWNER}`, 120_000);
  const L3 = (await pstate()).ledger;
  check(again.removed === true && same(L3.returned, L2.returned), 'item 7: a third remove answers removed=true and credits nothing');
  const p = await cons.point('once end');
  check(exact(p), `item 7: conservation difference 0 (${json(p.diff)})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 8: restart mid-feed

const RESTART = 'G6B Y Restart';
const rstate = path.join(OUT, 'restart-state.json');
steps.restart = async () => {
  const part = process.argv[3] ?? 'a';
  const out = { part };
  if (part === 'a') {
    const f = await fixture(RESTART);
    const { X, Z, y } = f;
    const h = await later(`place cabin ${X} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
    // a hopper chain on crate 3: a chest above a hopper above the crate
    const c3 = f.crates[2];
    await cmd(`/setblock ${c3[0]} ${c3[1] + 1} ${c3[2]} minecraft:hopper[facing=down]`);
    await cmd(`/setblock ${c3[0]} ${c3[1] + 2} ${c3[2]} minecraft:chest`);
    const cons = new Conservation(f.area);
    await cons.start();
    const need = (await pstate()).outstanding;
    let slot = 0;
    for (const [k, v] of Object.entries(need)) {
      if (slot >= 27) break;
      const n = Math.min(v, 64);
      await cmd(`/item replace block ${c3[0]} ${c3[1] + 2} ${c3[2]} container.${slot++} with ${k} ${n}`);
      cons.add({ [k]: n }, cons.injected);
    }
    // the chest holds exact needs only (a unit no target misses would go in as an equivalent: not counted in its own unit)
    await sleep(4000);
    const pt = await cons.point('feeding');
    check(exact(pt), `restart a: conservation exact while feeding (${json(pt.diff)})`);
    const a = await cons.parts();
    check(sum(a.containers) > 0 && sum(a.paidStanding) > 0, `restart a: hoppers feed (chest/hopper ${sum(a.containers)}) and the builder places (paid ${sum(a.paidStanding)})`);
    out.before = { point: pt, built: (await siteOf(h.siteId)).built };
    fs.writeFileSync(rstate, JSON.stringify({ site: h.siteId, area: f.area, crates: f.crates, base: cons.base, injected: cons.injected, built: out.before.built }));
    await leaveWorld(); // a clean stop (save and quit) while the hopper feeds and the builder places
    const file = JSON.parse(fs.readFileSync(path.join(SAVES, RESTART, 'architect', 'stockpiles.json'), 'utf8'));
    fs.writeFileSync(path.join(OUT, 'restart-file.json'), JSON.stringify(file, null, 1));
    return out;
  }
  const r = JSON.parse(fs.readFileSync(rstate, 'utf8'));
  const cons = new Conservation(r.area);
  cons.base = r.base;
  cons.injected = r.injected;
  if (part === 'b') {
    await ensure();
    await openWorld(RESTART);
    const saved = await pile('saved');
    const file = JSON.parse(fs.readFileSync(path.join(OUT, 'restart-file.json'), 'utf8'));
    check(json(saved.loaded) === json(file), 'item 8: the ledger loaded after the clean stop equals the one the stop saved (stockpiles.json)');
    const p = await cons.point('after the reload');
    check(exact(p), `item 8: conservation difference 0 after the reload (${json(p.diff)})`);
    await sleep(5000);
    const built = (await siteOf(r.site)).built;
    check(built > r.built, `item 8: building resumes (${r.built} -> ${built} cells)`);
    out.after = { point: p, built };
    return out;
  }
  if (part === 'kill') {
    // the hard kill (manual: the runner's client can't be killed under it): an autosave, more feeding and building, then kill -9
    await ensure();
    if (!(await call('dev.state')).inWorld) await openWorld(RESTART);
    await cmd('/save-all');
    await sleep(1000);
    const atSave = await cons.parts();
    const totSave = cons.total(atSave);
    const injAtSave = { ...cons.injected };
    await cons.insert(`stockpile:${OWNER}`, { 'minecraft:dark_oak_stairs': 30, 'minecraft:dark_oak_planks': 30 });
    await sleep(3000);
    const pre = await cons.parts();
    const moved = {};
    for (const k of new Set([...Object.keys(pre.ledger.consumed), ...Object.keys(pre.ledger.delivered)])) {
      const m = (pre.ledger.consumed[k] ?? 0) - (atSave.ledger.consumed[k] ?? 0) + (pre.ledger.delivered[k] ?? 0) - (atSave.ledger.delivered[k] ?? 0);
      if (m) moved[k] = m;
    }
    fs.writeFileSync(rstate, JSON.stringify({ ...r, totSave, injAtSave, moved, base: cons.base, injected: cons.injected }));
    const pids = clientPids();
    log(`kill -9 my client ${pids}`);
    for (const pid of pids) process.kill(pid, 'SIGKILL');
    try { state.dev?.close(); } catch { /* gone */ }
    state.dev = null;
    for (let i = 0; i < 60 && clientPids().length; i++) await sleep(1000);
    out.kill = { moved, pids };
    return out;
  }
  if (part === 'c') {
    // after `start` (the client opens the boot world), the killed world again
    await ensure();
    fs.rmSync(path.join(SAVES, RESTART, 'session.lock'), { force: true });
    await openWorld(RESTART);
    const a = await cons.parts();
    const now = cons.total(a);
    const drift = {};
    for (const k of new Set([...Object.keys(now), ...Object.keys(r.totSave)])) {
      const d = (now[k] ?? 0) - (r.totSave[k] ?? 0);
      if (d) drift[k] = d;
    }
    // what the driver injected after the save was lost with the kill (the ledger and chunks are the save's): count it back
    for (const [k, v] of Object.entries(cons.injected)) {
      const after = v - (r.injAtSave[k] ?? 0);
      if (after) drift[k] = (drift[k] ?? 0) + after;
      if (drift[k] === 0) delete drift[k];
    }
    const within = Object.entries(drift).every(([k, v]) => Math.abs(v) <= Math.abs(r.moved[k] ?? 0));
    out.kill = { drift, moved: r.moved };
    check(within, `item 8: hard kill after an autosave: drift ${json(drift)} (recorded; within the units moved since that save ${json(r.moved)})`);
    await leaveWorld();
    return out;
  }
  throw new Error(`restart part ${part}?`);
};

// ------------------------------------------------------------------ item 9: a crate gone

steps.gone = async () => {
  const f = await fixture('G6B Y Gone');
  const { X, Z, y } = f;
  const out = {};
  const b = await batch({ owner: OWNER, autoApprove: true, items: [cabin('h1', [X, y, Z]), cabin('h2', [X + 30, y, Z])] });
  const ids = [b.items.h1.site, b.items.h2.site];
  for (const id of ids) await pile('pause', { site: id, paused: true });
  const cons = new Conservation(f.area);
  await cons.start();
  const need = (await pstate()).outstanding;
  for (const [k, v] of Object.entries(need)) await cons.insert(`stockpile:${OWNER}`, { [k]: v });
  const st0 = await pstate();
  out.stocked = { used: st0.usedStacks, capacity: st0.capacityStacks };
  check(st0.usedStacks > 27, `item 9: the stock fills more than one crate (${st0.usedStacks} of ${st0.capacityStacks} stacks; paused targets keep it)`);
  const [c1, c2] = f.crates;
  await cmd(`/setblock ${c1[0]} ${c1[1]} ${c1[2]} minecraft:air`);
  await settle(1000);
  const st1 = await pstate();
  out.gone = { missing: st1.missingCrates, capacity: st1.capacityStacks, stock: sum(st1.stock) };
  check(json(st1.missingCrates) === json([c1]) && st1.capacityStacks === st0.capacityStacks - 27 && json(st1.stock) === json(st0.stock),
    `item 9: /setblock air on a crate: nothing lost, missingCrates lists it, capacity drops by 27 (${json(st1.missingCrates)}, ${st0.capacityStacks} -> ${st1.capacityStacks})`);
  const p1 = await cons.point('crate gone');
  check(exact(p1), `item 9: conservation difference 0 (${json(p1.diff)})`);
  const r1 = await pile('removecrate', { pos: c2 });
  check(r1.removed === false && /capacity/.test(r1.refusal ?? ''), `item 9: removeStockpileCrate with excess is refused (${r1.refusal})`);
  await cons.clear();
  const before = await pstate();
  const r2 = await pile('removecrate', { pos: c2, force: true });
  await settle(1000);
  const after = await pstate();
  const ents = (await call('dev.items.near', { pos: c2, radius: 3 }, 30_000)).items ?? {};
  const dd = {};
  for (const [k, v] of Object.entries(after.ledger.dropped)) if (v - (before.ledger.dropped[k] ?? 0)) dd[k] = v - (before.ledger.dropped[k] ?? 0);
  out.force = { dropped: r2.dropped, ledgerDropped: dd, entities: ents, used: after.usedStacks, capacity: after.capacityStacks };
  check(r2.removed === true && same(r2.dropped, dd) && same(dd, ents) && after.usedStacks <= after.capacityStacks && after.usedStacks
    >= after.capacityStacks - 1, `item 9: with force it drops exactly the excess (${sum(dd)} items; entities ${sum(ents)}; ${after.usedStacks} of ${after.capacityStacks} stacks left)`);
  const p2 = await cons.point('forced');
  check(exact(p2), `item 9: conservation difference 0 after the forced removal (${json(p2.diff)})`);
  // the last crate can't go while targets build, even with force
  // the missing crate's record goes (it held nothing; the capacity stays), then the third is the last one
  const gone1 = await pile('removecrate', { pos: c1 });
  check(gone1.removed === true, `item 9: the missing crate's record is removed (${json(gone1.refusal ?? gone1.removed)})`);
  const last = await pile('removecrate', { pos: f.crates[2], force: true });
  check(last.removed === false && /last crate/.test(last.refusal ?? ''), `item 9: the last crate with targets building is refused even with force (${last.refusal})`);
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ Steward's addition: dissolveStockpile

steps.dissolve = async () => {
  const f = await fixture('G6B Y Dissolve');
  const { X, Z, y } = f;
  const out = {};
  const h = await later(`place cabin ${X} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
  const cons = new Conservation(f.area);
  await cons.start();
  const need = (await pstate()).outstanding;
  for (const [k, v] of Object.entries(need)) await cons.insert(`stockpile:${OWNER}`, { [k]: Math.ceil(v / 2) });
  await sleep(3000);
  const st0 = await pstate();
  out.before = { stock: st0.stock, reserved: st0.reserved };
  check(sum(st0.reserved) > 0, `dissolve: the building target holds reserved stock (${sum(st0.reserved)} items)`);
  // the player stands next to the crates (creative: the inventory takes the items)
  await stand(f.crates[0][0] + 0.5, y, f.crates[0][2] - 2.5, 'creative');
  const d = await pile('dissolve', { toPlayer: true });
  await settle(1000);
  out.dissolve = { out: d.out, ledgerAtEnd: d.ledgerAtEnd };
  const L = d.ledgerAtEnd;
  const ids = new Set([...Object.keys(L.delivered), ...Object.keys(L.returned)]);
  let ok = true;
  for (const k of ids) {
    const s = (L.delivered[k] ?? 0) + (L.returned[k] ?? 0) - (L.consumed[k] ?? 0) - (L.withdrawn[k] ?? 0) - (L.dropped[k] ?? 0);
    if (s !== 0) ok = false;
  }
  check(ok && d.stockpile === null, `dissolve: every unit counted in withdrawn or dropped (the identity ends at 0); the stockpile ended (${json(d.out).slice(0, 120)})`);
  const p = await cons.point('dissolved');
  check(exact(p), `dissolve: conservation sum exact (${json(p.diff)})`);
  const a = await cons.parts();
  check((a.crateBlocks ?? []).length === 0, `dissolve: every crate block restored (${json(a.crateBlocks)})`);
  const cells = [];
  for (const c of f.crates) cells.push((await cellsOf({ min: c, max: c }))[0]);
  check(cells.every((c) => /minecraft:air"\}$/.test(c)), `dissolve: the crate cells hold what they held before (${json(cells)})`);
  const s0 = await siteState(h.siteId);
  await sleep(8000);
  const s1 = await siteState(h.siteId);
  out.target = { state: s1.state, paused: s1.paused, noStockpile: s1.noStockpile, built: [s0.built, s1.built] };
  check(s1.state === 'building' && !s1.paused && s1.noStockpile === true && s1.built === s0.built,
    `dissolve: the target keeps building with no stockpile: not paused, nothing placed in 120 ticks (${json(out.target)})`);
  const w = await api(`waiting ${h.siteId}`);
  const outst = sum(Object.fromEntries((s1.rows ?? []).map((r) => [r.item, r.needed - r.placed]).filter(([, n]) => n > 0)));
  const shownD = sum(Object.fromEntries((w?.nextNeeded ?? []).map((x) => [x.item, x.count]))) + (w?.moreUnits ?? 0);
  out.target.wait = w;
  check(w?.waiting === true && shownD > 0, `dissolve: the target reports waiting (C25) with no stockpile: nextNeeded ${shownD} units (${json(w).slice(0, 160)})`);
  void outst;
  await leaveWorld();
  return out;
};

// ------------------------------------------------------------------ item 12: migration

const MIG = 'G6B Y Mig';
const migState = path.join(OUT, 'migrate-state.json');
steps.migrate = async () => {
  const part = process.argv[3] ?? 'a';
  const out = { part };
  const X = 200, Z = 200;
  if (part === 'a') {
    // on 0.17.0 (GATE6CY_REF=v0.17.0 start): a half-built sharedCrate group and a per-site crate
    await ensure();
    await fresh(MIG);
    await stand(X + 40.5, 0, Z + 20.5, 'spectator');
    const y = await feet(X, Z);
    await stand(X + 40.5, y + 30, Z + 20.5, 'spectator');
    const v = await api('api112');
    out.version = v.version;
    const b = await batch({ owner: OWNER, sharedCrate: true, autoApprove: true, crateAt: [X - 10, y, Z - 20], items: [cabin('g1', [X, y, Z]), cabin('g2', [X + 30, y, Z])] });
    const s3 = await later(`place cabin ${X + 60} ${y} ${Z} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
    const ids = { g1: b.items.g1.site, g2: b.items.g2.site, s3: s3.siteId };
    const half = (m) => Object.fromEntries(Object.entries(m).map(([k, n]) => [k, Math.ceil(n / 2)]));
    // half built: a quarter fed and built, then paused (the 0.17.0 crate screen's Pause) and another quarter fed: the crates hold stock
    const pauseOld = async (id) => { await call('dev.crate.open', { site: id }); await sleep(1500); await call('dev.crate.press', { control: 'pause' }); await call('dev.crate.press', { control: 'close' }).catch(() => {}); };
    const sg = await api(`stock ${b.group}`);
    const ss = await siteState(ids.s3);
    const bom3 = Object.fromEntries((ss.rows ?? []).map((r) => [r.item, r.missing]).filter(([, n]) => n > 0));
    const quarter = (m) => half(half(m));
    await call('dev.crate.insert', { site: ids.g1, items: quarter(sg.outstanding) }, 120_000);
    await call('dev.crate.insert', { site: ids.s3, items: quarter(bom3) }, 120_000);
    await sleep(10_000);
    for (const id of Object.values(ids)) await pauseOld(id);
    await call('dev.crate.insert', { site: ids.g1, items: quarter(sg.outstanding) }, 120_000);
    await call('dev.crate.insert', { site: ids.s3, items: quarter(bom3) }, 120_000);
    await sleep(2000);
    const stock = await api(`stock ${b.group}`);
    const s3state = await siteState(ids.s3);
    fs.writeFileSync(migState, JSON.stringify({ ids, group: b.group, y, stock, s3: { ledger: s3state.ledger, built: s3state.built, crate: s3state.crate } }));
    out.stock = stock;
    out.s3 = s3state.ledger;
    check(stock.outstanding && Object.keys(stock.outstanding).length > 0 && s3state.state === 'building', `migrate a (${v.version}): a half-built sharedCrate group and a per-site crate (${json(sum(stock.outstanding))} items outstanding)`);
    await cmd('/save-all flush');
    await leaveWorld();
    return out;
  }
  const m = JSON.parse(fs.readFileSync(migState, 'utf8'));
  if (part === 'b') {
    await ensure();
    // copy 1: loads unchanged; the builds finish as before (legacy crates)
    await fresh('G6B Y Mig1', MIG);
    // the builder derives what is built from the world once its chunks are loaded: give the first rescans a moment
    let stock;
    for (let i = 0; i < 30; i++) {
      stock = await api(`stock ${m.group}`);
      if (canon(stock) === canon(m.stock)) break;
      await sleep(1000);
    }
    const s3 = await siteState(m.ids.s3);
    const diffs = ['delivered', 'credit', 'outstandingBySite', 'outstanding', 'crate'].filter((k) => canon(stock[k]) !== canon(m.stock[k]));
    check(canon(stock) === canon(m.stock), `item 12: the 0.17.0 world loads unchanged: Stock of the group equal (${diffs.length ? `differing: ${json(diffs)}` : json(stock).slice(0, 120)})`);
    check(json(s3.ledger) === json(m.s3.ledger) && s3.crate?.present === true && s3.stockpile === undefined, 'item 12: the per-site crate and its ledger unchanged');
    const saved = await pile('saved');
    check(Object.keys(saved.file ?? {}).length === 0, 'item 12: no stockpile file in an old world (no stockpile, no change)');
    for (const id of Object.values(m.ids)) await pile('pause', { site: id, paused: false });
    const gneed = {};
    for (const [k, v] of Object.entries(stock.outstanding)) { const n = v - (stock.delivered?.[k] ?? 0); if (n > 0) gneed[k] = n; }
    for (let i = 0; i < 20; i++) {
      const st = await api(`stock ${m.group}`);
      const credit = st.credit ?? {};
      const want = {};
      for (const [k, v] of Object.entries(st.outstanding ?? {})) { if (v > 0) want[k] = v; }
      if (!Object.keys(want).length) break;
      await call('dev.crate.insert', { site: m.ids.g1, items: want }, 120_000).catch(() => {});
      await sleep(3000);
      void credit;
    }
    for (let i = 0; i < 20; i++) {
      const s = await siteState(m.ids.s3);
      if (s.state !== 'building') break;
      const want = Object.fromEntries((s.rows ?? []).map((r) => [r.item, r.missing]).filter(([, n]) => n > 0));
      if (Object.keys(want).length) await call('dev.crate.insert', { site: m.ids.s3, items: want }, 120_000).catch(() => {});
      await sleep(3000);
    }
    const done = await waitBuilt([m.ids.g1, m.ids.g2, m.ids.s3], 180_000);
    check(done.length === 3, `item 12: the builds finish as before through their own crates (${json(done)})`);
    await leaveWorld();
    // copy 2: adoptCrates moves their stock in with difference 0, their crate cells restored
    await fresh('G6B Y Mig2', MIG);
    const y = m.y;
    const cons = new Conservation({ min: [X - 40, y - 8, Z - 40], max: [X + 140, y + 40, Z + 160] });
    const a0 = await cons.start();
    const oldCrates = (a0.crateBlocks ?? []).map((c) => c.pos);
    const crates = [[X - 20, y, Z - 25], [X - 18, y, Z - 25], [X - 16, y, Z - 25]];
    const c = await pile('create', { crates });
    check(!c.refused, `item 12: a stockpile for the owner (${json(c.refused ?? c.stockpile?.crates)})`);
    const ad = await pile('adopt');
    const a1 = await cons.parts();
    const p1 = await cons.point('adopted');
    out.adopt = { legacyBefore: a0.legacyCrateStock, stockAfter: a1.stock, oldCrates };
    check(exact(p1) && sum(a1.legacyCrateStock) === 0 && sum(a1.stock) === sum(a0.legacyCrateStock), `item 12: adoptCrates moved the legacy stock in with difference 0 (${sum(a0.legacyCrateStock)} -> stock ${sum(a1.stock)}; ${json(p1.diff)})`);
    const left = (a1.crateBlocks ?? []).filter((x) => oldCrates.includes(x.pos));
    check(sum(a0.legacyCrateStock) > 50, `item 12: the legacy crates hold stock to adopt (${sum(a0.legacyCrateStock)} items)`);
    check(oldCrates.length === 2 && left.length === 0, `item 12: the legacy crate cells are restored (${json(oldCrates)} -> ${json(left)})`);
    const st = ad.stockpile;
    check([m.ids.g1, m.ids.g2, m.ids.s3].every((id) => st.feedOrder.includes(id)), `item 12: their targets joined the feed order (${json(st.feedOrder)})`);
    const again = await pile('adopt');
    check(json(again.stockpile.ledger) === json(st.ledger), 'item 12: adoptCrates is idempotent');
    for (const id of Object.values(m.ids)) await pile('pause', { site: id, paused: false });
    await feedAll(cons, `stockpile:${OWNER}`);
    const done2 = await waitBuilt([m.ids.g1, m.ids.g2, m.ids.s3], 180_000);
    const p2 = await cons.point('adopted built');
    check(done2.length === 3 && exact(p2), `item 12: after the adoption they finish from the stockpile; conservation 0 (${json(p2.diff)})`);
    await leaveWorld();
    return out;
  }
  if (part === 'c') {
    // the downgrade fixture on this build: a stockpile and a half-built target, saved
    const f = await fixture('G6B Y Down');
    const { X: x0, Z: z0, y } = f;
    const h0 = await hash({ min: [x0 - 15, y - 6, z0 - 25], max: [x0 + 25, y + 25, z0 + 25] });
    const h = await later(`place cabin ${x0} ${y} ${z0} CONSTRUCTION unowned noactor 0 owner=${OWNER}`);
    const need = (await pstate()).outstanding;
    for (const [k, v] of Object.entries(need)) await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: { [k]: Math.ceil(v / 2) } }, 60_000);
    await sleep(5000);
    fs.writeFileSync(path.join(OUT, 'downgrade-state.json'), JSON.stringify({ site: h.siteId, h0, y, x0, z0 }));
    await cmd('/save-all flush');
    await leaveWorld();
    return out;
  }
  if (part === 'd') {
    // on 0.17.0: recorded, not supported
    const d = JSON.parse(fs.readFileSync(path.join(OUT, 'downgrade-state.json'), 'utf8'));
    await ensure();
    await openWorld('G6B Y Down');
    const v = await api('api112');
    const s = await siteState(d.site).catch((e) => ({ error: String(e.message ?? e) }));
    await sleep(5000);
    const s2 = await siteState(d.site).catch((e) => ({ error: String(e.message ?? e) }));
    const rm = await later(`remove ${d.site} ${OWNER} noforce`, 300_000).catch((e) => ({ error: String(e.message ?? e) }));
    await settle(3000);
    const h1 = await hash({ min: [d.x0 - 15, d.y - 6, d.z0 - 25], max: [d.x0 + 25, d.y + 25, d.z0 + 25] });
    out.downgrade = { version: v.version, state: s.state, crateMissing: s.crate?.missing, notes: s.notes, built: [s.built, s2.built], removed: rm.removed, diffZero: h1 === d.h0 };
    check(true, `item 12: downgrade to ${v.version} recorded (not supported): ${json(out.downgrade)}`);
    await leaveWorld();
    return out;
  }
  throw new Error(`migrate part ${part}?`);
};

// ------------------------------------------------------------------ item 1 (Y1's part) and item 14

steps.unit = async () => {
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*StockpileTest', '--tests', '*FeedOrderTest', '--tests', '*ApiY1Test', '--tests', '*StockpileFileTest', '--tests', '*LedgerTest'],
    { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  const out = { code: g.status, stockpile: xml('survival.StockpileTest'), feedOrder: xml('site.FeedOrderTest'), apiy1: xml('api.ApiY1Test'), file: xml('site.StockpileFileTest') };
  check(g.status === 0 && out.stockpile?.tests >= 9 && !out.stockpile.failures && out.feedOrder?.tests >= 6 && !out.feedOrder.failures && out.apiy1?.tests >= 5
    && !out.apiy1.failures && out.file?.tests >= 2 && !out.file.failures, `item 1 (Y1): StockpileFileTest ${json(out.file)} (an id-less file loads, ids never reused), StockpileTest ${json(out.stockpile)} (identity, capacity in stacks, credit once, overflow, adoption, bucket), FeedOrderTest ${json(out.feedOrder)} (default order, setFront, reservations), ApiY1Test ${json(out.apiy1)}`);
  spendZero();
  return out;
};

steps.apicompat = async () => {
  const y1 = path.join(MAIN_ART, 'gate6c-y1');
  const jars = [['1.16.0 apitest', [path.join(y1, 'v0190', 'architect_apitest-0.19.0.jar')]], ['1.15.0 apitest', [path.join(y1, 'v0180', 'architect_apitest-0.18.0.jar')]],
    ['1.14.0 apitest', [path.join(y1, 'v0170', 'architect_apitest-0.17.0.jar')]], ['1.16.0 surface', ['--surface', path.join(y1, 'v0190', 'architect_mc-0.19.0.jar')]]];
  const lines = [];
  let ok = 0;
  for (const [label, args] of jars) {
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
    const t = `${r.stdout}${r.stderr}`.trim();
    lines.push(`## ${label}\n${t}`);
    if (r.status === 0) ok++;
    check(r.status === 0, `item 14: api-compat ${label}: ${t.split('\n').pop()}`);
  }
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), `${lines.join('\n\n')}\n\n${ok}/${jars.length} clean\n`);
  if (state.dev || (await connect(5_000).then(() => true).catch(() => false))) {
    if (!(await call('dev.state')).inWorld) await openWorld(SURV);
    const v = await api('apiy1');
    check(v.version === '1.17.0' && v.features.includes('stockpile') && v.stockpileCrates === 16, `item 14: apitest apiy1 (${json(v)})`);
  }
  spendZero();
  return { ok, of: jars.length };
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'store', 'order', 'unloaded', 'refunds', 'overflow', 'once', 'restart-a', 'restart-b', 'restart-kill', 'restart-c', 'gone', 'dissolve', 'migrate-a', 'migrate-b', 'migrate-c', 'migrate-d', 'apicompat']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-Y1 (settlement stockpile, C24)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
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
