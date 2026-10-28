// (7a SA) Spiral stairs round a form (docs/CONTRACT.md "Phase 7a slice SA" §2): a stair that hugs a rock spire, an ice spike, a giant
// tree's trunk or a giant mushroom's stem from its foot to a railed lookout. Pure plan-time geometry, integer math only (the plan-path
// lint: no trig, no square roots, no random draw): the host's written cells in, the spiral's cells out. The hooks (spiral.mjs) read the
// host from the region and write what this module plans. This module never imports the compiler, the region program or rope.mjs (K1's
// integration lesson: no import cycle).
//
// Reading of §2 (recorded in "SA as built"):
// - The host's cross-section at y, S(y): its core cells at y (a spire's or spike's every cell; a tree's logs; a mushroom's stem), the
//   4-connected piece nearest the axis plus every piece within 3 of it (a spike cluster's near spikes hugged as one); a tree's or
//   mushroom's grows at most 1 a level past the one below (a branch is an obstacle, not a wall to hug).
// - The hug: a tread at level y stands outside U(y), the union of S(y), S(y + 1), S(y + 2) and the top's own cells there (the head room
//   over every tread is clear of the host by construction), in its ring: the cells 8-adjacent to U(y). A rising tread (a stairs block of
//   the tread role facing up the spiral) stands on a side of U (face-adjacent to it); a corner of the ring is taken flat (a top slab of
//   the tread role) at the level of the tread before it, so the turn stays face-adjacent to that tread. The walk goes counter-clockwise
//   (seen from above) round the axis; it steps inward where U shrinks and outward where it grows (a ledge, the lookout's corbel), one
//   cell a step, always within 1 of U (the outer edge within 2 at width 2).
// - Every 8 rising treads a 2-cell flat landing (top slabs). A rising tread with no solid face beside it at its own level (the host, the
//   corbel) gets a support under it (an upside-down stair of the tread role), face-adjacent to the tread below: M3 through the chain.
// - Rails (Noah's look, 2026-10-24): on the open side of the outermost lane, wherever the outside drops more than 3, a fence of the rail
//   role at tread + 1 standing on a bed (a full block of the tread role) at the tread's level; fences joined to their neighbours; a lamp
//   (W's fixture of the light role; its soul variant by ice, M17) on a rail post every floor(12 * level / 15) walk cells.
// - The top: `summit` a deck of the deck role's top slabs over the top cross-section grown by 1, one over the summit; `canopy` a ring deck
//   1 wide round the trunk or stem, 3 under the lowest leaf or cap cell near it; `{y}` a ring deck at y. Round the deck a bed ring (full
//   blocks) carrying the rail, with one gap where the spiral steps on; under the deck a two-level corbel (the tread role's blocks, its
//   outer cells upside-down stairs) so the deck never floats and the spiral steps out round it.
// - The foot: the side cell of the bottom ring facing `from` (its ground cell); from it a straight approach (the path role on the ground)
//   runs outward to the first column the route pass may use (outside the host's bounds or column mask): the leg's end.
// - Never written: a host cell, water, keep-out, builds, other regions, lot boxes and aprons, the claim margin, a body's hard cells.
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor } from '../region/fixtures.mjs';
import { joinedState, splitState } from './climbGeom.mjs';
import { BLOCKS, isCube } from '../blocks.mjs';

/** The limits (catalogue: `connector.stairs_around`). */
export const SPIRAL = Object.freeze({ riseMin: 4, riseMax: 64, landingEvery: 8, landing: 2, railDrop: 3, headroom: 2, outerMax: 2, merge: 3, canopyGap: 3, approachMax: 24, clear: 3, maxSteps: 4096, maxTries: 20000, lookahead: 10, widthMin: 1, widthMax: 2, villagerMinWidth: 2 });
/** The host kinds (R27). */
export const HOST_KINDS = Object.freeze(['rock_spire', 'ice_spike', 'giant_tree', 'giant_mushroom']);
/** The default top per host kind (§2). */
export const TOP_DEFAULT = Object.freeze({ rock_spire: 'summit', ice_spike: 'summit', giant_tree: 'canopy', giant_mushroom: 'canopy' });

const DIR4 = Object.freeze([[1, 0], [0, 1], [-1, 0], [0, -1]]);
const DIR8 = Object.freeze([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);
const CARD = Object.freeze({ '1,0': 'east', '-1,0': 'west', '0,1': 'south', '0,-1': 'north' });
const k2 = (x, z) => `${x},${z}`;
const k3 = (x, y, z) => `${x},${y},${z}`;
const nameOf = (s) => String(s).replace(/\[.*$/, '');
const cardOf = (dx, dz) => CARD[`${Math.sign(dx)},${Math.sign(dz)}`] ?? null;
/** The cardinal of the larger offset (ties: x), for an outward-facing corbel stair. */
const outwardCard = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : dz >= 0 ? 'south' : 'north');

/** Whether a host state is its core (the part a spiral hugs): a spire's or spike's every block, a tree's logs, a mushroom's stem. */
export function coreOf(kind) {
  if (kind === 'giant_tree') return (s) => /_(log|wood|stem|hyphae)$/.test(nameOf(s)) || /^minecraft:stripped_/.test(nameOf(s)) && /_(log|wood)$/.test(nameOf(s));
  if (kind === 'giant_mushroom') return (s) => nameOf(s) === 'minecraft:mushroom_stem';
  return () => true;
}
/** Whether a host state is a crown cell (leaves, a cap, a light in it): the canopy top sits 3 under the lowest near the trunk. */
export const crownOf = (s) => /_leaves$|mushroom_block$|_wart_block$|shroomlight$/.test(nameOf(s));

/** A list of [x, z] into a Set of keys. */
const setOf = (cells) => new Set(cells.map(([x, z]) => k2(x, z)));
/** The cells within Chebyshev `d` of a set (the set included). */
function dilate(set, d) {
  const out = new Set();
  for (const k of set) {
    const [x, z] = k.split(',').map(Number);
    for (let i = -d; i <= d; i++) for (let j = -d; j <= d; j++) out.add(k2(x + i, z + j));
  }
  return out;
}
/** The cells of a set whose Chebyshev `d` neighbourhood lies in it (d 0: the set). */
function erode(set, d) {
  if (d <= 0) return set;
  const out = new Set();
  for (const k of set) {
    const [x, z] = k.split(',').map(Number);
    let all = true;
    for (let i = -d; i <= d && all; i++) for (let j = -d; j <= d && all; j++) if (!set.has(k2(x + i, z + j))) all = false;
    if (all) out.add(k);
  }
  return out;
}
/** The cells whose centres lie in the convex hull of a set's cell centres (integer cross products only; Andrew's monotone chain). */
function hullFill(set) {
  const pts = [...set].map((k) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return set;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of pts) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 3) return set;
  const [x0, z0, x1, z1] = bbox(set), out = new Set(set);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    let inside = true;
    for (let i = 0; i < hull.length && inside; i++) if (cr(hull[i], hull[(i + 1) % hull.length], [x, z]) < 0) inside = false;
    if (inside) out.add(k2(x, z));
  }
  return out;
}
/** The doubled centroid of a set (integers), or null. */
function centroid2(set) {
  let n = 0, sx = 0, sz = 0;
  for (const k of set) { const [x, z] = k.split(',').map(Number); sx += x; sz += z; n++; }
  return n ? [Math.floor((2 * sx) / n), Math.floor((2 * sz) / n)] : null;
}
/** The 4-connected pieces of a set of keys, each a Set. */
function pieces(set) {
  const seen = new Set(), out = [];
  for (const k of [...set].sort()) {
    if (seen.has(k)) continue;
    const piece = new Set([k]);
    seen.add(k);
    const stack = [k];
    while (stack.length) {
      const [x, z] = stack.pop().split(',').map(Number);
      for (const [dx, dz] of DIR4) { const n = k2(x + dx, z + dz); if (set.has(n) && !seen.has(n)) { seen.add(n); piece.add(n); stack.push(n); } }
    }
    out.push(piece);
  }
  return out;
}
const cheb = (a, b) => { const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number); return Math.max(Math.abs(ax - bx), Math.abs(az - bz)); };
const setDist = (A, B) => { let m = Infinity; for (const a of A) for (const b of B) { const d = cheb(a, b); if (d < m) m = d; } return m; };
const bbox = (set) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const k of set) { const [x, z] = k.split(',').map(Number); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; } return [x0, z0, x1, z1]; };

/**
 * The host's cross-sections: `S(y)` (a Set of "x,z"), from the host cells (`host`: Map "x,y,z" -> state), its kind and its axis `at`
 * ([x, y, z], the generator's base centre). Computed bottom up from y0 (a section's piece nearest the centroid of the one below).
 */
export function sections(host, kind, at, y0) {
  const core = coreOf(kind);
  const byY = new Map();
  let yMax = -Infinity;
  for (const [k, s] of host) {
    if (!core(s)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push([x, z]);
    if (y > yMax) yMax = y;
  }
  const S = new Map();
  let prev = null, ref = [2 * at[0], 2 * at[2]];
  const grown = kind === 'giant_tree' || kind === 'giant_mushroom';
  for (let y = y0; y <= yMax; y++) {
    const cells = byY.get(y);
    if (!cells?.length) { S.set(y, new Set()); prev = null; continue; }
    const all = setOf(cells);
    const ps = pieces(all);
    // the piece nearest the reference (the centroid of the section below, else the axis); ties by the piece's first key
    const d2 = (piece) => { let m = Infinity; for (const k of piece) { const [x, z] = k.split(',').map(Number); const dx = 2 * x - ref[0], dz = 2 * z - ref[1], v = dx * dx + dz * dz; if (v < m) m = v; } return m; };
    ps.sort((a, b) => d2(a) - d2(b) || ([...a][0] < [...b][0] ? -1 : 1));
    let sec = new Set(ps[0]);
    // the near pieces join it (within SPIRAL.merge), until none is left that near
    let more = true;
    const rest = ps.slice(1);
    while (more) {
      more = false;
      for (let i = 0; i < rest.length; i++) if (rest[i] && setDist(rest[i], sec) <= SPIRAL.merge) { for (const k of rest[i]) sec.add(k); rest[i] = null; more = true; }
    }
    if (grown && prev?.size) {
      const [x0, z0, x1, z1] = bbox(prev);
      sec = new Set([...sec].filter((k) => { const [x, z] = k.split(',').map(Number); return x >= x0 - 1 && x <= x1 + 1 && z >= z0 - 1 && z <= z1 + 1; }));
    }
    S.set(y, sec);
    if (sec.size) { prev = sec; ref = centroid2(sec); }
  }
  return { S: (y) => S.get(y) ?? new Set(), yMax };
}

/** CCW (seen from above, north up) cross of p and q about the doubled axis a: > 0 when q is counter-clockwise of p. */
const cross = (p, q, a) => { const d1x = 2 * p[0] - a[0], d1z = 2 * p[1] - a[1], d2x = 2 * q[0] - a[0], d2z = 2 * q[1] - a[1]; return d1z * d2x - d1x * d2z; };
const r2 = (p, a) => { const dx = 2 * p[0] - a[0], dz = 2 * p[1] - a[1]; return dx * dx + dz * dz; };
/** The octant (0..7, counter-clockwise from east) of p about the doubled axis a (integer comparisons only). */
function octant(p, a) {
  const dx = 2 * p[0] - a[0], dz = -(2 * p[1] - a[1]); // (dz up: north positive)
  const ax = Math.abs(dx), az = Math.abs(dz);
  if (dx >= 0 && dz >= 0) return ax >= az ? 0 : 1;
  if (dx < 0 && dz >= 0) return az > ax ? 2 : 3;
  if (dx < 0 && dz < 0) return ax >= az ? 4 : 5;
  return az > ax ? 6 : 7;
}

/**
 * The spiral's plan. `host`: Map "x,y,z" -> state (the host form's cells); `o`: {kind, at: [x, y, z] (the host's base centre), from: [x,
 * z] (where the leg comes from), top: 'summit' | 'canopy' | {y}, width (1..2), land: {groundAt(x, z), open(x, y, z), waterAt?(x, z)}, hard(x,
 * z) (a column the route pass keeps off: the host's bounds or column mask), blocked(x, z) (keep-out, protected, builds, other regions,
 * lot boxes and aprons, the claim margin), kept(x, y, z) (a body's hard cell: {body, set, part}) | null, _unsafe {floating, noRails}}.
 * Returns {ok: false, code, message, evidence} or {ok: true, foot, approach, end, walk, outer, supports, beds, rails, lampSpots, top, rise, turns,
 * landings, D, axis}.
 */
export function spiralPlan(host, o) {
  const { kind, at, land, width = 1 } = o;
  const hard = o.hard ?? (() => false), blocked = o.blocked ?? (() => false);
  const fail = (code, message, evidence = {}) => ({ ok: false, code, message, evidence });
  const isHost = (x, y, z) => host.has(k3(x, y, z));
  const hostAt = new Map();
  for (const k of host.keys()) { const [x, y, z] = k.split(',').map(Number); if (!hostAt.has(y)) hostAt.set(y, []); hostAt.get(y).push([x, z]); }
  const g0 = land.groundAt(at[0], at[2]);
  const { S, yMax } = sections(host, kind, at, g0 - 1);
  // ---- the top level D and its cross-section
  const top = o.top ?? TOP_DEFAULT[kind];
  let D, St, topKind;
  let ys = g0;
  for (let y = g0 + 1; y <= yMax && S(y).size; y++) ys = y;
  if (top === 'summit') {
    topKind = 'summit';
    if (ys <= g0) return fail('SPAN', 'the host has no cross-section over its foot', { rise: 0, min: SPIRAL.riseMin, max: SPIRAL.riseMax });
    D = ys + 1;
    St = S(ys);
  } else if (top === 'canopy') {
    topKind = 'canopy';
    // the lowest crown cell over the trunk's near columns (within 4 of any section from the foot up)
    const near = new Set();
    for (let y = g0 + 1; y <= ys; y++) for (const k of dilate(S(y), 4)) near.add(k);
    let yc = Infinity;
    for (const [k, s] of host) {
      if (!crownOf(s)) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (y > g0 + 2 && y < yc && near.has(k2(x, z))) yc = y;
    }
    if (!Number.isFinite(yc)) return fail('SPAN', 'the host has no leaves or cap over its trunk (no canopy to stop under: top summit or {y})', { why: 'top', top: 'canopy' });
    D = yc - SPIRAL.canopyGap;
  } else if (top && Number.isInteger(top.y)) {
    topKind = 'ring';
    D = top.y;
  } else return fail('SPAN', 'top must be summit, canopy or {y}', { top });
  if (D - g0 < SPIRAL.riseMin || D - g0 > SPIRAL.riseMax) return fail('SPAN', `the rise ${D - g0} from the foot to the top is outside ${SPIRAL.riseMin}..${SPIRAL.riseMax}`, { rise: D - g0, min: SPIRAL.riseMin, max: SPIRAL.riseMax, top: D, foot: g0 });
  // ---- the top's cells at a level (deck, bed ring, corbel); a canopy's ring deck steps down past a branch over it (at most 6)
  const topAtLevel = (D) => {
    const St = topKind === 'summit' ? S(D - 1) : S(D);
    if (!St.size) return { St, bad: [{ why: 'no section', y: D }], noSection: true };
    const D1 = dilate(St, 1), D2 = dilate(St, 2);
    const deck = [...D1].filter((k) => { const [x, z] = k.split(',').map(Number); return topKind === 'summit' ? !isHost(x, D, z) : !St.has(k) && !isHost(x, D, z); });
    const bedRing = [...D2].filter((k) => !D1.has(k));
    const topAt = new Map(); // y -> Set of "x,z"
    const addTop = (y, k) => { if (!topAt.has(y)) topAt.set(y, new Set()); topAt.get(y).add(k); };
    for (const k of deck) addTop(D, k);
    for (const k of bedRing) { addTop(D, k); addTop(D + 1, k); }
    const corbel = []; // [x, y, z, outer]
    for (const [y, ring, inner] of [[D - 1, D2, D1], [D - 2, D1, St]]) {
      for (const k of ring) {
        const [x, z] = k.split(',').map(Number);
        if (isHost(x, y, z)) continue;
        corbel.push([x, y, z, !inner.has(k)]);
        addTop(y, k);
      }
    }
    // the deck's head room: 2 clear of the host and the land over every deck cell; the rails clear of the host; the corbel in the open
    const bad = [];
    for (const k of deck) { const [x, z] = k.split(',').map(Number); for (const y of [D + 1, D + 2]) if (isHost(x, y, z) || !land.open(x, y, z)) bad.push({ at: [x, y, z], why: isHost(x, y, z) ? 'host' : 'land' }); }
    for (const k of bedRing) { const [x, z] = k.split(',').map(Number); for (const y of [D, D + 1, D + 2]) if (isHost(x, y, z) || !land.open(x, y, z)) bad.push({ at: [x, y, z], why: isHost(x, y, z) ? 'host' : 'land', what: 'rail' }); }
    for (const [x, y, z] of corbel) if (!land.open(x, y, z)) bad.push({ at: [x, y, z], why: 'land', what: 'corbel' });
    return { St, deck, bedRing, topAt, corbel, bad };
  };
  let T = topAtLevel(D);
  const D0 = D;
  if (topKind === 'canopy') for (let t = 1; t <= 6 && T.bad.length; t++) { const T2 = topAtLevel(D0 - t); if (!T2.bad.length) { T = T2; D = D0 - t; } }
  if (T.noSection) return fail('SPAN', `no cross-section of the host at the top's level ${D} (a ring deck needs the trunk or stem there)`, { why: 'top', y: D });
  if (T.bad.length) return fail('HEADROOM', `the ${topKind === 'summit' ? 'summit deck' : 'ring deck'} at ${D} has ${T.bad.length} cell(s) of the host or the land in it or less than 2 over it`, { why: 'top', y: D, cells: T.bad.slice(0, 12), count: T.bad.length });
  St = T.St;
  const { deck, bedRing, topAt, corbel } = T;
  const rise0 = D - g0;
  if (rise0 < SPIRAL.riseMin || rise0 > SPIRAL.riseMax) return fail('SPAN', `the rise ${rise0} from the foot to the top is outside ${SPIRAL.riseMin}..${SPIRAL.riseMax}`, { rise: rise0, min: SPIRAL.riseMin, max: SPIRAL.riseMax, top: D, foot: g0 });
  const lowered = D0 - D;

  // ---- the hug: U(y) = S(y), S(y+1), S(y+2) and the top's cells at those levels
  const Umemo = new Map();
  const U = (y) => {
    if (Umemo.has(y)) return Umemo.get(y);
    const u = new Set();
    for (let t = 0; t <= 2; t++) { for (const k of S(y + t)) u.add(k); for (const k of topAt.get(y + t) ?? []) u.add(k); }
    // any other host cell (a ledge's underside, a branch, a root, a near spike) within 3 of the hug at these levels joins it (and what is
    // within 3 of that): the walk goes round it instead of under it (none over the top: the walk never climbs past it, and the top's own
    // head room is checked with the top)
    let near = dilate(u, 3);
    for (let grew = true, n = 0; grew && n < 8; n++) {
      grew = false;
      for (let t = 0; t <= 2 && y + t <= D; t++) for (const [x, z] of hostAt.get(y + t) ?? []) if (near.has(k2(x, z)) && !u.has(k2(x, z))) { u.add(k2(x, z)); grew = true; }
      if (grew) near = dilate(u, 3);
    }
    // a wide overhang further up (a ledge, a cap) moves the ring out one cell a level before it: its footprint t levels up, eroded by
    // t - 2, joins (the walk steps outward at most 1 a step and must stand clear of it 2 levels under it)
    for (let t = 3; t <= SPIRAL.lookahead && y + t <= D; t++) {
      const fp = new Set();
      for (const [x, z] of hostAt.get(y + t) ?? []) if (near.has(k2(x, z)) || u.has(k2(x, z))) fp.add(k2(x, z));
      for (const k of topAt.get(y + t) ?? []) fp.add(k);
      if (!fp.size) continue;
      for (const k of erode(fp, t - 2)) u.add(k);
    }
    // its convex hull (a cluster's spikes, a root beside the trunk, a ledge's notch: no pocket the ring could walk into), then notches
    // filled (a cell between two of its cells, or with three sides in it, joins it)
    for (const k of hullFill(u)) u.add(k);
    for (let more = true, n = 0; more && n < 16; n++) {
      more = false;
      for (const k of dilate(u, 1)) {
        if (u.has(k)) continue;
        const [x, z] = k.split(',').map(Number);
        const e = u.has(k2(x + 1, z)), w = u.has(k2(x - 1, z)), sN = u.has(k2(x, z - 1)), sS = u.has(k2(x, z + 1));
        if ((e && w) || (sN && sS) || e + w + sN + sS >= 3) { u.add(k); more = true; }
      }
    }
    Umemo.set(y, u);
    return u;
  };
  const topCell = (x, y, z) => topAt.get(y)?.has(k2(x, z)) ?? false;
  // a cell a walker may stand in: it and the 2 over it free of the host, the top and the land
  const free = (x, y, z) => { for (let t = 0; t <= SPIRAL.headroom; t++) if (isHost(x, y + t, z) || topCell(x, y + t, z) || !land.open(x, y + t, z)) return false; return true; };
  // (a cell a rising tread follows is clear 3 over it: a walker stepping down onto it from that tread carries its head through the
  // third: vanilla's fall check, and the kit's mover's)
  const clear3 = (x, y, z) => !isHost(x, y + SPIRAL.clear, z) && !topCell(x, y + SPIRAL.clear, z) && land.open(x, y + SPIRAL.clear, z);
  const side = (u, x, z) => DIR4.some(([dx, dz]) => u.has(k2(x + dx, z + dz)));
  const ring = (u, x, z) => DIR8.some(([dx, dz]) => u.has(k2(x + dx, z + dz)));

  // ---- the foot: the side cell of the bottom ring facing `from`; its approach outward to the first column the route may use
  const yb = g0 + 1, Ub = U(yb), ab = centroid2(Ub) ?? [2 * at[0], 2 * at[2]];
  const F = o.from ?? [at[0], at[2] + 64];
  const cands = [];
  for (const k of dilate(Ub, 1)) {
    if (Ub.has(k)) continue;
    const [x, z] = k.split(',').map(Number);
    if (!side(Ub, x, z)) continue;
    const g = land.groundAt(x, z);
    if (Math.abs(g - g0) > 1 || !free(x, g + 1, z) || isHost(x, g, z)) continue;
    const dot = (2 * x - ab[0]) * (2 * F[0] - ab[0]) + (2 * z - ab[1]) * (2 * F[1] - ab[1]);
    cands.push({ x, z, g, dot, dF: Math.abs(x - F[0]) + Math.abs(z - F[1]) });
  }
  cands.sort((a, b) => b.dot - a.dot || a.dF - b.dF || a.x - b.x || a.z - b.z);
  let foot = null, approach = null, end = null, why = null;
  for (const c of cands) {
    // the outward normal: the cardinal step from the section beside it, the one most toward `from`
    const ns = DIR4.filter(([dx, dz]) => Ub.has(k2(c.x - dx, c.z - dz))).sort((a, b) => ((b[0] * (F[0] - c.x) + b[1] * (F[1] - c.z)) - (a[0] * (F[0] - c.x) + a[1] * (F[1] - c.z))));
    for (const [nx, nz] of ns) {
      const cells = [[c.x, c.g, c.z]];
      let ok = true, e = null;
      for (let t = 1; t <= SPIRAL.approachMax; t++) {
        const x = c.x + nx * t, z = c.z + nz * t, g = land.groundAt(x, z), last = cells[cells.length - 1];
        // (the approach is written on the ground: never on a host cell there, a root at the surface)
        if (Math.abs(g - last[1]) > 1 || blocked(x, z) || land.waterAt?.(x, z) || !free(x, g + 1, z) || isHost(x, g, z)) { ok = false; why = { at: [x, g, z], why: blocked(x, z) ? 'protected' : land.waterAt?.(x, z) ? 'water' : Math.abs(g - last[1]) > 1 ? 'step' : isHost(x, g, z) ? 'host' : 'headroom' }; break; }
        if (!hard(x, z)) { e = [x, g, z]; break; }
        cells.push([x, g, z]);
      }
      if (!ok || !e) { if (ok) why = { why: 'approach', max: SPIRAL.approachMax }; continue; }
      foot = { x: c.x, z: c.z, g: c.g, normal: [nx, nz] };
      approach = cells;
      end = e;
      break;
    }
    if (foot) break;
  }
  if (!foot) return fail('UNREACHABLE', 'no foot on the host\'s bottom ring with a clear straight approach to a column the route may use', { why: why ?? { why: 'no side cell' }, candidates: cands.length });

  // ---- the walk
  const walk = []; // {x, y, z, kind: 'tread' | 'flat' | 'ground', facing, support}
  const used = new Set();
  // the levels each column is walked at (the approach's too): a column is walked again only 5 or more over or under (the head room of
  // the one under, and a support under a tread, stay clear)
  const colY = new Map();
  const markCol = (x, y, z) => { const k = k2(x, z); if (!colY.has(k)) colY.set(k, []); colY.get(k).push(y); };
  const spaced = (x, y, z) => (colY.get(k2(x, z)) ?? []).every((v) => Math.abs(v - y) >= 5);
  for (const [x, g, z] of approach) markCol(x, g, z);
  let p = [foot.x, foot.z], y = foot.g, rising = 0, flats = 0, entry = null;
  const pick = (yt, list) => {
    const u = U(yt), a = centroid2(u) ?? ab;
    const out = [];
    for (const [dx, dz] of DIR4) {
      const q = [p[0] + dx, p[1] + dz];
      if (u.has(k2(q[0], q[1])) || used.has(k3(q[0], yt, q[1])) || !spaced(q[0], yt, q[1])) continue;
      // (on the foot's level a flat step walks the ground: the ground cell itself, the 2 over it free)
      const flat = list === 'flat' || list === 'flatWide';
      const onGround = flat && yt === foot.g && land.groundAt(q[0], q[1]) === yt;
      if (onGround ? !free(q[0], yt + 1, q[1]) || isHost(q[0], yt, q[1]) : !free(q[0], yt, q[1])) continue;
      // the hug: a rising tread on a side of U, a flat one in its ring; the wide modes (a detour round an obstacle) within 2 of U
      if (list === 'rise' ? !side(u, q[0], q[1]) : list === 'flat' ? !ring(u, q[0], q[1]) : !ring(dilate(u, 1), q[0], q[1])) continue;
      if (yt > y && !clear3(p[0], y, p[1])) continue;
      const c = cross(p, q, a), rp = r2(p, a), rq = r2(q, a);
      // (inward and outward only straight toward or away from the axis: the cardinal of the larger offset)
      const ox = a[0] - 2 * p[0], oz = a[1] - 2 * p[1], rad = Math.abs(ox) >= Math.abs(oz) ? [Math.sign(ox), 0] : [0, Math.sign(oz)];
      const inward = dx === rad[0] && dz === rad[1], outward = dx === -rad[0] && dz === -rad[1];
      const rank = c > 0 ? 0 : inward && rq < rp ? 1 : outward && rq > rp ? 2 : -1;
      if (rank < 0) continue;
      out.push({ q, rank, rq });
    }
    out.sort((m, n) => m.rank - n.rank || m.rq - n.rq || m.q[0] - n.q[0] || m.q[1] - n.q[1]);
    return out.map((c) => c.q);
  };
  const entryOf = (q) => {
    for (const [dx, dz] of DIR4) {
      const b = k2(q[0] + dx, q[1] + dz);
      if (!bedRing.includes(b)) continue;
      const [bx, bz] = b.split(',').map(Number);
      if (DIR4.some(([ex, ez]) => deck.includes(k2(bx + ex, bz + ez)))) return [bx, bz];
    }
    return null;
  };
  // every next step in order of preference: a rising tread on the hug, a flat one (a corner, a landing), a rising one in place of a
  // landing, then the detours (an obstacle walked round within 2 of the hug)
  const options = () => {
    const out = [], seen = new Set();
    const add = (qs, yt, flatOff) => { for (const q of qs) { const k = k3(q[0], yt, q[1]); if (!seen.has(k)) { seen.add(k); out.push({ q, yt, flatOff }); } } };
    if (flats === 0 && y < D) add(pick(y + 1, 'rise'), y + 1, false);
    add(pick(y, 'flat'), y, false);
    if (flats > 0 && y < D) add(pick(y + 1, 'rise'), y + 1, true);
    if (y < D) add(pick(y + 1, 'riseWide'), y + 1, false);
    add(pick(y, 'flatWide'), y, false);
    return out;
  };
  const apply = (c) => {
    const { q, yt } = c;
    const facing = cardOf(q[0] - p[0], q[1] - p[1]);
    if (c.flatOff) flats = 0;
    if (yt > y) {
      // a rising tread: a support under it unless a solid face is beside it at its own level (the host or the top's corbel)
      const faced = DIR4.some(([dx, dz]) => isHost(q[0] + dx, yt, q[1] + dz) || topCell(q[0] + dx, yt, q[1] + dz));
      walk.push({ x: q[0], y: yt, z: q[1], kind: 'tread', facing, support: !faced });
      rising++;
      if (rising >= SPIRAL.landingEvery) { rising = 0; flats = SPIRAL.landing; }
    } else {
      const ground = yt === foot.g && land.groundAt(q[0], q[1]) === yt;
      walk.push({ x: q[0], y: yt, z: q[1], kind: ground ? 'ground' : 'flat', facing, support: false, landing: flats > 0 && !ground });
      if (flats > 0) flats--;
    }
    used.add(k3(q[0], yt, q[1]));
    markCol(q[0], yt, q[1]);
    p = q; y = yt;
  };
  // a depth-first walk that backs up out of a dead end (a pocket between a cluster's spikes, under a ledge), within a budget
  const stack = [];
  let tries = 0, deepest = null;
  for (;;) {
    if (y === D && walk.length) { entry = entryOf(p); if (entry) break; }
    if (walk.length > SPIRAL.maxSteps) break;
    stack.push({ opts: options(), i: 0, saved: { p, y, rising, flats } });
    let moved = false;
    while (stack.length && !moved) {
      const f = stack[stack.length - 1];
      if (f.i < f.opts.length && tries < SPIRAL.maxTries) { ({ p, y, rising, flats } = f.saved); apply(f.opts[f.i++]); tries++; moved = true; break; }
      // exhausted: record the deepest dead end, back up one step
      if (!deepest || y > deepest.y) deepest = { p: [...p], y, walk: walk.map((w) => ({ ...w })) };
      stack.pop();
      if (!stack.length) break;
      const w = walk.pop();
      used.delete(k3(w.x, w.y, w.z));
      const cy = colY.get(k2(w.x, w.z)); cy.splice(cy.lastIndexOf(w.y), 1);
      ({ p, y, rising, flats } = stack[stack.length - 1].saved);
    }
    if (!moved) {
      const at = deepest ?? { p, y, walk };
      // stuck: name what stands in the way (the host, the top or the land in the ring's cells and their head room)
      const cells = [];
      for (const [dx, dz] of DIR4) for (const t of [0, 1, 2, 3]) { const x = at.p[0] + dx, yy = at.y + t, z = at.p[1] + dz; if (isHost(x, yy, z) || !land.open(x, yy, z)) cells.push({ at: [x, yy, z], why: isHost(x, yy, z) ? 'host' : 'land' }); }
      return Object.assign(fail('HEADROOM', `the spiral cannot go on from ${at.p[0]} ${at.y} ${at.p[1]}: the host or the land stands in its ring or less than 2 over it`, { at: [at.p[0], at.y, at.p[1]], y: at.y, cells: cells.slice(0, 12), count: cells.length, tries }), { walk: at.walk });
    }
  }
  if (!entry) return fail('HEADROOM', `the spiral did not reach the top's deck within ${SPIRAL.maxSteps} steps`, { at: [p[0], y, p[1]], y, top: D });

  // ---- the lanes: the walk is lane 1; at width 2 the cells just outside it (lane 2), each a copy of its lane 1 cell
  const lanes = walk.map((w, i) => ({ ...w, lane: 1, i }));
  const walkAt = new Set(lanes.map((w) => k3(w.x, w.y, w.z)));
  if (width >= 2) {
    for (const w of walk.map((q, i) => ({ ...q, i }))) {
      const u = U(w.y), add = [];
      for (const [dx, dz] of DIR4) {
        const x = w.x + dx, z = w.z + dz;
        if (u.has(k2(x, z)) || ring(u, x, z)) continue;
        add.push([x, z]);
      }
      if (add.length === 2 && add[0][0] !== add[1][0] && add[0][1] !== add[1][1]) add.push([add[0][0] + add[1][0] - w.x, add[0][1] + add[1][1] - w.z]);
      for (const [x, z] of add) {
        // (a column another lane cell holds within 3 levels keeps it: the corner's fan and the next tread's outer cell share a column)
        if (walkAt.has(k3(x, w.y, z)) || !free(x, w.y, z) || !spaced(x, w.y, z)) continue;
        walkAt.add(k3(x, w.y, z));
        markCol(x, w.y, z);
        lanes.push({ ...w, x, z, lane: 2, support: w.kind === 'tread' && w.support });
      }
    }
  }
  const outerLane = width >= 2 ? 2 : 1;

  // ---- rails: beds and posts outside the outermost lane where the outside drops more than 3; a lamp post every L walk cells
  const occupied = (x, y, z) => walkAt.has(k3(x, y, z));
  const beds = [], rails = [], lampSpots = [];
  const railAt = new Set();
  const outsideOf = (w) => {
    const u = U(w.y), a = centroid2(u) ?? ab, out = [];
    for (const [dx, dz] of DIR4) {
      const x = w.x + dx, z = w.z + dz;
      if (u.has(k2(x, z)) || occupied(x, w.y, z) || r2([x, z], a) <= r2([w.x, w.z], a)) continue;
      out.push([x, z]);
    }
    if (out.length === 2 && out[0][0] !== out[1][0] && out[0][1] !== out[1][1]) { const c = [out[0][0] + out[1][0] - w.x, out[0][1] + out[1][1] - w.z]; if (!occupied(c[0], w.y, c[1])) out.push(c); }
    return out;
  };
  // (an open side: any side of a walk cell, not a walk cell a level under, at or over it, not the host, over a drop of more than 3 to the
  // host, the land or the spiral; the outermost lane's corner fans its diagonal too)
  // (the fall from the walk's feet, y + 1, into that column: to the first solid at or under y)
  const below = (x, y, z) => { for (let d = 0; d <= SPIRAL.railDrop + 1; d++) { const yy = y - d; if (isHost(x, yy, z) || !land.open(x, yy, z) || walkAt.has(k3(x, yy, z)) || topCell(x, yy, z)) return d; } return 99; };
  const nearWalk = (x, y, z) => walkAt.has(k3(x, y - 1, z)) || walkAt.has(k3(x, y, z)) || walkAt.has(k3(x, y + 1, z));
  for (const w of lanes) {
    const sides = DIR4.map(([dx, dz]) => [w.x + dx, w.z + dz]);
    if (w.lane === outerLane) for (const c of outsideOf(w)) if (!sides.some((q) => q[0] === c[0] && q[1] === c[1])) sides.push(c);
    for (const [x, z] of sides) {
      if (o._unsafe?.noRails || o._unsafe?.floating || nearWalk(x, w.y, z) || isHost(x, w.y, z) || isHost(x, w.y + 1, z) || topCell(x, w.y, z) || topCell(x, w.y + 1, z)) continue;
      if (below(x, w.y, z) <= SPIRAL.railDrop) continue;
      const k = k3(x, w.y, z);
      if (railAt.has(k)) continue;
      railAt.add(k);
      beds.push([x, w.y, z, w.i]);
      rails.push([x, w.y + 1, z, w.i]);
    }
  }
  // the lamp posts (the light's spacing is the caller's: `o.lampEvery`), on a rail of that walk cell, else a post of its own
  const every = Math.max(4, o.lampEvery ?? 12);
  if (o.lamps !== false) {
    for (let i = Math.floor(every / 2); i < walk.length; i += every) {
      const w = lanes.find((q) => q.i === i && q.lane === outerLane) ?? lanes[i];
      const outs = outsideOf(w);
      const r = rails.find((q) => q[3] === i && outs.some(([x, z]) => x === q[0] && z === q[2]));
      if (r) { lampSpots.push([r[0], r[1] + 1, r[2], i]); continue; }
      const c = outs[0];
      if (!c) continue;
      beds.push([c[0], w.y, c[1], i]);
      rails.push([c[0], w.y + 1, c[1], i]);
      railAt.add(k3(c[0], w.y, c[1]));
      lampSpots.push([c[0], w.y + 2, c[1], i]);
    }
  }

  // ---- the top's rails (the bed ring but the entry), lamps at two opposite corners of the ring
  const entryK = k2(entry[0], entry[1]);
  const topBeds = bedRing.filter((k) => k !== entryK).map((k) => { const [x, z] = k.split(',').map(Number); return [x, D, z]; });
  const topRails = topBeds.map(([x, , z]) => [x, D + 1, z]);
  // (two lamps on the deck's rail posts: the rail cells farthest apart along x + z, so no lantern stands off the rail)
  const byDiag = [...topBeds].sort((a, b) => a[0] + a[2] - (b[0] + b[2]) || a[0] - b[0]);
  const topLamps = o.lamps === false || !byDiag.length ? [] : [byDiag[0], byDiag[byDiag.length - 1]].filter((q, i, arr) => i === 0 || q !== arr[0]).map(([x, , z]) => [x, D + 2, z]);
  const deckCells = [...deck, entryK].map((k) => { const [x, z] = k.split(',').map(Number); return [x, D, z]; });

  // ---- the approach's lamp posts: a rail post on the ground beside every `every` approach cells from its middle (its lamp on top)
  const approachPosts = [];
  if (o.lamps !== false && approach.length >= 3) {
    const [nx, nz] = foot.normal;
    for (let i = Math.floor(approach.length / 2); i < approach.length; i += every) {
      const [ax, ag, az] = approach[i];
      for (const s0 of [1, -1]) {
        const x = ax - nz * s0, z = az + nx * s0, g = land.groundAt(x, z);
        if (g !== ag || !free(x, g + 1, z) || blocked(x, z) || approach.some((q) => q[0] === x && q[2] === z)) continue;
        approachPosts.push([x, g + 1, z]);
        break;
      }
    }
  }
  // ---- head room and collisions over everything the spiral writes
  const solids = new Map(); // "x,y,z" -> what
  for (const w of lanes) solids.set(k3(w.x, w.y, w.z), 'walk');
  for (const [x, yy, z] of deckCells) solids.set(k3(x, yy, z), 'deck');
  for (const [x, yy, z] of topBeds) solids.set(k3(x, yy, z), 'bed');
  for (const [x, yy, z] of topRails) solids.set(k3(x, yy, z), 'rail');
  for (const [x, yy, z] of topLamps) solids.set(k3(x, yy, z), 'lamp');
  for (const [x, yy, z] of corbel) solids.set(k3(x, yy, z), 'corbel');
  for (const [x, g, z] of approach) solids.set(k3(x, g, z), 'approach');
  for (const [x, y, z] of approachPosts) { solids.set(k3(x, y, z), 'rail'); solids.set(k3(x, y + 1, z), 'lamp'); }
  const supports = [];
  if (!o._unsafe?.floating) for (const w of lanes) {
    if (!w.support) continue;
    const k = k3(w.x, w.y - 1, w.z);
    if (solids.has(k) || isHost(w.x, w.y - 1, w.z) || !land.open(w.x, w.y - 1, w.z)) continue;
    solids.set(k, 'support');
    supports.push([w.x, w.y - 1, w.z, w.facing]);
  }
  // the head room cells of every walk cell (lanes, deck, approach): the rails, beds and lamps that would stand in one are dropped
  const head = new Set();
  for (const w of lanes) for (let t = 1; t <= SPIRAL.headroom; t++) head.add(k3(w.x, w.y + t, w.z));
  // (the third over a cell a rising tread follows, the foot's too)
  const lane1 = lanes.filter((w) => w.lane === 1);
  if (lane1[0]?.kind === 'tread') head.add(k3(foot.x, foot.g + SPIRAL.clear, foot.z));
  for (let i = 0; i + 1 < lane1.length; i++) if (lane1[i + 1].kind === 'tread') { const w = lane1[i]; head.add(k3(w.x, w.y + SPIRAL.clear, w.z)); for (const v of lanes) if (v.lane === 2 && v.i === w.i) head.add(k3(v.x, v.y + SPIRAL.clear, v.z)); }
  for (const [x, yy, z] of deckCells) for (let t = 1; t <= SPIRAL.headroom; t++) head.add(k3(x, yy + t, z));
  for (const [x, g, z] of approach) for (let t = 1; t <= SPIRAL.headroom; t++) head.add(k3(x, g + t, z));
  const keepB = [], keepR = [], keepL = [];
  let skipped = 0;
  // a bed and its rail where neither stands in a walk cell's head room or another cell; then no bed floats (a corner's diagonal bed
  // stays only while a bed or a walk cell beside it does: Noah's look, no floating posts); a bed a floating one's rail had blocked is
  // tried again
  const kept = new Set(), dropped = new Set();
  const keepPass = () => {
    let added = false;
    for (let i = 0; i < beds.length; i++) {
      if (kept.has(i) || dropped.has(i)) continue;
      const [x, yy, z] = beds[i];
      const kb = k3(x, yy, z), kr = k3(x, yy + 1, z);
      if (solids.has(kb) || solids.has(kr) || head.has(kb) || head.has(kr) || isHost(x, yy, z) || isHost(x, yy + 1, z) || !land.open(x, yy + 1, z)) continue;
      solids.set(kb, 'bed'); solids.set(kr, 'rail');
      kept.add(i); added = true;
    }
    return added;
  };
  const floatPass = () => {
    let removed = false;
    for (let more = true; more;) {
      more = false;
      const bedAt = new Set([...kept].map((i) => k3(beds[i][0], beds[i][1], beds[i][2])));
      for (const i of [...kept]) {
        const [x, yy, z] = beds[i];
        const held = !land.open(x, yy - 1, z) || isHost(x, yy - 1, z) || solids.has(k3(x, yy - 1, z)) || DIR4.some(([dx, dz]) => { const k = k3(x + dx, yy, z + dz); return walkAt.has(k) || bedAt.has(k) || isHost(x + dx, yy, z + dz) || topCell(x + dx, yy, z + dz); });
        if (held) continue;
        solids.delete(k3(x, yy, z)); solids.delete(k3(x, yy + 1, z));
        kept.delete(i); dropped.add(i); more = true; removed = true;
      }
    }
    return removed;
  };
  for (let round = 0; round < 16; round++) { keepPass(); if (!floatPass()) break; }
  for (const i of [...kept].sort((u, v) => u - v)) { keepB.push(beds[i]); keepR.push(rails[i]); }
  skipped = beds.length - keepB.length;
  for (const l of lampSpots) {
    const k = k3(l[0], l[1], l[2]);
    if (!keepR.some((r) => r[0] === l[0] && r[2] === l[2] && r[1] === l[1] - 1) || solids.has(k) || head.has(k) || isHost(l[0], l[1], l[2])) continue;
    solids.set(k, 'lamp');
    keepL.push(l);
  }
  const low = [];
  for (const k of head) { const [x, yy, z] = k.split(',').map(Number); if (solids.has(k) || isHost(x, yy, z) || !land.open(x, yy, z)) low.push({ at: [x, yy, z], why: solids.has(k) ? solids.get(k) : isHost(x, yy, z) ? 'host' : 'land' }); }
  if (low.length) return fail('HEADROOM', `${low.length} cell(s) over the spiral's walk stand less than 2 clear (the host, the land or the spiral itself)`, { cells: low.slice(0, 12), count: low.length });
  // never written: the host (checked here over every cell the spiral writes), water, keep-out and the like, a body's hard cells
  const onHost = [...solids.keys()].filter((k) => host.has(k));
  if (onHost.length) return fail('HEADROOM', `${onHost.length} cell(s) the spiral would write are the host's (a spiral never cuts its host)`, { why: 'host', cells: onHost.slice(0, 12).map((k) => ({ at: k.split(',').map(Number), why: 'host' })), count: onHost.length });
  const cols = new Set([...solids.keys()].map((k) => { const [x, , z] = k.split(',').map(Number); return k2(x, z); }));
  const prot = [...cols].filter((k) => { const [x, z] = k.split(',').map(Number); return blocked(x, z); });
  if (prot.length) return fail('PROTECTED', `${prot.length} column(s) the spiral writes are keep-out, protected, a build, another region, a lot box or apron, or the claim margin`, { columns: prot.slice(0, 12).map((k) => k.split(',').map(Number)), count: prot.length });
  if (o.kept) {
    const hit = [];
    for (const k of solids.keys()) { const [x, yy, z] = k.split(',').map(Number); const b = o.kept(x, yy, z); if (b && solids.get(k) !== 'lamp') hit.push({ at: [x, yy, z], body: b.body ?? null, part: b.part ?? null, what: solids.get(k) }); }
    if (hit.length) return fail('OVERLAP', `${hit.length} cell(s) of the spiral would land in a plan body's hard cells (KC)`, { kind: 'body', cells: hit.slice(0, 12), count: hit.length });
  }

  // ---- the record's numbers: rise, turns (octants walked round the base axis, counter-clockwise), landings
  let oct = 0, last = octant([foot.x, foot.z], ab);
  for (const w of walk) { const c = octant([w.x, w.z], ab); let d = (c - last + 8) % 8; if (d > 4) d -= 8; oct += d; last = c; }
  const turns = Math.round((oct * 100) / 8) / 100;
  return {
    ok: true, D, topKind, foot: [foot.x, foot.g, foot.z], normal: foot.normal, approach, end, entry: [entry[0], D, entry[1]],
    walk: lanes, supports, beds: keepB, rails: keepR, lampSpots: keepL, railsSkipped: skipped,
    approachPosts,
    top: { y: D, kind: topKind, deck: deckCells, beds: topBeds, rails: topRails, lamps: topLamps, corbel, node: deckCells.find(([x, , z]) => St.has(k2(x, z))) ?? deckCells[0] },
    rise: D - foot.g, turns, lowered, landings: walk.filter((w) => w.landing).length / SPIRAL.landing, treads: walk.filter((w) => w.kind === 'tread').length,
    axis: [ab[0] / 2, ab[1] / 2], width,
  };
}

/** The spiral's blocks from the plan's roles (the bible's `connectors.stairs_around` resolved: `slots`), each with its fallback. */
export function spiralRoles(roles, slots = {}, { cold = false } = {}) {
  const base = (b) => (b ? String(b).replace(/\[.*$/, '') : null);
  const firstShaped = (names, shape) => { for (const n of names) { const b = n && roles?.[n]; const v = b ? (shape === 'self' ? base(b) : shapeOf(base(b), shape)) : null; if (v) return { role: n, block: v }; } return null; };
  const cube = (names) => { for (const n of names) { const b = base(n && roles?.[n]); if (b && isCube({ name: b })) return { role: n, block: b }; } return null; };
  // the tread role: the slot's, else structure, path, floor, foundation: the first with stairs (N-SA-1, themed)
  const chain = [slots.tread, 'structure', 'path', 'floor', 'foundation', 'trim', 'wall'].filter(Boolean);
  const stairs = firstShaped(chain, 'stairs');
  const treadRole = stairs?.role ?? null;
  const slab = firstShaped([treadRole, ...chain].filter(Boolean), 'slab');
  const treadCube = cube([treadRole, ...chain].filter(Boolean));
  // the deck: the slot's, else floor, path: the first with a slab; its beds a cube of the same chain
  const dchain = [slots.deck, 'floor', 'path', ...chain].filter(Boolean);
  const deckSlab = firstShaped(dchain, 'slab');
  const deckCube = cube([deckSlab?.role, ...dchain].filter(Boolean));
  // the rail: the slot's, else rail, frame: a fence, else a wall
  const rchain = [slots.rail, 'rail', 'frame', 'trim', 'structure'].filter(Boolean);
  const rail = firstShaped(rchain, 'fence') ?? firstShaped(rchain, 'wall');
  const fx = fixtureFor(roles?.light ?? null, rail?.block ?? null);
  let light = fx.kind === 'hanging_lantern' ? fx.light.replace('hanging=true', 'hanging=false') : fx.light, level = fx.level;
  // (M17) by ice, a lantern or a torch is its soul variant (light 10): the light role's fixture, cold
  if (cold && level > 10) {
    const s = splitState(light);
    if (s.name === 'minecraft:lantern') { light = light.replace('minecraft:lantern', 'minecraft:soul_lantern'); level = 10; }
    else if (s.name === 'minecraft:torch') { light = light.replace('minecraft:torch', 'minecraft:soul_torch'); level = 10; }
    else light = null;
  }
  return { stairs: stairs?.block ?? null, slab: slab?.block ?? null, cube: treadCube?.block ?? null, deckSlab: deckSlab?.block ?? null, deckCube: deckCube?.block ?? null, rail: rail?.block ?? null, light, level, treadRole, cold };
}

const stairState = (b, facing, half = 'bottom') => `${b}[facing=${facing},half=${half},shape=straight,waterlogged=false]`;
const slabState = (b, type = 'top') => `${b}[type=${type},waterlogged=false]`;

/**
 * The cells of a passing plan `s` (spiralPlan) in the blocks `R` (spiralRoles), as `[[x, y, z, state, what]]` with the fences and walls
 * joined to their neighbours (Noah's look): what is approach, tread, flat, support, bed, rail, lamp, deck, corbel. `path` is the approach's
 * block (the path role, else the tread cube). `solidAt(x, y, z)` tells the joining what stands beside a fence that the spiral did not
 * write (the host, the land).
 */
export function spiralCells(s, R, { path = null, solidAt = () => false } = {}) {
  const out = [];
  const put = (x, y, z, st, what) => { if (st) out.push([x, y, z, st, what]); };
  for (const [x, g, z] of s.approach) put(x, g, z, path ?? R.cube, 'approach');
  for (const [x, y, z, f] of s.supports) put(x, y, z, R.stairs ? stairState(R.stairs, f, 'top') : R.cube, 'support');
  for (const w of s.walk) put(w.x, w.y, w.z, w.kind === 'tread' ? (R.stairs ? stairState(R.stairs, w.facing) : R.cube) : R.slab ? slabState(R.slab) : R.cube, w.kind);
  for (const [x, y, z, outer] of s.top.corbel) {
    if (outer && R.stairs) {
      const dx = x - Math.round(s.axis[0]), dz = z - Math.round(s.axis[1]);
      put(x, y, z, stairState(R.stairs, opposite(outwardCard(dx, dz)), 'top'), 'corbel');
    } else put(x, y, z, R.cube, 'corbel');
  }
  for (const [x, y, z] of s.top.deck) put(x, y, z, R.deckSlab ? slabState(R.deckSlab) : R.deckCube, 'deck');
  for (const [x, y, z] of s.beds) put(x, y, z, R.cube, 'bed');
  for (const [x, y, z] of s.top.beds) put(x, y, z, R.deckCube ?? R.cube, 'bed');
  for (const [x, y, z] of [...s.rails, ...s.top.rails]) put(x, y, z, R.rail, 'rail');
  for (const [x, y, z] of s.approachPosts ?? []) { put(x, y, z, R.rail, 'rail'); if (R.light) put(x, y + 1, z, R.light, 'lamp'); }
  if (R.light) for (const [x, y, z] of [...s.lampSpots, ...s.top.lamps]) put(x, y, z, R.light, 'lamp');
  // join the fences and walls (the spiral's own cells, else what stands there)
  const own = new Map(out.map((c) => [k3(c[0], c[1], c[2]), c[3]]));
  const CUBE = { name: 'minecraft:stone', props: {} };
  const at = (x, y, z) => { const s0 = own.get(k3(x, y, z)); if (s0) return splitState(s0); return solidAt(x, y, z) ? CUBE : null; };
  return out.map((c) => (c[4] === 'rail' ? [c[0], c[1], c[2], joinedState(c[3], c[0], c[1], c[2], at), c[4]] : c));
}
/** An upside-down corbel stair faces into the host (its tall side outward reads as a bracket): the opposite cardinal. */
const opposite = (c) => ({ east: 'west', west: 'east', north: 'south', south: 'north' })[c];

/** The bill of a spiral's cells (C26's rules). */
export const spiralBom = (cells) => bomOf(cells.map((c) => c[3]));

void BLOCKS;
