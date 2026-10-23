// (7a K1a) Wall lines (docs/CONTRACT.md "Phase 7a slice K1" §3): the obstacle grid a wall keeps off, the ring a wall.around or
// wall.edge takes (each side its smallest clear offset, corners joined), and wall.line's legs (an A* over 4-connected cells with a
// wall profile: no grade limit, no stairs, width = thickness, cost 1 a cell, 4 a turn, 40 a walk-network crossing). Integer cells,
// ties by (x, z); pure and deterministic.
// (6c H-b, §8.2) The wet grid (obstacleGrid's `wet` {waterDepth, vols, plan}: the wet fallback only): natural water columns at most
// waterDepth deep, sources to the bed (wetColumn), are clear and marked `wet` (G.wet, G.wetAt(k) -> {bed, surface, depth}); deeper,
// flowing or lava columns stay WATER (G.wetWhy names why); the plan's own water (`plan`: [[x, z]]) stays WATER. A ring's side takes its
// first dry clear offset, else its first clear one; a line's step costs 3 on a wet cell (dry 1).

import { wetColumn } from '../fluids/wet.mjs';

/** Obstacle classes, in the order a refusal names them. */
// ((6c KC, §4) BODY: a plan body's footprint (fluids/keep.mjs: a reservation at resolve, a body's hard set at emit). Never WATER, so it
// never sends a wall to the harbour fallback (wetWallFallback); a cell that is both natural water and a footprint is BODY)
export const OB = Object.freeze({ CLEAR: 0, OUT_OF_CLAIM: 1, PROTECTED: 2, WATER: 3, KEEP_OUT: 4, OVERLAP: 5, BODY: 6 });
export const OB_NAME = Object.freeze(['CLEAR', 'OUT_OF_CLAIM', 'PROTECTED', 'WATER', 'KEEP_OUT', 'OVERLAP', 'BODY']);
/** A refusal's reason code per obstacle class (a tree near keep-out is the keep-out's; a body's footprint: OVERLAP {kind: body}). */
export const OB_CODE = Object.freeze({ 1: 'OUT_OF_CLAIM', 2: 'PROTECTED', 3: 'WATER', 4: 'PROTECTED', 5: 'NO_ROOM', 6: 'OVERLAP' });
/** The claim margin nothing is written in (compile.mjs MARGIN). */
export const MARGIN = 2;
/** How far a tree's logs may reach (T2's TREE_REACH): a tree within it of keep-out is an obstacle (6a's felling rule bounded, C31). */
export const TREE_REACH = 6;
/** wall.line's A* costs. */
export const LINE_COST = Object.freeze({ step: 1, turn: 4, crossing: 40 });
/** The 4 headings (x east, z south): E, S, W, N; right of heading h is h + 1. */
export const H4 = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);

const FLAG_WATER = 1, FLAG_TREE = 4, FLAG_LAVA = 8;
/** (H-b) A wet wall cell's step cost (§8.2: 3 a cell, dry 1). */
export const WET_STEP = 3;

/**
 * The grid of a claim: `{x0, z0, W, D, ob: Uint8Array (OB class per cell), walk: Uint8Array (1: a walk cell of an existing network),
 * walkY: Int16Array, at(x, z) -> index | -1}`. `rects`: `{[class]: [{minX, minZ, maxX, maxZ}]}`; `cols`: the survey columns;
 * `walkCells`: [[x, z, y]] the existing networks' walk cells; `keepOut`: rects whose trees within TREE_REACH are obstacles.
 */
export function obstacleGrid({ claim, cols, rects = {}, walkCells = [], keepOut = [], kept = [], wet = null, bodies = [] }) {
  const x0 = claim.minX, z0 = claim.minZ, W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1, n = W * D;
  const ob = new Uint8Array(n), walk = new Uint8Array(n), walkY = new Int16Array(n).fill(-32768);
  const at = (x, z) => (x < x0 || z < z0 || x >= x0 + W || z >= z0 + D ? -1 : (x - x0) + (z - z0) * W);
  const set = (k, c) => { if (k >= 0 && (ob[k] === 0 || c < ob[k])) ob[k] = c; };
  const r = cols.resolution, sx = (x) => Math.floor((x - cols.minX + Math.floor(r / 2)) / r), sz = (z) => Math.floor((z - cols.minZ + Math.floor(r / 2)) / r);
  const colAt = (x, z) => Math.max(0, Math.min(cols.width - 1, sx(x))) + Math.max(0, Math.min(cols.depth - 1, sz(z))) * cols.width;
  const flagAt = (x, z) => cols.flags[colAt(x, z)];
  // ((H-b) the wet grid: natural water a wet section may stand in)
  const wetM = wet ? new Uint8Array(n) : null, wetInfo = wet ? new Map() : null, wetWhy = wet ? new Map() : null;
  const planWater = wet ? new Set((wet.plan ?? []).map(([x, z]) => `${x},${z}`)) : null;
  for (let z = z0; z < z0 + D; z++) for (let x = x0; x < x0 + W; x++) {
    const k = at(x, z);
    if (x < x0 + MARGIN || z < z0 + MARGIN || x > x0 + W - 1 - MARGIN || z > z0 + D - 1 - MARGIN) set(k, OB.OUT_OF_CLAIM);
    const f = flagAt(x, z);
    if (wet && (f & FLAG_WATER) && !(f & FLAG_LAVA) && !planWater.has(`${x},${z}`)) {
      const c = colAt(x, z), w = wetColumn(wet.vols ?? [], x, z, cols.ground[c], cols.floor[c], { waterDepth: wet.waterDepth });
      if (w.ok) { wetM[k] = 1; wetInfo.set(k, { bed: w.bed, surface: cols.ground[c], depth: w.depth }); continue; }
      wetWhy.set(k, w.why);
      set(k, OB.WATER);
      continue;
    }
    if (wet && (f & FLAG_LAVA)) wetWhy.set(k, 'lava');
    if (f & (FLAG_WATER | FLAG_LAVA)) set(k, OB.WATER);
  }
  if (wet) for (const key of planWater) { const [x, z] = key.split(',').map(Number); set(at(x, z), OB.WATER); }
  for (const [c, list] of Object.entries(rects)) for (const q of list) {
    for (let z = Math.max(z0, q.minZ); z <= Math.min(z0 + D - 1, q.maxZ); z++) for (let x = Math.max(x0, q.minX); x <= Math.min(x0 + W - 1, q.maxX); x++) set(at(x, z), Number(c));
  }
  for (const [x, z] of kept) set(at(x, z), OB.OVERLAP);
  // a tree within TREE_REACH of keep-out: the realise would fell it whole, reaching into the keep-out
  for (const q of keepOut) {
    for (let z = Math.max(z0, q.minZ - TREE_REACH); z <= Math.min(z0 + D - 1, q.maxZ + TREE_REACH); z++) for (let x = Math.max(x0, q.minX - TREE_REACH); x <= Math.min(x0 + W - 1, q.maxX + TREE_REACH); x++) {
      if (flagAt(x, z) & FLAG_TREE) set(at(x, z), OB.KEEP_OUT);
    }
  }
  for (const [x, z, y] of walkCells) { const k = at(x, z); if (k >= 0) { walk[k] = 1; if (y > walkY[k]) walkY[k] = y; } }
  // ((6c KC) the plan's bodies' footprints ([[x, z, body]]): BODY over clear and water cells (the other classes keep theirs); bodyAt(k) the
  // body or part keeping it)
  const bodyOf = bodies.length ? new Map() : null;
  for (const [x, z, id] of bodies) { const k = at(x, z); if (k < 0) continue; if (ob[k] === 0 || ob[k] === OB.WATER) ob[k] = OB.BODY; if (!bodyOf.has(k)) bodyOf.set(k, id); }
  return { x0, z0, W, D, ob, walk, walkY, at, bodyAt: (k) => bodyOf?.get(k) ?? null, ...(wet ? { wet: wetM, wetAt: (k) => (wetM[k] && !ob[k] ? wetInfo.get(k) : null), wetWhy } : {}) };
}

// ------------------------------------------------------------------ rings (wall.around, wall.edge)

const SIDES = ['n', 'e', 's', 'w'];

/** The inner line rect for per-side offsets `o` (an offset grows the rect outward; a negative one shrinks it). */
export const innerRect = (R, o) => ({ minX: R.minX - o.w, minZ: R.minZ - o.n, maxX: R.maxX + o.e, maxZ: R.maxZ + o.s });

/** A side's band cells (its rows of the wall, the corner squares included) for inner rect I and thickness t: [[x, z]]. */
function bandOf(I, side, t) {
  const out = [];
  const xa = I.minX - (t - 1), xb = I.maxX + (t - 1), za = I.minZ - (t - 1), zb = I.maxZ + (t - 1);
  if (side === 'n') for (let z = za; z <= I.minZ; z++) for (let x = xa; x <= xb; x++) out.push([x, z]);
  if (side === 's') for (let z = I.maxZ; z <= zb; z++) for (let x = xa; x <= xb; x++) out.push([x, z]);
  if (side === 'w') for (let x = xa; x <= I.minX; x++) for (let z = za; z <= zb; z++) out.push([x, z]);
  if (side === 'e') for (let x = I.maxX; x <= xb; x++) for (let z = za; z <= zb; z++) out.push([x, z]);
  return out;
}

/**
 * Whether a side's band is clear: no obstacle cell; walk cells of an existing network only as clean crossings (a run across the
 * band's whole depth, perpendicular, at least 1 cell from the side's corners). Returns {ok, blockers: {class: count}, crossings}.
 */
function sideClear(G, I, side, t) {
  const blockers = {};
  let ok = true;
  const horiz = side === 'n' || side === 's';
  // the side's rows (depth) and its straight positions (along)
  const depthRange = side === 'n' ? [I.minZ - (t - 1), I.minZ] : side === 's' ? [I.maxZ, I.maxZ + (t - 1)] : side === 'w' ? [I.minX - (t - 1), I.minX] : [I.maxX, I.maxX + (t - 1)];
  const alongLo = horiz ? I.minX - (t - 1) : I.minZ - (t - 1), alongHi = horiz ? I.maxX + (t - 1) : I.maxZ + (t - 1);
  const straightLo = horiz ? I.minX + 1 : I.minZ + 1, straightHi = horiz ? I.maxX - 1 : I.maxZ - 1;
  const cell = (u, d) => (horiz ? G.at(u, d) : G.at(d, u));
  const crossings = [];
  let run = null, wet = 0;
  for (let u = alongLo; u <= alongHi; u++) {
    let walks = 0;
    for (let d = depthRange[0]; d <= depthRange[1]; d++) {
      const k = cell(u, d);
      if (k < 0) { blockers[OB.OUT_OF_CLAIM] = (blockers[OB.OUT_OF_CLAIM] ?? 0) + 1; ok = false; continue; }
      if (G.ob[k]) { blockers[G.ob[k]] = (blockers[G.ob[k]] ?? 0) + 1; ok = false; }
      else if (G.wet?.[k]) wet++;
      if (G.walk[k]) walks++;
    }
    if (walks && (walks !== t || u < straightLo || u > straightHi)) { blockers[OB.OVERLAP] = (blockers[OB.OVERLAP] ?? 0) + 1; ok = false; }
    if (walks === t) { if (!run) run = { from: u, to: u }; else run.to = u; } else if (run) { crossings.push(run); run = null; }
  }
  if (run) crossings.push(run);
  // a crossing needs a jamb on each side inside the straight run
  for (const c of crossings) if (c.from - 1 < straightLo || c.to + 1 > straightHi) { blockers[OB.OVERLAP] = (blockers[OB.OVERLAP] ?? 0) + 1; ok = false; }
  return { ok, blockers, crossings: crossings.map((c) => ({ side, ...c })), ...(G.wet ? { wet } : {}) };
}

/**
 * Place a ring round rect R: each side takes the first offset of `order` (its preference list, e.g. [4..12] for around) at which
 * its band is clear, the corners joining the sides (sides re-checked until stable). Returns `{ok: true, I, o: {n, e, s, w},
 * crossings}` or `{ok: false, side, code, blockers: {class name: count}, tried}`.
 */
export function placeRing(G, R, order, t) {
  const idx = { n: 0, e: 0, s: 0, w: 0 };
  const o = () => ({ n: order[idx.n], e: order[idx.e], s: order[idx.s], w: order[idx.w] });
  const seen = {};
  for (let round = 0; round < 4 * order.length + 4; round++) {
    let changed = false;
    for (const side of SIDES) {
      let i = idx[side];
      // ((H-b) the wet grid: a side keeps its first dry clear offset; only a side with none takes a wet one)
      if (G.wet) {
        let j = i;
        for (; j < order.length; j++) {
          const I = innerRect(R, { ...o(), [side]: order[j] });
          if (I.maxX - I.minX < 2 || I.maxZ - I.minZ < 2) continue;
          const c = sideClear(G, I, side, t);
          if (c.ok && !c.wet) break;
        }
        if (j < order.length) { if (j !== idx[side]) { idx[side] = j; changed = true; } continue; }
      }
      for (; i < order.length; i++) {
        const I = innerRect(R, { ...o(), [side]: order[i] });
        if (I.maxX - I.minX < 2 || I.maxZ - I.minZ < 2) continue;
        const c = sideClear(G, I, side, t);
        if (c.ok) break;
        for (const [k, v] of Object.entries(c.blockers)) { seen[side] ??= {}; seen[side][k] = (seen[side][k] ?? 0) + v; }
        // the blockers of every offset tried (a class that blocks each one names the refusal)
        (seen[`${side}#all`] ??= []).push(new Set(Object.keys(c.blockers).map(Number)));
      }
      if (i >= order.length) {
        const sets = seen[`${side}#all`] ?? [];
        const every = [1, 2, 3, 4, 5, 6].filter((k) => sets.length && sets.every((s) => s.has(k)));
        const any = Object.keys(seen[side] ?? {}).map(Number).sort((a, b) => a - b);
        const cls = every[0] ?? any[0] ?? OB.OVERLAP;
        return { ok: false, side, code: OB_CODE[cls], blockers: Object.fromEntries(Object.entries(seen[side] ?? {}).map(([k, v]) => [OB_NAME[k], v])), tried: [order[0], order[order.length - 1]] };
      }
      if (i !== idx[side]) { idx[side] = i; changed = true; }
    }
    if (!changed) break;
  }
  const off = o(), I = innerRect(R, off);
  const crossings = SIDES.flatMap((s) => sideClear(G, I, s, t).crossings);
  return { ok: true, I, o: off, crossings };
}

/**
 * A ring's wall: positions (the inner rect's perimeter, clockwise from its NW corner) and cells (the band outward, `t` deep), each
 * cell `{x, z, pos, depth, axis}` (axis 1: a run along x, 2: along z, 3: a corner). `omit`: a side left out (an open ring): its
 * straight positions and band are dropped, its corners stay as the free ends.
 */
export function ringCells(I, t, omit = null) {
  const line = [];
  for (let x = I.minX; x <= I.maxX; x++) line.push([x, I.minZ]);
  for (let z = I.minZ + 1; z <= I.maxZ; z++) line.push([I.maxX, z]);
  for (let x = I.maxX - 1; x >= I.minX; x--) line.push([x, I.maxZ]);
  for (let z = I.maxZ - 1; z > I.minZ; z--) line.push([I.minX, z]);
  const isCorner = (x, z) => (x === I.minX || x === I.maxX) && (z === I.minZ || z === I.maxZ);
  const sideOf = (x, z) => (isCorner(x, z) ? null : z === I.minZ ? 'n' : z === I.maxZ ? 's' : x === I.minX ? 'w' : 'e');
  const posOf = new Map(line.map(([x, z], i) => [`${x},${z}`, i]));
  const positions = line.map(([x, z]) => ({ x, z, axis: isCorner(x, z) ? 3 : (z === I.minZ || z === I.maxZ) ? 1 : 2, side: sideOf(x, z) }));
  const cells = [];
  for (let z = I.minZ - (t - 1); z <= I.maxZ + (t - 1); z++) for (let x = I.minX - (t - 1); x <= I.maxX + (t - 1); x++) {
    if (x > I.minX && x < I.maxX && z > I.minZ && z < I.maxZ) continue;
    const px = Math.max(I.minX, Math.min(I.maxX, x)), pz = Math.max(I.minZ, Math.min(I.maxZ, z));
    const pos = posOf.get(`${px},${pz}`);
    if (omit && positions[pos].side === omit) continue;
    const depth = Math.max(I.minX - x, x - I.maxX, I.minZ - z, z - I.maxZ, 0);
    cells.push({ x, z, pos, depth, axis: positions[pos].axis });
  }
  let ends = [];
  if (omit) {
    // the free ends: the corners at the omitted side's two ends
    const c = { n: [[I.minX, I.minZ], [I.maxX, I.minZ]], s: [[I.maxX, I.maxZ], [I.minX, I.maxZ]], w: [[I.minX, I.maxZ], [I.minX, I.minZ]], e: [[I.maxX, I.minZ], [I.maxX, I.maxZ]] }[omit];
    ends = c.map(([x, z]) => posOf.get(`${x},${z}`));
  }
  return { positions, cells, ends, closed: !omit };
}

// ------------------------------------------------------------------ lines (wall.line)

class Heap {
  constructor() { this.a = []; }
  push(f, g, s, tie) { this.a.push([f, g, tie, s]); let i = this.a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; [this.a[i], this.a[p]] = [this.a[p], this.a[i]]; i = p; } }
  less(i, j) { const x = this.a[i], y = this.a[j]; return x[0] !== y[0] ? x[0] < y[0] : x[1] !== y[1] ? x[1] < y[1] : x[2] < y[2]; }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < this.a.length && this.less(l, m)) m = l; if (r < this.a.length && this.less(r, m)) m = r; if (m === i) break; [this.a[i], this.a[m]] = [this.a[m], this.a[i]]; i = m; }
    }
    return top;
  }
  get n() { return this.a.length; }
}

/**
 * One leg of a wall.line: A* from cell `a` to cell `b` ([x, z]) over the grid, 4-connected, the wall `t` thick to the right of
 * travel. A step costs 1, a turn 4; a walk-network crossing is a straight run over the network's cells (all `t` lanes walk cells,
 * a clear cell before and after: the jambs) costing its length plus 40. `free(k)`: extra cells the leg may use (a joined lot's
 * apron). `startH`/`goalH` (0..3 or null) force the first/last heading; `goals` ([[x, z]]) ends the leg at any of them. Returns `{cells: [[x, z, h]], crossings: [{from, to}]
 * (cell indices), cost}` or null.
 */
export function lineLeg(G, a, b, t, { free = null, startH = null, goalH = null, goals = null, maxExpand = 4_000_000 } = {}) {
  const { W, D } = G;
  const ka = G.at(a[0], a[1]), kb = G.at(b[0], b[1]);
  if (ka < 0 || kb < 0) return null;
  const goalSet = goals ? new Set(goals.map(([x, z]) => G.at(x, z)).filter((k) => k >= 0)) : null;
  const okCell = (k) => k >= 0 && (G.ob[k] === 0 || (free && free(k))) && !G.walk[k];
  const xy = (k) => [k % W, Math.floor(k / W)];
  const right = (h) => H4[(h + 1) & 3];
  // the lanes of a cell at heading h (the cell and t - 1 to its right)
  const lanes = (k, h) => { const [i, j] = xy(k), [ri, rj] = right(h); const out = []; for (let s = 0; s < t; s++) { const ii = i + ri * s, jj = j + rj * s; out.push(ii < 0 || jj < 0 || ii >= W || jj >= D ? -1 : ii + jj * W); } return out; };
  const clearAt = (k, h) => lanes(k, h).every(okCell);
  const g = new Map(), par = new Map(), how = new Map();
  // ties by (x, z, heading)
  const tieOf = (s) => { const k = Math.floor(s / 4); return ((k % W) * D + Math.floor(k / W)) * 4 + (s & 3); };
  const hd = (k) => { const [i, j] = xy(k), [bi, bj] = xy(kb); return Math.abs(i - bi) + Math.abs(j - bj); };
  const heap = new Heap();
  for (let h = 0; h < 4; h++) {
    if (startH !== null && h !== startH) continue;
    if (!clearAt(ka, h)) continue;
    const s = ka * 4 + h;
    g.set(s, 0); heap.push(hd(ka), 0, s, tieOf(s));
  }
  let found = -1, expanded = 0;
  while (heap.n) {
    const [, gv, , s] = heap.pop();
    if (g.get(s) !== gv) continue;
    if (++expanded > maxExpand) return null;
    const k = Math.floor(s / 4), h = s & 3;
    if ((goalSet ? goalSet.has(k) : k === kb) && (goalH === null || h === goalH)) { found = s; break; }
    const [i, j] = xy(k);
    for (const dh of [0, 1, 3]) {
      const h2 = (h + dh) & 3, [di, dj] = H4[h2];
      const turn = dh ? LINE_COST.turn : 0;
      // the turn's corner square, then the step
      if (dh) { const [r0i, r0j] = right(h), [r1i, r1j] = right(h2); let ok = true; for (let p = 0; p < t && ok; p++) for (let q = 0; q < t; q++) { const ii = i + r0i * p + r1i * q, jj = j + r0j * p + r1j * q; if (ii < 0 || jj < 0 || ii >= W || jj >= D || !okCell(ii + jj * W)) { ok = false; break; } } if (!ok) continue; }
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W || nj >= D) continue;
      const nk = ni + nj * W;
      if (clearAt(nk, h2)) {
        // ((H-b) the wet grid: a step onto a wet cell costs 3)
        const ns = nk * 4 + h2, ng = gv + (G.wet && lanes(nk, h2).some((x) => x >= 0 && G.wet[x]) ? WET_STEP : LINE_COST.step) + turn;
        if (ng < (g.get(ns) ?? Infinity)) { g.set(ns, ng); par.set(ns, s); how.set(ns, null); heap.push(ng + hd(nk), ng, ns, tieOf(ns)); }
        continue;
      }
      // a crossing: every lane a walk cell, straight on, until a clear cell (the far jamb)
      if (!lanes(nk, h2).every((x) => x >= 0 && G.walk[x] && (G.ob[x] === 0 || (free && free(x))))) continue;
      let m = 1, ek = -1;
      for (; m <= 16; m++) {
        const ci = i + di * m, cj = j + dj * m;
        if (ci < 0 || cj < 0 || ci >= W || cj >= D) break;
        const ck = ci + cj * W, ls = lanes(ck, h2);
        if (ls.every((x) => x >= 0 && G.walk[x] && (G.ob[x] === 0 || (free && free(x))))) continue;
        if (ls.every(okCell)) ek = ck;
        break;
      }
      if (ek < 0) continue;
      const ns = ek * 4 + h2, ng = gv + LINE_COST.step * m + LINE_COST.crossing + turn;
      if (ng < (g.get(ns) ?? Infinity)) { g.set(ns, ng); par.set(ns, s); how.set(ns, m); heap.push(ng + hd(ek), ng, ns, tieOf(ns)); }
    }
  }
  if (found < 0) return null;
  const rev = [];
  for (let s = found; s !== undefined; s = par.get(s)) rev.push(s);
  rev.reverse();
  const cells = [], crossings = [];
  for (let n = 0; n < rev.length; n++) {
    const s = rev[n], k = Math.floor(s / 4), h = s & 3;
    const m = how.get(s);
    if (m) {
      // the cells of the crossing run (and the far jamb, this state's cell)
      const [pi, pj] = xy(Math.floor(rev[n - 1] / 4)), [di, dj] = H4[h];
      const from = cells.length;
      for (let q = 1; q < m; q++) cells.push([G.x0 + pi + di * q, G.z0 + pj + dj * q, h]);
      crossings.push({ from, to: cells.length - 1 });
    }
    const [i, j] = xy(k);
    cells.push([G.x0 + i, G.z0 + j, h]);
  }
  return { cells, crossings, cost: g.get(found) };
}

/**
 * A line wall's cells from its centre cells ([[x, z, h]] in order): each cell and the t - 1 cells to its right (for its own heading
 * and the next cell's, so a turn's corner square fills), `{x, z, pos, depth, axis}` (axis from the headings at the cell: 1 along x,
 * 2 along z, 3 a turn). Returns {positions, cells, ends: [0, n - 1]}.
 */
export function lineCells(line, t) {
  const positions = line.map(([x, z, h], i) => {
    const hn = i + 1 < line.length ? line[i + 1][2] : h;
    const turn = hn !== h;
    return { x, z, axis: turn ? 3 : (h === 0 || h === 2) ? 1 : 2, h, hn };
  });
  const seen = new Map();
  positions.forEach((p, i) => {
    const hs = p.h === p.hn ? [p.h] : [p.h, p.hn];
    const [r0i, r0j] = H4[(hs[0] + 1) & 3], [r1i, r1j] = H4[(hs[hs.length - 1] + 1) & 3];
    for (let a = 0; a < t; a++) for (let b = 0; b < (hs.length > 1 ? t : 1); b++) {
      const x = p.x + r0i * a + (hs.length > 1 ? r1i * b : 0), z = p.z + r0j * a + (hs.length > 1 ? r1j * b : 0);
      const key = `${x},${z}`;
      if (!seen.has(key)) seen.set(key, { x, z, pos: i, depth: Math.max(a, b), axis: a || b ? (hs.length > 1 ? 3 : p.axis) : p.axis });
    }
    if (hs.length === 1) for (let a = 1; a < t; a++) { const x = p.x + r0i * a, z = p.z + r0j * a; const key = `${x},${z}`; if (!seen.has(key)) seen.set(key, { x, z, pos: i, depth: a, axis: p.axis }); }
  });
  return { positions: positions.map(({ x, z, axis }) => ({ x, z, axis })), cells: [...seen.values()], ends: [0, line.length - 1], closed: false };
}

// ------------------------------------------------------------------ (7a K2) along a boundary (wall.along)

/** (K2, §2) Spine cells per run: each run of 8 takes its own offset, as a ring's side does. */
export const ALONG_RUN = 8;
/** (K2) How far past `distance` a run may step (soft: a `move` deviation, judged by the part's tolerance). */
export const ALONG_REACH = 16;
/** (K2) The offset line is smoothed over +-SMOOTH spine cells (a boundary's wiggles leave no straight run for a gate). */
const SMOOTH = 4;

/** The cell a spine point offsets to at distance d on side `sign` (normalAt's Chebyshev normal, rounded). */
const offsetCell = (spine, i, d, sign, nrm) => { const [nx, nz] = nrm[i]; return [Math.round(spine[i][0] + nx * d * sign), Math.round(spine[i][1] + nz * d * sign)]; };

/**
 * The side of a spine a wall stands on: 1 (left of the spine's travel, its first cell to its last) or -1. `side`: left, right,
 * toward_anchor, away_from_anchor (with `anchor` [x, z]) or either: the side with more clear cells in the band of `dist` (ties left);
 * a shore's side is always the land. `nrm`: the spine's normals.
 */
export function alongSide(G, spine, nrm, { side = 'either', kind, anchor = null, dist: [lo, hi], waterAt }) {
  if (kind === 'shore') {
    let votes = 0;
    spine.forEach((p, i) => { votes += waterAt(...offsetCell(spine, i, 2, 1, nrm)) ? -1 : 1; });
    return { sign: votes >= 0 ? 1 : -1, why: 'land' };
  }
  if (side === 'left') return { sign: 1, why: 'left' };
  if (side === 'right') return { sign: -1, why: 'right' };
  if ((side === 'toward_anchor' || side === 'away_from_anchor') && anchor) {
    let bi = 0, bd = Infinity;
    spine.forEach((p, i) => { const d = Math.max(Math.abs(p[0] - anchor[0]), Math.abs(p[1] - anchor[1])); if (d < bd) { bd = d; bi = i; } });
    const [nx, nz] = nrm[bi], dot = nx * (anchor[0] - spine[bi][0]) + nz * (anchor[1] - spine[bi][1]);
    const toward = dot >= 0 ? 1 : -1;
    return { sign: side === 'toward_anchor' ? toward : -toward, why: side };
  }
  const clear = (sign) => { let n = 0; for (let i = 0; i < spine.length; i++) for (let d = lo; d <= hi; d++) { const [x, z] = offsetCell(spine, i, d, sign, nrm); const k = G.at(x, z); if (k >= 0 && !G.ob[k]) n++; } return n; };
  const l = clear(1), r = clear(-1);
  return { sign: r > l ? -1 : 1, why: 'either', clear: { left: l, right: r } };
}

/** A 4-connected join from cell a to b (x first, else z first when x first's corner is blocked): the cells after a, b included. */
function joinCells(G, a, b) {
  const legs = (xFirst) => {
    const out = [];
    let [x, z] = a;
    const sx = Math.sign(b[0] - x), sz = Math.sign(b[1] - z);
    if (xFirst) { while (x !== b[0]) { x += sx; out.push([x, z]); } while (z !== b[1]) { z += sz; out.push([x, z]); } } else { while (z !== b[1]) { z += sz; out.push([x, z]); } while (x !== b[0]) { x += sx; out.push([x, z]); } }
    return out;
  };
  const okAll = (cs) => cs.every(([x, z]) => { const k = G.at(x, z); return k >= 0 && !G.ob[k]; });
  const xf = legs(true);
  if (a[0] === b[0] || a[1] === b[1] || okAll(xf)) return xf;
  const zf = legs(false);
  return okAll(zf) ? zf : xf;
}

/**
 * (K2, §2) The line of a wall along a spine: each run of ALONG_RUN spine cells offset by the smallest clear distance in `dist`
 * (Chebyshev, D2's measure) to `sign`'s side, joined at the run ends by L legs, the 4-connected supercover of the whole (a loop the
 * offset folds into on an inner bend cut out), the wall `t` thick toward the spine (lineCells: to the right of travel). A run whose
 * every offset in `dist` is blocked steps outside it (at most ALONG_REACH, never into the spine: a `move`). The line's ends clip at the
 * claim margin. Network walk cells are crossings when every course of a straight run with a jamb each side is one (an open gate);
 * any other walk cell under the wall blocks its run. Returns `{ok: true, line: [[x, z, h]], lc (lineCells), runs: [{from, to, offset}],
 * window: [i0, i1], move, crossings: [{positions: [a, b]}]}` or `{ok: false, code, run, blockers, tried}`.
 */
export function alongLine(G, spine, nrm, { sign, dist: [lo, hi], t, reach = ALONG_REACH, maxRounds = 64 }) {
  const nRuns = Math.ceil(spine.length / ALONG_RUN);
  const minD = Math.max(1, t - 1);
  // each run's offset order: in range ascending, then outside it by how far (above first at a tie)
  const order = [];
  for (let d = Math.max(lo, minD); d <= hi; d++) order.push(d);
  for (let m = 1; m <= reach; m++) { if (hi + m <= 64) order.push(hi + m); if (lo - m >= minD) order.push(lo - m); }
  const idx = new Array(nRuns).fill(0);
  const seen = Array.from({ length: nRuns }, () => []);
  const clsOf = (k) => (k < 0 ? OB.OUT_OF_CLAIM : G.ob[k]);
  // a cell's Chebyshev distance to the spine (its cells within +-24 of index i)
  const spineDist = (c, i) => { let m = Infinity; for (let q = Math.max(0, i - 24); q <= Math.min(spine.length - 1, i + 24); q++) m = Math.min(m, Math.max(Math.abs(spine[q][0] - c[0]), Math.abs(spine[q][1] - c[1]))); return m; };
  // a run's own pre-check: every course of every offset cell clear (walk cells allowed: crossings, judged on the built line)
  const runBlockers = (r, d) => {
    const b = new Set();
    for (let i = r * ALONG_RUN; i < Math.min(spine.length, (r + 1) * ALONG_RUN); i++) for (let k = 0; k < t; k++) { const [x, z] = offsetCell(spine, i, d - k, sign, nrm); const c = clsOf(G.at(x, z)); if (c) b.add(c); }
    return b;
  };
  const advance = (r, also = null) => {
    for (;;) {
      if (idx[r] >= order.length) return false;
      const b = runBlockers(r, order[idx[r]]);
      if (also && idx[r] === also.at) for (const c of also.cls) b.add(c);
      // (an end run out of the claim is clipped, not refused)
      const endRun = r === 0 || r === nRuns - 1;
      if (!b.size || (endRun && [...b].every((c) => c === OB.OUT_OF_CLAIM))) return true;
      seen[r].push(b);
      idx[r]++;
      also = null;
    }
  };
  const refuse = (r) => {
    const every = [1, 2, 3, 4, 5, 6].filter((k) => seen[r].length && seen[r].every((s) => s.has(k)));
    const any = [...new Set(seen[r].flatMap((s) => [...s]))].sort((a, b) => a - b);
    const cls = every[0] ?? any[0] ?? OB.OVERLAP;
    const counts = {};
    for (const s of seen[r]) for (const c of s) counts[OB_NAME[c]] = (counts[OB_NAME[c]] ?? 0) + 1;
    return { ok: false, code: OB_CODE[cls], cls: OB_NAME[cls], run: r, spine: [spine[r * ALONG_RUN], spine[Math.min(spine.length, (r + 1) * ALONG_RUN) - 1]], blockers: counts, tried: [order[0], order[order.length - 1]] };
  };
  for (let r = 0; r < nRuns; r++) if (!advance(r)) return refuse(r);
  for (let round = 0; round < maxRounds; round++) {
    // the offset points, joined
    const pts = [], runOf = [];
    // each spine cell's offset point, smoothed over +-SMOOTH spine cells of the same offset (a boundary's 1-cell wiggles would leave the
    // line no straight run for a gate), kept only where the smoothed cell stays within the run's distance of the spine (else the raw one)
    const dAt = (i) => order[idx[Math.floor(i / ALONG_RUN)]];
    const pointAt = (i) => {
      const d = dAt(i);
      let sx = 0, sz = 0, n = 0;
      for (let q = Math.max(0, i - SMOOTH); q <= Math.min(spine.length - 1, i + SMOOTH); q++) {
        if (dAt(q) !== d) continue;
        const [nx, nz] = nrm[q];
        sx += spine[q][0] + nx * d * sign; sz += spine[q][1] + nz * d * sign; n++;
      }
      const c = [Math.round(sx / n), Math.round(sz / n)];
      const cd = spineDist(c, i);
      return cd === d || (cd >= Math.min(d, lo) && cd <= Math.max(d, hi) && cd >= minD) ? c : offsetCell(spine, i, d, sign, nrm);
    };
    for (let r = 0; r < nRuns; r++) {
      for (let i = r * ALONG_RUN; i < Math.min(spine.length, (r + 1) * ALONG_RUN); i++) {
        const c = pointAt(i);
        if (pts.length) {
          const p = pts[pts.length - 1];
          if (p[0] === c[0] && p[1] === c[1]) continue;
          for (const q of joinCells(G, p, c)) { pts.push(q); runOf.push(r); }
        } else { pts.push(c); runOf.push(r); }
      }
    }
    // loops cut out (a cell met again: the cells between it and its return dropped)
    const at = new Map();
    const cells = [], cr = [];
    for (let i = 0; i < pts.length; i++) {
      const k = `${pts[i][0]},${pts[i][1]}`;
      if (at.has(k)) { const j = at.get(k); for (let q = j + 1; q < cells.length; q++) at.delete(`${cells[q][0]},${cells[q][1]}`); cells.length = j + 1; cr.length = j + 1; continue; }
      at.set(k, cells.length); cells.push(pts[i]); cr.push(runOf[i]);
    }
    // the wall thick toward the spine: lineCells puts it to the right of travel, so a wall on the right of the spine runs backwards
    if (sign < 0) { cells.reverse(); cr.reverse(); }
    const hOf = (a, b) => (b[0] > a[0] ? 0 : b[1] > a[1] ? 1 : b[0] < a[0] ? 2 : 3);
    let line = cells.map((c, i) => [c[0], c[1], i + 1 < cells.length ? hOf(c, cells[i + 1]) : hOf(cells[i - 1], c)]);
    let runs = cr;
    // the ends clipped at the claim margin (a position with any course out of the claim)
    const posOut = (lc) => { const o = new Set(); for (const c of lc.cells) if (clsOf(G.at(c.x, c.z)) === OB.OUT_OF_CLAIM) o.add(c.pos); return o; };
    let lc = lineCells(line, t);
    const out = posOut(lc);
    if (out.size) {
      let a = 0, b = line.length - 1;
      while (a <= b && out.has(a)) a++;
      while (b >= a && out.has(b)) b--;
      if (a > 0 || b < line.length - 1) {
        line = line.slice(a, b + 1); runs = runs.slice(a, b + 1);
        if (line.length) line[line.length - 1] = [line[line.length - 1][0], line[line.length - 1][1], line.length > 1 ? line[line.length - 2][2] : line[0][2]];
        lc = lineCells(line, t);
      }
    }
    if (line.length < 8) return { ok: false, code: 'OUT_OF_CLAIM', cls: 'OUT_OF_CLAIM', run: 0, spine: [spine[0], spine[spine.length - 1]], blockers: { OUT_OF_CLAIM: 1 }, tried: [order[0], order[order.length - 1]], short: line.length };
    // every course clear; a walk cell only in a clean crossing (every course of a straight run, a clear jamb each side)
    const bad = new Map(); // run -> Set(class)
    const mark = (pos, c) => { const r = runs[pos]; if (!bad.has(r)) bad.set(r, new Set()); bad.get(r).add(c); };
    const byPos = Array.from({ length: line.length }, () => []);
    for (const c of lc.cells) byPos[c.pos].push(c);
    const walkPos = byPos.map((cs) => cs.filter((c) => { const k = G.at(c.x, c.z); return k >= 0 && G.walk[k]; }).length);
    for (const c of lc.cells) { const cl = clsOf(G.at(c.x, c.z)); if (cl) mark(c.pos, cl); }
    const crossings = [];
    for (let i = 0; i < line.length; i++) {
      if (!walkPos[i]) continue;
      let j = i; while (j + 1 < line.length && walkPos[j + 1]) j++;
      const full = byPos.slice(i, j + 1).every((cs, q) => walkPos[i + q] === cs.length && cs.length === t);
      const ax = lc.positions[i].axis;
      const straight = ax !== 3 && i > 0 && j < line.length - 1 && lc.positions.slice(i - 1, j + 2).every((p) => p.axis === ax) && !walkPos[i - 1] && !walkPos[j + 1];
      if (full && straight) crossings.push({ positions: [i, j] });
      else for (let q = i; q <= j; q++) mark(q, OB.OVERLAP);
      i = j;
    }
    if (!bad.size) {
      const used = [...new Set(runs)];
      const runsOut = [];
      for (let i = 0; i < runs.length; i++) { const last = runsOut[runsOut.length - 1]; if (last && last.run === runs[i]) last.to = i; else runsOut.push({ run: runs[i], from: i, to: i, offset: order[idx[runs[i]]] }); }
      const move = Math.max(0, ...runsOut.map((q) => (q.offset > hi ? q.offset - hi : q.offset < lo ? lo - q.offset : 0)));
      return { ok: true, line, lc, runs: runsOut, window: [Math.min(...used) * ALONG_RUN, Math.min(spine.length, (Math.max(...used) + 1) * ALONG_RUN) - 1], move, crossings };
    }
    // bump each blocked run past its offset (the classes found there remembered for the refusal)
    for (const [r, cls] of [...bad].sort((a, b) => a[0] - b[0])) {
      seen[r].push(new Set(cls));
      idx[r]++;
      if (!advance(r)) return refuse(r);
    }
  }
  return { ok: false, code: 'NO_ROOM', cls: 'OVERLAP', run: -1, blockers: {}, tried: [order[0], order[order.length - 1]], rounds: maxRounds };
}
