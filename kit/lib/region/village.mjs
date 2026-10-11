// Flat-village components (docs/CONTRACT.md "Phase 6c slice V", §2-§6): plan-time builders that emit named parts compiled to
// `columns` ops (no new op kind) and register the settlement graph's nodes, ports and edges (SETTLEMENTS §8.1's shape), so 7a
// reuses them as they are or as connectors.
//
//   layoutStreet(o)            the pure layout (Steward's VillageLayout geometry and scoring, ported, plus the shared space)
//   streetLayout(r, specs, o)  the layout emitted: pads and lots, the street (two 4e ground roads ending at the square), verges
//   square(r, sq, o)           the paved, levelled square (walk) with its plaza node, bell area and golem space
//   green(r, g, o)             the well green: a 7x7 levelled green beside the street (walk), the same reservations
//   lane(r, from, to, w, o)    a lane: a 4-connected surface swap (walk) from a lot's entrance to the street or the square
//
// Coordinates: the street runs along `u`, lots stand across it in `v`. Orientation 'ew' maps (u, v) to (x, z), 'ns' to (z, x).
// A lot's `size` is [alongStreet, deep] (Steward's sizeX, sizeZ for its east-west street; 0c's minLotSize alongStreet x deep).
import { COND } from './program.mjs';
import { inRects } from './survey.mjs';
import { crossOffsets } from './geom.mjs';
import { isGravity } from '../blocks.mjs';
import { fixtureFor, roadLamp } from './fixtures.mjs';

/** (6c W) The village's lamp fixture (the bible's `light` on its `rail`): as props.mjs lampFixture (no import cycle). */
const lampFixture = (r) => fixtureFor(r.material('light', 'lamp light'), r.material('rail', 'lamp post'));

/** VillageLayout.Rules.defaults(): street 5 (road 3 plus a verge each side), lot gap 3, slope at most 3, margin 2. */
export const STREET_RULES = Object.freeze({ streetWidth: 5, lotGap: 3, maxSlope: 3, claimMargin: 2 });
/** Lot pads in a flat village: cut and fill at most 2 (§1). */
export const PAD_MAX = 2;
/** The bell area (M22): 5x5, one y, standable, 2 clear; the golem space 3x3x3 within 8 of the bell. */
export const BELL_AREA = 5, GOLEM = 3, GOLEM_RANGE = 8;
/** M23: the trading hall's entrance within 12 of the bell anchor (horizontal Euclidean). M24: a farm's rect within 2 of water. */
export const TRADE_RANGE = 12, FARM_WATER = 2;
const VILLAGER_LOTS = new Set(['dwelling', 'job', 'trading_hall', 'farm']);
export const villagerLot = (v) => VILLAGER_LOTS.has(v);

// ------------------------------------------------------------------ frames

/** World (x, z) of local (u, v) for an orientation. */
export const toWorld = (o, u, v) => (o === 'ew' ? [u, v] : [v, u]);
/** Local (u, v) of world (x, z). */
export const toLocal = (o, x, z) => (o === 'ew' ? [x, z] : [z, x]);
/** A world front for a lot on the -v side (facing +v) or the +v side (facing -v). */
export const frontOf = (o, side) => (o === 'ew' ? (side < 0 ? 'south' : 'north') : side < 0 ? 'east' : 'west');
/** The local extents of a claim. */
function frame(o, claim) {
  return o === 'ew' ? { u0: claim.minX, u1: claim.maxX, v0: claim.minZ, v1: claim.maxZ } : { u0: claim.minZ, u1: claim.maxZ, v0: claim.minX, v1: claim.maxX };
}
/** The world rect [x0, z0, x1, z1] of a local rect. */
export function rectWorld(o, u0, v0, u1, v1) {
  return o === 'ew' ? [u0, v0, u1, v1] : [v0, u0, v1, u1];
}
const rectsMeet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const grow = (r, m) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];

// ------------------------------------------------------------------ the layout (pure)

/** VillageLayout.orderOf: central first, then landmarks, then the rest, edge last. */
const orderOf = (s) => (s.placement === 'central' ? 0 : s.landmark ? 1 : s.placement === 'edge' ? 3 : 2);
/** The square's first claims (§2): the trading hall, then the landmark lot, then central lots. */
const squareOrder = (s) => (s.villager === 'trading_hall' ? 0 : s.landmark ? 1 : s.placement === 'central' ? 2 : 9);

/** Each column's 8-neighbour step distance to the nearest surveyed water column (Steward's Grid.waterDistance), over the claim. */
export function waterDistance(survey, claim, { unfrozen = false } = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const d = new Int32Array(W * D).fill(0x7fffffff);
  const q = [];
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (survey.waterAt(claim.minX + i, claim.minZ + j) && !(unfrozen && survey.frozenAt?.(claim.minX + i, claim.minZ + j))) { d[i + j * W] = 0; q.push(i + j * W); }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], i = k % W, j = (k - i) / W;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= W || jj >= D) continue;
      const n = ii + jj * W;
      if (d[n] > d[k] + 1) { d[n] = d[k] + 1; q.push(n); }
    }
  }
  const any = q.length > 0;
  return { any, at: (x, z) => (x < claim.minX || z < claim.minZ || x > claim.maxX || z > claim.maxZ ? 0x7fffffff : d[(x - claim.minX) + (z - claim.minZ) * W]) };
}

/** (6c W) Does the claim's survey hold a frozen-water column? */
export function hasFrozen(survey, claim) {
  if (!survey.frozenAt) return false;
  const r = survey.resolution ?? 1;
  for (let x = claim.minX; x <= claim.maxX; x += r) for (let z = claim.minZ; z <= claim.maxZ; z += r) if (survey.frozenAt(x, z)) return true;
  return false;
}

/** The distance (8-neighbour steps) from a world rect to surveyed water: the least over its cells, or null without water. */
export function rectWater(wd, r) {
  if (!wd.any) return null;
  let best = 0x7fffffff;
  for (let x = r[0]; x <= r[2]; x++) for (let z = r[1]; z <= r[3]; z++) best = Math.min(best, wd.at(x, z));
  return best === 0x7fffffff ? null : best;
}

/**
 * The street layout (§2): VillageLayout's geometry and scoring ported, in both orientations (the one that places more lots,
 * then the better score), with the shared space at the street's middle and the square's frontage given to the trading hall,
 * the landmark and the central lots first. Pure: `{claim, survey, specs, rules?, shared: {kind: 'square'|'well', size}, keepOut?}`.
 * Returns `{orientation, streetV, streetY, u0, u1, shared, lots: [{spec, u, v, w, d, side, rect, front, floorY, groundY,
 * slot}], unplaced: [{id, reason}], score}` or `{fail: why}` when no street fits.
 */
export function layoutStreet({ claim, survey, specs, rules = STREET_RULES, shared = { kind: 'square', size: 11 }, keepOut = [], _unsafe = {} }) {
  const ordered = specs.map((s, i) => ({ ...s, _i: i })).sort((a, b) => orderOf(a) - orderOf(b) || a._i - b._i);
  const wd = ordered.some((s) => s.placement === 'near_water' || s.villager === 'farm') ? waterDistance(survey, claim) : null;
  // (6c W) a farm needs unfrozen water (M24); near_water counts frozen water as water (S-W-1)
  const wdFarm = wd && hasFrozen(survey, claim) ? waterDistance(survey, claim, { unfrozen: true }) : wd;
  let best = null;
  const fails = [];
  for (const o of ['ew', 'ns']) {
    const F = frame(o, claim);
    const m = rules.claimMargin;
    const cu = Math.floor((F.u0 + F.u1) / 2), cv = Math.floor((F.v0 + F.v1) / 2);
    const r = Math.floor((F.v1 - F.v0) / 2) - m;
    for (let dv = -Math.floor(r / 2); dv <= Math.floor(r / 2); dv += 4) {
      const sv = cv + dv;
      const sh = placeShared(o, F, claim, survey, sv, cu, shared, rules, keepOut);
      if (sh.fail) { fails.push(sh.fail); continue; }
      for (const firstNeg of [true, false]) {
        for (const upFirst of [true, false]) {
          const p = tryStreetSkipping({ o, F, claim, survey, specs: ordered, rules, sv, sh, firstNeg, upFirst, keepOut, wd, wdFarm, _unsafe });
          const street = streetCheck(o, p, sh, survey, rules, keepOut, claim);
          if (street.fail) { fails.push(street.fail); continue; }
          const score = p.lots.length * 1_000_000 + hintScore(o, p, survey, claim, wd, wdFarm) - slopeTotal(o, p, survey) * 10 - Math.abs(dv);
          if (!best || p.lots.length > best.lots.length || (p.lots.length === best.lots.length && score > best.score)) {
            best = { ...p, ...street, orientation: o, streetV: sv, shared: sh, score };
          }
        }
      }
    }
  }
  // (6c W) a claim refused over frozen water says so, naming a frozen column
  if (!best) { const fz = fails.filter((f) => /frozen/.test(f)).sort(); return { fail: fz.length ? fz[0] : fails.length ? fails.sort()[0] : 'no street fits the claim' }; }
  const placed = new Set(best.lots.map((l) => l.spec.id));
  const unplaced = specs.filter((s) => !placed.has(s.id)).map((s) => ({ id: s.id, reason: best.why.get(s.id) ?? 'no_room' }));
  return { orientation: best.orientation, streetV: best.streetV, streetY: best.streetY, u0: best.u0, u1: best.u1, shared: best.shared, lots: best.lots, unplaced, score: best.score, road: best.road };
}

/** The shared space at the street's middle: the square centred on the street, or the 7x7 green on one side of it. */
function placeShared(o, F, claim, survey, sv, cu, shared, rules, keepOut) {
  const half = Math.floor(rules.streetWidth / 2);
  const tries = [0, 4, -4, 8, -8, 12, -12, 16, -16];
  let why = null;
  for (const du of tries) {
    const c = cu + du;
    let u0, u1, v0, v1, side = 0;
    if (shared.kind === 'square') {
      const S = shared.size, h0 = Math.floor((S - 1) / 2);
      u0 = c - h0; u1 = u0 + S - 1; v0 = sv - h0; v1 = v0 + S - 1;
    } else {
      // the green: 7x7 on the -v side of the street, fronting its verge
      u0 = c - 3; u1 = c + 3; v1 = sv - half - 1; v0 = v1 - 6; side = -1;
    }
    if (u0 < F.u0 + rules.claimMargin || u1 > F.u1 - rules.claimMargin || v0 < F.v0 + rules.claimMargin || v1 > F.v1 - rules.claimMargin) { why ??= 'the shared space leaves the claim'; continue; }
    const wr = rectWorld(o, u0, v0, u1, v1);
    if (keepOut.some((k) => rectsMeet(grow(wr, 1), k))) { why = 'the shared space meets keep-out'; continue; }
    const st = levelStats(survey, wr);
    if (st.water) { why = st.frozen ? `frozen water under the shared space at ${st.frozen}` : 'water under the shared space'; continue; }
    const y = st.top;
    if (st.cut > PAD_MAX || st.fill > PAD_MAX) { why = `the shared space needs a cut of ${st.cut} and a fill of ${st.fill} (at most ${PAD_MAX})`; continue; }
    return { kind: shared.kind, u0, u1, v0, v1, side, cu: c, y, rect: wr };
  }
  return { fail: `shared ${shared.kind}: ${why}` };
}

/** A levelled area's top y (the median ground) and the cut and fill it needs; whether any column is water. */
export function levelStats(survey, [x0, z0, x1, z1]) {
  const g = [];
  let water = false, frozen = null;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { g.push(survey.heightAt(x, z)); if (survey.waterAt(x, z)) { water = true; if (!frozen && survey.frozenAt?.(x, z)) frozen = `${x},${z}`; } }
  const s = [...g].sort((a, b) => a - b);
  const top = s[s.length >> 1];
  return { top, cut: Math.max(0, s[s.length - 1] - top), fill: Math.max(0, top - s[0]), water, frozen };
}

/** VillageLayout.tryStreetSkipping: when a lot fits nowhere, lay the street again without it (at most 3 stale drops in a row). */
function tryStreetSkipping(a) {
  let use = [...a.specs];
  const dropped = [];
  let best = tryStreet({ ...a, specs: use });
  let p = best, stale = 0;
  while (p.left.length && use.length > 1) {
    const d = p.left[0];
    use = use.filter((s) => s !== d);
    dropped.push(d);
    const before = p.lots.length;
    p = tryStreet({ ...a, specs: use });
    if (p.lots.length > before) stale = 0; else if (++stale >= 3) break;
    if (p.lots.length > best.lots.length) best = { ...p, why: new Map([...best.why, ...p.why]) };
  }
  return best;
}

/** A lot's footprint (local), checked: inside the margin, dry, slope, pad within PAD_MAX at its entrance y, clear of the others. */
function fitLot(a, s, u, v, side, placed, obstacles, entranceTop = null) {
  const { o, F, survey, rules, keepOut } = a;
  const [w, d] = s.size;
  const m = rules.claimMargin;
  if (u < F.u0 + m || u + w - 1 > F.u1 - m || v < F.v0 + m || v + d - 1 > F.v1 - m) return { why: 'outside' };
  const rect = rectWorld(o, u, v, u + w - 1, v + d - 1);
  for (const ob of obstacles) if (rectsMeet(grow(rect, ob.gap), ob.rect)) return { why: 'no_room' };
  for (const l of placed) if (rectsMeet(grow(rect, rules.lotGap), l.rect)) return { why: 'no_room' };
  if (keepOut.some((k) => rectsMeet(grow(rect, 1), k))) return { why: 'keep_out' };
  let lo = Infinity, hi = -Infinity;
  const hs = [];
  for (let x = rect[0]; x <= rect[2]; x++) for (let z = rect[1]; z <= rect[3]; z++) {
    if (survey.waterAt(x, z)) return { why: 'water' };
    const h = survey.heightAt(x, z);
    lo = Math.min(lo, h); hi = Math.max(hi, h); hs.push(h);
  }
  if (hi - lo > rules.maxSlope) return { why: 'too_steep' };
  hs.sort((p, q) => p - q);
  // the entrance: the cell outside the middle of the front edge (the lot rule, program.mjs lot()); the pad's top meets it
  const eu = u + Math.floor((w - 1) / 2), ev = side < 0 ? v + d : v - 1;
  const [ex, ez] = toWorld(o, eu, ev);
  // on the street the entrance is a verge cell (ground-following); on the square it is the square's levelled edge
  const floorY = (entranceTop ?? survey.heightAt(ex, ez)) + 1;
  const ps = survey.padStats(rect[0], rect[1], rect[2] - rect[0] + 1, rect[3] - rect[1] + 1, { floorY });
  if (ps.cut > PAD_MAX || ps.fill > PAD_MAX) return { why: 'pad' };
  return { lot: { spec: s, u, v, w, d, side, rect, front: frontOf(o, side), floorY, groundY: hs[hs.length >> 1], entrance: [ex, floorY, ez] } };
}

/** VillageLayout.tryStreet with the shared space: the square's frontage first, then both sides outward from it, sides alternating. */
function tryStreet(a) {
  const { o, F, rules, sv, sh, firstNeg, upFirst } = a;
  const half = Math.floor(rules.streetWidth / 2);
  const m = rules.claimMargin;
  const placed = [];
  const why = new Map();
  let left = [...a.specs];
  const obstacles = [{ rect: sh.rect, gap: 1 }];
  // the square's frontage: one lot on each side, centred on the square's middle (its entrance on the square's edge)
  if (sh.kind === 'square') {
    const cands = left.filter((s) => squareOrder(s) < 9 && s.id !== a._unsafe?.notOnSquare).sort((p, q) => squareOrder(p) - squareOrder(q) || p._i - q._i);
    for (const side of firstNeg ? [-1, 1] : [1, -1]) {
      for (const s of cands) {
        if (placed.some((l) => l.spec === s)) continue;
        const [w, d] = s.size;
        const u = sh.cu - Math.floor((w - 1) / 2);
        const v = side < 0 ? sh.v0 - d : sh.v1 + 1;
        const f = fitLot(a, s, u, v, side, placed, [], sh.y);
        if (f.lot) { f.lot.slot = 'square'; placed.push(f.lot); left = left.filter((x) => x !== s); break; }
      }
    }
  }
  // the street: cursors from the shared space's edges outward ([up, down] per side)
  const start = { up: sh.u1 + 2, down: sh.u0 - 2 };
  const cur = { [-1]: { ...start }, [1]: { ...start } };
  let side = firstNeg ? -1 : 1;
  for (let guard = 0; guard < 4000 && left.length; guard++) {
    const c = cur[side];
    let placedOne = false;
    for (let t = 0; t < 2 && !placedOne; t++) {
      const up = ((guard + t + (upFirst ? 0 : 1)) % 2) === 0;
      const s = left[0];
      const [w, d] = s.size;
      const u = up ? c.up : c.down - w + 1;
      const v = side < 0 ? sv - half - d : sv + half + 1;
      if (u < F.u0 + m || u + w - 1 > F.u1 - m || v < F.v0 + m || v + d - 1 > F.v1 - m) { why.set(s.id, why.get(s.id) ?? 'no_room'); continue; }
      const f = fitLot(a, s, u, v, side, placed, obstacles);
      if (f.lot) {
        f.lot.slot = 'street';
        placed.push(f.lot);
        left = left.slice(1);
        if (up) c.up = u + w + rules.lotGap; else c.down = u - rules.lotGap - 1;
        placedOne = true;
      } else {
        why.set(s.id, f.why);
        if (up) c.up += 2; else c.down -= 2;
      }
    }
    side = -side;
    const room = (k) => cur[k].up <= F.u1 - m || cur[k].down >= F.u0 + m;
    if (!room(-1) && !room(1)) break;
  }
  if (!a._unsafe?.noNearWater) nearWater(a, placed, obstacles);
  return { lots: placed, left, why };
}

/**
 * (6c V) Farms and near_water lots: a lot laid out more than FARM_WATER from surveyed water moves to the street slot nearest the
 * shared space that is within FARM_WATER of water and fits (same side rules, gaps, pads), if there is one. M24 by construction
 * where the claim allows it; otherwise it stays (and M24 reports it).
 */
function nearWater(a, placed, obstacles) {
  const { o, F, rules, sv, sh } = a;
  if (!a.wd?.any) return;
  const half = Math.floor(rules.streetWidth / 2);
  const m = rules.claimMargin;
  for (const l of [...placed]) {
    const s = l.spec;
    if (l.slot !== 'street' || !(s.villager === 'farm' || s.placement === 'near_water')) continue;
    const wd = s.villager === 'farm' ? (a.wdFarm ?? a.wd) : a.wd;
    if (!wd.any) continue;
    const cur = rectWater(wd, l.rect);
    if (cur !== null && cur <= FARM_WATER) continue;
    const others = placed.filter((x) => x !== l);
    let best = null;
    for (const side of [-1, 1]) {
      const [w, d] = s.size;
      const v = side < 0 ? sv - half - d : sv + half + 1;
      for (let u = F.u0 + m; u + w - 1 <= F.u1 - m; u++) {
        const f = fitLot(a, s, u, v, side, others, obstacles);
        if (!f.lot) continue;
        const dw = rectWater(wd, f.lot.rect);
        if (dw === null || dw > FARM_WATER) continue;
        const dist = Math.min(Math.abs(u - sh.u1), Math.abs(u + w - 1 - sh.u0));
        if (!best || dist < best.dist) best = { lot: f.lot, dist };
      }
    }
    if (best) { best.lot.slot = 'street'; placed[placed.indexOf(l)] = best.lot; }
  }
}

/** The street's extent and road: from the outermost street lot to the shared space on each side; a ground road check. */
function streetCheck(o, p, sh, survey, rules, keepOut, claim) {
  const half = Math.floor(rules.streetWidth / 2);
  const street = p.lots.filter((l) => l.slot === 'street');
  const sv = sh.kind === 'square' ? Math.floor((sh.v0 + sh.v1) / 2) : sh.v1 + half + 1;
  let u0 = Math.min(sh.u0, ...street.map((l) => l.u)), u1 = Math.max(sh.u1, ...street.map((l) => l.u + l.w - 1));
  // a street at least past the shared space's edges (its two road items end there)
  u0 = Math.min(u0, sh.u0 - 4); u1 = Math.max(u1, sh.u1 + 4);
  const F = frame(o, claim);
  u0 = Math.max(u0, F.u0 + rules.claimMargin); u1 = Math.min(u1, F.u1 - rules.claimMargin);
  const rect = rectWorld(o, u0, sv - half, u1, sv + half);
  if (keepOut.some((k) => rectsMeet(rect, k))) return { fail: 'the street meets keep-out' };
  // ground road (4e) on the plan survey: no water, cut/fill within 3 with steps of 1 (program.mjs _groundRoadProblem)
  let lo = -Infinity, hi = Infinity;
  for (let u = u0; u <= u1; u++) {
    if (sh.kind === 'square' && u >= sh.u0 && u <= sh.u1) { lo = -Infinity; hi = Infinity; continue; }
    const [x, z] = toWorld(o, u, sv);
    if (survey.waterAt(x, z)) return { fail: survey.frozenAt?.(x, z) ? `the street crosses frozen water at ${x},${z}` : `the street crosses water at ${x},${z}` };
    const g = survey.heightAt(x, z);
    lo = Math.max(g - 3, lo - 1); hi = Math.min(g + 3, hi + 1);
    if (lo > hi) return { fail: `the street is too steep for a ground road at ${x},${z}` };
  }
  return { u0, u1, streetY: survey.heightAt(...toWorld(o, Math.floor((u0 + u1) / 2), sv)), road: { sv, u0, u1 } };
}

/** VillageLayout.hintScore (higher is better): near_water close to water, central close to the centre, edge far, high_ground above the mean. */
function hintScore(o, p, survey, claim, wd, wdFarm = wd) {
  if (!p.lots.length) return 0;
  const mean = p.lots.reduce((s, l) => s + l.groundY, 0) / p.lots.length;
  const cx = Math.floor((claim.minX + claim.maxX) / 2), cz = Math.floor((claim.minZ + claim.maxZ) / 2);
  let score = 0;
  for (const l of p.lots) {
    const r = l.rect;
    const toCentre = Math.hypot(Math.floor((r[0] + r[2]) / 2) - cx, Math.floor((r[1] + r[3]) / 2) - cz);
    const hint = l.spec.placement ?? (l.spec.villager === 'farm' ? 'near_water' : null);
    if (hint === 'near_water') { const w = l.spec.villager === 'farm' ? wdFarm : wd; const b = w ? rectWater(w, r) : null; score -= b === null ? 2000 : Math.min(b, 60) * 40; } else if (hint === 'central') score -= Math.floor(toCentre * 20);
    else if (hint === 'edge') score += Math.floor(toCentre * 10);
    else if (hint === 'high_ground') score += Math.floor((l.groundY - mean) * 60);
  }
  return score;
}

function slopeTotal(o, p, survey) {
  let t = 0;
  for (const l of p.lots) {
    let lo = Infinity, hi = -Infinity;
    for (let x = l.rect[0]; x <= l.rect[2]; x++) for (let z = l.rect[1]; z <= l.rect[3]; z++) { const h = survey.heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    t += hi - lo;
  }
  return t;
}

// ------------------------------------------------------------------ surface ops (columns)

/**
 * (6c W, item 4) The gap under a surface cell written at `y` in column (x, z), on the frozen plan survey: the number of fluid
 * cells (water, or frozen water's water) between the cell below it and the bed. 0 on dry land and over a fill.
 */
export function gapUnder(survey, x, y, z) {
  if (!survey.waterAt(x, z)) return 0;
  const u = y - 1, floor = survey.floorAt(x, z), ground = survey.heightAt(x, z);
  return u > floor && u <= ground ? u - floor : 0;
}

/**
 * Column ops for a set of cells levelled at y (abs) or following the ground (y null): fill below, the top (role, walk), 2 clear.
 * (6c W, item 4) When the top block falls (sand, gravel, concrete powder: blocks.mjs `isGravity`) and the cell under it is a gap
 * in the frozen ground, a 1-deep gap gets the `foundation` role under it and a deeper one takes the `subsurface` role as its top
 * (never a falling block). A top that doesn't fall, or a cell with nothing under it to fill, writes exactly as before.
 */
export function surfaceOps(part, cells, role, { walk = true, subsurface = 'subsurface', _noGravityRule = false } = {}) {
  const r = part.region;
  const top = r.material(role, `${part.id}: surface`), sub = r.material(subsurface, `${part.id}: subsurface`);
  const lev = cells.filter((c) => c[1] !== null), fol = cells.filter((c) => c[1] === null);
  const ops = [];
  // the gravity rule: the cells whose top would stand over a gap, by the fix they need
  let under = [], swap = [];
  if (!_noGravityRule && isGravity(top)) {
    const s = r.survey;
    const gap = (x, y, z) => gapUnder(s, x, y ?? s.heightAt(x, z), z);
    const keep = [];
    for (const c of lev) { const g = gap(c[0], c[1], c[2]); if (g === 1) under.push(c); else if (g > 1) swap.push(c); else keep.push(c); }
    const keepF = [];
    for (const c of fol) { const g = gap(c[0], null, c[2]); if (g === 1) under.push(c); else if (g > 1) swap.push(c); else keepF.push(c); }
    if (under.length || swap.length) { lev.length = 0; lev.push(...keep, ...under.filter((c) => c[1] !== null)); fol.length = 0; fol.push(...keepF, ...under.filter((c) => c[1] === null)); }
  }
  if (lev.length) {
    // fill from the ground up to y - 1, the top at y, cleared from y + 1 to the column's top (at least 2 above the ground)
    ops.push({ from: { surface: 0 }, to: { abs: 0 }, cols: lev.flatMap(([x, y, z]) => [x, z, 1, y - 1, 0]), materials: [sub], walk: false });
    ops.push({ from: { abs: 0 }, to: { abs: 0 }, cols: lev.flatMap(([x, y, z]) => [x, z, y, y, 0]), materials: [top], walk });
    ops.push({ from: { abs: 0 }, to: { max: [{ height: 0 }, { surface: 2 }] }, cols: lev.flatMap(([x, y, z]) => [x, z, y + 1, 0, 0]), materials: [null], walk: false });
  }
  if (fol.length) {
    ops.push({ from: { surface: 0 }, to: { surface: 0 }, cols: fol.flatMap(([x, , z]) => [x, z, 0, 0, 0]), materials: [top], walk });
    ops.push({ from: { surface: 1 }, to: { max: [{ height: 0 }, { surface: 2 }] }, cols: fol.flatMap(([x, , z]) => [x, z, 0, 0, 0]), materials: [null], walk: false });
  }
  if (under.length) {
    // a 1-deep gap: the foundation under the top (the gap's one fluid cell)
    const s = r.survey;
    const fdn = r.material(isGravity(r.material('foundation', 'gravity fill')) ? 'subsurface' : 'foundation', `${part.id}: gravity fill`);
    ops.push({ from: { abs: 0 }, to: { abs: 0 }, cols: under.flatMap(([x, y, z]) => { const yy = (y ?? s.heightAt(x, z)) - 1; return [x, z, yy, yy, 0]; }), materials: [fdn], walk: false });
  }
  if (swap.length) {
    // a deeper gap: the top takes the subsurface role (never a falling block), as it was otherwise
    const alt = isGravity(sub) ? r.material('foundation', `${part.id}: gravity swap`) : sub;
    const sl = swap.filter((c) => c[1] !== null), sf = swap.filter((c) => c[1] === null);
    if (sl.length) {
      ops.push({ from: { surface: 0 }, to: { abs: 0 }, cols: sl.flatMap(([x, y, z]) => [x, z, 1, y - 1, 0]), materials: [sub], walk: false });
      ops.push({ from: { abs: 0 }, to: { abs: 0 }, cols: sl.flatMap(([x, y, z]) => [x, z, y, y, 0]), materials: [alt], walk });
      ops.push({ from: { abs: 0 }, to: { max: [{ height: 0 }, { surface: 2 }] }, cols: sl.flatMap(([x, y, z]) => [x, z, y + 1, 0, 0]), materials: [null], walk: false });
    }
    if (sf.length) {
      ops.push({ from: { surface: 0 }, to: { surface: 0 }, cols: sf.flatMap(([x, , z]) => [x, z, 0, 0, 0]), materials: [alt], walk });
      ops.push({ from: { surface: 1 }, to: { max: [{ height: 0 }, { surface: 2 }] }, cols: sf.flatMap(([x, , z]) => [x, z, 0, 0, 0]), materials: [null], walk: false });
    }
  }
  for (const op of ops) part._push({ op: 'columns', from: op.from, to: op.to, cols: op.cols, materials: op.materials, cond: COND.IF_NATURAL, walk: op.walk });
  if (under.length || swap.length) ((r.meta.gravity ??= {})[part.id] ??= { under: 0, swap: 0 }, r.meta.gravity[part.id].under += under.length, r.meta.gravity[part.id].swap += swap.length);
  return part;
}

// ------------------------------------------------------------------ builders (emit parts, register graph nodes)

/** The plaza node's ports: `bell` (the bell anchor) plus the street ends and the square lots' lanes (added as they are made). */
function plaza(r, sh, bell) {
  return r.graphNode({ id: 'plaza', kind: 'plaza', ref: sh.kind, at: bell, ports: [{ name: 'bell', at: bell, facing: 'up', width: BELL_AREA }] });
}

/**
 * The reservations of a shared space (M22): the 5x5 bell area at its middle (one y, standable, 2 clear), the bell anchor at its
 * centre (feet y), the 3x3x3 golem space (beside the bell area, within 8), and its cells as world [x, z] lists.
 */
export function reservations(o, sh) {
  const y = sh.y + 1;
  const cu = sh.kind === 'square' ? sh.cu : sh.cu, cv = Math.floor((sh.v0 + sh.v1) / 2);
  const b = Math.floor(BELL_AREA / 2);
  const bell = [...toWorld(o, cu, cv)];
  const area = [], golem = [];
  for (let du = -b; du <= b; du++) for (let dv = -b; dv <= b; dv++) area.push(toWorld(o, cu + du, cv + dv));
  // the golem space: 3x3 at the +u end of the space (beside the bell area where the space allows, overlapping it otherwise)
  const gu1 = sh.u1, gu0 = gu1 - GOLEM + 1;
  for (let u = gu0; u <= gu1; u++) for (let dv = -1; dv <= 1; dv++) golem.push(toWorld(o, u, cv + dv));
  return { y, bell: [bell[0], y, bell[1]], area, golem, golemCentre: [...toWorld(o, gu0 + 1, cv)] };
}

/** The square (or the green): levelled at its y and paved in the `path` role with walk cells, prop cells paved without walk. */
export function square(r, sh, { stage = 'ground', o, noWalk = new Set(), noGravityRule = false } = {}) {
  const p = r.part(sh.kind === 'square' ? 'square' : 'green', { stage, set: 'path' });
  const cells = [], still = [];
  for (let u = sh.u0; u <= sh.u1; u++) for (let v = sh.v0; v <= sh.v1; v++) {
    const [x, z] = toWorld(o, u, v);
    (noWalk.has(`${x},${z}`) ? still : cells).push([x, sh.y, z]);
  }
  surfaceOps(p, cells, sh.kind === 'square' ? 'path' : 'surface', { _noGravityRule: noGravityRule });
  if (still.length) surfaceOps(p, still, sh.kind === 'square' ? 'path' : 'surface', { walk: false, _noGravityRule: noGravityRule });
  (r.meta.parts[p.id] ??= {}).kind = 'path';
  return p;
}

/** The well green (§2): the same as a square, in the `surface` role (grass), 7x7 beside the street. */
export const green = (r, sh, o) => square(r, sh, o);

/**
 * A lane (§2): from `from` (a lot's entrance, [x, y, z]: the cell just outside its box, at its floor y) to `to` (a walk cell of the
 * street verge or the square's edge), `w` wide (crossOffsets across its travel), levelled at the entrance's y - 1 (the lot's pad
 * top). 4-connected: across the street axis first, then along it. Never inside a lot box (`_unsafe` skips that guard: the broken
 * variant the checker's M1 must catch) and never across keep-out (that refuses the plan). Returns its top cells [x, y, z].
 */
export function lane(part, id, from, to, w, { o, boxes = [], keepOut = [], _unsafe = false, noGravityRule = false }) {
  const y = from[1] - 1;
  const [fu, fv] = toLocal(o, from[0], from[2]);
  const [tu, tv] = toLocal(o, to[0], to[2]);
  const offs = crossOffsets(w);
  const cells = [];
  const seen = new Set();
  const add = (u, v) => {
    const [x, z] = toWorld(o, u, v);
    const k = `${x},${z}`;
    if (!seen.has(k)) { seen.add(k); cells.push([x, y, z]); }
  };
  const sv = Math.sign(tv - fv) || 1;
  for (let v = fv; ; v += sv) { for (const k of offs) add(fu + k, v); if (v === tv) break; }
  const su = Math.sign(tu - fu);
  if (su) for (let u = fu + su; ; u += su) { for (const k of offs) add(u, tv + k); if (u === tu) break; }
  for (const [x, , z] of cells) {
    if (keepOut.length && inRects(keepOut, x, z)) throw new Error(`lane ${id} crosses keep-out at ${x},${z}`);
    if (!_unsafe) for (const b of boxes) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) throw new Error(`lane ${id} enters lot ${b.id}'s box at ${x},${z}`);
  }
  surfaceOps(part, cells, 'path', { _noGravityRule: noGravityRule });
  return cells;
}

// ------------------------------------------------------------------ the whole street, emitted

/**
 * `r.streetLayout(specs, rules)` (§3): lay the street out (layoutStreet) and emit it. Stage `ground`: the lot pads (part `pads`,
 * each lot in stage `lots`), the shared space (part `square` or `green`), the verges (part `verges`) and the lanes (part
 * `lanes`); stage `street`: the two road items ending at the shared space's edges (part `street`). Registers the graph: a lot
 * node per lot (port `entrance`), the plaza (ports `bell`, `street_<end>`, `lane_<lot>`), a junction per street lane, road
 * edges along the street and path edges for the lanes. Returns the layout plus `{bell, reserve, lanes, entrances}`.
 */
export function streetLayout(r, specs, { rules = STREET_RULES, shared = { kind: 'square', size: 11 }, laneWidth = 2, stages = {}, maxHeight = 32, requireAll = false, planProps = null, _unsafe = {} } = {}) {
  const ctx = r.ctx;
  const keepOut = ctx.keepOut ?? [];
  const L = layoutStreet({ claim: r.claim, survey: r.survey, specs, rules, shared, keepOut, _unsafe });
  if (L.fail) throw new Error(`flat village: ${L.fail}`);
  if (requireAll && L.unplaced.length) throw new Error(`flat village: requireAll, and ${L.unplaced.length} lot(s) are unplaced: ${L.unplaced.map((u) => `${u.id} (${u.reason})`).join(', ')}`);
  const o = L.orientation, sh = L.shared;
  const half = Math.floor(rules.streetWidth / 2);
  const sg = stages.ground ?? 'ground', ss = stages.street ?? 'street', sl = stages.lots ?? 'lots';
  const res = reservations(o, sh);
  const wd = waterDistance(r.survey, r.claim);
  // (6c W) M24's water is unfrozen water (a farm can't use ice); the same as wd on a claim with no frozen column
  const wdU = hasFrozen(r.survey, r.claim) ? waterDistance(r.survey, r.claim, { unfrozen: true }) : wd;
  // pads and lots (stage ground; the lots' own stage `lots`)
  const pads = r.part('pads', { stage: sg });
  const boxes = [];
  const lotOut = [];
  for (const l of [...L.lots].sort((a, b) => a.spec._i - b.spec._i)) {
    const s = l.spec;
    const water = rectWater(wd, l.rect);
    const bellDistance = Math.round(Math.hypot(l.entrance[0] - res.bell[0], l.entrance[2] - res.bell[2]) * 10) / 10;
    const lot = pads.lot(s.id, {
      at: [l.rect[0], l.rect[1]], size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1], floor: l.floorY, front: l.front,
      max: [l.rect[2] - l.rect[0] + 1, maxHeight, l.rect[3] - l.rect[1] + 1], brief: s.brief, pad: { maxCut: PAD_MAX, maxFill: PAD_MAX }, stage: sl,
      ext: { ...s.ext, 'architect_mc:village': { role: s.role, type: s.type, villager: s.villager, entrance: l.entrance, lane: `lane_${s.id}`, water, bellDistance, slot: l.slot, landmark: s.landmark, placement: s.placement } },
    });
    boxes.push({ id: s.id, ...lot.box });
    lotOut.push({ ...l, lot });
  }
  // the shared space (the props' cells, from the caller's planProps, paved without walk)
  const propsPlan = planProps ? planProps({ o, sh, res, lots: lotOut, layout: L }) : null;
  square(r, sh, { stage: sg, o, noWalk: propsPlan?.noWalk ?? new Set(), noGravityRule: !!_unsafe.noGravityRule });
  // the verges: the street's two outer rows, outside the shared space (surface swap, walk)
  const verges = r.part('verges', { stage: sg, set: 'path' });
  const sv = L.road.sv;
  const vcells = [];
  for (let u = L.u0; u <= L.u1; u++) {
    if (sh.kind === 'square' && u >= sh.u0 && u <= sh.u1) continue;
    for (const dv of [-half, half]) { const [x, z] = toWorld(o, u, sv + dv); vcells.push([x, null, z]); }
  }
  if (vcells.length) surfaceOps(verges, vcells, 'path', { _noGravityRule: !!_unsafe.noGravityRule });
  (r.meta.parts.verges ??= {}).kind = 'path';
  // the plaza and the street's junctions
  const pl = plaza(r, sh, res.bell);
  const lanes = r.part('lanes', { stage: sg, set: 'path' });
  (r.meta.parts.lanes ??= {}).kind = 'path';
  const laneCells = {};
  const junctions = []; // street lanes: {u, side, node}
  for (const l of lotOut) {
    const s = l.spec, id = `lane_${s.id}`;
    const e = l.entrance;
    const [eu, ev] = toLocal(o, e[0], e[2]);
    const ent = { name: 'entrance', at: e, facing: l.front, width: laneWidth };
    r.graphNode({ id: `lot:${s.id}`, kind: 'lot', ref: s.id, at: e, ports: [ent] });
    if (_unsafe.noLane === s.id) continue;
    let to;
    if (l.slot === 'square') {
      const tv = l.side < 0 ? sh.v0 : sh.v1;
      to = [...toWorld(o, eu, tv)];
      to = [to[0], e[1], to[1]];
      pl.ports.push({ name: id, at: to, facing: l.front, width: laneWidth });
      laneCells[s.id] = lane(lanes, id, e, to, laneWidth, { o, boxes, keepOut, _unsafe: _unsafe.laneIntoBox === s.id, noGravityRule: !!_unsafe.noGravityRule });
      r.graphEdge({ id, from: `lot:${s.id}.entrance`, to: `plaza.${id}`, type: 'path', width: laneWidth, path: id });
    } else {
      const tv = l.side < 0 ? sv - half : sv + half;
      const t2 = toWorld(o, eu, tv);
      to = [t2[0], e[1], t2[1]];
      laneCells[s.id] = lane(lanes, id, e, to, laneWidth, { o, boxes, keepOut, _unsafe: _unsafe.laneIntoBox === s.id, noGravityRule: !!_unsafe.noGravityRule });
      const jw = toWorld(o, eu, sv);
      junctions.push({ u: eu, side: l.side, id: s.id, at: [jw[0], L.streetY, jw[1]] });
    }
  }
  // the street (§2): for a square, two ground road items ending at its edges; for a green, one along it. Junctions where lanes
  // meet the street, road edges between them, the plaza's street ports at the square's edges (or the green's front).
  const street = r.part('street', { stage: ss, set: 'path' });
  const roads = [];
  const chains = sh.kind === 'square'
    ? [{ rid: 'street_w', a: L.u0, b: sh.u0 - 1, endPort: 'street_w' }, { rid: 'street_e', a: sh.u1 + 1, b: L.u1, startPort: 'street_e' }]
    : [{ rid: 'street', a: L.u0, b: L.u1, attach: sh.cu }];
  const facingU = (dir) => (o === 'ew' ? (dir < 0 ? 'west' : 'east') : dir < 0 ? 'north' : 'south');
  const at3 = (u) => { const w = toWorld(o, u, sv); return [w[0], L.streetY, w[1]]; };
  for (const ch of chains) {
    if (ch.b - ch.a < 1) continue;
    const pts = [toWorld(o, ch.a, sv), toWorld(o, ch.b, sv)];
    const why = street._groundRoadProblem(pts.map((q) => [q[0], null, q[1]]));
    if (why) throw new Error(`flat village: the street (${ch.rid}) can't be a ground road: ${why}`);
    street.road(pts, { width: rules.streetWidth - 2, surface: 'path', lanterns: true, mode: 'ground', id: ch.rid, lamp: roadLamp(lampFixture(r)) });
    roads.push(ch.rid);
    if (ch.endPort) pl.ports.push({ name: ch.endPort, at: at3(ch.b), facing: facingU(-1), width: rules.streetWidth });
    if (ch.startPort) pl.ports.push({ name: ch.startPort, at: at3(ch.a), facing: facingU(1), width: rules.streetWidth });
    const stops = [...new Set([...junctions.filter((j) => j.u >= ch.a && j.u <= ch.b).map((j) => j.u), ...(ch.attach !== undefined ? [ch.attach] : [])])].sort((p, q) => p - q);
    let prev = ch.startPort ? `plaza.${ch.startPort}` : null, k = 0;
    if (!prev && stops[0] !== ch.a) { const n = r.graphNode({ id: `${ch.rid}_start`, kind: 'junction', ref: ch.rid, at: at3(ch.a), ports: [{ name: 'street', at: at3(ch.a), facing: 'up', width: rules.streetWidth }] }); prev = `${n.id}.street`; }
    for (const u of stops) {
      const n = r.graphNode({ id: `${ch.rid}_j${++k}`, kind: 'junction', ref: ch.rid, at: at3(u), ports: [{ name: 'street', at: at3(u), facing: 'up', width: rules.streetWidth }] });
      if (prev) r.graphEdge({ id: `${ch.rid}#${k}`, from: prev, to: `${n.id}.street`, type: 'road', width: rules.streetWidth, path: ch.rid });
      prev = `${n.id}.street`;
      for (const j of junctions.filter((x) => x.u === u)) {
        const port = `lane_${j.id}`;
        n.ports.push({ name: port, at: at3(u), facing: frontOf(o, -j.side), width: laneWidth });
        r.graphEdge({ id: port, from: `lot:${j.id}.entrance`, to: `${n.id}.${port}`, type: 'path', width: laneWidth, path: port });
      }
      if (ch.attach === u) {
        const gat = toWorld(o, u, sh.v1);
        pl.ports.push({ name: 'street', at: [gat[0], sh.y + 1, gat[1]], facing: frontOf(o, 1), width: 7 });
        n.ports.push({ name: 'green', at: at3(u), facing: frontOf(o, -1), width: 7 });
        r.graphEdge({ id: 'green_link', from: `${n.id}.green`, to: 'plaza.street', type: 'path', width: 7, path: 'green' });
      }
    }
    if (ch.endPort) r.graphEdge({ id: `${ch.rid}#end`, from: prev, to: `plaza.${ch.endPort}`, type: 'road', width: rules.streetWidth, path: ch.rid });
    else if (stops[stops.length - 1] !== ch.b) {
      const n = r.graphNode({ id: `${ch.rid}_end`, kind: 'junction', ref: ch.rid, at: at3(ch.b), ports: [{ name: 'street', at: at3(ch.b), facing: 'up', width: rules.streetWidth }] });
      r.graphEdge({ id: `${ch.rid}#end`, from: prev, to: `${n.id}.street`, type: 'road', width: rules.streetWidth, path: ch.rid });
    }
  }
  if (L.unplaced.length) r.note(`unplaced: ${L.unplaced.map((u) => u.id).join(', ')}`);
  r.meta.village = {
    orientation: o, streetV: sv, shared: { kind: sh.kind, rect: sh.rect, y: sh.y }, bell: res.bell, bellArea: res.area.map(([x, z]) => [x, z]), bellY: res.y,
    golem: res.golem.map(([x, z]) => [x, z]), golemCentre: res.golemCentre, unplaced: L.unplaced, lanes: laneCells, roads, laneWidth,
    lots: Object.fromEntries(lotOut.map((l) => [l.spec.id, { villager: l.spec.villager, slot: l.slot, entrance: l.entrance, rect: l.rect, water: rectWater(wdU, l.rect) }])),
    waterAny: wdU.any, keepOut,
  };
  return { ...L, res, lots: lotOut, boxes, laneCells, plaza: pl, propsPlan };
}
