// (6c B) Terrain brushes (docs/CONTRACT.md "Phase 6c slice B"): the plan-time kernels of the bundled `brush` program
// (kit/regions/brush.mjs). Every kind's non-local work (local means, erosion, exposure counts, the cave worm) runs here, at plan
// time, over the plan survey or the frozen volume, and lands in the IR as `columns` ops (K2): the evaluator stays pointwise.
// Pure, integer arithmetic (Math.floor/sqrt/abs/min/max only), no clock: the same request and seed give the same IR.
import { VC } from './volume.mjs';

export const BRUSH_KINDS = Object.freeze(['smooth', 'erode', 'melt', 'blend', 'raise', 'lower', 'overlay', 'cave_carve']);
export const BRUSH_SHAPES = Object.freeze(['sphere', 'cylinder']);
export const DESTRUCTION = Object.freeze(['natural_only', 'player_blocks']);
/** `Limits.BRUSH_*` in the mod (a test holds them equal). */
export const BRUSH_LIMITS = Object.freeze({ radiusMin: 1, radiusMax: 32, strengthMin: 1, strengthMax: 16 });
/** The frozen volume reaches this far past the brush's box (MELT's neighbours, the cave's fluid and floating checks). */
export const VOLUME_PAD = 2;
/** The survey (the claim) reaches this far past the brush's box (CONTRACT B §2: "the brush box plus 8"). */
export const CLAIM_PAD = 8;
/** The voxel classes a NATURAL_ONLY stroke may remove (terrain; plants, trees and fluids are the column's own business). */
export const NATURAL_SOLID = Object.freeze([VC.ROCK, VC.SOIL, VC.LOOSE, VC.ICE, VC.SNOW]);
const FP = 16;
const TALUS = 2;

/** The brush's box: x/z within `radius` of the centre, y within `radius` (a cylinder is 2r+1 high), y clamped to [minY, maxY]. */
export function brushBox({ cx, cy, cz, radius }, { minY = -64, maxY = 319 } = {}) {
  return { minX: cx - radius, minZ: cz - radius, maxX: cx + radius, maxZ: cz + radius, minY: Math.max(minY, cy - radius), maxY: Math.min(maxY, cy + radius) };
}

/** The frozen volume's box: the brush box plus VOLUME_PAD on every side, y clamped. The mod computes the same box. */
export function volumeBox(b, { minY = -64, maxY = 319 } = {}) {
  const x = brushBox(b, { minY: -1e9, maxY: 1e9 });
  return { minX: x.minX - VOLUME_PAD, minZ: x.minZ - VOLUME_PAD, maxX: x.maxX + VOLUME_PAD, maxZ: x.maxZ + VOLUME_PAD,
    minY: Math.max(minY, x.minY - VOLUME_PAD), maxY: Math.min(maxY, x.maxY + VOLUME_PAD) };
}

/** Whether a stroke reads a frozen volume: MELT and CAVE_CARVE, and any mask with a block or class term. */
export function needsVolume(kind, maskSpec) {
  if (kind === 'melt' || kind === 'cave_carve') return true;
  if (!maskSpec) return false;
  const s = JSON.stringify(maskSpec);
  return /"(block|class)":/.test(s);
}

/** Whether cell (dx, dy, dz) from the centre is inside the shape. */
export function insideShape(shape, radius, dx, dy, dz) {
  const r2 = radius * radius;
  if (shape === 'sphere') return dx * dx + dy * dy + dz * dz <= r2;
  return dx * dx + dz * dz <= r2 && Math.abs(dy) <= radius;
}

/**
 * The surface grid of a stroke: the box's columns (W x D, from minX/minZ), each column's ground `g`, and `inside` (1 where the
 * column's ground lies inside the shape, the column is not water, lava or missing). `ground(x, z)` -> y | null (missing);
 * `wet(x, z)` -> bool.
 */
export function surfaceGrid({ cx, cy, cz, radius, shape }, ground, wet) {
  const minX = cx - radius - 1, minZ = cz - radius - 1, W = 2 * radius + 3, D = 2 * radius + 3;
  const g = new Int32Array(W * D), inside = new Uint8Array(W * D), d2 = new Int32Array(W * D), known = new Uint8Array(W * D);
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const x = minX + i, z = minZ + j, k = i + j * W;
      const y = ground(x, z);
      d2[k] = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (y === null || y === undefined) continue;
      known[k] = 1;
      g[k] = y;
      if (!wet(x, z) && insideShape(shape, radius, x - cx, y - cy, z - cz)) inside[k] = 1;
    }
  }
  // a missing column beside the shape reads as its own neighbour's ground (it never moves)
  for (let k = 0; k < W * D; k++) if (!known[k]) { const n = [k - 1, k + 1, k - W, k + W].find((q) => q >= 0 && q < W * D && known[q]); g[k] = n === undefined ? cy : g[n]; }
  return { minX, minZ, W, D, g, inside, d2, cx, cz, radius };
}

/**
 * The largest step between 4-neighbours that are both inside (the brush's own steps; a step to a column outside is the land's
 * edge, pinned).
 */
export function maxStep(grid, h = grid.g) {
  const { W, D, inside } = grid;
  let m = 0;
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const k = i + j * W;
      if (i + 1 < W && inside[k] && inside[k + 1]) m = Math.max(m, Math.abs(h[k] - h[k + 1]));
      if (j + 1 < D && inside[k] && inside[k + W]) m = Math.max(m, Math.abs(h[k] - h[k + W]));
    }
  }
  return m;
}

/** The sum of squared steps touching the inside columns (SMOOTH's energy). */
function stepEnergy(grid, h) {
  const { W, D, inside } = grid;
  let e = 0;
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const k = i + j * W;
      if (i + 1 < W && (inside[k] || inside[k + 1])) e += (h[k] - h[k + 1]) * (h[k] - h[k + 1]);
      if (j + 1 < D && (inside[k] || inside[k + W])) e += (h[k] - h[k + W]) * (h[k] - h[k + W]);
    }
  }
  return e;
}

/**
 * SMOOTH: the inside columns move toward their local integer mean (Jacobi over the 4-neighbourhood in 1/16 fixed point; the
 * columns outside the shape pin the edge), `2 * strength` sweeps. A sweep is kept only when neither the largest step between
 * inside columns nor the step energy (every step touching the inside) goes up, so the stroke never roughens the land. Returns the
 * new heights (Int32Array).
 */
export function smooth(grid, strength) {
  const { W, D, inside, g } = grid;
  let h = Int32Array.from(g);
  let f = new Int32Array(W * D);
  for (let k = 0; k < W * D; k++) f[k] = h[k] * FP;
  let best = maxStep(grid, h), energy = stepEnergy(grid, h);
  for (let it = 0; it < 2 * strength; it++) {
    const f2 = Int32Array.from(f);
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        const k = i + j * W;
        if (!inside[k]) continue;
        const e = i + 1 < W ? f[k + 1] : f[k], w = i > 0 ? f[k - 1] : f[k], s = j + 1 < D ? f[k + W] : f[k], n = j > 0 ? f[k - W] : f[k];
        f2[k] = Math.floor((e + w + s + n + 2 * f[k] + 3) / 6);
      }
    }
    const h2 = new Int32Array(W * D);
    for (let k = 0; k < W * D; k++) h2[k] = inside[k] ? Math.floor((f2[k] + FP / 2) / FP) : g[k];
    const m = maxStep(grid, h2), en = stepEnergy(grid, h2);
    if (m > best || en > energy) break;
    best = m; energy = en; f = f2; h = h2;
  }
  return stepDescent(grid, h, 4 * strength);
}

/**
 * SMOOTH's finish: up to `rounds` rounds, every pair of inside columns at the largest step M moves one block closer (the higher
 * down, else the lower up), when no step touching the moved column grows to M or past its old size. The largest inside step never
 * grows and drops where the pins allow. Mutates and returns `h`.
 */
export function stepDescent(grid, h, rounds) {
  const { W, D, inside } = grid;
  const nb = (k) => { const i = k % W, j = (k - i) / W, o = []; if (i > 0) o.push(k - 1); if (i + 1 < W) o.push(k + 1); if (j > 0) o.push(k - W); if (j + 1 < D) o.push(k + W); return o; };
  const can = (k, v, M) => {
    if (!inside[k]) return false;
    for (const n of nb(k)) {
      if (!inside[k] && !inside[n]) continue;
      const now = Math.abs(v - h[n]), was = Math.abs(h[k] - h[n]);
      if (now >= M && now > was) return false;
    }
    return true;
  };
  for (let r = 0; r < rounds; r++) {
    const M = maxStep(grid, h);
    if (M <= 1) break;
    let moved = 0;
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        const k = i + j * W;
        if (!inside[k]) continue;
        for (const n of [i + 1 < W ? k + 1 : -1, j + 1 < D ? k + W : -1]) {
          if (n < 0 || !inside[n] || Math.abs(h[k] - h[n]) < M) continue;
          const hi = h[k] > h[n] ? k : n, lo = hi === k ? n : k;
          if (can(hi, h[hi] - 1, M)) { h[hi]--; moved++; } else if (can(lo, h[lo] + 1, M)) { h[lo]++; moved++; }
        }
      }
    }
    if (!moved) break;
  }
  return h;
}

/**
 * RAISE (+1) / LOWER (-1): `sign * strength` at the centre, falling smoothly to 0 at the edge: a cylinder by (1 - d^2/r^2)^2, a
 * sphere by sqrt(1 - d^2/r^2) (a cap), rounded to whole blocks. Only inside columns move. Returns the new heights.
 */
export function raiseLower(grid, strength, sign, shape) {
  const { W, D, inside, g, d2, radius } = grid;
  const r2 = radius * radius;
  const h = Int32Array.from(g);
  for (let k = 0; k < W * D; k++) {
    if (!inside[k] || d2[k] >= r2) continue;
    h[k] = g[k] + sign * falloff(strength, d2[k], r2, shape);
  }
  return h;
}

/** The falloff's whole blocks at squared distance d2 of r2 (strength at 0, 0 at r2 and beyond). */
export function falloff(strength, d2, r2, shape) {
  if (d2 >= r2) return 0;
  if (d2 <= 0) return strength;
  if (shape === 'sphere') {
    // strength * sqrt((r2 - d2) / r2), rounded: the largest n with n^2 * r2 <= strength^2 * (r2 - d2) + rounding
    const num = strength * strength * (r2 - d2);
    let n = Math.floor(Math.sqrt(num / r2));
    while ((n + 1) * (n + 1) * r2 <= num) n++;
    while (n * n * r2 > num) n--;
    // round to nearest: compare (n + 0.5)^2 with num / r2 in integers: (2n + 1)^2 * r2 <= 4 * num
    return (2 * n + 1) * (2 * n + 1) * r2 <= 4 * num ? n + 1 : n;
  }
  const a = r2 - d2;
  return Math.floor((2 * strength * a * a + r2 * r2) / (2 * r2 * r2));
}

/**
 * ERODE: thermal sweeps (a drop over 2 slides one block to the lowest 4-neighbour) and stream sweeps (D8 accumulation, highest
 * first, cuts one block where it reaches 24), inside columns only, at most `strength` extra |dh| per column. Returns the new heights.
 */
export function erode(grid, strength, { thermal = 2 * strength, stream = strength, streamAt = 24 } = {}) {
  const { W, D, inside, g } = grid;
  const n = W * D;
  const H = Int32Array.from(g);
  const can = (i, d) => inside[i] && Math.abs(H[i] + d - g[i]) <= strength;
  for (let it = 0; it < thermal; it++) {
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const i = x + z * W;
        if (!inside[i]) continue;
        let low = -1, lv = H[i];
        if (x + 1 < W && inside[i + 1] && H[i + 1] < lv) { low = i + 1; lv = H[i + 1]; }
        if (x > 0 && inside[i - 1] && H[i - 1] < lv) { low = i - 1; lv = H[i - 1]; }
        if (z + 1 < D && inside[i + W] && H[i + W] < lv) { low = i + W; lv = H[i + W]; }
        if (z > 0 && inside[i - W] && H[i - W] < lv) { low = i - W; lv = H[i - W]; }
        if (low < 0 || H[i] - lv <= TALUS) continue;
        if (!can(i, -1) || !can(low, 1)) continue;
        H[i]--; H[low]++;
      }
    }
  }
  for (let it = 0; it < stream; it++) {
    const cells = [];
    for (let i = 0; i < n; i++) if (inside[i]) cells.push(i);
    cells.sort((a, b) => H[b] - H[a] || a - b);
    const acc = new Int32Array(n);
    for (const i of cells) {
      acc[i] += 1;
      const x = i % W, z = (i - x) / W;
      let low = -1, lv = H[i];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const X = x + dx, Z = z + dz;
          if (X < 0 || Z < 0 || X >= W || Z >= D) continue;
          const j = X + Z * W;
          if (inside[j] && H[j] < lv) { low = j; lv = H[j]; }
        }
      }
      if (low >= 0) acc[low] += acc[i];
    }
    for (const i of cells) if (acc[i] >= streamAt && can(i, -1)) H[i]--;
  }
  return H;
}

/**
 * BLEND: the inside columns within a third of the radius keep their ground (the cut or fill at the centre), the columns outside the
 * shape are the land; the ring between relaxes (Jacobi, `4 * radius` sweeps in 1/16 fixed point) so the centre meets the land,
 * each column within `strength` of its ground. Returns the new heights.
 */
export function blend(grid, strength) {
  const { W, D, inside, g, d2, radius } = grid;
  const core = Math.floor((radius * radius) / 9);
  const free = new Uint8Array(W * D);
  for (let k = 0; k < W * D; k++) free[k] = inside[k] && d2[k] > core ? 1 : 0;
  let f = new Int32Array(W * D);
  for (let k = 0; k < W * D; k++) f[k] = g[k] * FP;
  for (let it = 0; it < 4 * radius; it++) {
    const f2 = Int32Array.from(f);
    for (let j = 0; j < D; j++) {
      for (let i = 0; i < W; i++) {
        const k = i + j * W;
        if (!free[k]) continue;
        const e = i + 1 < W ? f[k + 1] : f[k], w = i > 0 ? f[k - 1] : f[k], s = j + 1 < D ? f[k + W] : f[k], n = j > 0 ? f[k - W] : f[k];
        let v = Math.floor((e + w + s + n + 2) / 4);
        const lo = (g[k] - strength) * FP, hi = (g[k] + strength) * FP;
        if (v < lo) v = lo; else if (v > hi) v = hi;
        f2[k] = v;
      }
    }
    f = f2;
  }
  const h = Int32Array.from(g);
  for (let k = 0; k < W * D; k++) if (free[k]) h[k] = Math.floor((f[k] + FP / 2) / FP);
  return h;
}

/**
 * The columns of a height change, for a `columns` op from/to `{surface: 0}`: a fill writes the old top and the new cells (the
 * subsurface role under the surface role, or the pattern), a cut writes air from the new top + 1 to the old top. Returns
 * `{cols: [x, z, a, b, m]..., moved, raised, lowered}` with materials 0 air, 1 surface, 2 subsurface, 3 pattern.
 */
export function heightCols(grid, h, { pattern = false } = {}) {
  const { W, D, inside, g, minX, minZ } = grid;
  const cols = [];
  let moved = 0, raised = 0, lowered = 0;
  for (let j = 0; j < D; j++) {
    for (let i = 0; i < W; i++) {
      const k = i + j * W;
      if (!inside[k]) continue;
      const dh = h[k] - g[k];
      if (dh === 0) continue;
      moved++;
      const x = minX + i, z = minZ + j;
      if (dh > 0) {
        raised++;
        if (pattern) cols.push(x, z, 0, dh, 3);
        else cols.push(x, z, 0, dh - 1, 2, x, z, dh, dh, 1);
      } else {
        lowered++;
        cols.push(x, z, dh + 1, 0, 0);
      }
    }
  }
  return { cols, moved, raised, lowered };
}

/** The voxel classes a stroke may remove: natural terrain, and with PLAYER_BLOCKS also unowned player and block-entity cells. */
export function removable(destruction) {
  const s = new Set(NATURAL_SOLID);
  if (destruction === 'player_blocks') { s.add(VC.PLAYER); s.add(VC.BLOCK_ENTITY); }
  return s;
}

const airLike = (c) => c === VC.AIR || c === VC.PLANT;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * MELT: `strength` rounds; each round removes every removable cell inside the shape with at least 4 air (or plant) neighbours of
 * 6, counted against the world as the previous rounds left it (spikes and overhangs round off). `cls(x, y, z)` -> class (MISSING
 * outside the volume). Returns `{cells: [[x, y, z]...] (sorted), rounds: [n per round]}`; it only ever removes.
 */
export function melt({ cx, cy, cz, radius, shape }, strength, cls, destruction = 'natural_only') {
  const may = removable(destruction);
  const gone = new Set();
  const key = (x, y, z) => `${x},${y},${z}`;
  const at = (x, y, z) => (gone.has(key(x, y, z)) ? VC.AIR : cls(x, y, z));
  const rounds = [];
  for (let r = 0; r < strength; r++) {
    const now = [];
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        for (let y = cy - radius; y <= cy + radius; y++) {
          if (!insideShape(shape, radius, x - cx, y - cy, z - cz)) continue;
          if (gone.has(key(x, y, z)) || !may.has(cls(x, y, z))) continue;
          let air = 0, missing = false;
          for (const [a, b, c] of N6) {
            const v = at(x + a, y + b, z + c);
            if (v === VC.MISSING) missing = true;
            if (airLike(v)) air++;
          }
          if (!missing && air >= 4) now.push([x, y, z]);
        }
      }
    }
    for (const [x, y, z] of now) gone.add(key(x, y, z));
    rounds.push(now.length);
    if (!now.length) break;
  }
  const cells = [...gone].map((k) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  return { cells, rounds };
}

/**
 * CAVE_CARVE: a seeded worm from the centre, resolved at plan time to a capsule chain (`segments` of up to `radius` cells in all,
 * radius `tube` = 1.5 + strength / 4, at most 4.5), its floor levelled (no cell below the centre line's y - floor(tube / 2)), only
 * removable cells carved. The worm stops before a segment whose cells come within one cell (26-neighbourhood) of water, lava or an
 * unknown (MISSING) cell (M4: no breach). Cells of the solid land left floating by the carve (6-connected components that no longer
 * reach the volume's faces) go too (M3). `rng()` -> [0, 1). Returns `{cells, points, tube, stopped, floating}`.
 */
export function caveWorm({ cx, cy, cz, radius, shape }, strength, cls, rng, box, destruction = 'natural_only') {
  const may = removable(destruction);
  const tube = Math.min(4.5, 1.5 + strength / 4);
  const steps = Math.max(1, Math.floor(radius / 2));
  const stepLen = 2;
  // the heading: a compass yaw in 16ths (no trig), a gentle pitch in [-1, 1] per step of 2
  const DIRS = [[16, 0], [15, 6], [11, 11], [6, 15], [0, 16], [-6, 15], [-11, 11], [-15, 6], [-16, 0], [-15, -6], [-11, -11], [-6, -15], [0, -16], [6, -15], [11, -11], [15, -6]];
  let yaw = Math.floor(rng() * 16);
  const points = [[cx, cy, cz]];
  let px = cx, py = cy, pz = cz;
  for (let s = 0; s < steps; s++) {
    yaw = (yaw + 16 + (Math.floor(rng() * 3) - 1)) % 16;
    const pitch = Math.floor(rng() * 3) - 1;
    const [dx, dz] = DIRS[yaw];
    const nx = px + Math.floor((dx * stepLen + 8) / 16), nz = pz + Math.floor((dz * stepLen + 8) / 16), ny = py + (s % 2 === 0 ? pitch : 0);
    if (!insideShape(shape, radius, nx - cx, ny - cy, nz - cz)) break;
    points.push([nx, ny, nz]);
    px = nx; py = ny; pz = nz;
  }
  const key = (x, y, z) => `${x},${y},${z}`;
  const carved = new Map();
  const reach = Math.ceil(tube);
  const segCells = (a, b) => {
    const out = [];
    const minx = Math.min(a[0], b[0]) - reach, maxx = Math.max(a[0], b[0]) + reach;
    const miny = Math.min(a[1], b[1]) - reach, maxy = Math.max(a[1], b[1]) + reach;
    const minz = Math.min(a[2], b[2]) - reach, maxz = Math.max(a[2], b[2]) + reach;
    const vx = b[0] - a[0], vy = b[1] - a[1], vz = b[2] - a[2];
    const vv = vx * vx + vy * vy + vz * vz;
    for (let x = minx; x <= maxx; x++) {
      for (let z = minz; z <= maxz; z++) {
        for (let y = miny; y <= maxy; y++) {
          const wx = x - a[0], wy = y - a[1], wz = z - a[2];
          let t = vv === 0 ? 0 : (wx * vx + wy * vy + wz * vz) / vv;
          t = Math.max(0, Math.min(1, t));
          const qx = a[0] + t * vx, qy = a[1] + t * vy, qz = a[2] + t * vz;
          const ex = x - qx, ey = y - qy, ez = z - qz;
          if (ex * ex + ey * ey + ez * ez > tube * tube) continue;
          if (y < Math.floor(qy + 0.5) - Math.floor(tube / 2)) continue; // the levelled floor
          if (!insideShape(shape, radius, x - cx, y - cy, z - cz)) continue;
          if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY || z < box.minZ || z > box.maxZ) continue;
          out.push([x, y, z]);
        }
      }
    }
    return out;
  };
  const breach = (cells) => {
    for (const [x, y, z] of cells) {
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const v = cls(x + a, y + b, z + c);
        if (v === VC.WATER || v === VC.LAVA || v === VC.MISSING) return true;
      }
    }
    return false;
  };
  let stopped = null;
  const segs = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
  for (let s = 0; s < segs.length; s++) {
    const cells = segCells(segs[s][0], segs[s][1]);
    if (breach(cells)) { stopped = s; break; }
    for (const [x, y, z] of cells) if (may.has(cls(x, y, z))) carved.set(key(x, y, z), [x, y, z]);
  }
  // M3: solid cells cut off by the carve (not reaching the volume box's faces through solid cells) go too, when removable
  const solid = (x, y, z) => { if (carved.has(key(x, y, z))) return false; const v = cls(x, y, z); return v !== VC.AIR && v !== VC.WATER && v !== VC.LAVA && v !== VC.PLANT && v !== VC.MISSING; };
  const floating = [];
  if (carved.size) {
    const seen = new Set();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const [x, y, z] of carved.values()) { lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z); }
    // candidates: solid cells beside the carve; each component is flood-filled within the volume box (a component touching the
    // box's faces is anchored)
    for (const [x, y, z] of carved.values()) {
      for (const [a, b, c] of N6) {
        const sx = x + a, sy = y + b, sz = z + c, k0 = key(sx, sy, sz);
        if (seen.has(k0) || !solid(sx, sy, sz)) continue;
        const comp = [];
        const todo = [[sx, sy, sz]];
        seen.add(k0);
        let anchored = false;
        while (todo.length && !anchored) {
          const [qx, qy, qz] = todo.pop();
          comp.push([qx, qy, qz]);
          if (qx <= box.minX || qx >= box.maxX || qy <= box.minY || qy >= box.maxY || qz <= box.minZ || qz >= box.maxZ) { anchored = true; break; }
          for (const [d, e, f] of N6) {
            const nx = qx + d, ny = qy + e, nz = qz + f, k = key(nx, ny, nz);
            if (seen.has(k) || !solid(nx, ny, nz)) continue;
            seen.add(k);
            todo.push([nx, ny, nz]);
          }
        }
        if (anchored) continue;
        for (const c of comp) {
          if (may.has(cls(c[0], c[1], c[2]))) floating.push(c);
        }
      }
    }
    for (const c of floating) carved.set(key(c[0], c[1], c[2]), c);
  }
  const cells = [...carved.values()].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  return { cells, points, tube, stopped, floating: floating.length };
}

/** Cells as `columns` entries [x, z, y0, y1, m] (vertical runs; absolute y: the op's from/to are 0). */
export function cellCols(cells, m = 0) {
  const by = new Map();
  for (const [x, y, z] of cells) { const k = `${x},${z}`; let a = by.get(k); if (!a) { a = []; by.set(k, a); } a.push(y); }
  const keys = [...by.keys()].map((k) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [x, z] of keys) {
    const ys = by.get(`${x},${z}`).sort((a, b) => a - b);
    let s = ys[0], p = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      if (i < ys.length && ys[i] === p + 1) { p = ys[i]; continue; }
      out.push(x, z, s, p, m);
      if (i < ys.length) { s = ys[i]; p = ys[i]; }
    }
  }
  return out;
}
