// (6c FL) Shared by the FL tests (fl.test.mjs, fl-layouts-1/2.test.mjs): seeded synthetic claims and the layout invariants (CONTRACT FL
// §10 item 1). Not a test file.
import assert from 'node:assert/strict';
import { flatSurvey } from './plan-helpers.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { Field, FL_RULES } from '../lib/region/frontage.mjs';
import { validateLots } from '../lib/params.mjs';

/** mulberry32: a seeded PRNG [0, 1) (tests only). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SIZES = [[9, 9], [9, 9], [9, 9], [13, 11], [11, 9], [17, 15]];
const PLACE = [null, null, null, null, 'central', 'edge', 'high_ground'];

/**
 * A seeded synthetic claim and lot list: `{S, claim, F, specs, shared, c, seed}`. Ground 64 (a gentle ramp on some), water ponds off the
 * centre on some, 4..`maxLots` lots.
 */
export function synthClaim(seed, { maxLots = 12, size = null, water = true } = {}) {
  const rnd = prng(seed * 7919 + 13);
  const W = size ?? 176 + 16 * Math.floor(rnd() * 4), D = W;
  const x0 = 1000, z0 = 2000;
  const bands = [];
  if (rnd() < 0.4) { const step = 12 + Math.floor(rnd() * 12); for (let k = 1; k * step < W; k++) bands.push({ x0: x0 + k * step, z0, x1: x0 + W - 1, z1: z0 + D - 1, y: 64 + k }); }
  if (water && rnd() < 0.5) {
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      const w = 8 + Math.floor(rnd() * 16), d = 8 + Math.floor(rnd() * 16);
      const corner = Math.floor(rnd() * 4);
      const bx = corner & 1 ? x0 + W - 8 - w : x0 + 8, bz = corner & 2 ? z0 + D - 8 - d : z0 + 8;
      bands.push({ x0: bx, z0: bz, x1: bx + w - 1, z1: bz + d - 1, y: 60, water: 4 });
    }
  }
  const sv = flatSurvey({ W, D, x0, z0, y: 64, bands });
  const S = surveyApi(sv.bytes, sv.claim);
  const n = 4 + Math.floor(rnd() * (maxLots - 3));
  const lots = Array.from({ length: n }, (_, i) => {
    const sz = SIZES[Math.floor(rnd() * SIZES.length)], pl = PLACE[Math.floor(rnd() * PLACE.length)];
    return { id: `l${i + 1}`, type: 'house', size: [...sz], ...(pl ? { placement: pl } : {}), ...(i === 0 && rnd() < 0.5 ? { landmark: true } : {}) };
  });
  const specs = validateLots(lots).map((s, i) => ({ ...s, _i: i }));
  const shared = [{ kind: 'square', size: 11 }, { kind: 'well', size: 7 }, { kind: 'none', size: 5 }][Math.floor(rnd() * 3)];
  const F = new Field(S, sv.claim, 2);
  return { S, sv, claim: sv.claim, F, specs, shared, c: [(sv.claim.minX + sv.claim.maxX) >> 1, (sv.claim.minZ + sv.claim.maxZ) >> 1], seed, lots, rnd };
}

const meets = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const grow = (r, m) => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];

/**
 * The invariants every free layout holds (item 1): no two lots overlapping or closer than the lot gap; every lot wholly in the zone's
 * land (the original field `F0`); no lot cell within 2 of a street's centre (never a lot over a street or its verge); every lane cell off
 * every lot; every entrance joined to a street (it, or its lane's last cell, lies on a street's band); fronts face the street (the
 * entrance is on the lot's front side). Returns counts for the report.
 */
export function assertLayout(F0, L, tag) {
  const centre = new Set();
  for (const st of L.streets) for (const [x, z] of st.cells) centre.add(`${x},${z}`);
  const near2 = (x, z) => { for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (centre.has(`${x + dx},${z + dz}`)) return true; return false; };
  for (let i = 0; i < L.lots.length; i++) for (let j = i + 1; j < L.lots.length; j++) assert.ok(!meets(grow(L.lots[i].rect, FL_RULES.lotGap), L.lots[j].rect), `${tag}: lots ${L.lots[i].spec.id} and ${L.lots[j].spec.id} closer than the gap`);
  for (const l of L.lots) {
    const r = l.rect;
    for (let z = r[1]; z <= r[3]; z++) for (let x = r[0]; x <= r[2]; x++) {
      assert.ok(F0.ok(x, z), `${tag}: lot ${l.spec.id} cell ${x},${z} outside the zone's land`);
      assert.ok(!near2(x, z), `${tag}: lot ${l.spec.id} cell ${x},${z} on a street's band`);
    }
    for (const [x, z] of l.lane) for (const q of L.lots) assert.ok(!(x >= q.rect[0] && x <= q.rect[2] && z >= q.rect[1] && z <= q.rect[3]), `${tag}: lane of ${l.spec.id} enters ${q.spec.id}`);
    // joined: the entrance (or the lane's street end) is on the band, or 4-next to it
    const ends = [[l.entrance[0], l.entrance[2]], ...l.lane];
    assert.ok(ends.some(([x, z]) => near2(x, z) || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => near2(x + dx, z + dz))), `${tag}: lot ${l.spec.id}'s entrance not joined to its street`);
    // the front: the entrance lies just outside the rect on its front side
    const [ex, , ez] = l.entrance;
    const side = { north: ez === r[1] - 1, south: ez === r[3] + 1, west: ex === r[0] - 1, east: ex === r[2] + 1 }[l.front];
    assert.ok(side, `${tag}: lot ${l.spec.id}'s entrance ${ex},${ez} is not outside its ${l.front} edge`);
    // the front faces its street: that street's cell nearest the lot's front edge's middle lies on its front side
    let best = null;
    for (const st of L.streets.filter((q) => q.name === l.street)) for (const [x, z] of st.cells) { const d = Math.max(Math.abs(x - ex), Math.abs(z - ez)); if (!best || d < best.d) best = { d, x, z }; }
    const fd = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[l.front];
    const mx = (r[0] + r[2]) / 2, mz = (r[1] + r[3]) / 2;
    assert.ok((best.x - mx) * fd[0] + (best.z - mz) * fd[1] > 0, `${tag}: lot ${l.spec.id} fronts ${l.front} but its nearest street cell ${best.x},${best.z} is behind it`);
  }
  return { lots: L.lots.length, unplaced: L.unplaced.length };
}
