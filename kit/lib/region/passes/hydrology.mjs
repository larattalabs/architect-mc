// (6c HY-a) The `hydrology` pass (docs/CONTRACT.md "Phase 6c slice HY" §5): where water would run over the plan survey. Pure:
// (survey, volumes, intent) -> {fields: {flow, wet}, ops: [], data}. It writes no cell (HY-b's courses write). Plan time only, under
// the realise lint all the same: integer cells, Math.floor/min/max/abs only, no clock, no random draw, ties by index or direction.
//
//   const h = r.pass('hydrology', { wetFalloff: 12, channelAt: 400, minReach: 6 });
//   // -> fields.flow (u8: 16 * floor(log2(accumulation))), fields.wet (u8), data.courses (only with channelAt)
//
// - Filling: a priority flood over the survey's integer ground (`ground`: the top solid, or a water column's surface; trees don't
//   count) with a min-heap keyed (filled height, index), seeded from the claim's edge columns and every surveyed water column
//   (FLAG_WATER; a FROZEN column carries it too). A seed is a sink: it has no outflow. Missing and lava columns are ordinary ground.
// - D8: to the lowest of the 8 neighbours of the filled surface that is strictly lower, ties by direction index (N, NE, E, SE, S,
//   SW, W, NW; north is -z). A column with no strictly lower neighbour (a flat, or a filled pit) drains to the column the flood
//   reached it from, so flats drain deterministically toward the seed the flood came from, and nothing cycles: the flood pops in
//   non-decreasing filled height, so both links point at a column popped earlier.
// - Accumulation: in reverse pop order (a topological order of the D8 graph); each world column contributes 1, so at survey
//   resolution 4 a survey column contributes 16 and `channelAt` means the same on every claim size.
// - flow = min(255, 16 * floor(log2(acc))); wet = min(255, 12 * floor(log2(acc)) + 20 * max(0, wetFalloff - d)), d the Chebyshev
//   distance in blocks (survey cells x resolution) to surveyed water or the plan's own water columns (`intent.water`).
// - channelAt: columns with acc >= channelAt form a forest along D8 (a channel column's outflow is a channel column too). Paths
//   run from each head (a channel column nothing in the channel flows into), longest first (ties by x, then z), to a seed (the
//   claim's edge or water) or to the first column an earlier path holds (that junction column is the path's last). A path with
//   fewer than minReach blocks of its own columns is merged: it is not listed, and its columns stay free for the paths after it.
import { FLAG_WATER } from '../pack.mjs';

/** The direction order D8 breaks ties by: N, NE, E, SE, S, SW, W, NW (north is -z). */
export const D8 = Object.freeze([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]);
/** The pass's defaults (CONTRACT HY §5). `channelAt` has none: data.courses is listed only when it is given. */
export const HYDRO_DEFAULTS = Object.freeze({ wetFalloff: 12, minReach: 6 });

const isInt = Number.isInteger;

/** floor(log2(a)) for an integer a >= 1 (0 for a < 2), without Math.log2 (the realise lint). */
export function ilog2(a) {
  let k = 0;
  while (a >= 2) { a = Math.floor(a / 2); k++; }
  return k;
}

/**
 * The flood, D8 and accumulation on a grid, exported for the unit tests. `ground` (Int16Array or any integer array), `seed`
 * (Uint8Array: 1 for a sink; the claim's edge is always a seed), `W`, `D`, `unit` (each column's contribution, default 1).
 * Returns `{filled (Int32Array), down (Int32Array: the D8 target index, -1 for a seed), order (Int32Array: the columns in pop order),
 * acc (Float64Array: exact integers), seeds, raised (columns the fill lifted), flatLinks (columns that drain by their flood link)}`.
 */
export function flood({ ground, seed, W, D, unit = 1 }) {
  const n = W * D;
  const filled = new Int32Array(n), parent = new Int32Array(n).fill(-1), down = new Int32Array(n).fill(-1);
  const order = new Int32Array(n), seen = new Uint8Array(n);
  // the min-heap of keys (filled + 32768) * n + index: exact doubles (at most 65536 * n < 2^53)
  const heap = new Float64Array(n);
  let hn = 0;
  const push = (k) => {
    let i = hn++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p] <= k) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = k;
  };
  const pop = () => {
    const top = heap[0], last = heap[--hn];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= hn) break;
      const c = l + 1 < hn && heap[l + 1] < heap[l] ? l + 1 : l;
      if (heap[c] >= last) break;
      heap[i] = heap[c]; i = c;
    }
    if (hn > 0) heap[i] = last;
    return top;
  };
  const key = (h, i) => (h + 32768) * n + i;
  let seeds = 0;
  for (let i = 0; i < n; i++) {
    const x = i % W, z = (i - x) / W;
    if (seed[i] || x === 0 || z === 0 || x === W - 1 || z === D - 1) {
      seen[i] = 1; filled[i] = ground[i]; seeds++;
      push(key(ground[i], i));
    }
  }
  let rank = 0, raised = 0;
  while (hn > 0) {
    const k = pop();
    const c = k - Math.floor(k / n) * n;
    order[rank++] = c;
    const x = c % W, z = (c - x) / W, f = filled[c];
    for (let d = 0; d < 8; d++) {
      const X = x + D8[d][0], Z = z + D8[d][1];
      if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
      const j = X + Z * W;
      if (seen[j]) continue;
      seen[j] = 1;
      const g = ground[j];
      filled[j] = g > f ? g : f;
      if (filled[j] > g) raised++;
      parent[j] = c;
      push(key(filled[j], j));
    }
  }
  // D8 over the filled surface
  let flatLinks = 0;
  for (let c = 0; c < n; c++) {
    if (parent[c] < 0) continue; // a seed
    const x = c % W, z = (c - x) / W, f = filled[c];
    let best = -1, bv = f;
    for (let d = 0; d < 8; d++) {
      const X = x + D8[d][0], Z = z + D8[d][1];
      if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
      const j = X + Z * W;
      if (filled[j] < bv) { bv = filled[j]; best = j; }
    }
    if (best < 0) { best = parent[c]; flatLinks++; }
    down[c] = best;
  }
  // accumulation, in reverse pop order
  const acc = new Float64Array(n).fill(unit);
  for (let t = n - 1; t >= 0; t--) {
    const c = order[t];
    if (down[c] >= 0) acc[down[c]] += acc[c];
  }
  return { filled, down, order, acc, seeds, raised, flatLinks };
}

/** Chebyshev distance (in cells) to the nearest `src` cell, by 8-neighbour BFS out to `R` cells; R + 1 beyond (and with no source). */
export function chebyshev(src, W, D, R) {
  const n = W * D;
  const dist = new Int32Array(n).fill(R + 1);
  let q = new Int32Array(n), qn = 0;
  for (let i = 0; i < n; i++) if (src[i]) { dist[i] = 0; q[qn++] = i; }
  let next = new Int32Array(n);
  for (let d = 1; d <= R && qn; d++) {
    let nn = 0;
    for (let t = 0; t < qn; t++) {
      const i = q[t], x = i % W, z = (i - x) / W;
      for (let e = 0; e < 8; e++) {
        const X = x + D8[e][0], Z = z + D8[e][1];
        if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
        const j = X + Z * W;
        if (dist[j] <= d) continue;
        dist[j] = d; next[nn++] = j;
      }
    }
    const s = q; q = next; next = s; qn = nn;
  }
  return dist;
}

/**
 * The channel paths (data.courses) from a flood's `down` and `acc`: `{cells: [[x, z]], accumulation: [..]}` in world coordinates
 * (a column's corner: minX + i * res), head first. See the header for the rule. `minCells`: minReach in survey cells.
 */
export function channelPaths({ down, acc, W, D, minX, minZ, res, channelAt, minCells }) {
  const n = W * D;
  const isCh = new Uint8Array(n), hasUp = new Uint8Array(n);
  for (let c = 0; c < n; c++) if (acc[c] >= channelAt) isCh[c] = 1;
  for (let c = 0; c < n; c++) if (isCh[c] && down[c] >= 0 && isCh[down[c]]) hasUp[down[c]] = 1;
  // each column's path length to its seed (columns), memoised along the way
  const len = new Int32Array(n);
  const lenOf = (c) => {
    if (len[c]) return len[c];
    const stack = [];
    let k = c;
    while (!len[k] && down[k] >= 0) { stack.push(k); k = down[k]; }
    if (!len[k]) len[k] = 1;
    for (let t = stack.length - 1; t >= 0; t--) len[stack[t]] = len[down[stack[t]]] + 1;
    return len[c];
  };
  const heads = [];
  for (let c = 0; c < n; c++) if (isCh[c] && !hasUp[c]) heads.push(c);
  const xOf = (c) => c % W, zOf = (c) => (c - (c % W)) / W;
  heads.sort((a, b) => lenOf(b) - lenOf(a) || xOf(a) - xOf(b) || zOf(a) - zOf(b));
  const held = new Uint8Array(n);
  const out = [];
  for (const h of heads) {
    const path = [];
    let c = h, own = 0;
    for (;;) {
      path.push(c);
      if (held[c]) break; // the junction: an earlier path's column (not this path's own)
      own++;
      if (down[c] < 0) break; // a seed: the claim's edge or water
      c = down[c];
    }
    if (own < minCells) continue; // merged
    for (const k of path) held[k] = 1;
    out.push({ cells: path.map((k) => [minX + xOf(k) * res, minZ + zOf(k) * res]), accumulation: path.map((k) => acc[k]) });
  }
  return out;
}

/**
 * The pass. `survey`: the plan's columns (resolution 1 or 4). `intent`: `{wetFalloff = 12 (blocks, 0..64), channelAt (world columns,
 * an integer of at least 1; data.courses only with it), minReach = 6 (blocks, 1..64), water: [[x, z]] (the plan's own water
 * columns, for wet's distance)}`. Returns `{fields: {flow, wet}, ops: [], data}`; the fields cover the whole survey grid.
 */
export function hydrologyPass(survey, volumes, intent) {
  const c = survey;
  const { wetFalloff = HYDRO_DEFAULTS.wetFalloff, channelAt = null, minReach = HYDRO_DEFAULTS.minReach, water = [] } = intent ?? {};
  if (!(isInt(wetFalloff) && wetFalloff >= 0 && wetFalloff <= 64)) throw new Error('hydrology: wetFalloff must be 0..64 (blocks)');
  if (channelAt !== null && !(isInt(channelAt) && channelAt >= 1)) throw new Error('hydrology: channelAt must be an integer of at least 1 (world columns)');
  if (!(isInt(minReach) && minReach >= 1 && minReach <= 64)) throw new Error('hydrology: minReach must be 1..64 (blocks)');
  if (!Array.isArray(water)) throw new Error('hydrology: water is [[x, z]] (the plan\'s own water columns)');
  const W = c.width, D = c.depth, n = W * D, r = c.resolution;
  const wet0 = new Uint8Array(n);
  let surveyed = 0, plan = 0;
  for (let k = 0; k < n; k++) if (c.flags[k] & FLAG_WATER) { wet0[k] = 1; surveyed++; }
  const seed = Uint8Array.from(wet0);
  for (const q of water) {
    if (!Array.isArray(q) || !isInt(q[0]) || !isInt(q[1])) throw new Error('hydrology: water is [[x, z]] integers');
    const i = Math.floor((q[0] - c.minX) / r), j = Math.floor((q[1] - c.minZ) / r);
    if (i < 0 || j < 0 || i >= W || j >= D) continue;
    if (!wet0[i + j * W]) { wet0[i + j * W] = 1; plan++; }
  }
  const f = flood({ ground: c.ground, seed, W, D, unit: r * r });
  const R = Math.floor((wetFalloff + r - 1) / r);
  const dist = chebyshev(wet0, W, D, R);
  const flow = new Uint8Array(n), wet = new Uint8Array(n);
  let maxAcc = 0;
  for (let k = 0; k < n; k++) {
    const l = ilog2(f.acc[k]);
    if (f.acc[k] > maxAcc) maxAcc = f.acc[k];
    flow[k] = Math.min(255, 16 * l);
    wet[k] = Math.min(255, 12 * l + 20 * Math.max(0, wetFalloff - dist[k] * r));
  }
  const geo = { type: 'u8', minX: c.minX, minZ: c.minZ, width: W, depth: D, res: r };
  const data = { resolution: r, columns: n, seeds: f.seeds, water: surveyed, planWater: plan, raised: f.raised, flatLinks: f.flatLinks, maxAccumulation: maxAcc, wetFalloff, minReach };
  if (channelAt !== null) {
    data.channelAt = channelAt;
    data.courses = channelPaths({ down: f.down, acc: f.acc, W, D, minX: c.minX, minZ: c.minZ, res: r, channelAt, minCells: Math.floor((minReach + r - 1) / r) });
  }
  return { fields: { flow: { ...geo, values: flow }, wet: { ...geo, values: wet } }, ops: [], data };
}
