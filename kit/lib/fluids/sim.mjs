// (6c H) M25's flow simulation (docs/CONTRACT.md "Phase 6c slice H" §2): integer and deterministic, over any world that answers what a
// cell holds. Two models over the same rules of vanilla 26.3's FlowingFluid (§0):
//   reach      the conservative flow: from every body's sources, falling first, then horizontal spread to 7 (water) or 3 (lava) into
//              every cell that can hold a fluid, in every direction (vanilla's preference for the nearest drop within 4 is ignored), so
//              the reached set is a superset of vanilla's. Every safety rule reads it.
//   predicted  vanilla's own steady state: FlowingFluid's tick, spread, getNewLiquid, getSpread and getSlopeDistance replayed as an
//              event simulation of scheduled ticks (delay 5 water, 30 lava; ticks at one position never stack), with the drop
//              preference and the levels. Only the realise's census reads it (§3.3), never a safety rule.
//
// simulate(world, bodies, {breach}) -> {reached, predicted, findings}
//   world.at(x, y, z) -> 'stop' | 'open' | 'water' | 'lava' (a natural or earlier source of that fluid) | 'flowing_water' |
//            'flowing_lava' (a natural flowing cell); a body's own cells are its sources whatever the world says there. Optional:
//            world.solid(x, y, z) -> bool (a full face under a cell, for source conversion; default: at() === 'stop'),
//            world.keep(x, y, z, body) -> reason | null (M25:keep; (6c IRR) the body judged, for its own lot's exemption), world.shell(x, y, z, body) -> reason | null (M25:shell),
//            world.surface(x, y, z) -> bool (sky above: no ceiling over the cell, for M25:trap), world.exit(x, y, z) -> bool (a bank
//            cell a villager can stand on, for M25:exit).
//   bodies: [{id, part?, fluid, level, cells: [[x, y, z]], shell?: [[x, y, z]], spill?: [[x, y, z]], joins?: [[x, y, z]], spillLands?:
//            true}]  ((6c HY) spillLands: the body's spill ends in another body of the plan (a course's step): a mover swept along it ends
//            up in that body, so its spill's surface cells are judged for M25:exit there (by the landing body's own rule), not here;
//            M25:trap covers them as before. The shell a course passes includes its lining and weir: M25:shell and the single breach
//            cover them; (7a LF) carried: [[x, y, z]]: a lift's bubble column cells, which carry a mover: never M25:trap)
//   breach: true also runs the single-breach flow per shell cell at or under the surface (§2.5): its reach in `breach` per body.
// Returns, per body (in input order): {id, reached: [[x, y, z]] (cells included), spill: reached minus cells, predicted: [[x, y, z,
// level]] (the block state's level, 1..7 flowing, 8 falling; every non-source cell the steady state holds), path (the longest
// predicted flow path in cells, falls counted), settleTicks, breach: [[x, y, z]] | undefined}; findings: [{rule: 'M25:<sub>', body,
// part, count, sample: [[x, y, z]], message}].
//
// Pure, no clock, no random numbers. Lava's random spread delay (vanilla quadruples it at random) changes only when a cell settles, not
// where: the steady state is the same, so `predicted` holds for lava too.
//
// (8c WM) The water model for flowing rivers (8c contract §2), opt-in per body: a body with `model: 'wm'` (WM_MODEL) is simulated with
// the rules below; every other body exactly as before (H, HY and IRR's IRs byte-identical). The world may also answer, for wm bodies:
//   world.wl(x, y, z) -> null | face mask (FACE): a cell `at` calls 'stop' that holds a water source as a block: a waterlogged block,
//            kelp, seagrass. Flow never enters it (canMaybePassThrough: a source of this type), but it is a FOREIGN SOURCE: it counts
//            toward conversion, feeds its neighbours and spreads when a change beside it schedules its tick. The mask's faces are the
//            ones its collision shape covers fully (canPassThroughWall refuses them: 26.3 FlowingFluid.canPassThroughWall, getNewLiquid
//            bytecode 85-97 and 231-244).
//   world.level(x, y, z) -> null | 1..15: a natural flowing cell's LiquidBlock.LEVEL (ARVX v4); null: unknown (amount 7, as before).
//   world.bubbler(x, y, z) -> bool: soul sand or a magma block (M25:bubble under a source or predicted cell, a lift's carried cells aside).
//   world.wash(x, y, z, body) -> null | 'clear' | reason: an `open` cell that is not air (a plant, torch, rail, carpet): 'clear' a natural
//            one the planner clears first (an IF_NATURAL air write, journaled: no drop), a reason one it may not (M25:wash).
// A wm body's result also carries converted (simulated source conversions outside its cells: M25:convert; never in `predicted`),
// foreign (the wl sources its flow touched: W5's attribution names them), wash (the cells to clear) and unsettled ({cells, rounds,
// sample} when the steady state did not settle: the finding UNSETTLED, never a throw). Its ticks run in the order (due, y descending, x,
// z) instead of the scheduling order.
//
// (8c SE) The settle step's bounds and caps (8c contract §2.5, §2.6; flowing.mjs LIMITS, its UNSETTLED shape), for wm bodies only:
//   rounds   the steady state runs until game tick wmMaxTick(fluid, reach) = settleBound(fluid, min(PATH_CAP, the conservative reach's
//            cell count)) x 4 (ticks, not rounds: every due is a multiple of the delay; the predicted path never exceeds the reach's cells,
//            nor a plannable river PATH_CAP); past it the body is unsettled {cap: 'rounds'}
//   cells    more than 4,096 predicted flowing cells (converted cells aside): {cap: 'cells'}
//   chunks   its watch set (cells, shell, spill, predicted and breach cells, grown by WATCH_GROW) meets more than 64 chunks: {cap: 'chunks'}
//   breach   per bank segment: the shell cells at or under the surface in (x, z, y) order, 32 at a time (BANK_SEGMENT), each segment
//            opened at once in one conservative reach (a superset of each of its single breaches: an opened cell under a flow never
//            stops that flow's sideways spread), each against BREACH_CAP. The work is segments x reach, not shell cells x reach
// The region's two caps (32,768 flowing cells, 8 river bodies) span bodies: fluidBody (body.mjs) counts them over the region's wm bodies.
// A wm body's `unsettled` is {cap, limit, cells, rounds, sample}; the result also carries `chunks` (the watch set's chunk count) and
// `segments` (the bank segments its breach ran). Every other body is simulated exactly as before.

import { LIMITS } from './flowing.mjs';

export const DELAY = Object.freeze({ water: 5, lava: 30 });
/** Horizontal spread from a source, in cells (vanilla's drop-off: 1 for water, 2 for lava in the Overworld). */
export const SPREAD = Object.freeze({ water: 7, lava: 3 });
const DROP = Object.freeze({ water: 1, lava: 2 });
/** How far getSlopeDistance looks for a drop (4 for water, 2 for lava in the Overworld). */
const SLOPE = Object.freeze({ water: 4, lava: 2 });
/** The single breach's flows are bounded: past this many cells reached, the breach is reported as unbounded (an M25:keep finding). */
export const BREACH_CAP = 20000;
/** The census watch box grows the body's cells, shell, spill and breach reach by this much (§3.3). */
export const WATCH_GROW = 2;
/** M25:trap and M25:exit (§2.1): a fluid cell needs a surface cell within 4; a surface cell an exit within 8 (Manhattan). */
export const TRAP_REACH = 4, EXIT_REACH = 8;

/** (8c WM) The opt-in model of a body (`model` on simulate's body, `model` on the IR's fluid op). */
export const WM_MODEL = 'wm';
/** (8c WM) Face bits of a wl cell's mask: the faces its collision shape covers fully. */
export const FACE = Object.freeze({ east: 1, west: 2, south: 4, north: 8, up: 16, down: 32 });
const faceBit = (dx, dy, dz) => (dx === 1 ? 1 : dx === -1 ? 2 : dz === 1 ? 4 : dz === -1 ? 8 : dy === 1 ? 16 : 32);
const OPP = { 1: 2, 2: 1, 4: 8, 8: 4, 16: 32, 32: 16 };

/** (8c SE) The longest river path the planner builds (7 x the claim's usable height range, at most HY's course length). */
export const PATH_CAP = 512;
/** (8c SE) A bank segment: the shell cells one breach reach (and one W3 run) opens at once, against BREACH_CAP. */
export const BANK_SEGMENT = 32;
/** (8c SE) The game tick past which a wm body's steady state is unsettled (cap 'rounds'): settleBound(min(PATH_CAP, reach)) x 4. */
export function wmMaxTick(fluid, reachCells) {
  return settleBound(fluid, Math.min(PATH_CAP, Math.max(0, reachCells))) * LIMITS.roundsFactor;
}
/** (8c SE) The chunks a watch set meets: the cells grown by WATCH_GROW, distinct (x >> 4, z >> 4). */
export function watchChunks(cellLists) {
  const out = new Set();
  for (const list of cellLists) for (const c of list ?? []) {
    for (const dx of [-WATCH_GROW, WATCH_GROW]) for (const dz of [-WATCH_GROW, WATCH_GROW]) out.add(`${(c[0] + dx) >> 4},${(c[2] + dz) >> 4}`);
  }
  return out.size;
}
/** (8c SE) A wm body's shell cells at or under its surface as bank segments: (x, z, y) order, BANK_SEGMENT at a time. */
export function bankSegments(shell, level) {
  const cells = shell.filter((c) => c[1] <= level).map((c) => [c[0], c[1], c[2]]).sort((p, q) => p[0] - q[0] || p[2] - q[2] || p[1] - q[1]);
  const out = [];
  for (let i = 0; i < cells.length; i += BANK_SEGMENT) out.push(cells.slice(i, i + BANK_SEGMENT));
  return out;
}

const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const k3 = (x, y, z) => `${x},${y},${z}`;
const un3 = (k) => k.split(',').map(Number);
const sortCells = (a) => a.sort((p, q) => p[1] - q[1] || p[0] - q[0] || p[2] - q[2]);

/** The settle bound of a body (§3.3): delay x (longest predicted flow path + 2) + 20. */
export function settleBound(fluid, path) {
  return DELAY[fluid] * (path + 2) + 20;
}

/**
 * A world over a plain map, for tests and generators: `cells` maps "x,y,z" to a world kind ('stop', 'water', ...); anything else is
 * `otherwise(x, y, z)` (default 'open').
 */
export function mapWorld(cells, otherwise = () => 'open', extra = {}) {
  return { at: (x, y, z) => cells.get(k3(x, y, z)) ?? otherwise(x, y, z), ...extra };
}

/**
 * The world a body sees: its own cells hold its fluid as sources; `open` lets a cell be opened (a breach). One fluid world per body (the
 * other bodies' cells count as their fluid's sources, so a flow meeting another body's water stops there, and lava meeting water mixes).
 */
function bodyWorld(world, own, fluid, others, opened = null) {
  return (x, y, z) => {
    const k = k3(x, y, z);
    if (own.has(k)) return fluid;
    if (opened !== null && (typeof opened === 'string' ? opened === k : opened.has(k))) return 'open';
    const o = others.get(k);
    if (o) return o;
    return world.at(x, y, z);
  };
}

const isFluid = (w, f) => w === f || w === `flowing_${f}`;
const otherFluid = (f) => (f === 'water' ? 'lava' : 'water');

/**
 * The conservative reach of one fluid from its sources: a map "x,y,z" -> the most fluid any feeding neighbour can give it (8: a source or
 * a falling cell, 1..7 flowing). Falling into every cell below that holds no source of the fluid; spreading sideways from a cell that
 * cannot fall (or a source with 3 source neighbours), to SPREAD cells. `cap`: stop past that many cells (null: unbounded).
 * (8c WM) `wl(x, y, z)` -> null | mask: a 'stop' cell holding a water source as a block (the header). Each one beside a reached cell
 * joins the reach as a source (all its faces: conservative), but is never itself reached: `foreign` lists them.
 */
export function reach(at, sources, fluid, { cap = null, wl = null, opened = null } = {}) {
  const amt = new Map();
  const queue = [];
  let head = 0;
  const put = (x, y, z, a) => {
    const k = k3(x, y, z);
    if ((amt.get(k) ?? 0) >= a) return;
    amt.set(k, a);
    queue.push([x, y, z, a]);
  };
  const src = new Set(sources.map(([x, y, z]) => k3(x, y, z)));
  for (const [x, y, z] of sources) put(x, y, z, 8);
  // a cell a flow can enter: empty (canHoldAnyFluid, nothing in it), or a natural flowing cell of the same fluid (it re-levels on its
  // tick and carries the flow on: counted as reached, conservatively)
  const takes = (w) => w === 'open' || w === `flowing_${fluid}`;
  // ((8c WM) the foreign sources a flow wakes: seeded as sources, taken out of the result)
  const wlOn = typeof wl === 'function' && fluid === 'water';
  const seeded = wlOn ? new Set() : null;
  const wlAt = (x, y, z) => wlOn && at(x, y, z) === 'stop' && wl(x, y, z) != null;
  const isSourceW = (x, y, z) => { const w = at(x, y, z); return w === fluid || (wlOn && w === 'stop' && wl(x, y, z) != null); };
  let n = 0;
  const done = (capped) => {
    if (wlOn) for (const k of seeded) amt.delete(k);
    return wlOn ? { amt, capped, foreign: sortCells([...seeded].map(un3)) } : { amt, capped };
  };
  while (head < queue.length) {
    const [x, y, z, a] = queue[head++];
    if (amt.get(k3(x, y, z)) !== a) continue;
    if (cap !== null && ++n > cap) return done(true);
    if (wlOn) {
      for (const [dx, dy, dz] of D6) {
        const k = k3(x + dx, y + dy, z + dz);
        if (seeded.has(k) || !wlAt(x + dx, y + dy, z + dz)) continue;
        seeded.add(k);
        src.add(k);
        put(x + dx, y + dy, z + dz, 8);
      }
    }
    const isSrc = src.has(k3(x, y, z));
    const below = at(x, y - 1, z);
    if (takes(below)) {
      // falling first; a source with 3 source neighbours also spreads sideways (vanilla's spread)
      put(x, y - 1, z, 8);
      // ((8c SE) a bank segment's opened cell under a flow: it falls in and spreads sideways as well (the single breach of every other
      // cell of the segment leaves that cell shut), so the segment's reach holds each of its single breaches)
      if (!(opened !== null && opened.has(k3(x, y - 1, z)))) {
        if (!isSrc) continue;
        let srcN = 0;
        for (const [dx, dz] of H4) if (wlOn ? isSourceW(x + dx, y, z + dz) : at(x + dx, y, z + dz) === fluid) srcN++;
        if (srcN < 3) continue;
      }
    } else if (!isSrc && isFluid(below, fluid)) continue; // a flowing or falling cell over its own fluid (a hole): no sideways spread
    // sideways: a source gives 8 - drop, a falling cell that landed 7, a flowing cell its amount - drop (every direction: conservative)
    const s = isSrc ? 8 - DROP[fluid] : a === 8 ? 7 : a - DROP[fluid];
    if (s <= 0) continue;
    for (const [dx, dz] of H4) if (takes(at(x + dx, y, z + dz))) put(x + dx, y, z + dz, s);
  }
  return done(false);
}

/**
 * Vanilla's steady state of one fluid from its sources (FlowingFluid replayed): returns {cells: Map "x,y,z" -> block level (0 source, 1..7
 * flowing, 8 falling), steps: the number of tick rounds until no tick was left}. Sources are written first, with no update (the realise's
 * writes skip them), then one fluid tick is forced on every source; everything after is vanilla's own ticks.
 * (8c WM) Options, each off by default (the result is then exactly H's):
 *   wl(x, y, z) -> null | FACE mask   a 'stop' cell holding a water source as a block (the header); `foreign` lists those that ticked.
 *   level(x, y, z) -> null | 1..15    a natural flowing cell's LiquidBlock.LEVEL (1..7 amount 8 - level, 8..15 falling, amount 8).
 *   order: 'yxz'                       ticks due together run by (y descending, x, z), not in scheduling order (§2.3); a function
 *                                      permutes each batch in place (the property tests).
 *   onCap: 'result'                    past maxTicks rounds: `unsettled: {cells, rounds, sample}` in the result, never a throw.
 * (8c SE, CL) maxTick (a cap in game ticks), init + wake (start from a settled state, ticking only the woken cells and their fluid
 * neighbours: a breach opened beside standing water), kick (cells ticked at 0 that are not written: foreign wl sources).
 */
export function steady(at0, sources, fluid, { maxTicks = 200000, maxTick = null, wl = null, level = null, order = null, onCap = 'throw', init = null, wake = null, kick = null } = {}) {
  const drop = DROP[fluid], slopeFind = SLOPE[fluid], delay = DELAY[fluid];
  // the live state: written cells override the world. A cell holds {amount (1..8), falling, source}
  const live = new Map();
  // ((8c SE) init: a settled state to start from (Map "x,y,z" -> level: 0 source, 1..7 flowing, 8 falling), e.g. a breach opened in it)
  if (init) for (const [k, lv] of init) live.set(k, lv === 0 ? { amount: 8, falling: false, source: true } : lv >= 8 ? { amount: 8, falling: true, source: false } : { amount: 8 - lv, falling: false, source: false });
  for (const [x, y, z] of sources) live.set(k3(x, y, z), { amount: 8, falling: false, source: true });
  // ((8c WM) a wl cell: a world 'stop' with a source fluid state; its mask is cached (-1: not one)
  const wlOn = typeof wl === 'function' && fluid === 'water';
  const masks = wlOn ? new Map() : null;
  const maskOf = (x, y, z) => {
    if (!wlOn) return -1;
    const k = k3(x, y, z);
    let m = masks.get(k);
    if (m === undefined) { m = live.has(k) || at0(x, y, z) !== 'stop' ? -1 : wl(x, y, z) ?? -1; masks.set(k, m); }
    return m;
  };
  // canPassThroughWall between a cell and its neighbour (dx, dy, dz): neither covers its face fully (only a wl cell has a mask here)
  const pass = (x, y, z, dx, dy, dz) => {
    if (!wlOn) return true;
    const f = faceBit(dx, dy, dz);
    const a = maskOf(x, y, z), b = maskOf(x + dx, y + dy, z + dz);
    return !(a > 0 && (a & f)) && !(b > 0 && (b & OPP[f]));
  };
  const at = (x, y, z) => {
    const v = live.get(k3(x, y, z));
    if (v === undefined) {
      const w = at0(x, y, z);
      return wlOn && w === 'stop' && maskOf(x, y, z) >= 0 ? 'wl' : w;
    }
    if (v === null) return 'open';
    return v.source ? fluid : `flowing_${fluid}`;
  };
  const levelled = typeof level === 'function';
  const stateOf = (x, y, z) => {
    const v = live.get(k3(x, y, z));
    if (v !== undefined) return v;
    const w = wlOn ? at(x, y, z) : at0(x, y, z);
    if (w === fluid || w === 'wl') return { amount: 8, falling: false, source: true };
    if (w === `flowing_${fluid}`) {
      // a natural flowing cell: its level from the world (ARVX v4), else unknown here (amount 7)
      const lv = levelled ? level(x, y, z) : null;
      if (Number.isInteger(lv) && lv >= 1 && lv <= 15) return lv >= 8 ? { amount: 8, falling: true, source: false } : { amount: 8 - lv, falling: false, source: false };
      return { amount: 7, falling: false, source: false };
    }
    return null;
  };
  const holdsAny = (w) => w !== 'stop' && w !== 'wl'; // canHoldAnyFluid: everything but a fluid-stopping block
  const isSource = (x, y, z) => { const w = at(x, y, z); return w === fluid || w === 'wl'; };
  const same = (w) => isFluid(w, fluid) || w === 'wl';
  const sourceN = (x, y, z) => { let c = 0; for (const [dx, dz] of H4) if (isSource(x + dx, y, z + dz)) c++; return c; };
  // getNewLiquid
  const newLiquid = (x, y, z) => {
    let hi = 0, srcs = 0;
    for (const [dx, dz] of H4) {
      const s = stateOf(x + dx, y, z + dz);
      if (!s) continue;
      if (!pass(x, y, z, dx, 0, dz)) continue;
      if (s.source) srcs++;
      hi = Math.max(hi, s.amount);
    }
    if (fluid === 'water' && srcs >= 2) {
      const b = at(x, y - 1, z);
      if (b === 'stop' || b === fluid || b === 'wl') return { amount: 8, falling: false, source: true };
    }
    if (same(at(x, y + 1, z)) && pass(x, y, z, 0, 1, 0)) return { amount: 8, falling: true, source: false };
    const a = hi - drop;
    return a <= 0 ? null : { amount: a, falling: false, source: false };
  };
  const eq = (a, b) => (a === null && b === null) || (!!a && !!b && a.amount === b.amount && a.falling === b.falling && a.source === b.source);
  // isWaterHole(top, bottom): the bottom holds this fluid, or can hold the flowing fluid
  const isHole = (x, y, z) => { const b = at(x, y - 1, z); return (same(b) && pass(x, y, z, 0, -1, 0)) || b === 'open'; };
  // canMaybePassThrough: not a source of this type, can hold a fluid
  const maybePass = (w) => w !== fluid && holdsAny(w) && w !== otherFluid(fluid) && w !== `flowing_${otherFluid(fluid)}`;
  // canPassThrough(flowing): maybePass and can hold the flowing fluid (a waterloggable block can't: it is 'stop' here)
  const slopeDistance = (x, y, z, pass1, fromDx, fromDz, holeCache) => {
    let lowest = 1000;
    for (const [dx, dz] of H4) {
      if (dx === fromDx && dz === fromDz) continue;
      const tx = x + dx, tz = z + dz;
      if (!maybePass(at(tx, y, tz))) continue;
      const hk = k3(tx, y, tz);
      let hole = holeCache.get(hk);
      if (hole === undefined) { hole = isHole(tx, y, tz); holeCache.set(hk, hole); }
      if (hole) return pass1;
      if (pass1 < slopeFind) {
        const d = slopeDistance(tx, y, tz, pass1 + 1, -dx, -dz, holeCache);
        if (d < lowest) lowest = d;
      }
    }
    return lowest;
  };
  const getSpread = (x, y, z) => {
    let lowest = 1000;
    let out = [];
    const holeCache = new Map();
    for (const [dx, dz] of H4) {
      const tx = x + dx, tz = z + dz;
      const tw = at(tx, y, tz);
      if (!maybePass(tw)) continue;
      if (!pass(x, y, z, dx, 0, dz)) continue; // ((8c WM) a wl cell spreads only through its open faces)
      const nf = newLiquid(tx, y, tz);
      // canHoldSpecificFluid: always true here (waterloggables are 'stop'); canBeReplacedWith: only an empty cell takes a spread
      let d;
      const hk = k3(tx, y, tz);
      let hole = holeCache.get(hk);
      if (hole === undefined) { hole = isHole(tx, y, tz); holeCache.set(hk, hole); }
      if (hole) d = 0;
      else d = slopeDistance(tx, y, tz, 1, -dx, -dz, holeCache);
      if (d < lowest) out = [];
      if (d <= lowest) {
        if (tw === 'open' && nf) out.push([tx, tz, nf]);
        lowest = d;
      }
    }
    return out;
  };
  // the scheduler: ticks by (time, scheduling order); a position holds at most one scheduled tick. Every tick is due `delay` after the
  // change that scheduled it (or at 0, the forced ticks), so dues are scheduled in non-decreasing order: one FIFO bucket per due tick
  // gives the (due, scheduling order) order exactly
  const sched = new Set();
  const buckets = []; // [[due, [[x, y, z], ...]]]
  let bh = 0;
  const schedule = (x, y, z, t) => {
    const k = k3(x, y, z);
    if (sched.has(k)) return;
    sched.add(k);
    let last = buckets[buckets.length - 1];
    if (!last || last[0] !== t) {
      if (last && last[0] > t) throw new Error(`steady: a tick scheduled at ${t} before ${last[0]}`);
      last = [t, []];
      buckets.push(last);
    }
    last[1].push([x, y, z]);
  };
  // a block change: its own tick (onPlace) and every fluid neighbour's (neighborChanged), all after `delay`
  const changed = (x, y, z, now) => {
    if (same(at(x, y, z))) schedule(x, y, z, now + delay);
    for (const [dx, dy, dz] of D6) if (same(at(x + dx, y + dy, z + dz))) schedule(x + dx, y + dy, z + dz, now + delay);
  };
  const set = (x, y, z, v, now) => {
    live.set(k3(x, y, z), v);
    changed(x, y, z, now);
  };
  const spreadToSides = (x, y, z, s, now) => {
    let a = s.amount - drop;
    if (s.falling) a = 7;
    if (a <= 0) return;
    for (const [tx, tz, nf] of getSpread(x, y, z)) set(tx, y, tz, nf, now);
  };
  const spread = (x, y, z, s, now) => {
    if (!s) return;
    const bw = at(x, y - 1, z);
    if (maybePass(bw) && pass(x, y, z, 0, -1, 0)) {
      const nf = newLiquid(x, y - 1, z);
      if (bw === 'open' && nf) {
        set(x, y - 1, z, nf, now);
        if (sourceN(x, y, z) >= 3) spreadToSides(x, y, z, s, now);
        return;
      }
    }
    if (s.source || !isHole(x, y, z)) spreadToSides(x, y, z, s, now);
  };
  const woke = wlOn ? new Set() : null;
  const tick = (x, y, z, now) => {
    let s = stateOf(x, y, z);
    const w = at(x, y, z);
    if (!s || !same(w)) return;
    if (w === 'wl') woke.add(k3(x, y, z));
    if (!s.source) {
      const nf = newLiquid(x, y, z);
      if (nf === null) {
        live.set(k3(x, y, z), null);
        changed(x, y, z, now);
        return;
      }
      if (!eq(nf, s)) {
        live.set(k3(x, y, z), nf);
        changed(x, y, z, now);
        s = nf;
      }
    }
    spread(x, y, z, s, now);
  };
  // the forced tick on every source (§3.2), in the write order (y, x, z); ((8c SE) from a settled state: only the woken cells and their
  // fluid neighbours tick, as a block broken beside settled water schedules them)
  if (init) {
    for (const [x, y, z] of sortCells((wake ?? []).map((c) => [c[0], c[1], c[2]]))) for (const [dx, dy, dz] of [[0, 0, 0], ...D6]) if (same(at(x + dx, y + dy, z + dz))) schedule(x + dx, y + dy, z + dz, 0);
  } else for (const [x, y, z] of sortCells(sources.map((c) => [...c]))) schedule(x, y, z, 0);
  // ((8c CL) kick: cells ticked at 0 without being written: foreign wl sources (a waterlogged block spreads only once it ticks))
  if (kick) for (const [x, y, z] of sortCells(kick.map((c) => [c[0], c[1], c[2]]))) if (same(at(x, y, z))) schedule(x, y, z, 0);
  const yxz = order === 'yxz';
  let now = 0, rounds = 0, unsettled = null;
  while (bh < buckets.length) {
    const [t, batch] = buckets[bh];
    buckets[bh++] = null;
    now = t;
    if (yxz) batch.sort((a, b) => b[1] - a[1] || a[0] - b[0] || a[2] - b[2]);
    else if (typeof order === 'function') order(batch); // (a test hook: any permutation of the batch)
    for (const [x, y, z] of batch) {
      sched.delete(k3(x, y, z));
      tick(x, y, z, now);
    }
    // ((8c SE) maxTick: a cap in game ticks (a wm body's wmMaxTick); a tick due past it is not run)
    const pastTick = maxTick !== null && bh < buckets.length && buckets[bh][0] > maxTick;
    if (++rounds > maxTicks || pastTick) {
      if (onCap !== 'result') throw new Error(`M25: the steady state did not settle in ${maxTicks} tick rounds`);
      let flowing = 0;
      for (const v of live.values()) if (v && !v.source) flowing++;
      unsettled = { cap: 'rounds', limit: pastTick ? maxTick : maxTicks, cells: flowing, rounds, sample: sortCells([...sched].map(un3)).slice(0, 16) };
      break;
    }
  }
  const cells = new Map();
  for (const [k, v] of live) {
    if (!v) continue;
    cells.set(k, v.source ? 0 : v.falling ? 8 : 8 - v.amount);
  }
  return { cells, steps: rounds, ticks: now, ...(wlOn ? { foreign: sortCells([...woke].map(un3)) } : {}), ...(unsettled ? { unsettled } : {}) };
}

/** The longest flow path (cells, falls counted) from the sources through the predicted cells. */
function longestPath(sources, predicted) {
  const dist = new Map();
  const q = [];
  for (const [x, y, z] of sources) { dist.set(k3(x, y, z), 0); q.push([x, y, z]); }
  let best = 0;
  while (q.length) {
    const [x, y, z] = q.shift();
    const d = dist.get(k3(x, y, z));
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const k = k3(x + dx, y + dy, z + dz);
      if (!predicted.has(k) || dist.has(k)) continue;
      dist.set(k, d + 1);
      best = Math.max(best, d + 1);
      q.push([x + dx, y + dy, z + dz]);
    }
  }
  return best;
}

/** The single breach (§2.5): each shell cell at or under the surface opened in turn; the union of what the flow then reaches. */
function breachReach(world, own, fluid, others, body, shell, ropts = {}) {
  const out = new Set();
  let capped = null;
  const level = body.level;
  // ((8c SE) a wm body: per bank segment, each opened at once in one reach, against BREACH_CAP)
  if (body.model === WM_MODEL) {
    const segs = bankSegments(shell, level);
    for (const seg of segs) {
      const opened = new Set(seg.map((c) => k3(...c)));
      const r = reach(bodyWorld(world, own, fluid, others, opened), body.cells, fluid, { cap: BREACH_CAP, ...ropts, opened });
      if (r.capped && !capped) capped = seg[0];
      for (const k of r.amt.keys()) out.add(k);
    }
    return { cells: out, capped, segments: segs.length };
  }
  // (H-a, a shortcut that changes no result) a body whose flow stays in its own cells (no spill: every reached cell is a source) and a
  // shell cell with no neighbour a flow could enter (open, or flowing of this fluid): opening it lets the fluid into that one cell and
  // no further, and changes no other cell's amount (a source's sideways spread only ever meets body and shell cells), so the reach is
  // the body's cells plus the opened cell. Every other breach runs the full reach as before. (A moat's thousands of shell cells.)
  const base = reach(bodyWorld(world, own, fluid, others), body.cells, fluid, { cap: BREACH_CAP, ...ropts });
  const noSpill = !base.capped && base.amt.size === own.size && [...base.amt.keys()].every((k) => own.has(k));
  const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [x, y, z] of shell) {
    if (y > level) continue;
    const opened = k3(x, y, z);
    const at = bodyWorld(world, own, fluid, others, opened);
    if (noSpill && D6.every(([dx, dy, dz]) => { const w = at(x + dx, y + dy, z + dz); return w !== 'open' && w !== `flowing_${fluid}`; })) {
      for (const k of base.amt.keys()) out.add(k);
      // ((6c HY-b) the opened cell takes the fluid only from a body cell beside it: a course's weir course or lining behind its shell is
      // reached by nothing, as the full reach finds; an H body's shell is always beside its cells, so H's result is unchanged)
      if (D6.some(([dx, dy, dz]) => own.has(k3(x + dx, y + dy, z + dz)))) out.add(opened);
      continue;
    }
    // the opened cell is reached from a body cell beside it: start the flow from the sources as before
    const r = reach(at, body.cells, fluid, { cap: BREACH_CAP, ...ropts });
    if (r.capped && !capped) capped = [x, y, z];
    for (const k of r.amt.keys()) out.add(k);
  }
  return { cells: out, capped };
}

/** Simulate every body; see the header. */
export function simulate(world, bodies, { breach = false } = {}) {
  const findings = [];
  const out = [];
  const fluidOf = new Map();
  for (const b of bodies) for (const c of b.cells) fluidOf.set(k3(...c), b.fluid);
  const add = (rule, b, cells, message) => {
    if (!cells.length) return;
    findings.push({ rule: `M25:${rule}`, body: b.id, part: b.part ?? null, count: cells.length, sample: sortCells(cells.map((c) => [...c])).slice(0, 16), message });
  };
  for (const b of bodies) {
    const fluid = b.fluid ?? 'water';
    const own = new Set(b.cells.map((c) => k3(...c)));
    const others = new Map();
    for (const [k, f] of fluidOf) if (!own.has(k)) others.set(k, f);
    const at = bodyWorld(world, own, fluid, others);
    // ((8c WM) the opt-in model: foreign wl sources, the world's levels, the (due, y desc, x, z) order, a typed unsettled result)
    const wm = b.model === WM_MODEL;
    const wlFn = wm && typeof world.wl === 'function' ? (x, y, z) => (at(x, y, z) === 'stop' ? world.wl(x, y, z) : null) : null;
    const ropts = wlFn ? { wl: wlFn } : {};
    const carried = Array.isArray(b.carried) && b.carried.length ? new Set(b.carried.map((c) => k3(c[0], c[1], c[2]))) : null;
    const r = reach(at, b.cells, fluid, ropts);
    const reached = [...r.amt.keys()].map(un3);
    const spillSet = new Set([...r.amt.keys()].filter((k) => !own.has(k)));
    const declared = new Set([...own, ...(b.spill ?? []).map((c) => k3(...c)), ...(b.joins ?? []).map((c) => k3(...c))]);
    // a reached cell that is a join (a natural source the spill lands in) is no leak; the declared spill bounds the rest
    const leak = b.spill ? [...spillSet].filter((k) => !declared.has(k)).map(un3) : [];
    add('leak', b, leak, `${leak.length} reached cell(s) outside the body's cells, spill and joins`);
    const st = steady(at, b.cells, fluid, wm ? { ...ropts, level: typeof world.level === 'function' ? world.level : null, order: 'yxz', onCap: 'result', maxTick: wmMaxTick(fluid, r.amt.size) } : {});
    let pred = new Map([...st.cells].filter(([k]) => !own.has(k)));
    const notReached = [...pred.keys()].filter((k) => !r.amt.has(k)).map(un3);
    // ((8c WM) a simulated conversion (a level-0 cell the flow made) is no prediction: listed as converted, an M25:convert finding unless
    // the planner lifts it into the body's cells (then it is a written source)
    let converted = [];
    if (wm) {
      converted = [...pred].filter(([, lv]) => lv === 0).map(([k]) => un3(k));
      pred = new Map([...pred].filter(([, lv]) => lv !== 0));
    }
    add('model', b, notReached, `${notReached.length} predicted cell(s) outside the conservative reach (the model disagrees with itself)`);
    // source conversion (water only): a reached non-body cell with 2 horizontal sources beside it and a solid or a source under it
    if (fluid === 'water') {
      const conv = [];
      for (const k of spillSet) {
        const [x, y, z] = un3(k);
        let n = 0;
        for (const [dx, dz] of H4) if (at(x + dx, y, z + dz) === 'water') n++;
        if (n < 2) continue;
        const below = at(x, y - 1, z);
        if (below === 'stop' || below === 'water' || (world.solid && world.solid(x, y - 1, z))) conv.push([x, y, z]);
      }
      if (wm) { const seen = new Set(conv.map((c) => k3(...c))); for (const c of converted) if (!seen.has(k3(...c))) conv.push(c); }
      add('convert', b, conv, `${conv.length} spill cell(s) source conversion would turn into sources (2 sources beside, a solid or source under)`);
    }
    // lava and water: within 2 (Chebyshev, 3D) of the other fluid, or the reach touching it
    const mix = [];
    const of = otherFluid(fluid);
    if (fluid === 'lava') {
      const seen = new Set();
      for (const k of [...own, ...spillSet]) {
        const [x, y, z] = un3(k);
        for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
          const w = at(x + dx, y + dy, z + dz);
          const kk = k3(x + dx, y + dy, z + dz);
          if (isFluid(w, of) && !seen.has(kk)) { seen.add(kk); mix.push([x + dx, y + dy, z + dz]); }
        }
      }
    } else {
      for (const k of spillSet) {
        const [x, y, z] = un3(k);
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (isFluid(at(x + dx, y + dy, z + dz), of)) mix.push([x + dx, y + dy, z + dz]);
      }
    }
    add('mix', b, mix, `lava within 2 of water, or a flow touching the other fluid (${mix.length} cell(s))`);
    // the shell
    if (b.shell && world.shell) {
      const bad = [];
      const why = new Map();
      for (const c of b.shell) { const w = world.shell(c[0], c[1], c[2], b); if (w) { bad.push(c); why.set(w, (why.get(w) ?? 0) + 1); } }
      add('shell', b, bad, `${bad.length} shell cell(s) not a written, fluid-stopping, non-gravity block of the body's own part (${[...why].map(([w, n]) => `${w} ${n}`).join(', ')})`);
    }
    let breachCells, segments = 0;
    if (breach && b.shell) {
      const br = breachReach(world, own, fluid, others, b, b.shell, ropts);
      segments = br.segments ?? 0;
      breachCells = [...br.cells].filter((k) => !own.has(k) && !spillSet.has(k)).map(un3);
      if (br.capped) add('keep', b, [br.capped], `the single breach at ${br.capped.join(', ')} reaches more than ${BREACH_CAP} cells`);
    }
    // keep: the body, its shell, its spill and its breach reach never in or beside what is not the plan's
    if (world.keep) {
      const bad = [];
      const why = new Map();
      const seen = new Set();
      for (const c of [...b.cells, ...(b.shell ?? []), ...[...spillSet].map(un3), ...(breachCells ?? [])]) {
        for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const x = c[0] + dx, y = c[1] + dy, z = c[2] + dz;
          const kk = k3(x, y, z);
          if (seen.has(kk)) continue;
          seen.add(kk);
          const w = world.keep(x, y, z, b); // ((6c IRR) the body too: an irrigation source's own lot)
          if (w) { bad.push([x, y, z]); why.set(w, (why.get(w) ?? 0) + 1); }
        }
      }
      add('keep', b, bad, `${bad.length} cell(s) of the body, shell, spill or breach reach in or beside what is not the plan's own (${[...why].map(([w, n]) => `${w} ${n}`).join(', ')})`);
    }
    // trap and exit: a surface cell is a body or spill cell with sky (no ceiling) over it
    if (world.surface) {
      const fluidCells = [...own, ...spillSet].map(un3);
      // (H-a) a spill cell under another reached cell is inside a falling column (the world holds no spill yet): no surface there
      const reachedSet = new Set([...own, ...spillSet]);
      const surf = fluidCells.filter(([x, y, z]) => !isFluid(at(x, y + 1, z), fluid) && !reachedSet.has(k3(x, y + 1, z)) && world.surface(x, y, z));
      // a fluid cell is trapped when no surface cell is within TRAP_REACH steps through the body's own fluid cells (a swimmer's way up);
      // (H-a) a cell of a falling column (reached cells straight up to a surface cell) has no ceiling: it is open too (a mover falls
      // through it into what it lands on)
      const fset = new Set(fluidCells.map((c) => k3(...c)));
      const surfSet = new Set(surf.map((c) => k3(...c)));
      const openUp = (x, y, z) => { for (let yy = y + 1; reachedSet.has(k3(x, yy, z)); yy++) if (surfSet.has(k3(x, yy, z))) return true; return false; };
      const seeds = [...surf, ...fluidCells.filter(([x, y, z]) => !surfSet.has(k3(x, y, z)) && spillSet.has(k3(x, y, z)) && openUp(x, y, z))];
      const dist = new Map(seeds.map((s) => [k3(...s), 0]));
      const q = seeds.map((s) => [...s]);
      for (let h = 0; h < q.length; h++) {
        const [x, y, z] = q[h];
        const d = dist.get(k3(x, y, z));
        if (d >= TRAP_REACH) continue;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const kk = k3(x + dx, y + dy, z + dz);
          if (!fset.has(kk) || dist.has(kk)) continue;
          dist.set(kk, d + 1);
          q.push([x + dx, y + dy, z + dz]);
        }
      }
      // ((7a LF) a bubble column's cells carry a mover (up to the surface, or down to its airlock): never trapped)
      const trap = fluidCells.filter((c) => !dist.has(k3(...c)) && !(carried && carried.has(k3(...c))));
      add('trap', b, trap, `${trap.length} fluid cell(s) under a ceiling with no open surface within ${TRAP_REACH}`);
      if (world.exit && b.exits !== false) {
        // an exit: a cell a villager stands on (its feet cell), within EXIT_REACH (Manhattan, x and z) of the surface cell, its bank at
        // most 1 over the surface (feet at most 2 over the water cell); lower banks are reached by dropping down
        const far = [];
        const memo = new Map();
        const exitAt = (x, y, z) => { const kk = k3(x, y, z); let v = memo.get(kk); if (v === undefined) { v = !!world.exit(x, y, z); memo.set(kk, v); } return v; };
        for (const [x, y, z] of surf) {
          // ((6c HY) a course's spill ends in the body below it: judged there)
          if (b.spillLands === true && spillSet.has(k3(x, y, z))) continue;
          let ok = false;
          for (let dx = -EXIT_REACH; dx <= EXIT_REACH && !ok; dx++) for (let dz = -EXIT_REACH; dz <= EXIT_REACH && !ok; dz++) {
            if (Math.abs(dx) + Math.abs(dz) > EXIT_REACH) continue;
            for (let fy = y + 2; fy >= y - 3 && !ok; fy--) if (exitAt(x + dx, fy, z + dz)) ok = true;
          }
          if (!ok) far.push([x, y, z]);
        }
        add('exit', b, far, `${far.length} surface cell(s) more than ${EXIT_REACH} from a bank a villager can climb out on`);
      }
    }
    // ((8c WM) bubble columns: soul sand or magma under a source or a predicted cell (a lift's carried cells aside); the wash rule: a
    // predicted cell holding a plant, torch, rail or carpet is cleared first (natural) or refused (M25:wash); UNSETTLED, typed
    let wm8 = null;
    if (wm) {
      const wet = [...new Set([...own, ...st.cells.keys()])].map(un3);
      const bubble = typeof world.bubbler === 'function' ? wet.filter(([x, y, z]) => !(carried && carried.has(k3(x, y, z))) && world.bubbler(x, y - 1, z)) : [];
      add('bubble', b, bubble, `${bubble.length} source or predicted cell(s) over soul sand or a magma block (a bubble column the plan never wrote)`);
      const wash = [], refused = [], why = new Map();
      if (typeof world.wash === 'function') {
        for (const k of st.cells.keys()) {
          if (own.has(k)) continue;
          const [x, y, z] = un3(k);
          const w = world.wash(x, y, z, b);
          if (w === 'clear') wash.push([x, y, z]);
          else if (w) { refused.push([x, y, z]); why.set(w, (why.get(w) ?? 0) + 1); }
        }
      }
      add('wash', b, refused, `${refused.length} predicted cell(s) hold a block the flow would wash away and the plan may not clear (${[...why].map(([w, n]) => `${w} ${n}`).join(', ')})`);
      // ((8c SE) the per-body caps after the rounds: the predicted flowing cells, then the watch set's chunks)
      const chunks = watchChunks([b.cells, b.shell, [...spillSet].map(un3), [...pred.keys()].map(un3), breachCells]);
      let unsettled = st.unsettled ?? null;
      if (!unsettled && pred.size > LIMITS.cellsPerBody) unsettled = { cap: 'cells', limit: LIMITS.cellsPerBody, cells: pred.size, rounds: st.steps, sample: sortCells([...pred.keys()].map(un3)).slice(0, 16) };
      if (!unsettled && chunks > LIMITS.chunksPerBody) unsettled = { cap: 'chunks', limit: LIMITS.chunksPerBody, cells: pred.size, rounds: st.steps, sample: sortCells([...pred.keys()].map(un3)).slice(0, 16), chunks };
      if (unsettled) {
        const what = unsettled.cap === 'rounds' ? `the steady state did not settle by tick ${unsettled.limit} (${unsettled.rounds - 1} tick rounds)` : unsettled.cap === 'cells' ? `${unsettled.cells} predicted flowing cells (at most ${unsettled.limit} per body)` : `the watch set meets ${chunks} chunks (at most ${unsettled.limit} per body)`;
        findings.push({ rule: 'UNSETTLED', body: b.id, part: b.part ?? null, cap: unsettled.cap, count: unsettled.cells, sample: unsettled.sample, message: `${what} (${unsettled.cells} flowing cell(s))` });
      }
      const foreign = new Map([...(r.foreign ?? []), ...(st.foreign ?? [])].map((c) => [k3(...c), c]));
      wm8 = { model: WM_MODEL, converted: sortCells(converted), foreign: sortCells([...foreign.values()].map((c) => [...c])), wash: sortCells(wash), chunks, segments, ...(unsettled ? { unsettled } : {}) };
    }
    const predicted = sortCells([...pred].map(([k, lv]) => [...un3(k), lv]));
    const path = longestPath(b.cells, pred);
    out.push({ id: b.id, reached: sortCells(reached), spill: sortCells([...spillSet].map(un3)), predicted, path, settleTicks: settleBound(fluid, path), ...(breachCells ? { breach: sortCells(breachCells) } : {}), ...(wm8 ?? {}) });
  }
  return { bodies: out, reached: out.map((o) => o.reached), predicted: out.map((o) => o.predicted), findings };
}
