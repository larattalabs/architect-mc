// (7a LF) Route row 9, `lift` (docs/CONTRACT.md "Phase 7a slice LF" §3; the foundation's §3.2): a bubble column against a face, opt-in
// per edge (`spans` includes 'lift'; a lift edge `once: 'lift'`). From a walk cell on a cardinal heading, 3 cells out from a face (the
// airlock's two layers between it and the shaft), the row tries the face's rise (4..64, or the edge's `rise`) and lands one cell past
// the top walk cell (the face's top beside the shaft: the shell's rim, the tower's own, so no walk writes it); with `down`, a second
// column beside the first carries a rider the other way: from one cell past its top walk cell, heading away from the face, it lands on
// the down column's approach at the foot. The tower is checked by
// connectors/liftGeom.mjs checkLift over the row's land (the survey's ground plus the program's base, a frozen volume's classes where the
// pass holds one; K1b's reading; trees count 64 high). Cost 300 + 10 a cell of rise (+ 100 with `down`). A lift edge uses exactly one
// column (the A* state's flag bit, which its goal needs) and walks at most `approach` at each end (route.mjs's withinM). `commit`: a routed
// lift's tower (its footprint, the written face) is hard for every later edge of the pass (blocks), so no later leg routes through its
// shell. `fail`: NO_CLIMB (no face rising 4 within the approach), SPAN, ANCHOR, HEADROOM, WATER, PROTECTED, or UNREACHABLE when a
// candidate passes (K1b's method). Under the realise lint (integer math only).
//
// The interface (the foundation's): liftInit, liftActive, liftNeedsFlag, liftBlocks, liftExpand, liftCells, liftCommit, liftFail; the
// edge's options in `edge.t7.lift` ({down, rise: {min, max}, diagnose}), the pass-level input in `intent.lift` ({volumes, kept: [[x, y,
// z, body]]}: the frozen volumes and the plan bodies' hard cells, KC).
import { FLAG_FROZEN, FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../../pack.mjs';
import { LIFT, LIFT_ORDER, checkLift } from '../../../connectors/liftGeom.mjs';
import { rightOf } from '../../../connectors/ropeGeom.mjs';
import { VC, VOXEL_CLASSES, classAt as volumeClassAt } from '../../volume.mjs';

const FP = 16;
const NONE = -32768;
/** A tree column's top (the pass has no trunk heights): never over a shaft or a top walk cell. */
const TREE_TOP = 64;
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const cardinalNear = (h) => ((h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]);
const isInt = Number.isInteger;
const onceOf = (edge) => (typeof edge?.once === 'string' ? edge.once : edge?.spanOnce ? 'rope' : null);
const SIDES = ['right', 'left'];
/** The move's arg: bit 0 the down column's side (1 left), bit 1 the edge builds a down column, bit 2 the move rides it (down). */
const argOf = (move, down, side) => (move === 'down' ? 4 : 0) | (down ? 2 : 0) | (side === 'left' ? 1 : 0);
const unArg = (a) => ({ move: a & 4 ? 'down' : 'up', down: !!(a & 2), side: a & 1 ? 'left' : 'right' });

/** The pass-level state from the intent and its edges, or null when no edge asks for lifts (full resolution only). */
export function liftInit(env, intent) {
  const edges = intent?.edges ?? [];
  if (env.r !== 1 || !edges.some((e) => Array.isArray(e.spans) && e.spans.includes('lift'))) return null;
  const { W, D, minX, minZ, flags } = env, G = env.G, n = W * D;
  const top = new Int16Array(n), water = new Uint8Array(n), blocked = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = flags[k];
    top[k] = f & FLAG_TREE ? G[k] + TREE_TOP : G[k];
    water[k] = f & FLAG_WATER ? 1 : 0;
    if (f & (FLAG_LAVA | FLAG_MISSING)) blocked[k] = 1;
  }
  const rect = (b) => {
    for (let z = Math.max(minZ, b[1]); z <= Math.min(minZ + D - 1, b[3]); z++) for (let x = Math.max(minX, b[0]); x <= Math.min(minX + W - 1, b[2]); x++) blocked[(x - minX) + (z - minZ) * W] = 1;
  };
  for (const b of intent.hard ?? []) rect(b);
  if (!intent._unsafe?.noKeepOut) for (const b of intent.keepOut ?? []) rect(b);
  const m = Math.max(0, intent.margin ?? 2);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (i < m || j < m || i >= W - m || j >= D - m) blocked[i + j * W] = 1;
  // (K1 interplay) a tower never stands on a wall cell
  for (const w of Array.isArray(intent.walls) ? intent.walls : []) for (const c of w?.cells ?? []) {
    const i = c[0] - minX, j = c[1] - minZ;
    if (i >= 0 && j >= 0 && i < W && j < D) blocked[i + j * W] = 1;
  }
  // the pre-region classes (K1b's reading): a frozen volume's where the pass holds one over the cell, else the 2.5D base
  const vols = Array.isArray(intent.lift?.volumes) ? intent.lift.volumes.filter(Boolean) : [];
  const G0 = Int16Array.from(G);
  const classAt = (x, y, z) => {
    for (const v of vols) { const c = volumeClassAt(v, x, y, z); if (c !== VC.MISSING) return VOXEL_CLASSES[c]; }
    const i = x - minX, j = z - minZ;
    if (i < 0 || j < 0 || i >= W || j >= D) return 'MISSING';
    const k = i + j * W, g = G0[k], f = flags[k];
    if (f & FLAG_MISSING) return 'MISSING';
    if (y > g) return 'AIR';
    if (f & FLAG_WATER) return (f & FLAG_FROZEN) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  // (6c KC) the plan bodies' hard cells: a tower never writes one
  const kept = new Map();
  for (const q of Array.isArray(intent.lift?.kept) ? intent.lift.kept : []) kept.set(`${q[0]},${q[1]},${q[2]}`, { body: q[3] ?? null });
  const at = (x, z) => (x - minX) + (z - minZ) * W;
  const inside = (x, z) => x >= minX && z >= minZ && x < minX + W && z < minZ + D;
  const committed = new Uint8Array(n);
  const state = { W, D, minX, minZ, G: G0, cur: null, memo: new Map(), committed, any: false, builtY: null };
  state.land = {
    groundAt: (x, z) => (inside(x, z) ? G0[at(x, z)] : -64), topAt: (x, z) => (inside(x, z) ? top[at(x, z)] : 320), waterAt: (x, z) => inside(x, z) && water[at(x, z)] === 1,
    blocked: (x, z) => !inside(x, z) || blocked[at(x, z)] === 1 || committed[at(x, z)] === 1, classAt, inClaim: inside,
    built: (x, z) => inside(x, z) && !!state.builtY && state.builtY[at(x, z)] !== NONE,
    ...(kept.size ? { kept: (x, y, z) => kept.get(`${x},${y},${z}`) ?? null } : {}),
  };
  return state;
}

/** Whether an edge searches with the lift move; sets the edge's own options for its search. */
export function liftActive(state, edge) {
  if (!state) return false;
  const on = Array.isArray(edge?.spans) && edge.spans.includes('lift');
  if (!on) { state.cur = null; return false; }
  const { W, minX, minZ } = state;
  const kOf = (p) => (p && Array.isArray(p.at) ? (p.at[0] - minX) + (p.at[2] - minZ) * W : -1);
  const o = edge.t7?.lift ?? {};
  const once = onceOf(edge) === 'lift';
  const rise = o.rise && typeof o.rise === 'object' ? o.rise : {};
  state.cur = {
    once, diagnose: once || !!o.diagnose, down: !!o.down,
    approach: isInt(edge.approach) && edge.approach >= 0 && edge.approach <= LIFT.approachMax ? edge.approach : LIFT.approach,
    rise: { min: Math.max(LIFT.riseMin, isInt(rise.min) ? rise.min : LIFT.riseMin), max: Math.min(LIFT.riseMax, isInt(rise.max) ? rise.max : LIFT.riseMax) },
    unsafe: o._unsafe ?? null, startK: kOf(edge.from), goalK: kOf(edge.to), reached: null,
  };
  state.cur.reached = state.cur.diagnose ? new Int32Array(state.W * state.D) : null;
  state.memo = new Map();
  return true;
}

/** Whether an edge's goal needs the flag bit set (a lift edge: exactly one column). */
export function liftNeedsFlag(state, edge) {
  return !!state && onceOf(edge) === 'lift';
}

/** The routed lifts' towers (committed): hard for every later edge's walks (null until one is routed). */
export const liftBlocks = (state) => (state?.any ? state.committed : null);

const cheb = (W, a, b) => { const ai = a % W, bi = b % W; return Math.max(Math.abs(ai - bi), Math.abs((a - ai) / W - (b - bi) / W)); };

/** One tower's check (memoised per edge): from the up approach `a` toward `hf`. */
function towerCheck(state, a, hf, side) {
  const c = state.cur, key = `${a[0]},${a[1]},${a[2]},${hf},${side}`;
  let r = state.memo.get(key);
  if (r) return r;
  r = checkLift(state.land, a, DIRS[hf], { down: c.down, side, rise: c.rise, _unsafe: c.unsafe ?? undefined });
  state.memo.set(key, r);
  return r;
}

/** The up approach of a down move from (i, j), one cell past the down column's top walk cell, heading hf (away from the face). */
function upApproachOf(state, i, j, hf, side) {
  const d = DIRS[(hf + 4) & 7], [rx, rz] = rightOf(d), s = side === 'left' ? -1 : 1;
  // (i, j) = (5, 2s); the up approach a = (0, 0) = (i, j) - 5d - 2s r
  return [state.minX + i - 5 * d[0] - 2 * s * rx, state.minZ + j - 5 * d[1] - 2 * s * rz];
}

/** Expand the lift move from a state (route.mjs's special-move table: S). Up columns by heading, then side; then down columns. */
export function liftExpand(state, S) {
  const c = state.cur;
  if (!c) return;
  const { W, D } = state;
  const { i, j, k, h, y, f, inS } = S;
  state.builtY = S.builtY;
  if (c.once && f === 1) return; // ridden: walk on to the goal
  if (c.diagnose && y + 32768 + 1 > c.reached[k]) c.reached[k] = y + 32768 + 1; // (the near cells reached at their highest y, for `fail`)
  if (c.once && cheb(W, k, c.startK) > c.approach) return;
  const G = state.G;
  for (const hf of cardinalNear(h)) {
    const di = DIRS[hf][0], dj = DIRS[hf][1];
    const i4 = i + 4 * di, j4 = j + 4 * dj, i5 = i + 5 * di, j5 = j + 5 * dj;
    if (i5 < 0 || j5 < 0 || i5 >= W || j5 >= D) continue;
    const k4 = i4 + j4 * W, k5 = i5 + j5 * W;
    // up: from a walk cell on its land (the airlock's floor at the foot's own level: no fill under the approach), the face 4 ahead
    // rising at least 4 over it; the landing one past it
    if (y === G[k] && G[k4] - y >= LIFT.riseMin && inS(k5) && !(c.once && cheb(W, k5, c.goalK) > c.approach)) {
      for (const side of c.down ? SIDES : ['right']) {
        const r = towerCheck(state, [state.minX + i, y, state.minZ + j], hf, side);
        if (!r.ok) continue;
        S.relax(k5, hf, 2, r.yT * FP, r.cost, argOf('up', c.down, side), c.once ? 1 : f);
      }
    }
    // down: from one past a top walk cell, heading away from the face, over the down column to its approach 5 ahead
    if (c.down && y - G[k5] >= LIFT.riseMin && inS(k5) && !(c.once && cheb(W, k5, c.goalK) > c.approach)) {
      for (const side of SIDES) {
        const [ax, az] = upApproachOf(state, i, j, hf, side);
        const ai = ax - state.minX, aj = az - state.minZ;
        if (ai < 0 || aj < 0 || ai >= W || aj >= D) continue;
        const y0 = G[k5];
        const r = towerCheck(state, [ax, y0, az], (hf + 4) & 7, side);
        if (!r.ok || r.yT !== y) continue;
        S.relax(k5, hf, 2, y0 * FP, r.cost, argOf('down', true, side), c.once ? 1 : f);
      }
    }
  }
}

/** The path cells of a lift move (after its start cell) and the segment's data. */
export function liftCells(state, m) {
  const a = unArg(m.arg), sx = Math.sign(m.dx), sz = Math.sign(m.dz);
  const hf = sx > 0 ? 0 : sx < 0 ? 4 : sz > 0 ? 2 : 6;
  const i0 = m.x0 - state.minX, j0 = m.z0 - state.minZ;
  let up, dirH;
  if (a.move === 'up') { up = [m.x0, m.y0, m.z0]; dirH = hf; } else {
    const [ax, az] = upApproachOf(state, i0, j0, hf, a.side);
    up = [ax, m.y1, az]; dirH = (hf + 4) & 7;
  }
  const g = towerCheck(state, up, dirH, a.side);
  const cells = [];
  if (a.move === 'up') {
    // the airlock's two cells and the shaft at the foot's level, the top walk cell at the top's, then the landing past it
    for (let t = 1; t <= 3; t++) cells.push([m.x0 + sx * t, m.y0, m.z0 + sz * t]);
    cells.push([m.x0 + sx * 4, m.y1, m.z0 + sz * 4]);
    cells.push([m.x1, m.y1, m.z1]);
  } else {
    // the top walk cell at the top's level, the shaft and the airlock at the foot's, then the approach
    cells.push([m.x0 + sx, m.y0, m.z0 + sz]);
    for (let t = 2; t <= 4; t++) cells.push([m.x0 + sx * t, m.y1, m.z0 + sz * t]);
    cells.push([m.x1, m.y1, m.z1]);
  }
  const d = DIRS[dirH];
  return { cells, data: { move: a.move, down: a.down, side: a.side, dir: [d[0], d[1]], rise: g.rise, y0: g.y0, yT: g.yT, approach: [...up], check: { ok: !!g.ok, rise: g.rise, cost: g.cost } } };
}

/** After an edge routes: its lifts (`edgeOut.lifts`); each tower's columns are hard for every later edge (true: the blocks changed). */
export function liftCommit(state, env, edgeOut) {
  if (!state?.cur) return false;
  const out = [];
  for (const g of edgeOut.segments ?? []) {
    if (g.kind !== 'lift') continue;
    const r = towerCheck(state, g.approach, DIRS.findIndex((d) => d[0] === g.dir[0] && d[1] === g.dir[1]), g.side);
    if (r.ok) {
      for (const [x, z] of r.footprint) { const i = x - state.minX, j = z - state.minZ; if (i >= 0 && j >= 0 && i < state.W && j < state.D) state.committed[i + j * state.W] = 1; }
      state.any = true;
    }
    out.push({ from: [...edgeOut.path[g.from]], to: [...edgeOut.path[g.to]], move: g.move, down: g.down, side: g.side, dir: [...g.dir], rise: g.rise, y0: g.y0, yT: g.yT, approach: [...g.approach] });
  }
  if (out.length) edgeOut.lifts = out;
  void env;
  return out.length > 0;
}

const cmpKey = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };
const rankOf = (r) => (r.ok ? LIFT_ORDER.length : LIFT_ORDER.indexOf(r.code));

/**
 * Why a lift edge found no route (K1b's method): over the near cells its search reached (each from its ground and from the highest y the
 * search reached there), every cardinal tower whose face 4 ahead rises (up) or falls (down, with `down`) by at least LIFT.riseMin, its
 * top (or foot) within `approach` of the goal; the rise is judged against the limits as checkLift does (SPAN). NO_CLIMB when no tower
 * stands at a face; else the candidate that got furthest through §3's order, then nearest the goal, names its first failing check;
 * UNREACHABLE when one passes. Sets `edgeOut.failed = 'LIFT'`, `edgeOut.t7 = {lift: {code, evidence}}`.
 */
export function liftFail(state, edgeOut, inS) {
  const c = state?.cur;
  if (!c || !c.diagnose) return false;
  const { W, D, minX, minZ, G } = state;
  const gi = c.goalK % W, gj = (c.goalK - gi) / W;
  let best = null, faces = 0, tried = 0;
  const wide = { min: LIFT.riseMin, max: LIFT.diagMax };
  for (let k = 0; k < W * D; k++) {
    if (!c.reached[k]) continue;
    const i = k % W, j = (k - i) / W, yTop = c.reached[k] - 32768 - 1;
    for (const y of yTop === G[k] ? [G[k]] : [G[k], yTop]) {
      for (let hf = 0; hf < 8; hf += 2) {
        const i4 = i + 4 * DIRS[hf][0], j4 = j + 4 * DIRS[hf][1], i5 = i + 5 * DIRS[hf][0], j5 = j + 5 * DIRS[hf][1];
        if (i5 < 0 || j5 < 0 || i5 >= W || j5 >= D) continue;
        const k4 = i4 + j4 * W, k5 = i5 + j5 * W;
        if (!inS(k5) || (c.once && cheb(W, k5, c.goalK) > c.approach)) continue;
        const cands = [];
        if (y === G[k] && G[k4] - y >= LIFT.riseMin) for (const side of c.down ? SIDES : ['right']) cands.push({ a: [minX + i, y, minZ + j], hf, side, move: 'up' });
        if (c.down && y - G[k5] >= LIFT.riseMin) for (const side of SIDES) { const [ax, az] = upApproachOf(state, i, j, hf, side); cands.push({ a: [ax, G[k5], az], hf: (hf + 4) & 7, side, move: 'down', top: y }); }
        for (const q of cands) {
          tried++;
          const r0 = checkLift(state.land, q.a, DIRS[q.hf], { down: c.down, side: q.side, rise: wide, _unsafe: c.unsafe ?? undefined });
          let r = r0;
          if (r0.ok || !['NO_CLIMB', 'SPAN'].includes(r0.code)) {
            if (r0.rise < c.rise.min || r0.rise > c.rise.max) r = { ok: false, code: 'SPAN', evidence: { rise: r0.rise, min: c.rise.min, max: c.rise.max } };
          }
          if (r.code === 'NO_CLIMB') continue;
          if (q.move === 'down' && r.ok && r0.yT !== q.top) continue;
          faces++;
          const code = r.ok ? 'UNREACHABLE' : r.code;
          const key = [-rankOf(r), Math.max(Math.abs(i5 - gi), Math.abs(j5 - gj)), Math.abs((r0.rise ?? 0) - c.rise.min), minX + i, minZ + j, q.hf, q.side === 'right' ? 0 : 1];
          if (!best || cmpKey(key, best.key) < 0) best = { key, code, evidence: { ...(r.evidence ?? {}), rise: r0.rise, move: q.move, ...(c.down ? { side: q.side } : {}), from: [minX + i, y, minZ + j], to: [minX + i5, G[k5], minZ + j5] } };
        }
      }
    }
  }
  const why = !faces
    ? { code: 'NO_CLIMB', evidence: { rise: 0, need: LIFT.riseMin, tried, approach: c.once ? c.approach : null, message: `no face rising ${LIFT.riseMin} or more${c.once ? ` within ${c.approach} of both ends` : ''}` } }
    : { code: best.code, evidence: best.evidence };
  edgeOut.failed = 'LIFT';
  edgeOut.t7 = { ...(edgeOut.t7 ?? {}), lift: why };
  edgeOut.note = `no lift: ${why.code}`;
  return true;
}
