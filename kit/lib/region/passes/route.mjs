// (6c T2) The `route` pass (docs/SETTLEMENTS.md §4.3, docs/CONTRACT.md "Phase 6c slice T2" §2): slope-aware routing of a plan's
// edges over the plan survey. A* over (x, z, heading, k) with 8 headings, `k` the straight cells since the last turn (0..3: a walk
// turns 45 degrees at most and only after 3 straight cells, so a tight reversal is a hairpin with its landing, never a pivot);
// the profile y rides in the state as a fixed-point value (1/16 block) that follows the ground at most `maxGrade` per cell, so
// every 8-cell window of a walk run is within the grade by construction, and switchbacks emerge where the land is steeper than
// that: a walk that can't climb straight runs across the slope, turns on a landing and comes back. Moves: walk (length, turn,
// grade, cut and fill), stair flights (rise 1 a cell, at most 8, then 2 flat cells; `stairs`), hairpins (a flat landing that
// holds both lanes), ladders (a cliff climbed against its face; only on an edge whose movers lack `villager`). Obstacles: the
// claim margin, water, lava, unknown columns, the caller's hard rects (lots and their aprons, forms, keep sets), keep-out rects,
// trees, and an earlier edge's stairs and ladders. Hysteresis: a cell on an earlier edge's walk or on a caller's `prefer` cell
// (a 4e road, a region path, an earlier plan's route) costs a third, and an earlier edge's walk cell keeps its y. Coarse to fine:
// a corridor search at 4 cells, then the cell search within `corridor` of it (the whole claim if that fails). Ties by (f, g, x,
// z, heading, k). Plan time only, pure, under the realise lint (integer math; Math.floor/abs/min/max only).
import { FLAG_LAVA, FLAG_MISSING, FLAG_TREE, FLAG_WATER } from '../pack.mjs';
import { gateActive, gateCells, gateCommit, gateExpand, gateInit, gatePrune } from './moves/gate.mjs';
import { ropeActive, ropeCells, ropeCommit, ropeExpand, ropeFail, ropeInit, ropeNeedsFlag } from './moves/rope.mjs';
// (6c T3) the bridge row (T3a's file) and the tunnel row (T3b's file): each file owns its row's hooks, this table only lists them
import { bridgeActive, bridgeCells, bridgeCommit, bridgeExpand, bridgeFail, bridgeInit, bridgeNeedsFlag } from './moves/bridge.mjs';
import { tunnelActive, tunnelBlocks, tunnelCells, tunnelCommit, tunnelExpand, tunnelFail, tunnelInit, tunnelNeedsFlag, tunnelPrune } from './moves/tunnel.mjs';
// (7a foundation) rows 9 lift (LF's file), 10 catwalk (CW's), 11 rock_stair (RK's), and the edge profiles over the built-in moves (CL's)
import { liftActive, liftBlocks, liftCells, liftCommit, liftExpand, liftFail, liftInit, liftNeedsFlag } from './moves/lift.mjs';
import { catwalkActive, catwalkBlocks, catwalkCells, catwalkCommit, catwalkExpand, catwalkFail, catwalkInit, catwalkNeedsFlag } from './moves/catwalk.mjs';
import { rockStairActive, rockStairBlocks, rockStairCells, rockStairCommit, rockStairExpand, rockStairFail, rockStairInit, rockStairNeedsFlag } from './moves/rockStair.mjs';
import { PROFILES } from './moves/profiles.mjs';

/** The 8 headings (x east, z south): E, SE, S, SW, W, NW, N, NE. Even headings are cardinal. */
export const DIRS = Object.freeze([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
/** Integer move costs (a straight cell is 10). */
export const COST = Object.freeze({ step: 10, diag: 14, turn: 8, grade: 6, cutFill: 3, flight: 60, stair: 40, hairpin: 40, landing: 2, ladder: 80, ladderPer: 25 });
/** Fixed-point scale of the profile (1/16 block). */
const FP = 16;
/** Straight cells a walk needs after a turn before it may turn again. */
export const TURN_COOLDOWN = 3;
/** The coarse grid's cell (in survey cells) and the fine search's corridor half-width (in cells). */
export const COARSE = 4;
export const CORRIDOR = 16;
/**
 * (7a CL) A climb edge's (a stair, switchback or ladder profile) tree cells within its ends' box grown by CORRIDOR are passable at
 * this extra cost a cell, not obstacles: the search still goes round a tree when that is cheap, and the realise fells only the trees
 * the chosen path and its clearance touch (6a's tree rule). A natural site's surveyed trees drift between surveys of one seed world
 * (chunk features not settled), and a climb in woods has no other way up. Every other edge keeps trees as obstacles.
 */
export const CLIMB_TREE_COST = 30;
const CLIMB_TREE_PROFILES = new Set(['stair', 'switchback', 'ladder']);
/** The grade window (cells), a flight's longest run (the landing interval) and the tallest ladder. */
export const WINDOW = 8;
export const FLIGHT_MAX = 8;
export const LADDER_MAX = 24;
/** No stair flight or ladder this close (cells) to an edge's end. */
export const NEAR_END = 1;
/** How far a tree's logs may reach from its surveyed column (a felled trunk goes whole). */
export const TREE_REACH = 6;
/** Movers that never climb: an edge with one of these never gets a ladder (Steward S-T2-2). */
export const VILLAGER = 'villager';
/** Lot kinds whose edges are player-only (S-T2-1: lookouts, watchtowers), and the kinds a villager must reach. */
export const PLAYER_ONLY_KINDS = Object.freeze(['lookout', 'watchtower', 'tower', 'overlook']);
const NONE = -32768;
const INF = 0x7fffffff;
const isInt = Number.isInteger;

/**
 * (7a K1) The special route moves (docs/CONTRACT.md "Phase 7a slice K1" §4; the interface K1a and K1b share, frozen by N-K1-4).
 * Each row, in this order:
 *   name, code      the move record's kind (the built-in moves are 0 walk, 1 stair, 2 hairpin, 3 ladder, 4 an earlier edge's walk)
 *   segment         the segment kind its moves make in the edge's `segments` (with the row's `data` merged in)
 *   flag            the move may set the A* state's flag bit (one bit, shared: the rope move's `spanned`)
 *   init(env, intent) -> state | null      once per pass; null turns the row off (no wall, no rope edge: the pass is T2's, byte for
 *                                           byte)
 *   active(state, edge) -> bool             whether the edge searches with the move
 *   needsFlag(state, edge) -> bool          whether the edge's goal needs the flag bit (a rope_bridge: exactly one span)
 *   blocks(state) -> Uint8Array | null      cells every edge treats as hard obstacles (the wall cells), crossed only by a move
 *   expand(state, S)                        relaxes the move's candidates from an expanded state (S below)
 *   cells(state, m) -> {cells, data}        the path cells of a move after its start cell ([[x, y, z]]), and the segment's data
 *   commit(state, env, edgeOut, moves, lat) after an edge routes (the gate move opens its gates for the later edges)
 *   prune(state, from, to) -> note | null   (optional) before an edge's search: a reason no route can exist (a sealed wall between its
 *                                           ends: the edge fails NO_ROUTE at once, instead of spending the node budget)
 *   fail?(state, edgeOut, inS) -> bool      (K1b, optional) an edge that found no route: the row names why (sets edgeOut.failed);
 *                                           true skips T2's water check (the rope move: NO_GAP, SPAN, ... on a rope_bridge edge)
 * (6c T3) Rows 7 (bridge) and 8 (tunnel) follow gate and rope (docs/CONTRACT.md "Phase 6c slice T3" §4). Each is opt-in per edge as
 * rope is: an edge's `spans` lists the rows it may use (['bridge'], ['tunnel'], an auto edge ['rope', 'bridge', 'tunnel']), and each
 * row's init returns null when no edge lists it, so a plan without T3 parts plans byte for byte as before. `once` names the one row
 * an edge uses exactly once (a bridge edge `once: 'bridge'`, a tunnel edge `once: 'tunnel'`; a rope_bridge edge keeps K1b's
 * `spanOnce`, read as once 'rope'): only that row's needsFlag is true for the edge and only it sets the one flag bit, and the edge
 * walks at most `approach` (default 16) at each end. A row with `crossesWater` (the bridge) has its edges' coarse corridor found over the
 * claim without the water obstacle, so a corridor exists across a river the row may span. An edge's T3 options ride in `edge.t3` ({bridge: {...}, tunnel: {...}}, opaque
 * to this pass), the pass-level inputs in `intent.bridge` and `intent.tunnel`.
 * (7a foundation) Rows 9 (lift), 10 (catwalk) and 11 (rock_stair) follow tunnel, opt-in the same way (`spans`, `once`); an edge's 7a
 * options ride in `edge.t7` ({lift, catwalk, rock_stair}, opaque here), the pass-level inputs in `intent.lift`, `intent.catwalk` and
 * `intent.rockStair`. An edge's `profile` ('stair' | 'switchback' | 'ladder', moves/profiles.mjs) merges its costs over COST and sets
 * its stairs, ladders and ladder limit for that edge's search only; absent, the search is T2's byte for byte. `auto` lists none of
 * rows 9-11 (S-7a-1).
 * Order and ties: a state's moves are relaxed walk, stair, hairpin, ladder, then each active special row in table order; a row
 * relaxes its candidates in its own fixed order (the gate move: at most one, straight ahead; the rope move: K1b's, by span length
 * ascending). The heap breaks ties by (f, g, x, z, heading, k, d, flag), the flag last, so an unflagged state wins a tie.
 * S: {i, j, k, h, kk, y, q, f, W, D, r, G, inS(k), free(k) (clear of every obstacle but the blocks), dOf(y, k), builtY, latLo, latHi,
 * w, nearEnd, relax(k, h, kk, q, cost, arg, f?)} (`relax` records the row's code; f defaults to the state's flag).
 */
export const SPECIAL_MOVES = Object.freeze([
  Object.freeze({ name: 'gate', code: 5, segment: 'gate', flag: false, init: gateInit, active: gateActive, needsFlag: () => false, blocks: (st) => st.mask, expand: gateExpand, cells: gateCells, commit: gateCommit, prune: gatePrune }),
  Object.freeze({ name: 'rope', code: 6, segment: 'rope', flag: true, init: ropeInit, active: ropeActive, needsFlag: ropeNeedsFlag, blocks: () => null, expand: ropeExpand, cells: ropeCells, commit: ropeCommit, fail: ropeFail }),
  Object.freeze({ name: 'bridge', code: 7, segment: 'bridge', flag: true, crossesWater: true, init: bridgeInit, active: bridgeActive, needsFlag: bridgeNeedsFlag, blocks: () => null, expand: bridgeExpand, cells: bridgeCells, commit: bridgeCommit, fail: bridgeFail }),
  Object.freeze({ name: 'tunnel', code: 8, segment: 'tunnel', flag: true, init: tunnelInit, active: tunnelActive, needsFlag: tunnelNeedsFlag, blocks: tunnelBlocks, expand: tunnelExpand, cells: tunnelCells, commit: tunnelCommit, fail: tunnelFail, prune: tunnelPrune }),
  // (7a foundation) rows 9-11 (docs/CONTRACT.md "Phase 7a foundation" §3.2), each in its slice's file; the foundation's inits return null
  Object.freeze({ name: 'lift', code: 9, segment: 'lift', flag: true, init: liftInit, active: liftActive, needsFlag: liftNeedsFlag, blocks: liftBlocks, expand: liftExpand, cells: liftCells, commit: liftCommit, fail: liftFail }),
  Object.freeze({ name: 'catwalk', code: 10, segment: 'catwalk', flag: true, init: catwalkInit, active: catwalkActive, needsFlag: catwalkNeedsFlag, blocks: catwalkBlocks, expand: catwalkExpand, cells: catwalkCells, commit: catwalkCommit, fail: catwalkFail }),
  Object.freeze({ name: 'rock_stair', code: 11, segment: 'rock_stair', flag: true, init: rockStairInit, active: rockStairActive, needsFlag: rockStairNeedsFlag, blocks: rockStairBlocks, expand: rockStairExpand, cells: rockStairCells, commit: rockStairCommit, fail: rockStairFail }),
]);

/** (6c T3) The row an edge uses exactly once: `once` ('rope' | 'bridge' | 'tunnel'; (7a) 'lift' | 'catwalk' | 'rock_stair'), or K1b's
 * `spanOnce` read as 'rope'; else null. */
export const onceOf = (edge) => (typeof edge?.once === 'string' ? edge.once : edge?.spanOnce ? 'rope' : null);

/**
 * S-T2-1: an edge's movers from its end nodes' lot kinds. A player-only kind at either end (a lookout, a watchtower) makes the
 * edge player-only (`['player']`, ladders allowed); otherwise villagers walk it too (`['player', 'villager']`). An explicit list
 * (a later per-edge override) wins.
 */
export function inferMovers(fromKind, toKind, explicit = null) {
  if (Array.isArray(explicit) && explicit.length) return [...explicit];
  const po = (k) => typeof k === 'string' && PLAYER_ONLY_KINDS.includes(k);
  return po(fromKind) || po(toKind) ? ['player'] : ['player', VILLAGER];
}

/**
 * The grade of a run's surface y values over every `window`-cell window: `{windows, bad, maxRise, limit}`; a window is bad when it
 * rises (or falls) more than floor(maxGrade * window). One function for the pass, the checker's M2:grade and the gate.
 */
export function windowGrade(ys, maxGrade, window = WINDOW) {
  const limit = Math.floor(maxGrade * window + 1e-9);
  let windows = 0, bad = 0, maxRise = 0;
  for (let i = 0; i + window < ys.length; i++) {
    const d = Math.abs(ys[i + window] - ys[i]);
    windows++;
    if (d > maxRise) maxRise = d;
    if (d > limit) bad++;
  }
  return { windows, bad, maxRise, limit };
}

/** Chebyshev dilation of a 0/1 grid by `R` cells (separable sliding max). */
export function dilate(m, W, D, R) {
  if (R <= 0) return Uint8Array.from(m);
  const a = new Uint8Array(W * D), out = new Uint8Array(W * D);
  for (let j = 0; j < D; j++) {
    let cnt = 0;
    const row = j * W;
    for (let i = 0; i < Math.min(W, R); i++) cnt += m[row + i];
    for (let i = 0; i < W; i++) {
      if (i + R < W) cnt += m[row + i + R];
      if (i - R - 1 >= 0) cnt -= m[row + i - R - 1];
      a[row + i] = cnt > 0 ? 1 : 0;
    }
  }
  for (let i = 0; i < W; i++) {
    let cnt = 0;
    for (let j = 0; j < Math.min(D, R); j++) cnt += a[i + j * W];
    for (let j = 0; j < D; j++) {
      if (j + R < D) cnt += a[i + (j + R) * W];
      if (j - R - 1 >= 0) cnt -= a[i + (j - R - 1) * W];
      out[i + j * W] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

/** A binary min-heap of states keyed by (f, g, x, z, heading, k): deterministic ties. */
class Heap {
  constructor(tie) { this.f = new Int32Array(1024); this.g = new Int32Array(1024); this.s = new Int32Array(1024); this.n = 0; this.tie = tie; }
  less(a, b) {
    if (this.f[a] !== this.f[b]) return this.f[a] < this.f[b];
    if (this.g[a] !== this.g[b]) return this.g[a] < this.g[b];
    return this.tie(this.s[a], this.s[b]) < 0;
  }
  swap(a, b) {
    let t = this.f[a]; this.f[a] = this.f[b]; this.f[b] = t;
    t = this.g[a]; this.g[a] = this.g[b]; this.g[b] = t;
    t = this.s[a]; this.s[a] = this.s[b]; this.s[b] = t;
  }
  push(f, g, s) {
    if (this.n === this.f.length) {
      const grow = (x) => { const y = new Int32Array(x.length * 2); y.set(x); return y; };
      this.f = grow(this.f); this.g = grow(this.g); this.s = grow(this.s);
    }
    let i = this.n++;
    this.f[i] = f; this.g[i] = g; this.s[i] = s;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop() {
    const top = [this.f[0], this.g[0], this.s[0]];
    this.n--;
    if (this.n > 0) {
      this.f[0] = this.f[this.n]; this.g[0] = this.g[this.n]; this.s[0] = this.s[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

const octile = (di, dj) => { const a = Math.abs(di), b = Math.abs(dj); return a > b ? 10 * (a - b) + 14 * b : 10 * (b - a) + 14 * a; };

/** The coarse corridor: an 8-neighbour A* on COARSE x COARSE blocks; returns the fine-cell corridor mask or null. */
function corridorOf(env, blockedW, si, sj, ti, tj, maxGrade, radius = CORRIDOR) {
  const { W, D, G } = env, F = COARSE;
  const CW = Math.floor((W + F - 1) / F), CD = Math.floor((D + F - 1) / F), cn = CW * CD;
  const cg = new Int32Array(cn), cb = new Uint8Array(cn);
  for (let J = 0; J < CD; J++) for (let I = 0; I < CW; I++) {
    let sum = 0, cnt = 0, bl = 0;
    for (let j = J * F; j < Math.min(D, J * F + F); j++) for (let i = I * F; i < Math.min(W, I * F + F); i++) { const k = i + j * W; sum += G[k]; cnt++; if (blockedW[k]) bl++; }
    cg[I + J * CW] = Math.floor(sum / cnt);
    cb[I + J * CW] = bl * 2 > cnt ? 1 : 0;
  }
  const s = Math.floor(si / F) + Math.floor(sj / F) * CW, t = Math.floor(ti / F) + Math.floor(tj / F) * CW;
  cb[s] = 0; cb[t] = 0;
  const g = new Int32Array(cn).fill(INF), par = new Int32Array(cn).fill(-1), closed = new Uint8Array(cn);
  const TI = t % CW, TJ = (t - TI) / CW;
  const heap = new Heap((a, b) => (a % CW) - (b % CW) || Math.floor(a / CW) - Math.floor(b / CW));
  g[s] = 0;
  heap.push(octile(s % CW - TI, Math.floor(s / CW) - TJ) * F, 0, s);
  const allow = (len) => Math.floor((maxGrade * F * len) / 10 + 1e-9);
  while (heap.n) {
    const [, gv, u] = heap.pop();
    if (closed[u] || gv !== g[u]) continue;
    closed[u] = 1;
    if (u === t) break;
    const I = u % CW, J = (u - I) / CW;
    for (let h = 0; h < 8; h++) {
      const NI = I + DIRS[h][0], NJ = J + DIRS[h][1];
      if (NI < 0 || NJ < 0 || NI >= CW || NJ >= CD) continue;
      const v = NI + NJ * CW;
      if (cb[v] || closed[v]) continue;
      const len = h & 1 ? 14 : 10;
      const excess = Math.max(0, Math.abs(cg[v] - cg[u]) - allow(len));
      const ng = gv + len * F + excess * 20;
      if (ng < g[v]) { g[v] = ng; par[v] = u; heap.push(ng + octile(NI - TI, NJ - TJ) * F, ng, v); }
    }
  }
  if (!closed[t]) return null;
  const seed = new Uint8Array(W * D);
  for (let u = t; u >= 0; u = par[u]) {
    const I = u % CW, J = (u - I) / CW;
    for (let j = J * F; j < Math.min(D, J * F + F); j++) for (let i = I * F; i < Math.min(W, I * F + F); i++) seed[i + j * W] = 1;
  }
  return dilate(seed, W, D, radius);
}

/**
 * Route one edge on the fine grid. The state is (cell, heading, k, d): `d` the surface's offset from the land (-maxCut..maxFill), so
 * the route chooses its own cut and fill (a walk may hold its level over a dip, or cut into a rise); within a state the profile is
 * fixed point (1/16 block) and moves at most `Gq` a cell. Returns `{moves, cost, expanded}` (moves null when there is no route).
 * Move records: `[kind, cell, heading, arg, y]` with kind 0 walk, 1 stair (arg = n * 2 + (s > 0)), 2 hairpin (arg = side: 1 right,
 * 0 left), 3 ladder (arg = 1 up, 0 down); `cell` and `y` are the state the move ends in.
 */
function search(env, ctx) {
  const { W, D } = env;
  // (7a foundation) the edge's profile (moves/profiles.mjs): its costs merged over COST and its ladder limit; absent, COST itself
  const C = ctx.cost ?? COST, LMAX = ctx.ladderMax ?? LADDER_MAX;
  const { G, corridor, blockedW, blocked1, builtY, prefer, start, goal, Gq, w, laneW, Ld, latLo, latHi, maxCut, maxFill, stairs, ladders, nearEnd, maxStates = 24_000_000, maxExpand = Infinity, treeC = null } = ctx;
  const TC = C.tree ?? CLIMB_TREE_COST, treeN = (k) => (treeC && treeC[k] ? TC : 0);
  // (7a K1) the special moves this edge searches with, the flag bit (F = 2 when a row may set it) and whether the goal needs it
  const special = ctx.special ?? [], F = special.some((x) => x.m.flag) ? 2 : 1, needFlag = !!ctx.needFlag;
  const free0 = ctx.free ?? blockedW;
  const goalH = isInt(ctx.goalH) ? ctx.goalH : -1, goalLead = ctx.goalLead ?? 0;
  const ND = maxCut + maxFill + 1, SPC = 32 * ND * F;
  // the footprint square around a centre cell: an own move may lie beside an earlier edge's built cells only within a step of
  // their y (its writes skip them), and a stair flight never over them (its treads would stack)
  const fLo = latLo, fHi = latHi;
  const fpBuilt = (k, y, strict) => {
    const i0 = k % W, j0 = (k - i0) / W;
    for (let dj = fLo; dj <= fHi; dj++) for (let di = fLo; di <= fHi; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= W || j >= D) continue;
      const b = builtY[i + j * W];
      if (b !== NONE && (strict || Math.abs(b - y) > 1)) return true;
    }
    return false;
  };
  // dense ids over the searchable cells
  const cid = new Int32Array(W * D).fill(-1);
  const cells = [];
  for (let k = 0; k < W * D; k++) if ((!corridor || corridor[k]) && !blockedW[k]) { cid[k] = cells.length; cells.push(k); }
  if (cid[start.k] < 0 || cid[goal.k] < 0) return { moves: null, expanded: 0 };
  const S = cells.length * SPC;
  if (S > maxStates) return { moves: null, expanded: 0, tooBig: true };
  const gArr = new Int32Array(S).fill(INF), par = new Int32Array(S).fill(-1), qArr = new Int32Array(S), mv = new Uint8Array(S), arg = new Uint8Array(S), closed = new Uint8Array(S);
  const st = (k, h, kk, d, f = 0) => (((cid[k] * 8 + h) * 4 + kk) * ND + d) * F + f;
  const cellOf = (s) => cells[Math.floor(s / SPC)];
  const hOfS = (s) => Math.floor(s / (4 * ND * F)) & 7, kOfS = (s) => Math.floor(s / (ND * F)) & 3, fOfS = (s) => s % F;
  const tie = (a, b) => {
    const ka = cellOf(a), kb = cellOf(b);
    const xa = ka % W, xb = kb % W;
    if (xa !== xb) return xa - xb;
    const za = (ka - xa) / W, zb = (kb - xb) / W;
    if (za !== zb) return za - zb;
    return (a % SPC) - (b % SPC);
  };
  const heap = new Heap(tie);
  const gi = goal.k % W, gj = (goal.k - gi) / W;
  const hOf = (k) => { const i = k % W; return octile(i - gi, (k - i) / W - gj); };
  const yOf = (q) => Math.floor((q + FP / 2) / FP);
  const dOf = (y, k) => { const d = y - G[k]; return d <= maxFill && -d <= maxCut ? d + maxCut : -1; };
  const inS = (k) => k >= 0 && cid[k] >= 0;
  const open1 = (k) => (!corridor || corridor[k]) && !blocked1[k] && builtY[k] === NONE;
  let curF = 0;
  const relax = (s0, k, h, kk, q, cost, kind, a, built = false, f = curF) => {
    // (a cell an earlier edge built keeps its y whatever this edge's land says: its offset only keys the state)
    let d = dOf(yOf(q), k);
    if (d < 0 && built) d = Math.max(0, Math.min(ND - 1, yOf(q) - G[k] + maxCut));
    if (d < 0) return;
    if (treeC) cost += treeN(k);
    const s = st(k, h, kk, d, f);
    if (closed[s]) return;
    const ng = gArr[s0] + cost;
    if (ng < gArr[s]) { gArr[s] = ng; par[s] = s0; qArr[s] = q; mv[s] = kind; arg[s] = a; heap.push(ng + hOf(k), ng, s); }
  };
  const d0 = dOf(start.y, start.k);
  if (d0 < 0) return { moves: null, expanded: 0 };
  const q0 = start.y * FP;
  for (let h = 0; h < 8; h++) {
    const s = st(start.k, h, TURN_COOLDOWN, d0);
    gArr[s] = 0; qArr[s] = q0; mv[s] = 255;
    heap.push(hOf(start.k), 0, s);
  }
  let expanded = 0, found = -1;
  const qs = [0, 0, 0, 0];
  while (heap.n) {
    const [, gv, s] = heap.pop();
    if (closed[s] || gv !== gArr[s]) continue;
    closed[s] = 1;
    // (6c P0) the check's node budget (maxNodes over all edges): out of budget, no route and `budget`
    if (expanded >= maxExpand) return { moves: null, expanded, budget: true };
    expanded++;
    const k = cellOf(s), h = hOfS(s), kk = kOfS(s), q = qArr[s], y = yOf(q);
    curF = fOfS(s);
    // ((6c D3) an end's `lead: n` (n <= TURN_COOLDOWN): the goal is reached heading `goalH` after n straight walk cells, so the last n cells
    // run straight into the end along its facing; absent: as before)
    if (k === goal.k && y === goal.y && (!needFlag || curF === 1) && (goalH < 0 || (h === goalH && kk >= goalLead && mv[s] === 0))) { found = s; break; }
    const i = k % W, j = (k - i) / W;
    // walk: straight, or 45 degrees after the cooldown; the profile follows the land, or holds, rises or falls by Gq
    for (const dh of kk >= TURN_COOLDOWN ? [0, -1, 1] : [0]) {
      const h2 = (h + dh + 8) & 7, di = DIRS[h2][0], dj = DIRS[h2][1];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= D) continue;
      const nk = ni + nj * W;
      if (!inS(nk)) continue;
      const diag = (h2 & 1) === 1;
      const ck = diag ? ni + j * W : -1; // the 4-connected corner cell (x first, as the primitives' lines)
      if (diag && !inS(ck)) continue;
      // an earlier edge's built cell (its walk, landing or stair footprint): walked at its surface y, a step of at most 1 (it was
      // that edge's to grade; this edge's runs start and end beside it)
      if (builtY[nk] !== NONE) {
        const y2 = builtY[nk];
        if (Math.abs(y2 - y) > 1) continue;
        if (diag && ((builtY[ck] !== NONE && Math.abs(builtY[ck] - y2) > 1) || (builtY[ck] === NONE && dOf(y2, ck) < 0))) continue;
        relax(s, nk, h2, dh ? 0 : Math.min(kk + 1, TURN_COOLDOWN), y2 * FP, Math.floor((diag ? C.diag : C.step) / 3) + (dh ? C.turn : 0), 4, 0, true);
        continue;
      }
      let nq = 0;
      const toward = Math.max(q - Gq, Math.min(q + Gq, G[nk] * FP));
      qs[nq++] = toward;
      for (const c of [q - Gq, q, q + Gq]) if (c !== toward) qs[nq++] = c;
      let len = diag ? C.diag : C.step;
      if (prefer[nk]) len = Math.floor(len / 3);
      for (let t = 0; t < nq; t++) {
        const q2 = qs[t], y2 = yOf(q2);
        if (dOf(y2, nk) < 0) continue;
        let cf = Math.abs(y2 - G[nk]);
        if (diag) {
          if ((builtY[ck] === NONE && dOf(y2, ck) < 0) || (builtY[ck] !== NONE && Math.abs(builtY[ck] - y2) > 1)) continue;
          cf += Math.abs(y2 - G[ck]);
        }
        if (fpBuilt(nk, y2, false)) continue;
        relax(s, nk, h2, dh ? 0 : Math.min(kk + 1, TURN_COOLDOWN), q2, len + (dh ? C.turn : 0) + C.grade * Math.abs(y2 - y) + C.cutFill * cf * w, 0, 0);
      }
    }
    // stair flights: n cells rising (or falling) 1 each, then 2 flat cells; cardinal, within 45 degrees of the heading
    if (stairs && !nearEnd[k]) {
      for (const hf of (h & 1) === 0 ? [h] : [(h + 7) & 7, (h + 1) & 7]) {
        const di = DIRS[hf][0], dj = DIRS[hf][1];
        for (const sg of [1, -1]) {
          let cf = 0;
          for (let n = 1; n <= FLIGHT_MAX; n++) {
            const ci = i + di * n, cj = j + dj * n;
            if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
            const ck = ci + cj * W, yn = y + sg * n;
            if (!inS(ck) || builtY[ck] !== NONE || nearEnd[ck] || dOf(yn, ck) < 0 || fpBuilt(ck, yn, true)) break;
            cf += Math.abs(yn - G[ck]);
            if (n < 2) continue;
            // the 2 landing cells
            let cf2 = 0, ok = true, last = -1;
            for (let t = n + 1; t <= n + 2; t++) {
              const li = i + di * t, lj = j + dj * t;
              if (li < 0 || lj < 0 || li >= W || lj >= D) { ok = false; break; }
              const lk = li + lj * W;
              if (!inS(lk) || builtY[lk] !== NONE || dOf(yn, lk) < 0) { ok = false; break; }
              cf2 += Math.abs(yn - G[lk]);
              last = lk;
            }
            if (!ok) continue;
            // (hysteresis: a flight over preferred cells costs a third, as a walk does)
            let pref = 1;
            for (let t = 1; t <= n + 2 && pref; t++) { const pi = i + di * t, pj = j + dj * t; if (!prefer[pi + pj * W]) pref = 0; }
            let fc = C.flight + C.stair * n + C.step * 2 + C.cutFill * (cf + cf2) * w;
            if (treeC) for (let t = 1; t <= n + 1; t++) fc += treeN(i + di * t + (j + dj * t) * W);
            relax(s, last, hf, 2, yn * FP, (pref ? Math.floor(fc / 3) : fc) + (hf !== h ? C.turn : 0), 1, n * 2 + (sg > 0 ? 1 : 0));
          }
        }
      }
    }
    if ((h & 1) === 0) {
      const di = DIRS[h][0], dj = DIRS[h][1], ri = -dj, rj = di;
      // hairpins: a flat landing ahead that holds both lanes, then back the other way one lane over
      if (kk >= 1) {
        for (const side of [1, -1]) {
          const lo = side > 0 ? latLo : latLo - laneW, hi = side > 0 ? latHi + laneW : latHi;
          let ok = true, cf = 0, cnt = 0, tl = 0;
          for (let t = 1; t <= Ld && ok; t++) {
            for (let v = lo; v <= hi; v++) {
              const ci = i + di * t + ri * v, cj = j + dj * t + rj * v;
              if (ci < 0 || cj < 0 || ci >= W || cj >= D) { ok = false; break; }
              const ck = ci + cj * W;
              if (!open1(ck) || dOf(y, ck) < 0) { ok = false; break; }
              cf += Math.abs(y - G[ck]); tl += treeN(ck); cnt++;
            }
          }
          if (!ok) continue;
          const ei = i + ri * side * laneW, ej = j + rj * side * laneW;
          if (ei < 0 || ej < 0 || ei >= W || ej >= D) continue;
          const ek = ei + ej * W;
          if (!inS(ek) || builtY[ek] !== NONE) continue;
          relax(s, ek, (h + 4) & 7, 0, y * FP, C.hairpin + C.landing * cnt + C.step * (laneW + 2) + C.cutFill * cf + tl, 2, side > 0 ? 1 : 0);
        }
      }
      // ladders (player-only edges): up a cliff face ahead, or down one; the walk meets the land at both feet
      if (ladders && y === G[k]) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < W && nj < D) {
          const nk = ni + nj * W, rise = G[nk] - y;
          if (inS(nk) && builtY[nk] === NONE && !nearEnd[k] && !nearEnd[nk] && Math.abs(rise) >= 2 && Math.abs(rise) <= LMAX) relax(s, nk, h, 2, G[nk] * FP, C.ladder + C.ladderPer * Math.abs(rise), 3, rise > 0 ? 1 : 0);
        }
      }
    }
    // (7a K1) the special moves, in table order
    for (const x of special) {
      const code = x.m.code, f0 = curF;
      x.m.expand(x.st, { i, j, k, h, kk, y, q, f: f0, W, D, r: env.r, G, inS, free: (c) => (!corridor || corridor[c]) && !free0[c], dOf, builtY, latLo, latHi, w, nearEnd,
        relax: (k2, h2, kk2, q2, cost, a2, f2 = f0) => relax(s, k2, h2, kk2, q2, cost, code, a2, false, f2) });
    }
  }
  if (found < 0) return { moves: null, expanded };
  const moves = [];
  for (let s = found; s >= 0 && mv[s] !== 255; s = par[s]) moves.push([mv[s], cellOf(s), hOfS(s), arg[s], yOf(qArr[s]), qArr[s], fOfS(s)]);
  moves.reverse();
  return { moves, cost: gArr[found], expanded };
}

/** The masks of the claim: hard obstacles (raw), trees (raw), water (raw). */
function baseMasks(env, intent, { water = true, keepOut = true } = {}) {
  const { W, D, r, minX, minZ, flags } = env;
  // hard: never under a route's footprint; guard (water, keep-out): not under it nor beside it (a cut beside water lets it in; a
  // retaining column or a lantern beside the footprint stays out of keep-out); trees: never under the footprint
  const n = W * D, hard = new Uint8Array(n), guard = new Uint8Array(n), tree = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const f = flags[k];
    if (f & (FLAG_LAVA | FLAG_MISSING)) hard[k] = 1;
    if (water && (f & FLAG_WATER)) guard[k] = 1;
    if (f & FLAG_TREE) tree[k] = 1;
  }
  const rect = (m, x0, z0, x1, z1) => {
    const i0 = Math.max(0, Math.floor((x0 - minX) / r)), i1 = Math.min(W - 1, Math.floor((x1 - minX) / r));
    const j0 = Math.max(0, Math.floor((z0 - minZ) / r)), j1 = Math.min(D - 1, Math.floor((z1 - minZ) / r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m[i + j * W] = 1;
  };
  // (rects the program clears to the column's top before the routes, e.g. a slope pad's batter: no tree obstacle there)
  for (const b of intent.clearTrees ?? []) {
    const i0 = Math.max(0, Math.floor((b[0] - minX) / r)), i1 = Math.min(W - 1, Math.floor((b[2] - minX) / r));
    const j0 = Math.max(0, Math.floor((b[1] - minZ) / r)), j1 = Math.min(D - 1, Math.floor((b[3] - minZ) / r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) tree[i + j * W] = 0;
  }
  for (const b of intent.hard ?? []) rect(hard, b[0], b[1], b[2], b[3]);
  if (keepOut) {
    const ko = new Uint8Array(n);
    for (const b of intent.keepOut ?? []) rect(ko, b[0], b[1], b[2], b[3]);
    // a tree near keep-out: the realise fells a whole trunk whose log a write removes (6a's tree rule), and a tree within 6 of the
    // rect may reach into it, so the routes keep 6 clear of such trees (their branches are not in the survey); `_unsafe.noTreeReach`
    // turns this guard off (the unit test's broken variant)
    const near = dilate(ko, W, D, Math.floor((TREE_REACH + r - 1) / r));
    const treeNear = new Uint8Array(n);
    if (!intent._unsafe?.noTreeReach) for (let k = 0; k < n; k++) if (near[k] && tree[k]) treeNear[k] = 1;
    const reach = dilate(treeNear, W, D, Math.floor((TREE_REACH + r - 1) / r));
    for (let k = 0; k < n; k++) if (ko[k] || reach[k]) guard[k] = 1;
  }
  // the claim margin
  const m = Math.max(0, Math.floor(((intent.margin ?? 2) + r - 1) / r));
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (i < m || j < m || i >= W - m || j >= D - m) hard[i + j * W] = 1;
  return { hard, guard, tree };
}

/** (6c H) Whether the plan's own water (its columns and shells) separates two cells: a 4-connected flood from `a` that never reaches `b`. */
export function sealedByPlanWater(pw, W, D, a, b) {
  if (pw[a] || pw[b]) return false;
  const seen = new Uint8Array(W * D);
  const q = [a];
  seen[a] = 1;
  for (let h = 0; h < q.length; h++) {
    const k = q[h];
    if (k === b) return false;
    const i = k % W, j = (k - i) / W;
    if (i > 0 && !seen[k - 1] && !pw[k - 1]) { seen[k - 1] = 1; q.push(k - 1); }
    if (i < W - 1 && !seen[k + 1] && !pw[k + 1]) { seen[k + 1] = 1; q.push(k + 1); }
    if (j > 0 && !seen[k - W] && !pw[k - W]) { seen[k - W] = 1; q.push(k - W); }
    if (j < D - 1 && !seen[k + W] && !pw[k + W]) { seen[k + W] = 1; q.push(k + W); }
  }
  return true;
}

/**
 * Where a path crosses or overlaps itself: path indices `j` whose footprint square shares a column with that of an index `i` more than
 * 2 * width + 2 cells before it (a switchback's legs sit side by side, never on each other; a landing's cells are near in index).
 */
export function selfClash(P, width) {
  const lo = -Math.floor((width - 1) / 2), hi = Math.floor(width / 2), gap = 2 * width + 2;
  const first = new Map(), out = [];
  for (let j = 0; j < P.length; j++) {
    const [x, , z] = P[j];
    let hit = false;
    for (let dz = lo; dz <= hi && !hit; dz++) for (let dx = lo; dx <= hi; dx++) {
      const key = (x + dx) * 65536 + (z + dz);
      const i = first.get(key);
      if (i === undefined) continue;
      if (j - i > gap) { hit = true; break; }
    }
    if (hit) out.push(j);
    for (let dz = lo; dz <= hi; dz++) for (let dx = lo; dx <= hi; dx++) {
      const key = (x + dx) * 65536 + (z + dz);
      // the latest index (so a long straight run never clashes with its own tail)
      first.set(key, j);
    }
  }
  return out;
}

/**
 * The pass. `survey`: the plan's columns. `intent` (resolved by the program's `r.pass('route', ...)`): `{edges: [{id, from: {at:
 * [x, y, z] (feet), facing: [dx, dz]?}, to, width, movers, ladders}], maxGrade = 0.25, hairpinLanding = 3, stairs = true, maxCut =
 * 4, maxFill = 4, margin = 2, hard: [[x0, z0, x1, z1]], keepOut: [[x0, z0, x1, z1]], prefer: [[x, z]], base: {minX, minZ, width,
 * depth, values} | null, _unsafe: {noKeepOut, noGrade, villagerLadders, noTreeReach}}`; an edge may carry `prefer: [[x, z]]` (its own
 * preferred cells) and `within: [[x, z]], withinRadius = 3` (6c D2: the search keeps to those cells grown by the radius). Returns `{fields: {}, ops: [], data: {edges: [...]}}`:
 * each edge `{id, ok, failed?, movers, ladders, width, path: [[x, y, z]] (4-connected centre cells, y the surface), segments:
 * [{kind: walk|stair|landing|ladder, from, to}] (path indices, inclusive), landings: [{cells: [[x, z]], y}], ladderCols: [{x, z,
 * y0, y1, facing}], cost, length, rise, expanded, search: 'corridor'|'claim'}`. The program turns them into primitives.
 */
export function routePass(survey, volumes, intent) {
  const c = survey;
  // (6c H) the plan's own water (`intent.fluids`, lib/fluids/moat.mjs passInput: every body's columns): a raised body's footprint is hard
  const it = intent?.fluids ? { ...intent, hard: [...(intent.hard ?? []), ...(intent.fluids.hard ?? [])] } : intent ?? {};
  const { edges = [], maxGrade = 0.25, hairpinLanding = 3, stairs = true, maxCut = 4, maxFill = 4, base = null, _unsafe = {} } = it;
  if (!Array.isArray(edges) || !edges.length) throw new Error('route: `edges` must list the edges to route');
  if (!(typeof maxGrade === 'number' && maxGrade > 0 && maxGrade <= 1)) throw new Error('route: maxGrade must be in (0, 1]');
  if (!(isInt(hairpinLanding) && hairpinLanding >= 1 && hairpinLanding <= 16)) throw new Error('route: hairpinLanding must be 1..16');
  for (const [k, v] of [['maxCut', maxCut], ['maxFill', maxFill]]) if (!(isInt(v) && v >= 0 && v <= 12)) throw new Error(`route: ${k} must be 0..12`);
  const W = c.width, D = c.depth, r = c.resolution, n = W * D;
  // the land the routes meet: the survey's ground plus the program's base (a hill it raises in an earlier stage)
  const G0 = Int16Array.from(c.ground);
  if (base) {
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      const bi = c.minX + i * r - base.minX, bj = c.minZ + j * r - base.minZ;
      if (bi >= 0 && bj >= 0 && bi < base.width && bj < base.depth) G0[i + j * W] += base.values[bi + bj * base.width];
    }
  }
  // (6c H) `intent.fluids`: the plan's own water is water to every move (the walks keep off it as off natural water; the bridge row
  // spans it, its piers never on it): its columns and its shells' carry FLAG_WATER (lava FLAG_LAVA) in the pass's own copy of the
  // flags, their ground the body's surface (so a deck's clearance is measured from it); a shell column's real top (its rim, or the
  // bank over it) is the bridge row's head room there. Absent, the pass reads the survey's flags as before (byte for byte).
  const cellAt = (x, z) => {
    const i = Math.floor((x - c.minX) / r), j = Math.floor((z - c.minZ) / r);
    return i < 0 || j < 0 || i >= W || j >= D ? -1 : i + j * W;
  };
  let flags = c.flags, planWater = null, topFix = null;
  if (it.fluids) {
    flags = Uint8Array.from(c.flags);
    planWater = new Uint8Array(n);
    topFix = new Map();
    for (const [x, z, level] of it.fluids.water ?? []) { const k = cellAt(x, z); if (k < 0) continue; flags[k] |= FLAG_WATER; G0[k] = level; planWater[k] = 1; }
    for (const [x, z, top, level] of it.fluids.shell ?? []) { const k = cellAt(x, z); if (k < 0) continue; flags[k] |= FLAG_WATER; G0[k] = level ?? top - 1; planWater[k] = 2; topFix.set(k, top); }
    for (const [x, z] of it.fluids.lava ?? []) { const k = cellAt(x, z); if (k >= 0) { flags[k] |= FLAG_LAVA; planWater[k] = 3; } }
  }
  // ((6c H-b) the survey's floor too: the bed under water, for the bridge row's wet piers)
  const env = { W, D, r, minX: c.minX, minZ: c.minZ, flags, G: G0, F: c.floor, ...(planWater ? { planWater } : {}) };
  const masks = baseMasks(env, it, { keepOut: !_unsafe.noKeepOut });
  // (7a K1) the special moves' pass-level states (a row whose init returns null is off) and their blocked cells (the walls)
  const special = SPECIAL_MOVES.map((m) => ({ m, st: m.init(env, it) })).filter((x) => x.st);
  // (6c H) a shell column of plan water: the bridge row's head room there is the shell's real top (its rim, or the bank over it)
  if (topFix) for (const x of special) if (x.m.name === 'bridge' && x.st.top) for (const [k, t] of topFix) if (t > x.st.top[k]) x.st.top[k] = t;
  let specialBlocks = null;
  for (const x of special) { const b = x.m.blocks(x.st); if (b) { specialBlocks ??= new Uint8Array(n); for (let k = 0; k < n; k++) specialBlocks[k] |= b[k]; } }
  const builtY = new Int16Array(n).fill(NONE); // an earlier edge's footprint: its surface (or tread) y
  const preferM = new Uint8Array(n);
  for (const p of it.prefer ?? []) { const k = cellAt(p[0], p[1]); if (k >= 0) preferM[k] = 1; }
  const earlier = new Uint8Array(n); // an earlier edge's stairs and ladders
  // no stair or ladder within NEAR_END cells of any edge's end: the approaches stay walks, which later edges share (with their y)
  const nearEnd = new Uint8Array(n);
  for (const e of edges) for (const p of [e.from, e.to]) {
    if (!p || !Array.isArray(p.at)) continue;
    const k = cellAt(p.at[0], p.at[2]);
    if (k < 0) continue;
    // ((6c S3) `nearEnd`: the pass's own radius, a terraced district's (several joins share a lot's approach); absent: NEAR_END)
    const i0 = k % W, j0 = Math.floor(k / W), R = Math.floor(((isInt(it.nearEnd) ? it.nearEnd : NEAR_END) + r - 1) / r);
    for (let j = Math.max(0, j0 - R); j <= Math.min(D - 1, j0 + R); j++) for (let i = Math.max(0, i0 - R); i <= Math.min(W - 1, i0 + R); i++) nearEnd[i + j * W] = 1;
  }
  // ((6c D3) a frame's hard cells: outside its rects, and within the margin of its outer edge (cached per frame))
  const frames = new Map();
  const frameMask = (f) => {
    if (!Array.isArray(f) || !f.length) return null;
    const key = JSON.stringify(f);
    if (frames.has(key)) return frames.get(key);
    const out = new Uint8Array(n).fill(1);
    for (const q of f) {
      const i0 = Math.max(0, Math.floor((q[0] - c.minX) / r)), i1 = Math.min(W - 1, Math.floor((q[2] - c.minX) / r));
      const j0 = Math.max(0, Math.floor((q[1] - c.minZ) / r)), j1 = Math.min(D - 1, Math.floor((q[3] - c.minZ) / r));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out[i + j * W] = 0;
    }
    const m = Math.max(0, Math.floor(((it.margin ?? 2) + r - 1) / r));
    const hard = dilate(out, W, D, m);
    frames.set(key, hard);
    return hard;
  };
  const coarse = r > 1;
  // (6c S2) the quantum also keeps every WINDOW-cell window within the checker's whole-block limit floor(maxGrade * WINDOW): at a
  // grade whose window limit rounds down (0.2: 1.6 -> 1 block), 3/16 a cell rises 1.5 over a window, which rounds to 2. At 0.25
  // (the default: 2 blocks, 4/16 a cell) both give the same quantum, so no earlier route moves.
  const GqWin = Math.floor((Math.floor(maxGrade * WINDOW + 1e-9) * FP * r) / WINDOW);
  // (`_unsafe.coarseGrade`: the broken variant, the quantum before S2)
  const Gq = _unsafe.noGrade ? FP * 16 : Math.max(1, _unsafe.coarseGrade ? Math.floor(maxGrade * FP * r + 1e-9) : Math.min(Math.floor(maxGrade * FP * r + 1e-9), GqWin));
  const out = { edges: [], resolution: r, maxGrade, hairpinLanding, stairs, coarse };
  // (6c P0) `maxExpanded`: A* expansions over all edges (the plan check's maxNodes); absent, no cap. An edge the budget stops, and
  // every edge after it, fails `BUDGET` (never searched again for a reason)
  const cap = isInt(it.maxExpanded) && it.maxExpanded >= 0 ? it.maxExpanded : Infinity;
  let spent = 0, broke = false;
  for (const e of edges) {
    const w = e.width ?? 3;
    if (!(isInt(w) && w >= 1 && w <= 9)) throw new Error(`route ${e.id}: width must be 1..9`);
    const movers = inferMovers(null, null, e.movers);
    const ladders = !coarse && !!e.ladders && (!movers.includes(VILLAGER) || !!_unsafe.villagerLadders);
    const lo = -Math.floor((w - 1) / 2), hi = Math.floor(w / 2);
    const Rw = Math.floor((Math.max(-lo, hi) + 1 + r - 1) / r), R1 = Math.floor((1 + r - 1) / r);
    const Rt = Math.floor((Math.max(-lo, hi) + r - 1) / r);
    const edgeOut = { id: e.id, ok: false, movers, ladders, width: w, path: [], segments: [], landings: [], ladderCols: [], cost: 0, length: 0, rise: 0, expanded: 0, search: 'corridor' };
    out.edges.push(edgeOut);
    const ends = [e.from, e.to].map((p, idx) => {
      if (!p || !Array.isArray(p.at) || p.at.length !== 3 || !p.at.every(isInt)) throw new Error(`route ${e.id}: ${idx ? 'to' : 'from'} needs at: [x, y, z] (feet)`);
      return { k: cellAt(p.at[0], p.at[2]), y: p.at[1] - 1, facing: p.facing ?? null, at: p.at };
    });
    if (ends.some((x) => x.k < 0)) { edgeOut.failed = 'NO_ROUTE'; edgeOut.note = 'an end is outside the survey'; continue; }
    if (broke || spent >= cap) { broke = true; edgeOut.failed = 'BUDGET'; edgeOut.note = `the node budget (${cap} expansions over all edges) ran out before this edge`; continue; }
    // the land near each end ramps to its y (a pad's top is not the natural ground)
    const G = Int16Array.from(G0);
    for (const en of ends) {
      const ei = en.k % W, ej = (en.k - ei) / W;
      const R = Math.min(24, Math.max(8, 4 * Math.abs(G0[en.k] - en.y)));
      for (let j = Math.max(0, ej - R); j <= Math.min(D - 1, ej + R); j++) for (let i = Math.max(0, ei - R); i <= Math.min(W - 1, ei + R); i++) {
        const d = Math.max(Math.abs(i - ei), Math.abs(j - ej)), k = i + j * W;
        G[k] = G0[k] + Math.floor(((en.y - G0[k]) * (R - d)) / R);
      }
    }
    env.G = G;
    const sp = special.filter((x) => x.m.active(x.st, e));
    const needFlag = sp.some((x) => x.m.needsFlag(x.st, e));
    const pruned = sp.map((x) => x.m.prune?.(x.st, ends[0].at, ends[1].at) ?? null).find((v) => v);
    if (pruned) { edgeOut.failed = 'NO_ROUTE'; edgeOut.note = pruned; continue; }
    // (6c H) the plan's own water between the ends (a closed moat round one of them): no walk crosses it, so an edge that may not
    // span water fails at once as ROUTE_WATER (the street fallback bridges it) instead of spending the node budget on the claim
    if (planWater && !sp.some((x) => x.m.crossesWater) && sealedByPlanWater(planWater, W, D, ends[0].k, ends[1].k)) {
      edgeOut.failed = 'ROUTE_WATER';
      edgeOut.note = "the plan's own water lies between the ends (a closed ring round one of them): every route crosses water";
      continue;
    }
    // ((6c D3) `frame`: the edge's own frame (rects [x0, z0, x1, z1], their union), else the pass's; absent both: the survey's grid, as
    // before)
    const fr = frameMask(e.frame ?? it.frame ?? null);
    const build = (water) => {
      const mk = water ? masks : baseMasks(env, it, { water: false, keepOut: !_unsafe.noKeepOut });
      const hardW = dilate(mk.hard, W, D, Rt), guardW = dilate(mk.guard, W, D, Rw), treeW = dilate(mk.tree, W, D, Rt), earlyW = dilate(earlier, W, D, Rt);
      const blockedW = new Uint8Array(n), blocked1 = dilate(mk.guard, W, D, R1);
      // ((7a CL) a climb edge's trees in its box: passable at CLIMB_TREE_COST, marked in treeC)
      let tree1 = mk.tree, treeC = null;
      if (CLIMB_TREE_PROFILES.has(e.profile)) {
        const [ai, aj] = [ends[0].k % W, Math.floor(ends[0].k / W)], [bi, bj] = [ends[1].k % W, Math.floor(ends[1].k / W)];
        const i0 = Math.max(0, Math.min(ai, bi) - CORRIDOR), i1 = Math.min(W - 1, Math.max(ai, bi) + CORRIDOR);
        const j0 = Math.max(0, Math.min(aj, bj) - CORRIDOR), j1 = Math.min(D - 1, Math.max(aj, bj) + CORRIDOR);
        tree1 = Uint8Array.from(mk.tree);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const k = i + j * W;
          if (treeW[k] || tree1[k]) { treeC ??= new Uint8Array(n); treeC[k] = 1; treeW[k] = 0; tree1[k] = 0; }
        }
      }
      for (let k = 0; k < n; k++) { blockedW[k] = hardW[k] | guardW[k] | treeW[k] | earlyW[k]; blocked1[k] |= mk.hard[k] | tree1[k] | earlier[k]; }
      // ((6c D3) the edge's frame: outside it, and within the margin of its outer edge, is hard (under the footprint too))
      if (fr) { const fW = dilate(fr, W, D, Rt); for (let k = 0; k < n; k++) { blockedW[k] |= fW[k]; blocked1[k] |= fr[k]; } }
      // the approach to a lot: straight out of its front, through its apron and the margins
      for (const en of ends) {
        const fx = en.facing ? en.facing[0] : 0, fz = en.facing ? en.facing[1] : 0;
        const A = en.facing ? Math.floor((hi + 2 + r - 1) / r) : 0;
        for (let t = 0; t <= A; t++) {
          const i = (en.k % W) + fx * t, j = Math.floor(en.k / W) + fz * t;
          if (i < 0 || j < 0 || i >= W || j >= D) continue;
          const k = i + j * W;
          if ((mk.hard[k] || mk.guard[k]) && !en.facing) continue;
          // never into keep-out or water
          const x = c.minX + i * r, z = c.minZ + j * r;
          if (!_unsafe.noKeepOut && (it.keepOut ?? []).some((b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3])) continue;
          if (env.flags[k] & (FLAG_WATER | FLAG_LAVA)) continue;
          blockedW[k] = 0;
        }
      }
      // (7a K1) the special moves' blocked cells (the walls, under the footprint and its half width) after the approaches, so no
      // walk ever writes one; `free` keeps the obstacles without them (a gate move's own cells, the coarse corridor)
      if (!specialBlocks) return { blockedW, blocked1, ...(treeC ? { treeC } : {}) };
      const free = Uint8Array.from(blockedW), sbW = dilate(specialBlocks, W, D, Rt);
      for (let k = 0; k < n; k++) { blockedW[k] |= sbW[k]; blocked1[k] |= specialBlocks[k]; }
      return { blockedW, blocked1, free, ...(treeC ? { treeC } : {}) };
    };
    // the edge's own earlier route (6d replanning: `prefer` on the edge) costs a third too, for this edge only
    let preferE = preferM;
    if (Array.isArray(e.prefer) && e.prefer.length) {
      preferE = Uint8Array.from(preferM);
      for (const p of e.prefer) { const k = cellAt(p[0], p[1]); if (k >= 0) preferE[k] = 1; }
    }
    // (6c D2) `within: [[x, z]]` on the edge (a following district's street line): the search keeps to those cells grown by
    // `withinRadius` (default 3), one search in that corridor instead of the corridor, corridor48, claim sequence
    let withinM = null;
    if (Array.isArray(e.within) && e.within.length) {
      const seed = new Uint8Array(n);
      for (const p of e.within) { const k = cellAt(p[0], p[1]); if (k >= 0) seed[k] = 1; }
      const wr = isInt(e.withinRadius) && e.withinRadius >= 0 && e.withinRadius <= 16 ? e.withinRadius : 3;
      withinM = dilate(seed, W, D, Math.floor((wr + r - 1) / r));
    }
    // (7a K1b) a rope_bridge edge (`spanOnce`) walks at most `approach` cells at each end: it searches the two squares of that radius
    // round its ends only (its span's landings lie in them; the deck between needs no search cell); (6c T3) so does any `once` edge
    if (!withinM && onceOf(e)) {
      const A = isInt(e.approach) && e.approach >= 0 && e.approach <= 32 ? e.approach : 16;
      const seed = new Uint8Array(n);
      for (const en of ends) seed[en.k] = 1;
      withinM = dilate(seed, W, D, Math.floor((A + r - 1) / r));
    }
    // ((6c D3) the `to` end's `lead`: the goal's arriving heading (against its facing, cardinal) and its straight cells)
    const lead = isInt(e.to?.lead) && e.to.lead > 0 && Array.isArray(e.to.facing) ? Math.min(TURN_COOLDOWN, e.to.lead) : 0;
    const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const goalH = lead ? DIRS.findIndex((d) => d[0] === -sgn(e.to.facing[0]) && d[1] === -sgn(e.to.facing[1])) : -1;
    // (7a foundation) the edge's profile: its costs over COST, its stairs and ladders ANDed with the pass's, its ladder limit
    const prof = e.profile === undefined || e.profile === null ? null : PROFILES[e.profile];
    if (e.profile !== undefined && e.profile !== null && !prof) throw new Error(`route ${e.id}: profile must be one of ${Object.keys(PROFILES).join(', ')}`);
    const sctx = { G, builtY, prefer: preferE, start: ends[0], goal: ends[1], ...(goalH >= 0 && (goalH & 1) === 0 ? { goalH, goalLead: lead } : {}), Gq, w, laneW: Math.floor((w + r - 1) / r), Ld: Math.floor((Math.max(isInt(e.hairpinLanding) && e.hairpinLanding >= 1 && e.hairpinLanding <= 16 ? e.hairpinLanding : hairpinLanding, w) + r - 1) / r), // ((7a CL) an edge's own landing depth: a switchback's `landing`)
     
      latLo: Math.floor(lo / r), latHi: Math.floor((hi + r - 1) / r), maxCut, maxFill, stairs: (e.stairs ?? stairs) && !coarse && (!prof || prof.stairs), ladders: ladders && (!prof || prof.ladders), nearEnd, // ((6c S3) an edge's own `stairs: false`)
      ...(prof ? { cost: { ...COST, ...prof.cost }, ladderMax: prof.ladderMax } : {}),
      ...(sp.length ? { special: sp, needFlag } : {}) };
    // ---- the moves as 4-connected centre cells with their surface y, and segments
    const toPath = (res) => {
    const P = [], landings = [], ladderCols = [];
    const wx = (k) => c.minX + (k % W) * r, wz = (k) => c.minZ + Math.floor(k / W) * r;
    const push = (x, y, z) => { const l = P[P.length - 1]; if (!l || l[0] !== x || l[2] !== z || l[1] !== y) P.push([x, y, z]); return P.length - 1; };
    const segs = [];
    const seg = (kind, from, to) => {
      const l = segs[segs.length - 1];
      if (l && l.kind === kind && !l.shared && l.to === from) l.to = to; else segs.push({ kind, from, to });
    };
    push(wx(ends[0].k), ends[0].y, wz(ends[0].k));
    const lineTo = (x0, z0, x1, z1, y0, y1) => {
      // the primitives' 4-connected line (x first on a tie), y moving from y0 to y1 at the last cell (r = 1) or spread (r > 1)
      const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0), sx = x1 > x0 ? 1 : -1, sz = z1 > z0 ? 1 : -1;
      let x = x0, z = z0, ix = 0, iz = 0;
      const total = dx + dz;
      let idx = P.length - 1, s = 0;
      while (ix < dx || iz < dz) {
        const tx = (1 + 2 * ix) * dz, tz = (1 + 2 * iz) * dx;
        if (iz >= dz || (ix < dx && tx <= tz)) { x += sx; ix++; } else { z += sz; iz++; }
        s++;
        const y = r === 1 ? y1 : y0 + Math.floor(((y1 - y0) * s * 2 + total) / (2 * total));
        idx = push(x, y, z);
      }
      return idx;
    };
    let curK = ends[0].k, curY = ends[0].y;
    for (const [kind, k, h, a, y] of res.moves) {
      const from = P.length - 1;
      if (kind === 0) {
        const to = lineTo(wx(curK), wz(curK), wx(k), wz(k), curY, y);
        seg('walk', from, to);
      } else if (kind === 1) {
        const nst = a >> 1, sg = a & 1 ? 1 : -1, di = DIRS[h][0] * r, dj = DIRS[h][1] * r;
        let idx = from;
        for (let t = 1; t <= nst; t++) idx = push(wx(curK) + di * t, curY + sg * t, wz(curK) + dj * t);
        segs.push({ kind: 'stair', from, to: idx });
        const l1 = push(wx(curK) + di * (nst + 1), curY + sg * nst, wz(curK) + dj * (nst + 1));
        const l2 = push(wx(curK) + di * (nst + 2), curY + sg * nst, wz(curK) + dj * (nst + 2));
        seg('walk', idx, l2 > l1 ? l2 : l1);
      } else if (kind === 2) {
        const side = a ? 1 : -1, hh = (h + 4) & 7, f = DIRS[hh], rr = [-f[1], f[0]];
        // the entry heading is the reverse of the new one
        const x0 = wx(curK), z0 = wz(curK);
        const fi = f[0] * r, fj = f[1] * r, ri = rr[0] * side * r, rj = rr[1] * side * r;
        const laneW = sctx.laneW;
        const a0 = push(x0 + fi, curY, z0 + fj);
        for (let v = 1; v <= laneW; v++) push(x0 + fi + ri * v, curY, z0 + fj + rj * v);
        const a1 = P.length - 1;
        seg('walk', from, a0);
        segs.push({ kind: 'landing', from: a0, to: a1 });
        const ex = push(x0 + ri * laneW, curY, z0 + rj * laneW);
        seg('walk', a1, ex);
        // the landing's cells: rows 1..Ld ahead of the entry, both lanes across
        const L = [];
        const lo2 = side > 0 ? sctx.latLo : sctx.latLo - laneW, hi2 = side > 0 ? sctx.latHi + laneW : sctx.latHi;
        for (let t = 1; t <= sctx.Ld; t++) for (let v = lo2; v <= hi2; v++) L.push([x0 + fi * t + rr[0] * v * r, z0 + fj * t + rr[1] * v * r]);
        landings.push({ cells: L, y: curY, at: [x0, curY, z0] });
      } else if (kind === 4) {
        // an earlier edge's built cells, walked: built by that edge
        const to = lineTo(wx(curK), wz(curK), wx(k), wz(k), curY, y);
        const l = segs[segs.length - 1];
        if (l && l.kind === 'walk' && l.shared && l.to === from) l.to = to; else segs.push({ kind: 'walk', from, to, shared: true });
      } else if (kind >= 5) {
        // (7a K1) a special move: its row's cells, one segment of its kind with the row's data
        const row = SPECIAL_MOVES.find((m) => m.code === kind);
        const x = special.find((q) => q.m === row);
        const x0 = wx(curK), z0 = wz(curK), x1 = wx(k), z1 = wz(k);
        const nst = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0)) / r;
        const out = row.cells(x.st, { x0, z0, y0: curY, x1, z1, y1: y, h, arg: a, n: nst, dx: DIRS[h][0] * r, dz: DIRS[h][1] * r });
        let idx = from;
        for (const q of out.cells) idx = push(q[0], q[1], q[2]);
        segs.push({ kind: row.segment, from, to: idx, ...(out.data ?? {}) });
      } else if (kind === 3) {
        const up = a === 1;
        const nx = wx(k), nz = wz(k);
        const to = push(nx, y, nz);
        segs.push({ kind: 'ladder', from, to });
        // the ladder's column: the lower cell, against the higher cell's face
        const lowX = up ? wx(curK) : nx, lowZ = up ? wz(curK) : nz, y0 = (up ? curY : y) + 1, y1 = up ? y : curY;
        const fdx = up ? nx - wx(curK) : wx(curK) - nx, fdz = up ? nz - wz(curK) : wz(curK) - nz; // toward the wall
        const facing = fdx > 0 ? 'west' : fdx < 0 ? 'east' : fdz > 0 ? 'north' : 'south';
        ladderCols.push({ x: lowX, z: lowZ, y0, y1, facing });
      }
      curK = k; curY = y;
    }
    return { P, segs, landings, ladderCols };
    };
    const ij = (k) => [k % W, Math.floor(k / W)];
    const [si, sj] = ij(ends[0].k), [ti, tj] = ij(ends[1].k);
    // a route that crosses or overlaps itself is searched again with the crossing cells blocked (at most 8 times)
    const selfBlock = new Uint8Array(n);
    let res = null, built = null;
    // (6c T3) an edge with a row that spans water (the bridge) finds its coarse corridor over the claim without the water obstacle
    const wetCorridor = sp.some((x) => x.m.crossesWater);
    for (let attempt = 0; attempt <= 8; attempt++) {
      const b = build(true);
      if (attempt) { const sb = dilate(selfBlock, W, D, Rt); for (let k = 0; k < n; k++) b.blockedW[k] |= sb[k]; }
      res = null;
      let cmask = b.free ?? b.blockedW;
      if (wetCorridor) {
        const bw = build(false);
        cmask = bw.free ?? bw.blockedW;
        if (attempt) { const sb = dilate(selfBlock, W, D, Rt); cmask = Uint8Array.from(cmask); for (let k = 0; k < n; k++) cmask[k] |= sb[k]; }
      }
      // coarse to fine: the corridor (16), then a wider one (48), then the whole claim when it is small enough
      for (const [radius, name] of withinM ? [[-1, 'within']] : [[CORRIDOR, 'corridor'], [3 * CORRIDOR, 'corridor48'], [0, 'claim']]) {
        const corridor = radius < 0 ? withinM : radius ? corridorOf(env, cmask, si, sj, ti, tj, maxGrade, radius) : null;
        if (radius && !corridor) continue;
        edgeOut.search = name;
        res = search(env, { ...sctx, ...b, corridor, maxExpand: cap - spent });
        edgeOut.expanded += res?.expanded ?? 0;
        spent += res?.expanded ?? 0;
        if (res?.budget) { broke = true; break; }
        if (res?.moves) break;
      }
      if (!res?.moves || broke) break;
      const tp = toPath(res);
      const clash = selfClash(tp.P, w);
      edgeOut.retries = attempt;
      if (!clash.length) { built = tp; break; }
      for (const q of clash) { const kk = cellAt(tp.P[q][0], tp.P[q][2]); if (kk >= 0) selfBlock[kk] = 1; }
      res = null;
    }
    if (!built && broke) { edgeOut.failed = 'BUDGET'; edgeOut.note = `the node budget (${cap} expansions over all edges) ran out on this edge`; continue; }
    // (7a K1b) a special row may name why the edge found no route (the rope move on a rope_bridge edge)
    if (!built && sp.some((x) => x.m.fail)) {
      const bl = build(true).blockedW;
      if (sp.some((x) => x.m.fail && x.m.fail(x.st, edgeOut, (k) => k >= 0 && !bl[k]))) continue;
    }
    if (!built) {
      // why: would it route through water (T3's bridges)?
      const bw = build(false);
      const cw = corridorOf(env, bw.free ?? bw.blockedW, si, sj, ti, tj, maxGrade, 3 * CORRIDOR);
      const rw = search(env, { ...sctx, ...bw, corridor: cw, maxExpand: cap === Infinity ? Infinity : Math.max(0, cap - spent) });
      spent += rw?.expanded ?? 0;
      edgeOut.failed = rw?.moves ? 'ROUTE_WATER' : 'NO_ROUTE';
      edgeOut.note = rw?.moves ? 'every route crosses water (bridges come with T3)' : edgeOut.retries ? 'no route that does not cross itself within the grade, the limits and the obstacles' : 'no route within the grade, the cut and fill limits and the obstacles';
      continue;
    }
    const { P, segs } = built;
    edgeOut.landings = built.landings;
    edgeOut.ladderCols = built.ladderCols;
    edgeOut.ok = true;
    edgeOut.path = P;
    edgeOut.segments = segs;
    edgeOut.cost = res.cost;
    edgeOut.length = P.length;
    edgeOut.rise = Math.abs(P[P.length - 1][1] - P[0][1]);
    // later edges: this edge's footprint is built (its surface or tread y, each column once, as the program writes it) and costs a
    // third; its ladders are obstacles
    for (const o of edgeColumns({ path: P, segments: segs, landings: edgeOut.landings, width: w }).cols) {
      if (segs[o.seg].shared) continue;
      const kk = cellAt(o.x, o.z);
      if (kk >= 0) { preferM[kk] = 1; builtY[kk] = o.y; }
    }
    for (const lc of edgeOut.ladderCols) { const kk = cellAt(lc.x, lc.z); if (kk >= 0) earlier[kk] = 1; }
    // (7a K1) the special rows commit what the edge's moves did (the gate move opens its gates for the later edges)
    if (sp.length) {
      const ms = [];
      let ck = ends[0].k, cy = ends[0].y;
      for (const [kind, k, h, a, y] of res.moves) {
        if (kind >= 5) ms.push({ code: kind, i0: ck % W, j0: Math.floor(ck / W), dx: DIRS[h][0], dz: DIRS[h][1], n: Math.max(Math.abs((k % W) - (ck % W)), Math.abs(Math.floor(k / W) - Math.floor(ck / W))), y0: cy, y1: y, arg: a });
        ck = k; cy = y;
      }
      for (const x of sp) x.m.commit(x.st, env, edgeOut, ms, { lo: sctx.latLo, hi: sctx.latHi });
    }
  }
  out.routed = out.edges.filter((x) => x.ok).length;
  out.failed = out.edges.filter((x) => !x.ok).map((x) => ({ id: x.id, failed: x.failed, note: x.note }));
  return { fields: {}, ops: [], data: out };
}

/**
 * A run's footprint: every column within the width's square of a centre cell, each with the y of its nearest centre cell
 * (Manhattan distance, then the lower path index): `[[x, z, y, edge, idx]]` in a fixed order (`edge`: the column has a 4-neighbour
 * outside the footprint; `idx`: the centre cell's index). `cells`: [[x, y, z]] centre cells.
 */
export function footprintOf(cells, width) {
  const lo = -Math.floor((width - 1) / 2), hi = Math.floor(width / 2);
  const m = new Map();
  cells.forEach(([x, y, z], idx) => {
    for (let dz = lo; dz <= hi; dz++) for (let dx = lo; dx <= hi; dx++) {
      const key = `${x + dx},${z + dz}`, d = Math.abs(dx) + Math.abs(dz);
      const o = m.get(key);
      if (!o || d < o.d || (d === o.d && idx < o.idx)) m.set(key, { x: x + dx, z: z + dz, y, d, idx });
    }
  });
  const out = [...m.values()];
  out.sort((a, b) => a.idx - b.idx || a.d - b.d || a.x - b.x || a.z - b.z);
  return out.map((o) => [o.x, o.z, o.y, [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !m.has(`${o.x + dx},${o.z + dz}`)) ? 1 : 0, o.idx]);
}

/** The primitives' 4-connected line (lib/region/geom.mjs line4): x first on a tie. */
function line4(x0, z0, x1, z1) {
  const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0), sx = x1 > x0 ? 1 : -1, sz = z1 > z0 ? 1 : -1;
  const out = [[x0, z0]];
  let x = x0, z = z0, ix = 0, iz = 0;
  while (ix < dx || iz < dz) {
    const tx = (1 + 2 * ix) * dz, tz = (1 + 2 * iz) * dx;
    if (iz >= dz || (ix < dx && tx <= tz)) { x += sx; ix++; } else { z += sz; iz++; }
    out.push([x, z]);
  }
  return out;
}

/**
 * The fewest polyline vertices whose 4-connected lines give exactly these centre cells (greedy: the longest prefix a straight
 * line reproduces), for a road the mod lays from points (4e). `cells`: [[x, y, z]]; returns indices into it.
 */
export function polylineOf(cells) {
  const out = [0];
  let a = 0;
  while (a < cells.length - 1) {
    let best = a + 1;
    for (let b = a + 2; b < cells.length; b++) {
      const l = line4(cells[a][0], cells[a][2], cells[b][0], cells[b][2]);
      if (l.length !== b - a + 1 || !l.every(([x, z], t) => x === cells[a + t][0] && z === cells[a + t][2])) break;
      best = b;
    }
    out.push(best);
    a = best;
  }
  return out;
}

/**
 * Lamp spots beside a routed edge (for lightCover's `extra`): every `every` centre cells of its walk runs and landings, one cell past
 * the footprint and its retaining column on each side. Returns `{spots: [{lot: 'route:<id>', x, z}], cap}` (cap: one lamp per 10
 * cells of path, at least 2).
 */
export function lampSpots(edge, { every = 4 } = {}) {
  const spots = [];
  if (!edge?.ok) return { spots, cap: 0 };
  const hi = Math.floor(edge.width / 2) + 2, lo = -Math.floor((edge.width - 1) / 2) - 2;
  const key = `route:${edge.id}`;
  for (const g of edge.segments) {
    if (g.kind !== 'walk' && g.kind !== 'landing') continue;
    for (let i = g.from; i <= g.to; i += every) {
      const [x, , z] = edge.path[i], nb = edge.path[Math.min(g.to, i + 1)] ?? edge.path[i], pv = edge.path[Math.max(g.from, i - 1)];
      const ax = Math.abs(nb[0] - pv[0]) >= Math.abs(nb[2] - pv[2]) ? [0, 1] : [1, 0];
      for (const v of [hi, lo]) spots.push({ lot: key, x: x + ax[0] * v, z: z + ax[1] * v });
    }
  }
  return { spots, cap: Math.max(2, Math.floor((edge.length + 9) / 10)) };
}

/**
 * A routed edge's columns, each written once: the whole path's footprint (each column the y of its nearest centre cell), a column
 * belonging to the segment that owns that centre cell (a segment owns its cells after its first: a flight owns its treads, the walk
 * before it the cell it starts from), the landings' cells to their landing at its y. Returns `{cols: [{x, z, y, seg, edge}], bySeg:
 * [[...cols]]}` (`edge`: a 4-neighbour outside the edge's footprint).
 */
export function edgeColumns(edge) {
  const { path, segments, landings, width } = edge;
  const owner = new Int32Array(path.length).fill(0);
  segments.forEach((g, si) => { for (let i = g.from + (si ? 1 : 0); i <= g.to; i++) owner[i] = si; });
  const m = new Map();
  for (const [x, z, y, , idx] of footprintOf(path, width)) m.set(`${x},${z}`, { x, z, y, seg: owner[idx] });
  segments.forEach((g, si) => {
    if (g.kind !== 'landing') return;
    const l = landings.find((q) => q.cells.some(([cx, cz]) => cx === path[g.from][0] && cz === path[g.from][2]));
    if (l) for (const [x, z] of l.cells) m.set(`${x},${z}`, { x, z, y: l.y, seg: si });
  });
  const cols = [...m.values()];
  for (const o of cols) o.edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !m.has(`${o.x + dx},${o.z + dz}`)) ? 1 : 0;
  const bySeg = segments.map(() => []);
  for (const o of cols) bySeg[o.seg].push(o);
  return { cols, bySeg };
}
