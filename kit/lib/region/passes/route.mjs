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
  const { G, corridor, blockedW, blocked1, builtY, prefer, start, goal, Gq, w, laneW, Ld, latLo, latHi, maxCut, maxFill, stairs, ladders, nearEnd, maxStates = 24_000_000, maxExpand = Infinity } = ctx;
  const ND = maxCut + maxFill + 1, SPC = 32 * ND;
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
  const st = (k, h, kk, d) => ((cid[k] * 8 + h) * 4 + kk) * ND + d;
  const cellOf = (s) => cells[Math.floor(s / SPC)];
  const hOfS = (s) => Math.floor(s / (4 * ND)) & 7, kOfS = (s) => Math.floor(s / ND) & 3;
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
  const relax = (s0, k, h, kk, q, cost, kind, a, built = false) => {
    // (a cell an earlier edge built keeps its y whatever this edge's land says: its offset only keys the state)
    let d = dOf(yOf(q), k);
    if (d < 0 && built) d = Math.max(0, Math.min(ND - 1, yOf(q) - G[k] + maxCut));
    if (d < 0) return;
    const s = st(k, h, kk, d);
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
    if (k === goal.k && y === goal.y) { found = s; break; }
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
        relax(s, nk, h2, dh ? 0 : Math.min(kk + 1, TURN_COOLDOWN), y2 * FP, Math.floor((diag ? COST.diag : COST.step) / 3) + (dh ? COST.turn : 0), 4, 0, true);
        continue;
      }
      let nq = 0;
      const toward = Math.max(q - Gq, Math.min(q + Gq, G[nk] * FP));
      qs[nq++] = toward;
      for (const c of [q - Gq, q, q + Gq]) if (c !== toward) qs[nq++] = c;
      let len = diag ? COST.diag : COST.step;
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
        relax(s, nk, h2, dh ? 0 : Math.min(kk + 1, TURN_COOLDOWN), q2, len + (dh ? COST.turn : 0) + COST.grade * Math.abs(y2 - y) + COST.cutFill * cf * w, 0, 0);
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
            const fc = COST.flight + COST.stair * n + COST.step * 2 + COST.cutFill * (cf + cf2) * w;
            relax(s, last, hf, 2, yn * FP, (pref ? Math.floor(fc / 3) : fc) + (hf !== h ? COST.turn : 0), 1, n * 2 + (sg > 0 ? 1 : 0));
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
          let ok = true, cf = 0, cnt = 0;
          for (let t = 1; t <= Ld && ok; t++) {
            for (let v = lo; v <= hi; v++) {
              const ci = i + di * t + ri * v, cj = j + dj * t + rj * v;
              if (ci < 0 || cj < 0 || ci >= W || cj >= D) { ok = false; break; }
              const ck = ci + cj * W;
              if (!open1(ck) || dOf(y, ck) < 0) { ok = false; break; }
              cf += Math.abs(y - G[ck]); cnt++;
            }
          }
          if (!ok) continue;
          const ei = i + ri * side * laneW, ej = j + rj * side * laneW;
          if (ei < 0 || ej < 0 || ei >= W || ej >= D) continue;
          const ek = ei + ej * W;
          if (!inS(ek) || builtY[ek] !== NONE) continue;
          relax(s, ek, (h + 4) & 7, 0, y * FP, COST.hairpin + COST.landing * cnt + COST.step * (laneW + 2) + COST.cutFill * cf, 2, side > 0 ? 1 : 0);
        }
      }
      // ladders (player-only edges): up a cliff face ahead, or down one; the walk meets the land at both feet
      if (ladders && y === G[k]) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < W && nj < D) {
          const nk = ni + nj * W, rise = G[nk] - y;
          if (inS(nk) && builtY[nk] === NONE && !nearEnd[k] && !nearEnd[nk] && Math.abs(rise) >= 2 && Math.abs(rise) <= LADDER_MAX) relax(s, nk, h, 2, G[nk] * FP, COST.ladder + COST.ladderPer * Math.abs(rise), 3, rise > 0 ? 1 : 0);
        }
      }
    }
  }
  if (found < 0) return { moves: null, expanded };
  const moves = [];
  for (let s = found; s >= 0 && mv[s] !== 255; s = par[s]) moves.push([mv[s], cellOf(s), hOfS(s), arg[s], yOf(qArr[s]), qArr[s]]);
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
 * depth, values} | null, _unsafe: {noKeepOut, noGrade, villagerLadders, noTreeReach}}`. Returns `{fields: {}, ops: [], data: {edges: [...]}}`:
 * each edge `{id, ok, failed?, movers, ladders, width, path: [[x, y, z]] (4-connected centre cells, y the surface), segments:
 * [{kind: walk|stair|landing|ladder, from, to}] (path indices, inclusive), landings: [{cells: [[x, z]], y}], ladderCols: [{x, z,
 * y0, y1, facing}], cost, length, rise, expanded, search: 'corridor'|'claim'}`. The program turns them into primitives.
 */
export function routePass(survey, volumes, intent) {
  const c = survey;
  const it = intent ?? {};
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
  const env = { W, D, r, minX: c.minX, minZ: c.minZ, flags: c.flags, G: G0 };
  const cellAt = (x, z) => {
    const i = Math.floor((x - c.minX) / r), j = Math.floor((z - c.minZ) / r);
    return i < 0 || j < 0 || i >= W || j >= D ? -1 : i + j * W;
  };
  const masks = baseMasks(env, it, { keepOut: !_unsafe.noKeepOut });
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
    const i0 = k % W, j0 = Math.floor(k / W), R = Math.floor((NEAR_END + r - 1) / r);
    for (let j = Math.max(0, j0 - R); j <= Math.min(D - 1, j0 + R); j++) for (let i = Math.max(0, i0 - R); i <= Math.min(W - 1, i0 + R); i++) nearEnd[i + j * W] = 1;
  }
  const coarse = r > 1;
  const Gq = _unsafe.noGrade ? FP * 16 : Math.max(1, Math.floor(maxGrade * FP * r + 1e-9));
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
    const build = (water) => {
      const mk = water ? masks : baseMasks(env, it, { water: false, keepOut: !_unsafe.noKeepOut });
      const hardW = dilate(mk.hard, W, D, Rt), guardW = dilate(mk.guard, W, D, Rw), treeW = dilate(mk.tree, W, D, Rt), earlyW = dilate(earlier, W, D, Rt);
      const blockedW = new Uint8Array(n), blocked1 = dilate(mk.guard, W, D, R1);
      for (let k = 0; k < n; k++) { blockedW[k] = hardW[k] | guardW[k] | treeW[k] | earlyW[k]; blocked1[k] |= mk.hard[k] | mk.tree[k] | earlier[k]; }
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
          if (c.flags[k] & (FLAG_WATER | FLAG_LAVA)) continue;
          blockedW[k] = 0;
        }
      }
      return { blockedW, blocked1 };
    };
    // the edge's own earlier route (6d replanning: `prefer` on the edge) costs a third too, for this edge only
    let preferE = preferM;
    if (Array.isArray(e.prefer) && e.prefer.length) {
      preferE = Uint8Array.from(preferM);
      for (const p of e.prefer) { const k = cellAt(p[0], p[1]); if (k >= 0) preferE[k] = 1; }
    }
    const sctx = { G, builtY, prefer: preferE, start: ends[0], goal: ends[1], Gq, w, laneW: Math.floor((w + r - 1) / r), Ld: Math.floor((Math.max(hairpinLanding, w) + r - 1) / r),
      latLo: Math.floor(lo / r), latHi: Math.floor((hi + r - 1) / r), maxCut, maxFill, stairs: stairs && !coarse, ladders, nearEnd };
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
    for (let attempt = 0; attempt <= 8; attempt++) {
      const b = build(true);
      if (attempt) { const sb = dilate(selfBlock, W, D, Rt); for (let k = 0; k < n; k++) b.blockedW[k] |= sb[k]; }
      res = null;
      // coarse to fine: the corridor (16), then a wider one (48), then the whole claim when it is small enough
      for (const [radius, name] of [[CORRIDOR, 'corridor'], [3 * CORRIDOR, 'corridor48'], [0, 'claim']]) {
        const corridor = radius ? corridorOf(env, b.blockedW, si, sj, ti, tj, maxGrade, radius) : null;
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
    if (!built) {
      // why: would it route through water (T3's bridges)?
      const bw = build(false);
      const cw = corridorOf(env, bw.blockedW, si, sj, ti, tj, maxGrade, 3 * CORRIDOR);
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
