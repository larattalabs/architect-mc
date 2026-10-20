// (6c FL) Free layouts' shared engine (docs/CONTRACT.md "Phase 6c slice FL" §1-§2): a zone is a mask (the cells it may use), one or more
// street centre lines inside it, and lots on those lines. Every lot is an axis-aligned rect with a cardinal front facing its street, every
// street a V street (road 3 plus a verge each side, W's lanterns), every lot box + 1 kept off the streets, as V keeps it. Only the street's
// shape differs per layout (layouts/*.mjs). D2's followLots (followEmit.mjs) is the model and stays untouched.
//
//   Grid / Field            a claim-sized cell grid (Uint8Array per field: the mask, the street band, occupancy)
//   polarLoop / polarArc    integer polar curves (a 256-step integer sine table: no floating point reaches a cell)
//   frontage(F, street, specs, o)   lots along one street line, on the side(s) asked, V's fitLot rules (gap, dry, slope 3, pad 2)
//   emitFree(r, L, o)       the layout emitted: pads and lots, the hub (square, green or nothing), verges, lanes, roads, the graph,
//                           meta.village (V's shape, so props, lamps, the bell, M22-M24 and the siteplan run unchanged)
//
// Determinism: every choice is integer and ordered (index, then min x, then min z); the seed is the caller's ctx.rng(label).
import { surfaceOps, square, reservations, levelStats, toWorld, waterDistance, rectWater, BELL_AREA, STREET_RULES } from './village.mjs';
import { line4 } from './geom.mjs';
import { roadLamp } from './fixtures.mjs';
import { lampFixture } from './props.mjs';

/** V's street: road 3 plus a verge each side; lots 3 apart; slope at most 3; pads cut and fill at most 2. */
export const FL_RULES = Object.freeze({ setback: 3, lotGap: STREET_RULES.lotGap, maxSlope: STREET_RULES.maxSlope, pad: 2, half: 2 });

// ------------------------------------------------------------------ integer trigonometry (256 steps a turn)

/** round(4096 sin(2 pi k / 256)) for k = 0..64 (a quarter turn), integers: every polar cell is integer arithmetic. */
const SIN_Q = Object.freeze([0, 101, 201, 301, 401, 501, 601, 700, 799, 897, 995, 1092, 1189, 1285, 1380, 1474, 1567, 1660, 1751, 1842, 1931, 2019, 2106, 2191,
  2276, 2359, 2440, 2520, 2598, 2675, 2751, 2824, 2896, 2967, 3035, 3102, 3166, 3229, 3290, 3349, 3406, 3461, 3513, 3564, 3612, 3659, 3703, 3745, 3784, 3822, 3857,
  3889, 3920, 3948, 3973, 3996, 4017, 4036, 4052, 4065, 4076, 4085, 4091, 4095, 4096]);
export const TURN = 256;
const mod = (k, n) => ((k % n) + n) % n;
export function sin4096(k) {
  const a = mod(k, TURN);
  return a <= 64 ? SIN_Q[a] : a <= 128 ? SIN_Q[128 - a] : a <= 192 ? -SIN_Q[a - 128] : -SIN_Q[256 - a];
}
export const cos4096 = (k) => sin4096(k + 64);
/** v / 4096, rounded half away from zero (integers). */
const q12 = (v) => (v >= 0 ? Math.floor((v + 2048) / 4096) : -Math.floor((-v + 2048) / 4096));
/** The cell at polar (step k, radius r) about c. Angle 0 is east (+x), 64 south (+z). */
export const polarCell = (c, k, r) => [c[0] + q12(r * cos4096(k)), c[1] + q12(r * sin4096(k))];
/** The integer square root (floor). */
export function isqrt(n) {
  if (n <= 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}
/** The angle step (0..255) of a vector, by the table (integer cross products; ties to the lower step). */
export function stepOf(dx, dz) {
  if (dx === 0 && dz === 0) return 0;
  // the quadrant by signs, then the step of that quadrant whose ray has the largest dot product (ties: the lower step)
  const q = dz >= 0 ? (dx > 0 ? 0 : 1) : (dx >= 0 ? 3 : 2);
  let best = q * 64, bd = -Infinity;
  for (let k = q * 64; k <= q * 64 + 64; k++) { const d = cos4096(k) * dx + sin4096(k) * dz; if (d > bd) { bd = d; best = k; } }
  return mod(best, TURN);
}

// ------------------------------------------------------------------ lines

/** Bresenham's 8-connected cells from a to b inclusive. */
export function line8(a, b) {
  let [x0, z0] = a;
  const [x1, z1] = b;
  const dx = Math.abs(x1 - x0), dz = -Math.abs(z1 - z0), sx = x0 < x1 ? 1 : -1, sz = z0 < z1 ? 1 : -1;
  let err = dx + dz;
  const out = [];
  for (;;) {
    out.push([x0, z0]);
    if (x0 === x1 && z0 === z1) break;
    const e2 = 2 * err;
    if (e2 >= dz) { err += dz; x0 += sx; }
    if (e2 <= dx) { err += dx; z0 += sz; }
  }
  return out;
}

/** A cell list made 4-connected (a diagonal step gains its x-first corner), consecutive repeats and back-steps (A B A) dropped. */
export function to4(cells, closed = false) {
  const out = [];
  const push = (c) => {
    const n = out.length;
    if (n && out[n - 1][0] === c[0] && out[n - 1][1] === c[1]) return;
    if (n >= 2 && out[n - 2][0] === c[0] && out[n - 2][1] === c[1]) { out.pop(); return; }
    out.push([c[0], c[1]]);
  };
  const all = closed && cells.length ? [...cells, cells[0]] : cells;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (out.length) {
      const p = out[out.length - 1];
      if (Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]) > 1) for (const q of line4(p[0], p[1], c[0], c[1]).slice(1, -1)) push(q);
    }
    push(c);
  }
  if (closed && out.length > 1 && out[out.length - 1][0] === out[0][0] && out[out.length - 1][1] === out[0][1]) out.pop();
  // a closed loop's seam: drop a back-step across it
  while (closed && out.length > 2 && out[out.length - 1][0] === out[1][0] && out[out.length - 1][1] === out[1][1]) { out.pop(); out.shift(); }
  return out;
}

/** A closed polar loop about c: radius `rad(k)` at each of the 256 steps, joined and made 4-connected. */
export function polarLoop(c, rad) {
  const pts = [];
  for (let k = 0; k < TURN; k++) pts.push(polarCell(c, k, rad(k)));
  const joined = [];
  for (let k = 0; k < TURN; k++) { const seg = line8(pts[k], pts[(k + 1) % TURN]); joined.push(...(k ? seg.slice(1) : seg)); }
  joined.pop(); // the first cell again
  return to4(joined, true);
}

/** An open polar curve: steps k0..k1 (inclusive, k1 may exceed 256: turns), radius rad(k). */
export function polarArc(c, k0, k1, rad) {
  const pts = [];
  for (let k = k0; k <= k1; k++) pts.push(polarCell(c, k, rad(k)));
  const joined = [];
  for (let i = 0; i + 1 < pts.length; i++) { const seg = line8(pts[i], pts[i + 1]); joined.push(...(i ? seg.slice(1) : seg)); }
  if (pts.length === 1) joined.push(pts[0]);
  return to4(joined, false);
}

/** A polyline's corners (the first and last cell, and every cell where the step changes): a road's points. */
export function cornersOf(cells) {
  if (cells.length <= 2) return cells.map((c) => [c[0], c[1]]);
  const out = [cells[0]];
  for (let i = 1; i + 1 < cells.length; i++) {
    const a = cells[i - 1], b = cells[i], c = cells[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1]) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out.map((c) => [c[0], c[1]]);
}

// ------------------------------------------------------------------ the field: claim-sized grids

/**
 * The working field of one zone over the claim: `mask` (1 where the zone may use the cell: the claim less its margin, keep-out,
 * protected areas, other owners' regions, builds, standing regions, earlier zones and forms, H footprints, natural water), `band`
 * (2: a street's road, 1: its verge), `occ` (lots, the hub's reservations, lanes), and the survey.
 */
export class Field {
  constructor(S, claim, margin = 2) {
    this.S = S;
    this.claim = claim;
    this.x0 = claim.minX; this.z0 = claim.minZ;
    this.W = claim.maxX - claim.minX + 1; this.D = claim.maxZ - claim.minZ + 1;
    this.margin = margin;
    this.mask = new Uint8Array(this.W * this.D);
    this.band = new Uint8Array(this.W * this.D);
    this.occ = new Uint8Array(this.W * this.D);
    for (let j = margin; j < this.D - margin; j++) for (let i = margin; i < this.W - margin; i++) {
      const x = this.x0 + i, z = this.z0 + j;
      if (!S.waterAt(x, z)) this.mask[i + j * this.W] = 1;
    }
  }
  in(x, z) { return x >= this.x0 && z >= this.z0 && x < this.x0 + this.W && z < this.z0 + this.D; }
  k(x, z) { return (x - this.x0) + (z - this.z0) * this.W; }
  ok(x, z) { return this.in(x, z) && this.mask[this.k(x, z)] === 1; }
  /** Remove a rect [x0, z0, x1, z1] (inclusive) from the mask. */
  cut([a, b, c, d]) {
    for (let z = Math.max(b, this.z0); z <= Math.min(d, this.z0 + this.D - 1); z++) for (let x = Math.max(a, this.x0); x <= Math.min(c, this.x0 + this.W - 1); x++) this.mask[this.k(x, z)] = 0;
  }
  /** Keep only the cells `keep(x, z)` says. */
  keepOnly(keep) {
    for (let j = 0; j < this.D; j++) for (let i = 0; i < this.W; i++) if (this.mask[i + j * this.W] && !keep(this.x0 + i, this.z0 + j)) this.mask[i + j * this.W] = 0;
  }
  clone() {
    const f = Object.create(Field.prototype);
    Object.assign(f, this);
    f.mask = this.mask.slice(); f.band = this.band.slice(); f.occ = this.occ.slice();
    return f;
  }
  /** Mark a street's band: road (Chebyshev <= 1 of a centre cell) 2, verge (<= 2) 1. */
  markBand(cells) {
    for (const [x, z] of cells) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Z = z + dz;
      if (!this.in(X, Z)) continue;
      const v = Math.max(Math.abs(dx), Math.abs(dz)) <= 1 ? 2 : 1;
      const k = this.k(X, Z);
      if (this.band[k] < v) this.band[k] = v;
    }
  }
  /** Whether a street line may run here: every road cell (Chebyshev <= 1) in the mask. */
  streetOk(cells) {
    for (const [x, z] of cells) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.ok(x + dx, z + dz)) return { x: x + dx, z: z + dz };
    return null;
  }
  occupy([a, b, c, d], v = 1) {
    for (let z = b; z <= d; z++) for (let x = a; x <= c; x++) if (this.in(x, z)) this.occ[this.k(x, z)] = v;
  }
  /** Whether every cell of a rect is in the mask, off every band and unoccupied. */
  rectFree([a, b, c, d]) {
    for (let z = b; z <= d; z++) for (let x = a; x <= c; x++) {
      if (!this.ok(x, z)) return false;
      const k = this.k(x, z);
      if (this.band[k] || this.occ[k]) return false;
    }
    return true;
  }
}

/** A field's mask as row runs [[x0, z, x1, z]] (z, then x): the geometry's `mask`. */
export function fieldRuns(F, keep = (x, z) => F.ok(x, z)) {
  const out = [];
  for (let j = 0; j < F.D; j++) {
    let s = null;
    for (let i = 0; i <= F.W; i++) {
      const on = i < F.W && keep(F.x0 + i, F.z0 + j);
      if (on && s === null) s = i;
      if (!on && s !== null) { out.push([F.x0 + s, F.z0 + j, F.x0 + i - 1, F.z0 + j]); s = null; }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the ground road rule (4e's ground mode, V's streetCheck)

/**
 * Why a street along `cells` (4-connected centre cells) can't be a ground road on the plan survey, or null: no water, and a running
 * window of cut and fill within 3 with steps of 1 (program.mjs _groundRoadProblem).
 */
export function groundRoadProblem(S, cells) {
  let lo = -Infinity, hi = Infinity;
  for (const [x, z] of cells) {
    if (S.waterAt(x, z)) return `water at ${x},${z}`;
    const g = S.heightAt(x, z);
    lo = Math.max(g - 3, lo - 1); hi = Math.min(g + 3, hi + 1);
    if (lo > hi) return `too steep at ${x},${z} (cut/fill over 3 with steps of 1)`;
  }
  return null;
}

// ------------------------------------------------------------------ lots along a street (the frontage engine)

const rectsMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const growR = (r, m) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];
/** V's orderOf: central first, then landmarks, then the rest, edge last. */
export const orderOf = (s) => (s.placement === 'central' ? 0 : s.landmark ? 1 : s.placement === 'edge' ? 3 : 2);
const FRONT = { '0,1': 'north', '0,-1': 'south', '1,0': 'west', '-1,0': 'east' };

/** The along-axis at index i of a street (from i - 3 to i + 3): true when it runs along x. */
export function alongX(st, i) {
  const P = st.cells, n = P.length;
  const j0 = st.closed ? mod(i - 3, n) : Math.max(0, i - 3), j1 = st.closed ? mod(i + 3, n) : Math.min(n - 1, i + 3);
  const dx = P[j1][0] - P[j0][0], dz = P[j1][1] - P[j0][1];
  return Math.abs(dx) >= Math.abs(dz);
}

/**
 * A lot for `spec` at index i of street `st`, on side `side` (+1 or -1 along the normal axis), its front edge `near` off the centre:
 * `{lot}` or `{why}`. V's fitLot rules: wholly in the mask, off every street band, unoccupied, `gap` from the lots placed, dry, slope 3,
 * the pad (floor at the entrance's ground + 1) within FL_RULES.pad; the entrance is the cell outside its front edge's middle, joined to
 * the street by a straight lane (empty when the entrance lies on the verge).
 */
export function lotAt(F, st, i, side, spec, { near: near0 = FL_RULES.setback, gap = FL_RULES.lotGap, placed = [], avoid = [], push = null } = {}) {
  const [cx, cz] = st.cells[i];
  const ax = alongX(st, i);
  const n = ax ? [0, side] : [side, 0];
  const [w, dp] = spec.size;
  const half = Math.floor((w - 1) / 2);
  // the setback, pushed out (a longer lane) where a curving street runs on across the lot's front: at most half the lot's width + 2
  const maxPush = push ?? half + 2;
  let why = 'no_room';
  for (let p = 0; p <= maxPush; p++) {
    const near = near0 + p;
    const far = near + dp - 1;
    const rect = ax ? [cx - half, Math.min(cz + side * near, cz + side * far), cx - half + w - 1, Math.max(cz + side * near, cz + side * far)]
      : [Math.min(cx + side * near, cx + side * far), cz - half, Math.max(cx + side * near, cx + side * far), cz - half + w - 1];
    if (!F.rectFree(rect)) continue;
    if (placed.some((l) => rectsMeet(growR(rect, gap), l.rect))) { why = 'no_room'; continue; }
    if (avoid.some((a) => rectsMeet(growR(rect, 1), a))) { why = 'no_room'; continue; }
    // the entrance: the cell outside the front edge's middle; the lane: from it towards the street until the street's band
    const ex = ax ? cx : cx + side * (near - 1), ez = ax ? cz + side * (near - 1) : cz;
    if (!F.ok(ex, ez) || F.occ[F.k(ex, ez)]) continue;
    const lane = [];
    let laneOk = true;
    for (let t = near - 1; t >= 1; t--) {
      const x = cx + n[0] * t, z = cz + n[1] * t;
      if (F.band[F.k(x, z)]) break;
      if (!F.ok(x, z) || F.occ[F.k(x, z)] || placed.some((l) => x >= l.rect[0] && x <= l.rect[2] && z >= l.rect[1] && z <= l.rect[3])) { laneOk = false; break; }
      lane.push([x, z]);
    }
    if (!laneOk) continue;
    const S = F.S;
    let lo = Infinity, hi = -Infinity;
    const hs = [];
    for (let x = rect[0]; x <= rect[2]; x++) for (let z = rect[1]; z <= rect[3]; z++) { const h = S.heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); hs.push(h); }
    if (hi - lo > FL_RULES.maxSlope) { why = 'too_steep'; continue; }
    hs.sort((a, b) => a - b);
    // the lane's ground steps at most 1 a cell (walkable), and its street end at most 1 from the street's ground
    const lg = [[cx + n[0] * (lane.length ? near - lane.length - 1 : near - 1), cz + n[1] * (lane.length ? near - lane.length - 1 : near - 1)], ...[...lane].reverse(), [ex, ez]].map(([x, z]) => S.heightAt(x, z));
    if (lg.some((g, k) => k && Math.abs(g - lg[k - 1]) > 1)) { why = 'too_steep'; continue; }
    const floorY = S.heightAt(ex, ez) + 1;
    const ps = S.padStats(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1, { floorY });
    if (ps.water || ps.cut > FL_RULES.pad || ps.fill > FL_RULES.pad) { why = 'pad'; continue; }
    const front = FRONT[`${n[0]},${n[1]}`];
    return { lot: { spec, rect, front, floorY, groundY: hs[hs.length >> 1], entrance: [ex, floorY, ez], street: st.name, at: i, junction: [cx, cz], lane, side, near } };
  }
  return { why };
}

/** A lot's score under its hint (higher is better): V's hintScore, plus central -> near `centre`. */
function hintScore(F, l, { wd, centre, mean }) {
  const s = l.spec, r = l.rect;
  const mx = (r[0] + r[2]) >> 1, mz = (r[1] + r[3]) >> 1;
  const d = centre ? Math.max(Math.abs(mx - centre[0]), Math.abs(mz - centre[1])) : 0;
  const hint = s.placement ?? (s.villager === 'farm' ? 'near_water' : null);
  if (hint === 'near_water') { const b = wd?.any ? rectWater(wd, r) : null; return b === null ? -2000 : -Math.min(b, 60) * 40; }
  if (hint === 'central') return -d * 20;
  if (hint === 'edge') return d * 10;
  if (hint === 'high_ground') return (l.groundY - mean) * 60;
  return 0;
}

/**
 * Lots along one street `st` ({name, cells, closed}): each spec in V's order. `sides(i)`: the side signs allowed at index i (+1/-1
 * along the normal), first preferred. Hinted specs (near_water, high_ground) take their best-scored place; the rest are spread along the
 * line (`spread`: even spacing on a closed line) or packed from `start`. `setbackOf(spec, k)` and `gapOf(spec, k)` vary them (organic).
 * Marks each placed lot (and its lane) occupied in F. Returns `{lots, unplaced: [{id, reason}]}`.
 */
export function frontage(F, st, specs, { sides, setbackOf = () => FL_RULES.setback, gapOf = () => FL_RULES.lotGap, spread = st.closed, start = 0, placed = [], avoid = [], centre = null, step = 1 } = {}) {
  const P = st.cells, L = P.length;
  const out = [], unplaced = [];
  const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => orderOf(a.s) - orderOf(b.s) || a.i - b.i);
  const wd = ordered.some(({ s }) => s.placement === 'near_water' || s.villager === 'farm') ? waterDistance(F.S, F.claim) : null;
  let mean = 0;
  { let n = 0; for (let i = 0; i < L; i += 4) { mean += F.S.heightAt(P[i][0], P[i][1]); n++; } mean = n ? Math.floor(mean / n) : 0; }
  const tryAt = (s, k, i) => {
    for (const sd of sides(i)) {
      const r = lotAt(F, st, i, sd, s, { near: setbackOf(s, k), gap: gapOf(s, k), placed: [...placed, ...out], avoid });
      if (r.lot) return r.lot;
    }
    return null;
  };
  const take = (l) => { out.push(l); F.occupy(l.rect, 1); for (const [x, z] of l.lane) F.occ[F.k(x, z)] = 3; };
  // hinted lots first (their best place over the whole line, every `step` cells)
  const hinted = ordered.filter(({ s }) => ['near_water', 'high_ground'].includes(s.placement) || (s.villager === 'farm' && !s.placement));
  const rest = ordered.filter((o) => !hinted.includes(o));
  for (const { s, i: k } of hinted) {
    let best = null, bs = -Infinity;
    for (let i = 0; i < L; i += step) {
      const l = tryAt(s, k, i);
      if (!l) continue;
      const sc = hintScore(F, l, { wd, centre, mean });
      if (sc > bs) { bs = sc; best = l; }
    }
    if (best) take(best); else unplaced.push({ id: s.id, reason: 'no_room' });
  }
  // the rest: spread (an even share of the free length between lots) or packed from `start`
  const need = rest.reduce((a, { s, i }) => a + s.size[0] + gapOf(s, i), 0);
  const extra = spread && rest.length ? Math.max(0, Math.floor((L - need) / rest.length)) : 0;
  let cur = start;
  const left = [];
  for (const { s, i: k } of rest) {
    let got = null;
    for (let t = 0; t < L && !got; t++) {
      const i = st.closed ? mod(cur + t, L) : cur + t;
      if (!st.closed && i >= L) break;
      got = tryAt(s, k, i);
      if (got) cur = (st.closed ? i : i) + s.size[0] + gapOf(s, k) + extra;
    }
    if (got) take(got); else left.push({ s, k });
  }
  // a second pass for what the spread missed: packed from the line's start
  for (const { s, k } of left) {
    let got = null;
    for (let i = 0; i < L && !got; i++) got = tryAt(s, k, i);
    if (got) take(got); else unplaced.push({ id: s.id, reason: 'no_room' });
  }
  return { lots: out, unplaced };
}

// ------------------------------------------------------------------ the hub's shared space

/**
 * The hub's shared space at `c` (V's square, or the 7x7 well green, or none): `{sh, res}` in V's frame ('ew': u = x, v = z) or
 * `{fail}`. `none` keeps the ground: only the bell area and the golem space are reserved there (nothing written).
 */
export function hubSpace(F, c, shared) {
  const S = F.S;
  const size = shared.kind === 'square' ? shared.size : shared.kind === 'well' ? 7 : 5;
  const h0 = Math.floor((size - 1) / 2);
  const u0 = c[0] - h0, v0 = c[1] - h0, u1 = u0 + size - 1, v1 = v0 + size - 1;
  const wr = [u0, v0, u1, v1];
  for (let z = v0 - 1; z <= v1 + 1; z++) for (let x = u0 - 1; x <= u1 + 1; x++) if (!F.ok(x, z)) return { fail: `the hub's ${shared.kind === 'none' ? 'bell area' : shared.kind} leaves the zone's land at ${x},${z}` };
  const st = levelStats(S, wr);
  if (st.water) return { fail: `water under the hub's ${shared.kind}` };
  if (shared.kind !== 'none' && (st.cut > 2 || st.fill > 2)) return { fail: `the hub's ${shared.kind} needs a cut of ${st.cut} and a fill of ${st.fill} (at most 2)` };
  if (shared.kind === 'none' && st.cut + st.fill > 0) return { fail: 'the hub\'s bell area is not level (shared none writes nothing there)' };
  const sh = { kind: shared.kind === 'none' ? 'none' : shared.kind, u0, u1, v0, v1, side: 0, cu: c[0], y: st.top, rect: wr };
  // the reservations: V's for a square or green; for none, the bell area at the centre and the golem space at its east edge
  const res = reservations('ew', { ...sh, kind: shared.kind === 'square' ? 'square' : 'well' });
  return { sh, res };
}

/** The hub's rects kept clear of lots and lanes (the space, its bell area and golem space, grown by 1 by the caller's avoid). */
export function hubAvoid(h) {
  const xs = [...h.res.area, ...h.res.golem].map((c) => c[0]), zs = [...h.res.area, ...h.res.golem].map((c) => c[1]);
  return [h.sh.rect, [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]];
}

/**
 * Spokes from the hub's space to a street: from the middle of each edge of the space (south, east, north, west), straight out until the
 * first street band cell; kept when every cell is in the mask, off every lot (+1) and lane. `max` spokes at most. Each `{cells: [[x,
 * z]], to: [x, z] (the band cell reached), dir}`.
 */
export function spokes(F, h, max = 4) {
  const sh = h.sh, out = [];
  const mu = (sh.u0 + sh.u1) >> 1, mv = (sh.v0 + sh.v1) >> 1;
  for (const [dx, dz, x, z] of [[0, 1, mu, sh.v1 + 1], [1, 0, sh.u1 + 1, mv], [0, -1, mu, sh.v0 - 1], [-1, 0, sh.u0 - 1, mv]]) {
    if (out.length >= max) break;
    const cells = [];
    let X = x, Z = z, ok = false;
    for (let t = 0; t < 256; t++, X += dx, Z += dz) {
      if (!F.in(X, Z)) break;
      const k = F.k(X, Z);
      if (F.band[k]) { ok = true; break; }
      if (!F.mask[k] || F.occ[k]) break;
      cells.push([X, Z]);
    }
    if (!ok) continue;
    // wide enough: the cell beside each spoke cell (the lane is 2 wide) is free too
    const side = dx ? [0, 1] : [1, 0];
    if (cells.some(([a, b]) => { const k = F.k(a + side[0], b + side[1]); return !F.in(a + side[0], b + side[1]) || !F.mask[k] || (F.occ[k] && !F.band[k]); })) continue;
    out.push({ cells, to: [X, Z], dir: [dx, dz], side });
    for (const [a, b] of cells) { F.occ[F.k(a, b)] = 3; F.occ[F.k(a + side[0], b + side[1])] = 3; }
  }
  return out;
}

// ------------------------------------------------------------------ emission

/** The cardinal a world step faces ([1, 0]: east). */
const facingOf = (dx, dz) => (dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north');

/**
 * Emit a free layout `L` into region r: `{kind, streets: [{name, cells, closed}], lots, unplaced, hub: {sh, res} | null, spokes, F}`.
 * Stage `ground`: the lot pads (part `<prefix>pads`, each lot in stage `lots`), the hub's square or green (`<prefix>square` /
 * `<prefix>green`), the verges (`<prefix>verges`), the lanes and spokes (`<prefix>lanes`); stage `street`: each street a ground road
 * `<prefix>street_<name>` (two arcs for a closed one) in part `<prefix>street`. The graph: a lot node per lot, the plaza (port bell, a
 * port per spoke), a junction per lot on its street, road edges along each street, path edges for the lanes and spokes. Returns V's
 * result shape (`lots` [{spec, rect, lot, entrance, slot}], `res`, `laneCells`, `unplaced`, `shared`, `orientation`, `plaza`, `roads`)
 * plus `streets` and `ends`.
 */
export function emitFree(r, L, { stages = {}, prefix = '', padEdge = null, maxHeight = 32, planProps = null, laneWidth = 2, zone = null, _unsafe = {} } = {}) {
  const sg = stages.ground ?? 'ground', ss = stages.street ?? 'street', sl = stages.lots ?? 'lots';
  const F = L.F;
  const hub = L.hub;
  const res = hub ? hub.res : null;
  const wd = waterDistance(r.survey, r.claim);
  // pads and lots
  const pads = r.part(`${prefix}pads`, { stage: sg });
  const boxes = [], lotOut = [];
  const bell = res ? res.bell : (() => { const l = L.lots[0]; return l ? [...l.entrance] : [F.x0, 64, F.z0]; })();
  for (const l of [...L.lots].sort((a, b) => a.spec._i - b.spec._i)) {
    const s = l.spec;
    const water = rectWater(wd, l.rect);
    const bellDistance = Math.round(Math.hypot(l.entrance[0] - bell[0], l.entrance[2] - bell[2]) * 10) / 10;
    const lot = pads.lot(s.id, {
      at: [l.rect[0], l.rect[1]], size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1], floor: l.floorY, front: l.front,
      max: [l.rect[2] - l.rect[0] + 1, maxHeight, l.rect[3] - l.rect[1] + 1], brief: s.brief, pad: { maxCut: FL_RULES.pad, maxFill: FL_RULES.pad, ...(padEdge ? { edge: padEdge } : {}) }, stage: sl,
      ext: { ...s.ext, 'architect_mc:village': { role: s.role, type: s.type, villager: s.villager, entrance: l.entrance, lane: `lane_${s.id}`, water, bellDistance, slot: l.slot, landmark: s.landmark, placement: s.placement, layout: L.kind } },
    });
    boxes.push({ id: s.id, ...lot.box });
    lotOut.push({ ...l, lot });
  }
  // the hub's space (its props' cells paved without walk)
  const o = 'ew';
  const propsPlan = hub && planProps && hub.sh.kind !== 'none' ? planProps({ o, sh: hub.sh, res, lots: lotOut, layout: L }) : null;
  if (hub && hub.sh.kind !== 'none') square(r, hub.sh, { stage: sg, o, noWalk: propsPlan?.noWalk ?? new Set(), prefix });
  // the verges: each street's band less its road, the lots, the hub's space and anything off the mask (surface swap, walk)
  const verges = r.part(`${prefix}verges`, { stage: sg, set: 'path' });
  const vset = new Set(), road = new Set();
  for (const st of L.streets) for (const [x, z] of st.cells) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) road.add(`${x + dx},${z + dz}`);
  const inBox = (x, z) => boxes.some((b) => x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1);
  const inHub = (x, z) => hub && hub.sh.kind !== 'none' && x >= hub.sh.u0 && x <= hub.sh.u1 && z >= hub.sh.v0 && z <= hub.sh.v1;
  const vcells = [];
  for (const st of L.streets) for (const [x, z] of st.cells) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const X = x + dx, Z = z + dz, key = `${X},${Z}`;
    if (vset.has(key) || road.has(key)) continue;
    vset.add(key);
    if (!F.ok(X, Z) || inBox(X, Z) || inHub(X, Z)) continue;
    vcells.push([X, null, Z]);
  }
  vcells.sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  if (vcells.length) surfaceOps(verges, vcells, 'path');
  (r.meta.parts[verges.id] ??= {}).kind = 'path';
  // the plaza
  const plazaAt = res ? res.bell : bell;
  const pl = r.graphNode({ id: `${prefix}plaza`, kind: 'plaza', ref: hub?.sh.kind ?? 'none', at: plazaAt, ports: [{ name: 'bell', at: plazaAt, facing: 'up', width: BELL_AREA }] });
  // lanes (each lot's entrance and the cells to the street, at the lot's pad top) and spokes
  const lanes = r.part(`${prefix}lanes`, { stage: sg, set: 'path' });
  (r.meta.parts[lanes.id] ??= {}).kind = 'path';
  const laneCells = {};
  for (const l of lotOut) {
    const s = l.spec, e = l.entrance;
    r.graphNode({ id: `lot:${s.id}`, kind: 'lot', ref: s.id, at: e, ports: [{ name: 'entrance', at: e, facing: l.front, width: laneWidth }] });
    if (_unsafe.noLane === s.id) continue;
    const cells = [[e[0], e[1] - 1, e[2]], ...l.lane.filter(([x, z]) => x !== e[0] || z !== e[2]).map(([x, z]) => [x, null, z])];
    if (!_unsafe.laneThroughLot) for (const [x, , z] of cells) for (const b of boxes) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) throw new Error(`lane lane_${s.id} enters lot ${b.id}'s box at ${x},${z}`);
    surfaceOps(lanes, cells, 'path');
    laneCells[s.id] = cells.map(([x, y, z]) => [x, y ?? r.survey.heightAt(x, z), z]);
  }
  // ((6c FL, broken variant laneThroughLot) a lane driven through the next lot's box: the emit must refuse it)
  if (_unsafe.laneThroughLot && lotOut.length >= 2) {
    const a = lotOut[0], b = lotOut[1].lot.box;
    const cells = line4(a.entrance[0], a.entrance[2], (b.minX + b.maxX) >> 1, (b.minZ + b.maxZ) >> 1).map(([x, z]) => [x, z]);
    for (const [x, z] of cells) for (const q of boxes) if (q.id !== a.spec.id && x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ) throw new Error(`lane lane_${a.spec.id} enters lot ${q.id}'s box at ${x},${z}`);
  }
  const spokeCells = [];
  for (const sp of L.spokes ?? []) for (const [x, z] of sp.cells) spokeCells.push([x, null, z], [x + sp.side[0], null, z + sp.side[1]]);
  if (spokeCells.length) surfaceOps(lanes, spokeCells, 'path');
  // the streets: ground roads (a closed street as two arcs), junctions where lanes and spokes meet them, road edges between
  const street = r.part(`${prefix}street`, { stage: ss, set: 'path' });
  const lamp = roadLamp(lampFixture(r));
  const roads = [];
  const ends = [];
  const yAt = (x, z) => r.survey.heightAt(x, z) + 1;
  for (const st of L.streets) {
    const n = st.cells.length;
    const rid = `${prefix}street_${st.name}`;
    const pieces = st.closed ? [[rid, 0, n >> 1], [`${rid}_b`, n >> 1, n]] : [[rid, 0, n - 1]];
    for (const [id, a, b] of pieces) {
      const cells = st.closed ? [...st.cells.slice(a, b + 1 > n ? n : b + 1), ...(b === n ? [st.cells[0]] : [])] : st.cells.slice(a, b + 1);
      const pts = cornersOf(cells);
      const why = street._groundRoadProblem(pts.map((q) => [q[0], null, q[1]]));
      if (why) throw new Error(`free layout: the street (${id}) can't be a ground road: ${why}`);
      const got = street.road(pts, { width: 3, surface: 'path', lanterns: true, mode: 'ground', id, lamp });
      roads.push(...(got?.ids ?? [id]));
    }
    // junctions: each lot's, each spoke's, and the ends of an open street, in line order
    const stops = new Map(); // index -> {lots: [ids], spoke: k}
    const idxOf = new Map(st.cells.map((c, i) => [`${c[0]},${c[1]}`, i]));
    for (const l of lotOut) if (l.street === st.name) { const v = stops.get(l.at) ?? { lots: [], spokes: [] }; v.lots.push(l.spec.id); stops.set(l.at, v); }
    (L.spokes ?? []).forEach((sp, k) => {
      // the street cell nearest the spoke's end
      let bi = -1, bd = Infinity;
      st.cells.forEach((c, i) => { const d = Math.max(Math.abs(c[0] - sp.to[0]), Math.abs(c[1] - sp.to[1])); if (d < bd) { bd = d; bi = i; } });
      if (bd > 2 || sp.street === false) return;
      if (sp.streetName && sp.streetName !== st.name) return;
      sp.streetName = st.name; sp.at = bi;
      const v = stops.get(bi) ?? { lots: [], spokes: [] }; v.spokes.push(k); stops.set(bi, v);
    });
    if (!st.closed) { for (const i of [0, n - 1]) if (!stops.has(i)) stops.set(i, { lots: [], spokes: [], end: true }); else stops.get(i).end = true; }
    const order = [...stops.keys()].sort((p, q) => p - q);
    void idxOf;
    const nodes = [];
    order.forEach((i, k) => {
      const [x, z] = st.cells[i];
      const at = [x, yAt(x, z) - 1, z];
      const v = stops.get(i);
      const ports = [{ name: 'street', at, facing: 'up', width: 5 }];
      const nd = r.graphNode({ id: `${rid}_j${k + 1}`, kind: 'junction', ref: rid, at, ports });
      for (const id of v.lots) {
        const port = `lane_${id}`;
        const l = lotOut.find((q) => q.spec.id === id);
        nd.ports.push({ name: port, at, facing: l.front, width: laneWidth });
        r.graphEdge({ id: port, from: `lot:${id}.entrance`, to: `${nd.id}.${port}`, type: 'path', width: laneWidth, path: port });
      }
      for (const sk of v.spokes) {
        const sp = L.spokes[sk], pn = `spoke_${sk + 1}`;
        const sa = sp.cells.length ? sp.cells[0] : sp.to;
        const pa = [sa[0], (hub?.sh.y ?? at[1]) + 1, sa[1]];
        pl.ports.push({ name: pn, at: pa, facing: facingOf(sp.dir[0], sp.dir[1]), width: 2 });
        nd.ports.push({ name: pn, at, facing: facingOf(-sp.dir[0], -sp.dir[1]), width: 2 });
        r.graphEdge({ id: `${prefix}${pn}`, from: `${pl.id}.${pn}`, to: `${nd.id}.${pn}`, type: 'path', width: 2, path: `${prefix}lanes` });
      }
      if (v.end) ends.push({ street: st.name, x, z, at, facing: (() => { const j = i === 0 ? Math.min(n - 1, 3) : Math.max(0, n - 4); const dx = x - st.cells[j][0], dz = z - st.cells[j][1]; return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1]; })(), node: nd.id });
      nodes.push(nd);
    });
    for (let k = 0; k + 1 < nodes.length; k++) r.graphEdge({ id: `${rid}#${k + 1}`, from: `${nodes[k].id}.street`, to: `${nodes[k + 1].id}.street`, type: 'road', width: 5, path: rid });
    if (st.closed && nodes.length > 1) r.graphEdge({ id: `${rid}#${nodes.length}`, from: `${nodes[nodes.length - 1].id}.street`, to: `${nodes[0].id}.street`, type: 'road', width: 5, path: `${rid}_b` });
    st.nodes = nodes.map((x) => x.id);
  }
  // a hub with no spoke (shared none, or every spoke blocked): the plaza joins the nearest street junction (its ground is walkable)
  if (!(L.spokes ?? []).some((sp) => sp.streetName)) {
    let best = null;
    for (const st of L.streets) for (const id of st.nodes ?? []) { const nd = r.graph.nodes.find((x) => x.id === id); const d = Math.max(Math.abs(nd.at[0] - plazaAt[0]), Math.abs(nd.at[2] - plazaAt[2])); if (!best || d < best.d) best = { d, nd }; }
    if (best) {
      best.nd.ports.push({ name: 'hub', at: best.nd.at, facing: 'up', width: 2 });
      pl.ports.push({ name: 'street', at: plazaAt, facing: 'up', width: 2 });
      r.graphEdge({ id: `${prefix}hub_link`, from: `${pl.id}.street`, to: `${best.nd.id}.hub`, type: 'path', width: 2, path: `${prefix}hub` });
    }
  }
  if (L.unplaced.length) r.note(`unplaced: ${L.unplaced.map((u) => u.id).join(', ')}`);
  const wdU = wd;
  const village = {
    orientation: o, streetV: null, layout: L.kind, shared: hub ? { kind: hub.sh.kind, rect: hub.sh.rect, y: hub.sh.y } : null,
    bell: res ? res.bell : bell, bellArea: res ? res.area.map(([x, z]) => [x, z]) : [], bellY: res ? res.y : bell[1],
    golem: res ? res.golem.map(([x, z]) => [x, z]) : [], golemCentre: res ? res.golemCentre : [bell[0], bell[2]], unplaced: L.unplaced, lanes: laneCells, roads, laneWidth,
    lots: Object.fromEntries(lotOut.map((l) => [l.spec.id, { villager: l.spec.villager, slot: l.slot, entrance: l.entrance, rect: l.rect, water: rectWater(wdU, l.rect) }])),
    waterAny: wdU.any, keepOut: r.ctx.keepOut ?? [],
  };
  if (prefix) (r.meta.villageZones ??= {})[prefix] = village; else r.meta.village = village;
  void zone;
  return {
    free: true, kind: L.kind, orientation: L.orientation ?? null, claimCentre: [(r.claim.minX + r.claim.maxX) >> 1, (r.claim.minZ + r.claim.maxZ) >> 1], shared: hub ? { kind: hub.sh.kind, rect: hub.sh.rect, y: hub.sh.y } : null,
    res: { bell: res ? res.bell : bell, area: res ? res.area : [], golem: res ? res.golem : [] }, lots: lotOut, boxes, laneCells, unplaced: L.unplaced, plaza: pl, propsPlan, roads, streets: L.streets, ends,
  };
}
