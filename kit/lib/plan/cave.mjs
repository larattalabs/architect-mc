// (slice CAVE) `feature.cave`: a cave the claim's land already has, as an elevated zone's locator (`where: {near: {feature: {cave:
// {minFloor?, pick?, to?}}}}`), and the zone's lots carved into the cave's walls (carve_into site lots). The plan reads the claim's
// window volume (the box the template pick and the composer's affordance list read: RegionDesigns.affordanceBox, mirrored by
// caveWindowBox), so the caves it finds carry the ids the composer was shown. The first plan asks for it (the zone answers incomplete
// VOLUME; the elevated zone's two-plan flow reads it); the second finds the caves (AF's cave detector, lib/region/affordances.mjs),
// takes them in pick order (largest floor area, or nearest the `to` anchor; `minFloor` drops smaller ones), and uses the first cave that
// holds the most lots. A lot is placed with its front row on the hall's edge (its door cell a cave floor cell, open for two rows, rock
// under it) and its other rows in rock (CARVE_SOLID of them site-solid; no water, lava, sky-open air, build or missing cell in the box),
// as s6_cave_city's caveLayout does by hand, and with the elevated zone's checks: inside the zone's rect, its site volume (box + 8)
// inside the read volume and the claim, apart from the other lots (gap 1) and the zones and forms before it. Lots greedily in plan
// order, candidates nearest the cave's anchor first. Deterministic: integers, the survey and the volume only.
import { analyseVolume } from '../region/affordances.mjs';
import { VC } from '../region/volume.mjs';
import { rotateBlock } from '../reserved.mjs';
import { FLAG_MISSING } from '../region/pack.mjs';
import { SITE_MARGIN } from '../siteFits.mjs';

/** RegionDesigns.AFFORDANCE_WINDOW, AFFORDANCE_BELOW, AFFORDANCE_ABOVE (the template pick's claim window). */
export const CAVE_WINDOW = Object.freeze({ side: 256, below: 48, above: 24 });
/** A carved lot's height (s6_cave_city's lot), and the share of its rows behind the front that must be site-solid. */
export const CARVE_HEIGHT = 12;
export const CARVE_SOLID = 0.9;
/** The zone's rect without a size: the cave's columns grown by this (a lot's depth into the rock). */
export const CARVE_REACH = 24;
const ROTS = Object.freeze(['none', 'clockwise_90', 'clockwise_180', 'counterclockwise_90']);
const TURNS = Object.freeze({ none: 0, clockwise_90: 1, clockwise_180: 2, counterclockwise_90: 3 });

const OPEN = new Uint8Array(16); OPEN[VC.AIR] = 1; OPEN[VC.PLANT] = 1;
const TERRAIN = new Uint8Array(16); for (const c of ['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW']) TERRAIN[VC[c]] = 1;
const BAD = new Uint8Array(16); for (const c of ['WATER', 'LAVA', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING']) BAD[VC[c]] = 1;

/** The cave spec of a part's locator (`where.near.feature.cave`), or null. */
export const caveSpecOf = (part) => part?.where?.near?.feature?.cave ?? null;

/**
 * The claim's window box (RegionDesigns.affordanceBox): at most CAVE_WINDOW.side columns a side centred on the claim, from `below`
 * under the surveyed lowest ground (or floor) to `above` over the highest top, clamped to the claim's y range; null with no column.
 */
export function caveWindowBox(env) {
  const c = env.cols, claim = env.claim;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < c.width * c.depth; k++) {
    if (c.flags[k] & FLAG_MISSING) continue;
    lo = Math.min(lo, c.ground[k], c.floor[k]);
    hi = Math.max(hi, c.ground[k], c.height[k]);
  }
  if (lo > hi) return null;
  const xs = claim.maxX - claim.minX + 1, zs = claim.maxZ - claim.minZ + 1;
  const w = Math.min(CAVE_WINDOW.side, xs), d = Math.min(CAVE_WINDOW.side, zs);
  const x0 = claim.minX + Math.trunc((xs - w) / 2), z0 = claim.minZ + Math.trunc((zs - d) / 2);
  return { minX: x0, minY: Math.max(claim.minY, lo - CAVE_WINDOW.below), minZ: z0, maxX: x0 + w - 1, maxY: Math.min(claim.maxY, hi + CAVE_WINDOW.above), maxZ: z0 + d - 1 };
}

const sameBox = (a, b) => a.minX === b.minX && a.minY === b.minY && a.minZ === b.minZ && a.maxX === b.maxX && a.maxY === b.maxY && a.maxZ === b.maxZ;
const meets2 = (a, b, g = 0) => a.minX - g <= b.maxX && b.minX - g <= a.maxX && a.minZ - g <= b.maxZ && b.minZ - g <= a.maxZ;

/** The caves in pick order (spec: minFloor, pick largest | nearest, to: an anchor). */
export function orderCaves(env, caves, spec) {
  const min = Number.isInteger(spec.minFloor) ? spec.minFloor : 1;
  const to = spec.to ? env.anchors.get(spec.to) : [(env.claim.minX + env.claim.maxX) >> 1, (env.claim.minZ + env.claim.maxZ) >> 1];
  const d2 = (a) => (a.anchors[0][0] - to[0]) ** 2 + (a.anchors[0][2] - to[1]) ** 2;
  const id = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const out = caves.filter((a) => a.metrics.floorArea >= min);
  out.sort(spec.pick === 'nearest' ? (a, b) => d2(a) - d2(b) || id(a, b) : (a, b) => b.metrics.floorArea - a.metrics.floorArea || id(a, b));
  return out;
}

/** The volume's grids for carving: sky-open cells, a cave's component, prefix sums of site-solid and bad cells. */
function grids(vol) {
  const { width: W, height: H, depth: D, classes: cls } = vol;
  const idx = (i, j, k) => (i * D + k) * H + j;
  const sky = new Uint8Array(W * H * D);
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = H - 1; j >= 0; j--) { const x = idx(i, j, k); if (!OPEN[cls[x]]) break; sky[x] = 1; }
  // 3D prefix sums (W+1)(D+1)(H+1): site-solid, and bad (water, lava, builds, missing, sky-open air)
  const P = (W + 1) * (D + 1) * (H + 1);
  const pidx = (i, j, k) => (i * (D + 1) + k) * (H + 1) + j;
  const solid = new Int32Array(P), bad = new Int32Array(P);
  for (let i = 1; i <= W; i++) for (let k = 1; k <= D; k++) for (let j = 1; j <= H; j++) {
    const x = idx(i - 1, j - 1, k - 1), c = cls[x];
    const s = TERRAIN[c] ? 1 : 0, b = BAD[c] || sky[x] ? 1 : 0;
    const p0 = pidx(i, j, k), a = pidx(i - 1, j, k), bb = pidx(i, j - 1, k), cc = pidx(i, j, k - 1), ab = pidx(i - 1, j - 1, k), ac = pidx(i - 1, j, k - 1), bc = pidx(i, j - 1, k - 1), abc = pidx(i - 1, j - 1, k - 1);
    solid[p0] = s + solid[a] + solid[bb] + solid[cc] - solid[ab] - solid[ac] - solid[bc] + solid[abc];
    bad[p0] = b + bad[a] + bad[bb] + bad[cc] - bad[ab] - bad[ac] - bad[bc] + bad[abc];
  }
  const sum = (arr, i0, j0, k0, i1, j1, k1) => arr[pidx(i1 + 1, j1 + 1, k1 + 1)] - arr[pidx(i0, j1 + 1, k1 + 1)] - arr[pidx(i1 + 1, j0, k1 + 1)] - arr[pidx(i1 + 1, j1 + 1, k0)]
    + arr[pidx(i0, j0, k1 + 1)] + arr[pidx(i0, j1 + 1, k0)] + arr[pidx(i1 + 1, j0, k0)] - arr[pidx(i0, j0, k0)];
  return { W, H, D, idx, cls, sky, solid, bad, sum };
}

/** A cave's component (6-connected open cells without sky, from its anchor): a Uint8Array mask, and its floor cells [i, j, k]. */
function component(g, vol, a) {
  const { W, H, D, idx, cls, sky } = g;
  const b = vol.box, [ax, ay, az] = a.anchors[0];
  const i0 = ax - b.minX, j0 = ay - b.minY, k0 = az - b.minZ;
  const mask = new Uint8Array(W * H * D);
  const floor = [];
  if (i0 < 0 || j0 < 0 || k0 < 0 || i0 >= W || j0 >= H || k0 >= D || !OPEN[cls[idx(i0, j0, k0)]] || sky[idx(i0, j0, k0)]) return { mask, floor };
  const q = [[i0, j0, k0]];
  mask[idx(i0, j0, k0)] = 1;
  for (let h = 0; h < q.length; h++) {
    const [i, j, k] = q[h];
    if (j > 0 && TERRAIN[cls[idx(i, j - 1, k)]]) floor.push(q[h]);
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const ni = i + di, nj = j + dj, nk = k + dk;
      if (ni < 0 || nj < 0 || nk < 0 || ni >= W || nj >= H || nk >= D) continue;
      const n = idx(ni, nj, nk);
      if (mask[n] || !OPEN[cls[n]] || sky[n]) continue;
      mask[n] = 1;
      q.push([ni, nj, nk]);
    }
  }
  return { mask, floor };
}

/**
 * Carved lots in one cave: `lots` [{id, size: [w, d]}] in plan order, each placed or left out. `rect` the zone's rect, `taken` the rects
 * before it, `claim`. Returns {picks: [{spec, box, rotation, max}], unplaced: [id]}.
 */
export function carveLots(vol, g, a, lots, { rect, taken, claim }) {
  const { mask, floor } = component(g, vol, a);
  const b = vol.box, { idx, cls, solid, bad, sum } = g;
  const [ax, , az] = a.anchors[0];
  const fl = floor.map(([i, j, k]) => [i, j, k, (b.minX + i - ax) ** 2 + (b.minZ + k - az) ** 2]);
  fl.sort((p, q) => p[3] - q[3] || p[1] - q[1] || p[0] - q[0] || p[2] - q[2]);
  const boxes = [], picks = [], unplaced = [];
  const H = CARVE_HEIGHT;
  for (const l of lots) {
    const [w, d] = Array.isArray(l.size) && l.size.length === 2 ? l.size : [9, 9];
    const mx = Math.floor((w - 1) / 2);
    let got = null;
    for (const [fi, fj, fk] of fl) {
      if (fj + 1 >= g.H || !mask[idx(fi, fj + 1, fk)]) continue; // (the door: two open rows of the cave)
      for (const rot of ROTS) {
        const t = TURNS[rot], quarter = t % 2 === 1;
        // the door's design cell [mx, 0, d - 1] lands on the floor cell; the design's origin follows
        const [rx, rz] = rotateBlock(mx, d - 1, w, d, t);
        const ox = fi - rx, oz = fk - rz;
        const sx = quarter ? d : w, sz = quarter ? w : d;
        const box = { minX: b.minX + ox, minY: b.minY + fj, minZ: b.minZ + oz, maxX: b.minX + ox + sx - 1, maxY: b.minY + fj + H - 1, maxZ: b.minZ + oz + sz - 1 };
        if (box.minX - SITE_MARGIN < b.minX || box.maxX + SITE_MARGIN > b.maxX || box.minZ - SITE_MARGIN < b.minZ || box.maxZ + SITE_MARGIN > b.maxZ
          || box.minY - SITE_MARGIN < b.minY || box.maxY + SITE_MARGIN > b.maxY) continue;
        if (box.minX - SITE_MARGIN < claim.minX || box.maxX + SITE_MARGIN > claim.maxX || box.minZ - SITE_MARGIN < claim.minZ || box.maxZ + SITE_MARGIN > claim.maxZ) continue;
        if (box.minX < rect.minX || box.maxX > rect.maxX || box.minZ < rect.minZ || box.maxZ > rect.maxZ) continue;
        // the cell behind the door is rock (the face to carve into)
        const [bx, bz] = rotateBlock(mx, d - 2, w, d, t);
        if (d < 2 || !TERRAIN[cls[idx(ox + bx, fj, oz + bz)]]) continue;
        const i0 = ox, k0 = oz, i1 = ox + sx - 1, k1 = oz + sz - 1, j0 = fj, j1 = fj + H - 1;
        if (sum(bad, i0, j0, k0, i1, j1, k1)) continue;
        // the rows behind the front: the box less its front row (front south: maxZ; west: minX; north: minZ; east: maxX)
        const back = t === 0 ? [i0, k0, i1, k1 - 1] : t === 1 ? [i0 + 1, k0, i1, k1] : t === 2 ? [i0, k0 + 1, i1, k1] : [i0, k0, i1 - 1, k1];
        const n = (back[2] - back[0] + 1) * (back[3] - back[1] + 1) * H;
        if (sum(solid, back[0], j0, back[1], back[2], j1, back[3]) < CARVE_SOLID * n) continue;
        if (boxes.some((q) => meets2(box, q, 1)) || taken.some((q) => meets2(box, q, 1))) continue;
        got = { spec: l, box, rotation: rot, max: [w, H, d] };
        break;
      }
      if (got) break;
    }
    if (got) { boxes.push(got.box); picks.push(got); } else unplaced.push(l.id);
  }
  return { picks, unplaced };
}

/**
 * Resolve an elevated zone located by a cave (step 2). `vol`: the read window volume (or null: incomplete VOLUME, volBox asked).
 * Returns elevated's answer draft plus `carved: true`, the picks carrying `box` and `rotation` (fit carve_into), and `cave` (its id).
 */
export function resolveCaveZone(env, p, { taken = [], tol = { max: 0 }, sizedRect }) {
  const part = p.part, spec = caveSpecOf(part);
  const volBox = caveWindowBox(env);
  if (!volBox) return { klass: 'refused', reasons: [{ code: 'NO_FEATURE', message: 'the survey has no column to look for a cave under' }] };
  const vol = (env.ctx.volumes ?? []).find((v) => v.decoded && sameBox(v.box, volBox))?.decoded ?? null;
  const ev = { box: [volBox.minX, volBox.minY, volBox.minZ, volBox.maxX, volBox.maxY, volBox.maxZ] };
  const c = env.claim;
  const claimIn = { minX: c.minX + 1, minZ: c.minZ + 1, maxX: c.maxX - 1, maxZ: c.maxZ - 1 };
  if (!vol) return { klass: 'incomplete', rect: claimIn, volBox, reasons: [{ code: 'VOLUME', message: 'the land the cave is in was not read yet (the two-plan flow reads it): prepare (or check with load: "generate"), then check again', evidence: { ...ev, missing: true } }] };
  const caves = orderCaves(env, analyseVolume(vol, { kinds: ['cave'] }), spec);
  if (!caves.length) return { klass: 'refused', volBox, reasons: [{ code: 'NO_FEATURE', message: `no cave${Number.isInteger(spec.minFloor) ? ` with a floor of at least ${spec.minFloor}` : ''} under the claim (the frozen volume shows none)`, evidence: ev }] };
  const g = grids(vol);
  const lots = part.program.lots;
  let best = null;
  for (const a of caves) {
    const ab = a.box;
    const rect = sizedRect ? sizedRect([a.anchors[0][0], a.anchors[0][2]]) : {
      minX: Math.max(claimIn.minX, ab.minX - CARVE_REACH), minZ: Math.max(claimIn.minZ, ab.minZ - CARVE_REACH), maxX: Math.min(claimIn.maxX, ab.maxX + CARVE_REACH), maxZ: Math.min(claimIn.maxZ, ab.maxZ + CARVE_REACH),
    };
    const r = carveLots(vol, g, a, lots, { rect, taken, claim: c });
    if (!best || r.picks.length > best.picks.length) best = { ...r, a, rect };
    if (!r.unplaced.length) break;
  }
  const { a, rect: search, picks, unplaced } = best;
  const cv = { cave: a.id, floorArea: a.metrics.floorArea, ceiling: a.metrics.ceiling };
  const notes = [`cave ${a.id} (floor ${a.metrics.floorArea}, ceiling ${a.metrics.ceiling}; ${caves.length} cave(s) under the claim); ${picks.length} of ${lots.length} lot(s) carved into its walls`];
  // the zone's footprint (what later zones and forms keep clear of): the x/z box round its lots, not the rect searched (a claim-wide cave's)
  const rect = picks.length ? picks.reduce((q, { box: b }) => ({ minX: Math.min(q.minX, b.minX), minZ: Math.min(q.minZ, b.minZ), maxX: Math.max(q.maxX, b.maxX), maxZ: Math.max(q.maxZ, b.maxZ) }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity }) : search;
  const out = { rect, volBox, carved: true, cave: a.id, picks: picks.map((q) => ({ ...q, fit: 'carve_into' })), unplaced };
  if (!unplaced.length) return { klass: 'fits', ...out, notes };
  if (picks.length && unplaced.length <= (tol.hard ? (tol.max ?? 0) : (tol.ceiling ?? Infinity))) {
    return { klass: 'adjusted', ...out, deviations: [{ what: 'count', value: unplaced.length, max: tol.max ?? 0, ...(unplaced.length > (tol.max ?? 0) ? { exceeds: true } : {}) }], notes: [...notes, `unplaced: ${unplaced.join(', ')} (no wall of rock left for ${unplaced.length === 1 ? 'it' : 'them'})`] };
  }
  const fragment = { program: { ...part.program, lots: lots.filter((l) => !unplaced.includes(l.id)) } };
  return {
    klass: 'refused', ...out, picks: [], notes,
    reasons: [{ code: 'NO_FEATURE', message: `${unplaced.length} of ${lots.length} lot(s) found no wall of rock to carve into round the cave (a door on its floor, ${Math.round(CARVE_SOLID * 100)}% rock behind, clear of water, sky and the other lots)`, evidence: { ...ev, ...cv, unplaced } }],
    ...(picks.length ? { wouldFit: [{ part: p.id, fragment, geometry: { rect: [search.minX, search.minZ, search.maxX, search.maxZ] } }] } : {}),
  };
}
