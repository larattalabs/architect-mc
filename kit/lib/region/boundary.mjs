// (6c D2, C27) Boundaries a district follows (docs/CONTRACT.md "Phase 6c slice D", "Steward round 8 additions"): a biome edge between
// two biome families, a river or shore, or a ridge. Each is traced over the plan survey (and, for a biome edge, the plan's biome grid:
// one biome per 4x4 columns, the game's own storage resolution: C28) to a set of cells, then the longest (or the one nearest an
// anchor) connected piece is ordered into a spine: a 4-connected polyline of cells along the boundary. Pure; integer math only.
import { FLAG_LAVA, FLAG_MISSING, FLAG_WATER } from './pack.mjs';

/**
 * Biome families (a district names two of them for a biome edge): a family is a set of biome ids (`minecraft:` implied). A biome in no
 * family is its own family (its id's path).
 */
export const BIOME_FAMILIES = Object.freeze({
  desert: ['desert'],
  jungle: ['jungle', 'sparse_jungle', 'bamboo_jungle'],
  savanna: ['savanna', 'savanna_plateau', 'windswept_savanna'],
  badlands: ['badlands', 'eroded_badlands', 'wooded_badlands'],
  plains: ['plains', 'sunflower_plains', 'meadow'],
  forest: ['forest', 'flower_forest', 'birch_forest', 'old_growth_birch_forest', 'dark_forest', 'pale_garden'],
  taiga: ['taiga', 'old_growth_pine_taiga', 'old_growth_spruce_taiga', 'snowy_taiga'],
  snowy: ['snowy_plains', 'ice_spikes', 'snowy_slopes', 'frozen_peaks', 'jagged_peaks', 'grove', 'snowy_beach'],
  mountain: ['stony_peaks', 'windswept_hills', 'windswept_gravelly_hills', 'windswept_forest', 'stony_shore'],
  swamp: ['swamp', 'mangrove_swamp'],
  cherry: ['cherry_grove'],
  mushroom: ['mushroom_fields'],
  beach: ['beach'],
  river: ['river', 'frozen_river'],
  ocean: ['ocean', 'deep_ocean', 'warm_ocean', 'lukewarm_ocean', 'deep_lukewarm_ocean', 'cold_ocean', 'deep_cold_ocean', 'frozen_ocean', 'deep_frozen_ocean'],
});
const FAMILY_OF = new Map(Object.entries(BIOME_FAMILIES).flatMap(([f, ids]) => ids.map((b) => [b, f])));

/** The family of a biome id (`minecraft:desert` -> `desert`); an id in no family is its own (its path). */
export function familyOf(id) {
  if (!id) return null;
  const p = String(id).replace(/^minecraft:/, '');
  return FAMILY_OF.get(p) ?? p;
}

/**
 * Validate the plan's biome grid (Regions.plan sends it: one biome per 4x4 columns at the surface, LOADED_ONLY): `{minX, minZ, res: 4,
 * width, depth, palette: [id], ids: [index | -1]}`. Returns it frozen, or throws.
 */
export function parseBiomes(b) {
  if (!b || typeof b !== 'object') throw new Error('biomes must be an object');
  for (const k of ['minX', 'minZ', 'res', 'width', 'depth']) if (!Number.isInteger(b[k])) throw new Error(`biomes.${k} must be an integer`);
  if (b.res !== 4) throw new Error('biomes.res must be 4 (one biome per 4x4 columns)');
  if (b.width < 1 || b.depth < 1 || b.width * b.depth > 1 << 20) throw new Error('biomes: bad size');
  if (!Array.isArray(b.palette) || b.palette.length > 4096 || !b.palette.every((p) => typeof p === 'string' && /^[a-z0-9_.:/-]{1,128}$/.test(p))) throw new Error('biomes.palette must be biome ids');
  if (!Array.isArray(b.ids) || b.ids.length !== b.width * b.depth || !b.ids.every((i) => Number.isInteger(i) && i >= -1 && i < b.palette.length)) throw new Error('biomes.ids must be width x depth palette indexes (-1: unknown)');
  return Object.freeze({ minX: b.minX, minZ: b.minZ, res: 4, width: b.width, depth: b.depth, palette: Object.freeze([...b.palette]), ids: Int32Array.from(b.ids) });
}

/** The biome id at world (x, z), or null (unknown, or outside the grid). */
export function biomeAt(g, x, z) {
  const i = Math.floor((x - g.minX) / g.res), j = Math.floor((z - g.minZ) / g.res);
  if (i < 0 || j < 0 || i >= g.width || j >= g.depth) return null;
  const k = g.ids[i + j * g.width];
  return k < 0 ? null : g.palette[k];
}

/** Connected pieces (8-neighbour) of a set of "x,z" keys, largest first, then by their smallest key (z, then x). */
export function pieces(cells) {
  const left = new Set(cells), out = [];
  const key = (x, z) => `${x},${z}`;
  for (const k of [...cells].sort(byZX)) {
    if (!left.has(k)) continue;
    const comp = [k];
    left.delete(k);
    for (let i = 0; i < comp.length; i++) {
      const [x, z] = comp[i].split(',').map(Number);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const n = key(x + dx, z + dz);
        if (left.has(n)) { left.delete(n); comp.push(n); }
      }
    }
    out.push(comp);
  }
  out.sort((a, b) => b.length - a.length || byZX(a[0], b[0]));
  return out;
}
function byZX(a, b) {
  const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number);
  return az - bz || ax - bx;
}

/**
 * Order a connected piece into a spine: the cells on the path between its two farthest cells (two BFS sweeps, 8-neighbour; ties by
 * z, then x), as [[x, z]], then thinned to a 4-connected polyline. Deterministic.
 */
export function spineOf(piece) {
  const set = new Set(piece);
  const bfs = (start) => {
    const dist = new Map([[start, 0]]), prev = new Map();
    const q = [start];
    for (let i = 0; i < q.length; i++) {
      const [x, z] = q[i].split(',').map(Number);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const n = `${x + dx},${z + dz}`;
        if (!set.has(n) || dist.has(n)) continue;
        dist.set(n, dist.get(q[i]) + 1); prev.set(n, q[i]); q.push(n);
      }
    }
    let far = start;
    for (const [k, d] of dist) if (d > dist.get(far) || (d === dist.get(far) && byZX(k, far) < 0)) far = k;
    return { far, prev };
  };
  const first = [...piece].sort(byZX)[0];
  const a = bfs(first).far;
  const { far: b, prev } = bfs(a);
  const path = [b];
  while (path[path.length - 1] !== a) path.push(prev.get(path[path.length - 1]));
  const pts = path.map((k) => k.split(',').map(Number));
  // 4-connected: a diagonal step gets the cell between (x first)
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [px, pz] = out[out.length - 1], [x, z] = pts[i];
    if (px !== x && pz !== z) out.push([x, pz]);
    out.push([x, z]);
  }
  return out;
}

/** The claim's columns as a grid helper over a (resolution-1) survey. */
function gridOf(cols, claim) {
  const r = cols.resolution;
  const idx = (x, z) => {
    const i = Math.floor((x - cols.minX) / r), j = Math.floor((z - cols.minZ) / r);
    return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? -1 : i + j * cols.width;
  };
  const inClaim = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  return { r, idx, inClaim };
}

/**
 * A biome edge between families `fa` and `fb`: the land columns (inside the claim's `margin`) on the `fa` side whose 4x4 cell meets a
 * `fb` cell (4-neighbour) - the edge as `fa`'s border row. Returns `{cells: Set<"x,z">, faCells, fbCells}` (counts) or empty.
 */
export function biomeEdgeCells(cols, claim, biomes, [fa, fb], { margin = 2 } = {}) {
  const G = gridOf(cols, claim);
  const fam = (i, j) => { if (i < 0 || j < 0 || i >= biomes.width || j >= biomes.depth) return null; const k = biomes.ids[i + j * biomes.width]; return k < 0 ? null : familyOf(biomes.palette[k]); };
  const cells = new Set();
  let na = 0, nb = 0;
  for (let j = 0; j < biomes.depth; j++) for (let i = 0; i < biomes.width; i++) {
    const f = fam(i, j);
    if (f === fa) na++; else if (f === fb) nb++;
    if (f !== fa) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (fam(i + di, j + dj) !== fb) continue;
      // the fa cell's 4 columns along the shared side
      for (let t = 0; t < 4; t++) {
        const x = biomes.minX + i * 4 + (di === 1 ? 3 : di === -1 ? 0 : t), z = biomes.minZ + j * 4 + (dj === 1 ? 3 : dj === -1 ? 0 : t);
        if (x < claim.minX + margin || x > claim.maxX - margin || z < claim.minZ + margin || z > claim.maxZ - margin) continue;
        const k = G.idx(x, z);
        if (k < 0 || cols.flags[k] & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) continue;
        cells.add(`${x},${z}`);
      }
    }
  }
  return { cells, faCells: na, fbCells: nb };
}

/** A river or shore: land columns 4-adjacent to water of a body of at least `minArea` columns (inside the claim's margin). */
export function shoreCells(cols, claim, { minArea = 64, margin = 2 } = {}) {
  const G = gridOf(cols, claim);
  const W = cols.width, D = cols.depth, n = W * D;
  const body = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let k = 0; k < n; k++) {
    if (!(cols.flags[k] & FLAG_WATER) || body[k] >= 0) continue;
    const id = sizes.length, q = [k];
    body[k] = id;
    for (let i = 0; i < q.length; i++) {
      const c = q[i], ci = c % W, cj = (c - ci) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = ci + di, b = cj + dj;
        if (a < 0 || b < 0 || a >= W || b >= D) continue;
        const t = a + b * W;
        if (body[t] < 0 && cols.flags[t] & FLAG_WATER) { body[t] = id; q.push(t); }
      }
    }
    sizes.push(q.length * cols.resolution * cols.resolution);
  }
  const cells = new Set();
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W;
    if (cols.flags[k] & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) continue;
    const x = cols.minX + i * cols.resolution, z = cols.minZ + j * cols.resolution;
    if (x < claim.minX + margin || x > claim.maxX - margin || z < claim.minZ + margin || z > claim.maxZ - margin) continue;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= W || b >= D) continue;
      const t = a + b * W;
      if (body[t] >= 0 && sizes[body[t]] >= minArea) { cells.add(`${x},${z}`); break; }
    }
  }
  void G;
  return { cells, bodies: sizes.filter((s) => s >= minArea).length };
}

/**
 * A ridge: land columns on a crest of the ground smoothed over 5 x 5: in one of four directions (x, z, the two diagonals) no higher
 * smoothed column within 3 either way, and at least `minRise` above the lowest one within `radius` on both sides; the crest cells are
 * then grown by one (8-neighbour) so a crest the smoothing breaks stays one piece (inside the claim's margin).
 */
export function ridgeCells(cols, claim, { minRise = 8, radius = 12, margin = 2 } = {}) {
  const W = cols.width, D = cols.depth, r = cols.resolution;
  const R = Math.max(1, Math.floor(radius / r));
  // the smoothed ground (5 x 5 mean, floored; water and unknown columns take their own ground)
  const sm = new Int32Array(W * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    let sum = 0, n = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= W || b >= D) continue;
      sum += cols.ground[a + b * W]; n++;
    }
    sm[i + j * W] = Math.floor(sum / n);
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= W || j >= D ? null : sm[i + j * W]);
  const crest = new Set();
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
    const k = i + j * W;
    if (cols.flags[k] & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) continue;
    const y = sm[k];
    for (const [di, dj] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let top = true, lowA = y, lowB = y;
      for (let t = 1; t <= R; t++) {
        const ha = at(i + di * t, j + dj * t), hb = at(i - di * t, j - dj * t);
        if (t <= 3 && ((ha !== null && ha > y) || (hb !== null && hb > y))) { top = false; break; }
        if (ha !== null) lowA = Math.min(lowA, ha);
        if (hb !== null) lowB = Math.min(lowB, hb);
      }
      if (top && y - lowA >= minRise && y - lowB >= minRise) { crest.add(k); break; }
    }
  }
  const cells = new Set();
  for (const k of crest) {
    const i0 = k % W, j0 = (k - i0) / W;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i < 0 || j < 0 || i >= W || j >= D) continue;
      const kk = i + j * W;
      if (cols.flags[kk] & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) continue;
      const x = cols.minX + i * r, z = cols.minZ + j * r;
      if (x < claim.minX + margin || x > claim.maxX - margin || z < claim.minZ + margin || z > claim.maxZ - margin) continue;
      cells.add(`${x},${z}`);
    }
  }
  return { cells, crest: crest.size };
}

/**
 * The boundary a district follows (`follow`: `{biome_edge: {between: [a, b]}}`, `{shore: {minArea?}}` or `{ridge: {minRise?}}`) as a
 * spine: the longest connected piece (or, with `near` [x, z], the piece nearest it), at least `minLength` cells long. Returns
 * `{kind, spine: [[x, z]], cells: n, pieces: n}` or `{none: reason}` (NO_EDGE).
 */
export function traceBoundary(cols, claim, follow, { biomes = null, near = null, minLength = 16 } = {}) {
  const kind = Object.keys(follow ?? {})[0];
  let found;
  if (kind === 'biome_edge') {
    const between = follow.biome_edge?.between;
    if (!Array.isArray(between) || between.length !== 2) throw new Error('follow.biome_edge.between must name two biome families');
    if (!biomes) return { none: 'NO_EDGE: the plan has no biome grid (the helper sent none)' };
    found = biomeEdgeCells(cols, claim, biomes, between);
    if (!found.faCells || !found.fbCells) return { none: `NO_EDGE: no ${!found.faCells ? between[0] : between[1]} within the claim (biome families ${between.join(' / ')})` };
  } else if (kind === 'shore') found = shoreCells(cols, claim, { minArea: follow.shore?.minArea ?? 64 });
  else if (kind === 'ridge') found = ridgeCells(cols, claim, { minRise: follow.ridge?.minRise ?? 8 });
  else throw new Error('follow must be {biome_edge}, {shore} or {ridge}');
  if (!found.cells.size) return { none: `NO_EDGE: no ${kind.replace('_', ' ')} within the claim` };
  let ps = pieces(found.cells);
  if (near) {
    const d = (p) => Math.min(...p.map((k) => { const [x, z] = k.split(',').map(Number); return Math.max(Math.abs(x - near[0]), Math.abs(z - near[1])); }));
    ps = [...ps].sort((a, b) => d(a) - d(b) || b.length - a.length);
  }
  const spines = ps.slice(0, 8).map(spineOf).filter((s) => s.length >= minLength);
  if (!spines.length) return { none: `NO_EDGE: the ${kind.replace('_', ' ')} within the claim is shorter than ${minLength} (longest ${ps.length ? spineOf(ps[0]).length : 0})` };
  return { kind, spine: spines[0], cells: found.cells.size, pieces: ps.length };
}

/**
 * The normal of a spine at index i (its direction over +-k cells turned 90 degrees, as the dominant axis unit step: [dx, dz]) and the
 * side sign. Integer.
 */
export function normalAt(spine, i, k = 4) {
  const a = spine[Math.max(0, i - k)], b = spine[Math.min(spine.length - 1, i + k)];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  // left of travel (x east, z south): (dz, -dx), scaled to a Chebyshev length of 1 (a step of t along it is t cells out by the
  // grid's own distance, on a diagonal boundary too: an axis-snapped normal put a diagonal boundary's offset line at half its distance)
  const m = Math.max(Math.abs(dx), Math.abs(dz));
  return m ? [dz / m, -dx / m] : [1, 0];
}
