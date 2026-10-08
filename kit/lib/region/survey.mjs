// The plan survey as programs see it (`ctx.survey`): nearest-sample lookups over the ARSV plan survey (resolution 1 up to
// 256x256 columns, else 4), plus coarse helpers. Also windowFromSurvey(): a tile's 80x80 resolution-1 window
// nearest-neighbour upsampled from the survey, which the plan's budget pass evaluates.
import { FLAG_MISSING, FLAG_WATER, asColumns, makeColumns } from './pack.mjs';

/** Index of the survey sample nearest to world (x, z): floor((x - minX) / res + 1/2), clamped to the grid. */
export function sampleIndex(c, x, z) {
  const r = c.resolution;
  let i = Math.floor((x - c.minX + (r >> 1)) / r), j = Math.floor((z - c.minZ + (r >> 1)) / r);
  if (i < 0) i = 0; else if (i >= c.width) i = c.width - 1;
  if (j < 0) j = 0; else if (j >= c.depth) j = c.depth - 1;
  return i + j * c.width;
}

/** A tile's heights window (80x80, resolution 1, minX = 64*tx - 8) nearest-neighbour upsampled from a survey. */
export function windowFromSurvey(survey, key) {
  const s = asColumns(survey);
  const [tx, tz] = String(key).split(',').map(Number);
  const w = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  for (let j = 0; j < 80; j++) {
    for (let i = 0; i < 80; i++) {
      const k = sampleIndex(s, w.minX + i, w.minZ + j);
      const o = i + j * 80;
      w.ground[o] = s.ground[k]; w.height[o] = s.height[k]; w.floor[o] = s.floor[k]; w.flags[o] = s.flags[k];
    }
  }
  return w;
}

/** The `ctx.survey` object for a claim. */
export function surveyApi(survey, claim) {
  const c = asColumns(survey);
  const at = (x, z) => sampleIndex(c, x, z);
  const api = {
    columns: c,
    resolution: c.resolution,
    /** the region's ground (water counts as ground: its top) */
    heightAt: (x, z) => c.ground[at(x, z)],
    groundAt: (x, z) => c.ground[at(x, z)],
    /** the first non-fluid block under the ground (= ground on dry land) */
    floorAt: (x, z) => c.floor[at(x, z)],
    /** the top of the column: max(height, ground) (trunks included, leaves not) */
    topAt: (x, z) => Math.max(c.height[at(x, z)], c.ground[at(x, z)]),
    waterAt: (x, z) => (c.flags[at(x, z)] & FLAG_WATER) !== 0,
    missingAt: (x, z) => (c.flags[at(x, z)] & FLAG_MISSING) !== 0,
    /** largest ground difference to the 4 neighbouring samples, per block */
    slopeAt: (x, z) => {
      const r = c.resolution, g = c.ground[at(x, z)];
      let m = 0;
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) m = Math.max(m, Math.abs(c.ground[at(x + dx, z + dz)] - g));
      return m / r;
    },
    /** biomes are not in the plan survey yet (phase 6a): always null */
    biomeAt: () => null,
    /** the claim's centre column [x, ground, z] */
    pickCenter: () => {
      const x = Math.floor((claim.minX + claim.maxX) / 2), z = Math.floor((claim.minZ + claim.maxZ) / 2);
      return [x, c.ground[at(x, z)], z];
    },
    /**
     * Ground statistics over the samples in [x0, x1] x [z0, z1] (inclusive world coordinates): min/max of ground,
     * floor and top, the median ground, the water sample count and the number of samples.
     */
    stats(x0, z0, x1, z1) {
      const r = c.resolution;
      const g = [];
      let minG = Infinity, maxG = -Infinity, minF = Infinity, maxF = -Infinity, maxT = -Infinity, water = 0;
      const xs = [], zs = [];
      for (let x = x0; x <= x1; x += r) xs.push(x);
      if (xs[xs.length - 1] !== x1) xs.push(x1);
      for (let z = z0; z <= z1; z += r) zs.push(z);
      if (zs[zs.length - 1] !== z1) zs.push(z1);
      for (const z of zs) for (const x of xs) {
        const k = at(x, z);
        const v = c.ground[k], f = c.floor[k];
        g.push(v);
        if (v < minG) minG = v; if (v > maxG) maxG = v;
        if (f < minF) minF = f; if (f > maxF) maxF = f;
        const t = Math.max(v, c.height[k]); if (t > maxT) maxT = t;
        if (c.flags[k] & FLAG_WATER) water++;
      }
      g.sort((a, b) => a - b);
      return { minGround: minG, maxGround: maxG, minFloor: minF, maxFloor: maxF, maxTop: maxT, median: g[g.length >> 1], water, samples: g.length };
    },
    /**
     * What a lot pad at (x0, z0) of size w x d (plus a 1-column apron) needs: the pad's top block `top`
     * (floor(maxGround + minFloor) / 2 unless `floorY` is given: then floorY - 1), `floorY` (= top + 1), `cut` (ground
     * above the top) and `fill` (from the lowest floor up to the top).
     */
    padStats(x0, z0, w, d, { floorY = null } = {}) {
      const s = api.stats(x0 - 1, z0 - 1, x0 + w, z0 + d);
      const top = floorY === null ? Math.floor((s.maxGround + s.minFloor) / 2) : floorY - 1;
      return { top, floorY: top + 1, cut: Math.max(0, s.maxGround - top), fill: Math.max(0, top - s.minFloor), water: s.water };
    },
    /**
     * Coarse flat areas: squares of `size` on a grid over the claim whose ground range is at most `maxRange` and that
     * hold no water, flattest first (then north to south, west to east). At most `limit`.
     */
    flatAreas({ size = 16, maxRange = 2, limit = 64 } = {}) {
      const out = [];
      for (let z = claim.minZ; z + size - 1 <= claim.maxZ; z += size) {
        for (let x = claim.minX; x + size - 1 <= claim.maxX; x += size) {
          const s = api.stats(x, z, x + size - 1, z + size - 1);
          const range = s.maxGround - s.minGround;
          if (range <= maxRange && !s.water) out.push({ x, z, size, y: s.median, range });
        }
      }
      out.sort((a, b) => a.range - b.range || a.z - b.z || a.x - b.x);
      return out.slice(0, limit);
    },
  };
  return Object.freeze(api);
}
