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
//            world.keep(x, y, z) -> reason | null (M25:keep), world.shell(x, y, z, body) -> reason | null (M25:shell),
//            world.surface(x, y, z) -> bool (sky above: no ceiling over the cell, for M25:trap), world.exit(x, y, z) -> bool (a bank
//            cell a villager can stand on, for M25:exit).
//   bodies: [{id, part?, fluid, level, cells: [[x, y, z]], shell?: [[x, y, z]], spill?: [[x, y, z]], joins?: [[x, y, z]]}]
//   breach: true also runs the single-breach flow per shell cell at or under the surface (§2.5): its reach in `breach` per body.
// Returns, per body (in input order): {id, reached: [[x, y, z]] (cells included), spill: reached minus cells, predicted: [[x, y, z,
// level]] (the block state's level, 1..7 flowing, 8 falling; every non-source cell the steady state holds), path (the longest
// predicted flow path in cells, falls counted), settleTicks, breach: [[x, y, z]] | undefined}; findings: [{rule: 'M25:<sub>', body,
// part, count, sample: [[x, y, z]], message}].
//
// Pure, no clock, no random numbers. Lava's random spread delay (vanilla quadruples it at random) changes only when a cell settles, not
// where: the steady state is the same, so `predicted` holds for lava too.

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

const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
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
    if (opened !== null && opened === k) return 'open';
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
 */
export function reach(at, sources, fluid, { cap = null } = {}) {
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
  let n = 0;
  while (head < queue.length) {
    const [x, y, z, a] = queue[head++];
    if (amt.get(k3(x, y, z)) !== a) continue;
    if (cap !== null && ++n > cap) return { amt, capped: true };
    const isSrc = src.has(k3(x, y, z));
    const below = at(x, y - 1, z);
    if (takes(below)) {
      // falling first; a source with 3 source neighbours also spreads sideways (vanilla's spread)
      put(x, y - 1, z, 8);
      if (!isSrc) continue;
      let srcN = 0;
      for (const [dx, dz] of H4) if (at(x + dx, y, z + dz) === fluid) srcN++;
      if (srcN < 3) continue;
    } else if (!isSrc && isFluid(below, fluid)) continue; // a flowing or falling cell over its own fluid (a hole): no sideways spread
    // sideways: a source gives 8 - drop, a falling cell that landed 7, a flowing cell its amount - drop (every direction: conservative)
    const s = isSrc ? 8 - DROP[fluid] : a === 8 ? 7 : a - DROP[fluid];
    if (s <= 0) continue;
    for (const [dx, dz] of H4) if (takes(at(x + dx, y, z + dz))) put(x + dx, y, z + dz, s);
  }
  return { amt, capped: false };
}

/**
 * Vanilla's steady state of one fluid from its sources (FlowingFluid replayed): returns {cells: Map "x,y,z" -> block level (0 source, 1..7
 * flowing, 8 falling), steps: the number of tick rounds until no tick was left}. Sources are written first, with no update (the realise's
 * writes skip them), then one fluid tick is forced on every source; everything after is vanilla's own ticks.
 */
export function steady(at0, sources, fluid, { maxTicks = 200000 } = {}) {
  const drop = DROP[fluid], slopeFind = SLOPE[fluid], delay = DELAY[fluid];
  // the live state: written cells override the world. A cell holds {amount (1..8), falling, source}
  const live = new Map();
  for (const [x, y, z] of sources) live.set(k3(x, y, z), { amount: 8, falling: false, source: true });
  const at = (x, y, z) => {
    const v = live.get(k3(x, y, z));
    if (v === undefined) return at0(x, y, z);
    if (v === null) return 'open';
    return v.source ? fluid : `flowing_${fluid}`;
  };
  const stateOf = (x, y, z) => {
    const v = live.get(k3(x, y, z));
    if (v !== undefined) return v;
    const w = at0(x, y, z);
    if (w === fluid) return { amount: 8, falling: false, source: true };
    if (w === `flowing_${fluid}`) return { amount: 7, falling: false, source: false }; // a natural flowing cell: its level is unknown here
    return null;
  };
  const holdsAny = (w) => w !== 'stop'; // canHoldAnyFluid: everything but a fluid-stopping block
  const isSource = (x, y, z) => at(x, y, z) === fluid;
  const same = (w) => isFluid(w, fluid);
  const sourceN = (x, y, z) => { let c = 0; for (const [dx, dz] of H4) if (isSource(x + dx, y, z + dz)) c++; return c; };
  const solid = (x, y, z) => at(x, y, z) === 'stop';
  // getNewLiquid
  const newLiquid = (x, y, z) => {
    let hi = 0, srcs = 0;
    for (const [dx, dz] of H4) {
      const s = stateOf(x + dx, y, z + dz);
      if (!s) continue;
      if (s.source) srcs++;
      hi = Math.max(hi, s.amount);
    }
    if (fluid === 'water' && srcs >= 2) {
      const b = at(x, y - 1, z);
      if (b === 'stop' || b === fluid) return { amount: 8, falling: false, source: true };
    }
    if (same(at(x, y + 1, z))) return { amount: 8, falling: true, source: false };
    const a = hi - drop;
    return a <= 0 ? null : { amount: a, falling: false, source: false };
  };
  const eq = (a, b) => (a === null && b === null) || (!!a && !!b && a.amount === b.amount && a.falling === b.falling && a.source === b.source);
  // isWaterHole(top, bottom): the bottom holds this fluid, or can hold the flowing fluid
  const isHole = (x, y, z) => { const b = at(x, y - 1, z); return same(b) || b === 'open'; };
  // canMaybePassThrough: not a source of this type, can hold a fluid
  const maybePass = (w) => w !== fluid && holdsAny(w) && w !== otherFluid(fluid) && w !== `flowing_${otherFluid(fluid)}`;
  // canPassThrough(flowing): maybePass and can hold the flowing fluid (a waterloggable block can't: it is 'stop' here)
  const slopeDistance = (x, y, z, pass, fromDx, fromDz, holeCache) => {
    let lowest = 1000;
    for (const [dx, dz] of H4) {
      if (dx === fromDx && dz === fromDz) continue;
      const tx = x + dx, tz = z + dz;
      if (!maybePass(at(tx, y, tz))) continue;
      const hk = k3(tx, y, tz);
      let hole = holeCache.get(hk);
      if (hole === undefined) { hole = isHole(tx, y, tz); holeCache.set(hk, hole); }
      if (hole) return pass;
      if (pass < slopeFind) {
        const d = slopeDistance(tx, y, tz, pass + 1, -dx, -dz, holeCache);
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
  // the scheduler: ticks by (time, insertion order); a position holds at most one scheduled tick
  const sched = new Map(); // key -> due
  const order = []; // [due, seq, x, y, z]
  let seq = 0;
  const schedule = (x, y, z, t) => {
    const k = k3(x, y, z);
    if (sched.has(k)) return;
    sched.set(k, t);
    order.push([t, seq++, x, y, z]);
  };
  // a block change: its own tick (onPlace) and every fluid neighbour's (neighborChanged), all after `delay`
  const changed = (x, y, z, now) => {
    if (same(at(x, y, z))) schedule(x, y, z, now + delay);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) if (same(at(x + dx, y + dy, z + dz))) schedule(x + dx, y + dy, z + dz, now + delay);
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
    if (maybePass(bw)) {
      const nf = newLiquid(x, y - 1, z);
      if (bw === 'open' && nf) {
        set(x, y - 1, z, nf, now);
        if (sourceN(x, y, z) >= 3) spreadToSides(x, y, z, s, now);
        return;
      }
    }
    if (s.source || !isHole(x, y, z)) spreadToSides(x, y, z, s, now);
  };
  const tick = (x, y, z, now) => {
    let s = stateOf(x, y, z);
    if (!s || !same(at(x, y, z))) return;
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
  // the forced tick on every source (§3.2), in the write order (y, x, z)
  for (const [x, y, z] of sortCells(sources.map((c) => [...c]))) schedule(x, y, z, 0);
  let now = 0, rounds = 0;
  while (order.length) {
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const t = order[0][0];
    now = t;
    const batch = [];
    while (order.length && order[0][0] === t) batch.push(order.shift());
    for (const [, , x, y, z] of batch) {
      sched.delete(k3(x, y, z));
      tick(x, y, z, now);
    }
    if (++rounds > maxTicks) throw new Error(`M25: the steady state did not settle in ${maxTicks} tick rounds`);
  }
  const cells = new Map();
  for (const [k, v] of live) {
    if (!v) continue;
    cells.set(k, v.source ? 0 : v.falling ? 8 : 8 - v.amount);
  }
  return { cells, steps: rounds, ticks: now };
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
function breachReach(world, own, fluid, others, body, shell) {
  const out = new Set();
  let capped = null;
  const level = body.level;
  for (const [x, y, z] of shell) {
    if (y > level) continue;
    const opened = k3(x, y, z);
    const at = bodyWorld(world, own, fluid, others, opened);
    // the opened cell is reached from a body cell beside it: start the flow from the sources as before
    const r = reach(at, body.cells, fluid, { cap: BREACH_CAP });
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
    const r = reach(at, b.cells, fluid);
    const reached = [...r.amt.keys()].map(un3);
    const spillSet = new Set([...r.amt.keys()].filter((k) => !own.has(k)));
    const declared = new Set([...own, ...(b.spill ?? []).map((c) => k3(...c)), ...(b.joins ?? []).map((c) => k3(...c))]);
    // a reached cell that is a join (a natural source the spill lands in) is no leak; the declared spill bounds the rest
    const leak = b.spill ? [...spillSet].filter((k) => !declared.has(k)).map(un3) : [];
    add('leak', b, leak, `${leak.length} reached cell(s) outside the body's cells, spill and joins`);
    const st = steady(at, b.cells, fluid);
    const pred = new Map([...st.cells].filter(([k]) => !own.has(k)));
    const notReached = [...pred.keys()].filter((k) => !r.amt.has(k)).map(un3);
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
    let breachCells;
    if (breach && b.shell) {
      const br = breachReach(world, own, fluid, others, b, b.shell);
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
          const w = world.keep(x, y, z);
          if (w) { bad.push([x, y, z]); why.set(w, (why.get(w) ?? 0) + 1); }
        }
      }
      add('keep', b, bad, `${bad.length} cell(s) of the body, shell, spill or breach reach in or beside what is not the plan's own (${[...why].map(([w, n]) => `${w} ${n}`).join(', ')})`);
    }
    // trap and exit: a surface cell is a body or spill cell with sky (no ceiling) over it
    if (world.surface) {
      const fluidCells = [...own, ...spillSet].map(un3);
      const surf = fluidCells.filter(([x, y, z]) => !isFluid(at(x, y + 1, z), fluid) && world.surface(x, y, z));
      // a fluid cell is trapped when no surface cell is within TRAP_REACH steps through the body's own fluid cells (a swimmer's way up)
      const fset = new Set(fluidCells.map((c) => k3(...c)));
      const dist = new Map(surf.map((s) => [k3(...s), 0]));
      const q = surf.map((s) => [...s]);
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
      const trap = fluidCells.filter((c) => !dist.has(k3(...c)));
      add('trap', b, trap, `${trap.length} fluid cell(s) under a ceiling with no open surface within ${TRAP_REACH}`);
      if (world.exit && b.exits !== false) {
        // an exit: a cell a villager stands on (its feet cell), within EXIT_REACH (Manhattan, x and z) of the surface cell, its bank at
        // most 1 over the surface (feet at most 2 over the water cell); lower banks are reached by dropping down
        const far = [];
        const memo = new Map();
        const exitAt = (x, y, z) => { const kk = k3(x, y, z); let v = memo.get(kk); if (v === undefined) { v = !!world.exit(x, y, z); memo.set(kk, v); } return v; };
        for (const [x, y, z] of surf) {
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
    const predicted = sortCells([...pred].map(([k, lv]) => [...un3(k), lv]));
    const path = longestPath(b.cells, pred);
    out.push({ id: b.id, reached: sortCells(reached), spill: sortCells([...spillSet].map(un3)), predicted, path, settleTicks: settleBound(fluid, path), ...(breachCells ? { breach: sortCells(breachCells) } : {}) });
  }
  return { bodies: out, reached: out.map((o) => o.reached), predicted: out.map((o) => o.predicted), findings };
}
