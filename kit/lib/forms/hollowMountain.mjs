// The `hollowMountain` generator, version 1 (docs/CONTRACT.md "Phase 7c" §3 row 2, slice BF): a mountain with a lit cavern inside it,
// for a hold, a mine or a hall carved in the rock. Plan time only; integer maths and Math.sqrt (exact) only: no trig, no Math.random,
// no Date. Deterministic: the same params, ground and seed give byte-identical ops.
//
// - The mass: an elliptical cone over `rect` (its foot the rect's inscribed ellipse) rising `height` over the base (the median of the
//   survey's ground over the rect), with a smooth lattice bump of 0..2. Written IF_AIR_OR_FLUID, so land that already stands higher (a
//   real mountain) is kept and only what is missing is raised. Materials: the `surface` role on the top cell below the tree line (70% of
//   the height), the `subsurface` role 3 under it, the `rock` role elsewhere (all natural in the default Style: free in survival).
// - The cavern (6b `cavern`'s rules, for a hollow the plan raises itself, which 6b's primitive does not carve: it keeps to the survey's
//   ground): an ellipse of half the mountain's radii, its floor flat at base + 1, its walls vertical for WALL cells (a cliff face) and
//   its ceiling a dome up to `cavern` high. **Light is mandatory**: a shroomlight set into the floor every LIGHT_EVERY cells (and on
//   every floor cell left more than LIGHT_EVERY / 2 from one), so no floor cell is dark (M5 reads the `caverns` meta the caller records).
// - The gallery: a ledge 3 deep along the cavern's back wall (opposite the entrance), its top 3 over the floor (a LEDGE: drop 3 on the
//   open side, never over 3: no rail needed, M8; the wall rising over it).
// - The halls: up to 3 box chambers (7 wide, 5 high, up to 9 deep) off the cavern's sides (not the entrance's), each only as deep as
//   leaves at least ROOF cells of rock over it, one light at its middle.
// - The entrance: a 3-wide, 4-high tunnel from the cavern out through the mountainside on the `entrance` side, lit like the floor.
// Returns `{ops, bounds, generator, version, params, seed, base, floorY, cavern, halls, entrance, solid(x, y, z), void(x, y, z), lights}`:
// `solid` and `void` describe the form's own cells (for the caller's affordance analysis over its virtual land).
import { fnv64, hash3 } from '../noise.mjs';

export const GENERATOR = 'hollowMountain';
export const VERSION = 1;
/** The cavern's vertical wall (a cliff face, AF's face.minHeight is 6). */
export const WALL = 8;
/** The least rock left over a hall or the cavern. */
export const ROOF = 3;
export const LIGHT_EVERY = 6;
export const HALL = Object.freeze({ width: 7, height: 5, depth: [5, 9] });
export const LEDGE = Object.freeze({ depth: 3, rise: 3 });
const SIDES = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] });
const isInt = Number.isInteger;

/** Validate the params; returns them with defaults filled. */
export function mountainParams(p) {
  const rect = p.rect;
  if (!rect || ![rect.minX, rect.minZ, rect.maxX, rect.maxZ].every(isInt) || rect.maxX - rect.minX < 23 || rect.maxZ - rect.minZ < 23) throw new Error('hollowMountain: rect needs integer minX..maxZ, at least 24 across');
  const w = rect.maxX - rect.minX + 1, d = rect.maxZ - rect.minZ + 1;
  const height = p.height ?? Math.max(20, Math.min(64, Math.floor((Math.min(w, d) * 3) / 5)));
  if (!(isInt(height) && height >= 20 && height <= 64)) throw new Error('hollowMountain: height must be 20..64');
  const halls = p.halls ?? 2;
  if (!(isInt(halls) && halls >= 0 && halls <= 3)) throw new Error('hollowMountain: halls must be 0..3');
  const entrance = p.entrance ?? 'south';
  if (!SIDES[entrance]) throw new Error('hollowMountain: entrance must be north, south, east or west');
  if (typeof p.groundAt !== 'function') throw new Error('hollowMountain: groundAt(x, z) is required');
  return { rect: { minX: rect.minX, minZ: rect.minZ, maxX: rect.maxX, maxZ: rect.maxZ }, height, halls, entrance, seed: String(p.seed ?? '1'), groundAt: p.groundAt };
}

/** The sides a hall may open on (every side but the entrance's, the back first), in a fixed order. */
export function hallSides(entrance) {
  const back = { north: 'south', south: 'north', east: 'west', west: 'east' }[entrance];
  return [back, ...['east', 'west', 'north', 'south'].filter((s) => s !== back && s !== entrance)];
}

export function hollowMountain(params) {
  const p = mountainParams(params);
  const { rect, height: H, seed } = p;
  const w = rect.maxX - rect.minX + 1, d = rect.maxZ - rect.minZ + 1;
  // the centre (doubled, so even sides stay exact) and the radii
  const cx2 = rect.minX + rect.maxX, cz2 = rect.minZ + rect.maxZ;
  const rx = (w - 1) / 2, rz = (d - 1) / 2;
  const gs = [];
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) gs.push(p.groundAt(x, z));
  gs.sort((a, b) => a - b);
  const base = gs[Math.floor(gs.length / 2)];
  const floorY = base + 1;
  const k = fnv64(seed, GENERATOR, 'bump');
  // a smooth lattice bump 0..2: bilinear over a 6-cell lattice of hashed corners (integers only)
  const corner = (ix, iz) => hash3(k.hi, k.lo, ix, 0, iz) % 3;
  const bump = (x, z) => {
    const ix = Math.floor(x / 6), iz = Math.floor(z / 6), fx = x - ix * 6, fz = z - iz * 6;
    const a = corner(ix, iz) * (6 - fx) + corner(ix + 1, iz) * fx, b = corner(ix, iz + 1) * (6 - fx) + corner(ix + 1, iz + 1) * fx;
    return Math.floor((a * (6 - fz) + b * fz + 18) / 36);
  };
  /** The mass's top over (x, z) (null outside its foot). */
  const tops = new Map();
  const topAt = (x, z) => {
    const key = `${x},${z}`;
    if (tops.has(key)) return tops.get(key);
    const dx = (2 * x - cx2) / 2, dz = (2 * z - cz2) / 2;
    const t = (dx * dx) / (rx * rx) + (dz * dz) / (rz * rz);
    const v = t > 1 ? null : base + Math.floor(H * (1 - Math.sqrt(t)) + 0.5) + bump(x, z);
    tops.set(key, v);
    return v;
  };
  // the cavern: half the radii, a dome over WALL vertical cells
  const crx = rx / 2, crz = rz / 2;
  const domeH = Math.max(WALL, Math.min(16, Math.floor(H / 2)));
  const ceilAt = (x, z) => {
    const dx = (2 * x - cx2) / 2, dz = (2 * z - cz2) / 2;
    const t = (dx * dx) / (crx * crx) + (dz * dz) / (crz * crz);
    if (t > 1) return null;
    return floorY + WALL - 1 + Math.floor((domeH - WALL) * Math.sqrt(1 - t) + 0.5);
  };
  const voids = new Map(); // "x,z" -> [[y0, y1], ...] (the form's air)
  const floors = new Map(); // "x,z" -> y (the floor cell, solid, under a void at floorY or the ledge's top + 1)
  const addVoid = (x, z, y0, y1) => { if (y1 < y0) return; const key = `${x},${z}`; const l = voids.get(key) ?? []; l.push([y0, y1]); voids.set(key, l); };
  const [ex, ez] = SIDES[p.entrance];
  const back = hallSides(p.entrance)[0];
  const [bx, bz] = SIDES[back];
  // the cavern and the ledge along its back wall (the cavern cells within LEDGE.depth of the back edge, along the back axis)
  const cavX0 = Math.ceil((cx2 - 2 * crx) / 2), cavX1 = Math.floor((cx2 + 2 * crx) / 2), cavZ0 = Math.ceil((cz2 - 2 * crz) / 2), cavZ1 = Math.floor((cz2 + 2 * crz) / 2);
  const inCav = (x, z) => ceilAt(x, z) !== null;
  const onLedge = (x, z) => {
    if (!inCav(x, z)) return false;
    for (let s = 1; s <= LEDGE.depth; s++) if (!inCav(x + bx * s, z + bz * s)) return true;
    return false;
  };
  let ledgeCells = 0;
  for (let z = cavZ0; z <= cavZ1; z++) for (let x = cavX0; x <= cavX1; x++) {
    const c = ceilAt(x, z);
    if (c === null) continue;
    if (onLedge(x, z)) { addVoid(x, z, floorY + LEDGE.rise, c); floors.set(`${x},${z}`, floorY + LEDGE.rise - 1); ledgeCells++; } else { addVoid(x, z, floorY, c); floors.set(`${x},${z}`, base); }
  }
  // the halls: off the cavern's edge on each side but the entrance's, as deep as the roof allows
  const halls = [];
  const half = (HALL.width - 1) / 2;
  for (const side of hallSides(p.entrance).slice(0, p.halls)) {
    const [sx, sz] = SIDES[side];
    // the cavern's edge cell on the axis through the centre, on that side
    let ox = Math.floor(cx2 / 2), oz = Math.floor(cz2 / 2);
    while (inCav(ox + sx, oz + sz)) { ox += sx; oz += sz; }
    const y1 = floorY + HALL.height - 1;
    let depth = 0;
    for (let s = 1; s <= HALL.depth[1]; s++) {
      let ok = true;
      for (let q = -half; q <= half && ok; q++) {
        const x = ox + sx * s + (sz !== 0 ? q : 0), z = oz + sz * s + (sx !== 0 ? q : 0);
        const t = topAt(x, z);
        if (t === null || t - y1 < ROOF) ok = false;
      }
      if (!ok) break;
      depth = s;
    }
    if (depth < HALL.depth[0]) { halls.push({ side, depth: 0, skipped: true }); continue; }
    const cells = [];
    for (let s = 1; s <= depth; s++) for (let q = -half; q <= half; q++) {
      const x = ox + sx * s + (sz !== 0 ? q : 0), z = oz + sz * s + (sx !== 0 ? q : 0);
      if (floors.has(`${x},${z}`)) continue;
      addVoid(x, z, floorY, y1); floors.set(`${x},${z}`, base); cells.push([x, z]);
    }
    const mid = [ox + sx * Math.ceil(depth / 2), oz + sz * Math.ceil(depth / 2)];
    halls.push({ side, depth, from: [ox + sx, floorY, oz + sz], mid: [mid[0], floorY, mid[1]], box: hallBox(ox, oz, sx, sz, depth, half, floorY, y1) });
  }
  // the entrance: from the cavern's edge outward until the mass's top is under the tunnel's floor (out in the open)
  let ox = Math.floor(cx2 / 2), oz = Math.floor(cz2 / 2);
  while (inCav(ox + ex, oz + ez)) { ox += ex; oz += ez; }
  const tunnel = [];
  for (let s = 1; s < 4 * Math.max(w, d); s++) {
    let open = true;
    for (let q = -1; q <= 1; q++) {
      const x = ox + ex * s + (ez !== 0 ? q : 0), z = oz + ez * s + (ex !== 0 ? q : 0);
      const t = Math.max(topAt(x, z) ?? -Infinity, p.groundAt(x, z));
      if (t >= floorY) {
        open = false;
        if (!floors.has(`${x},${z}`)) { addVoid(x, z, floorY, Math.min(floorY + 3, t)); floors.set(`${x},${z}`, base); tunnel.push([x, z]); }
      }
    }
    if (open) { ox += ex * s; oz += ez * s; break; }
  }
  const mouth = [ox, floorY, oz];
  // the lights: a grid over the floor cells, then every floor cell left more than LIGHT_EVERY / 2 from one
  const lights = [];
  const h2 = LIGHT_EVERY >> 1;
  const floorList = [...floors.entries()].map(([kk, y]) => { const [x, z] = kk.split(',').map(Number); return [x, y, z]; }).sort((a, b) => a[2] - b[2] || a[0] - b[0]);
  for (const [x, y, z] of floorList) if (((x - rect.minX) % LIGHT_EVERY + LIGHT_EVERY) % LIGHT_EVERY === h2 && ((z - rect.minZ) % LIGHT_EVERY + LIGHT_EVERY) % LIGHT_EVERY === h2) lights.push([x, y, z]);
  for (const [x, y, z] of floorList) {
    if (lights.some(([lx, ly, lz]) => ly === y && Math.abs(lx - x) <= h2 && Math.abs(lz - z) <= h2)) continue;
    lights.push([x, y, z]);
  }
  lights.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  const lit = new Set(lights.map(([x, y, z]) => `${x},${y},${z}`));
  // the ops: the mass (solid runs around the voids, IF_AIR_OR_FLUID), the voids over natural land (IF_NATURAL air), the floor and
  // lights (ALWAYS_OURS: the floor is the mass's own cell or the land's)
  const treeLine = base + Math.floor((H * 7) / 10);
  const mass = [], cut = [], floorOps = [];
  const M_ROCK = 0, M_SUB = 1, M_SURF = 2, M_LIGHT = 3;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity, by1 = -Infinity;
  const cols = [];
  for (let z = rect.minZ - 1; z <= rect.maxZ + 1; z++) for (let x = rect.minX - 1; x <= rect.maxX + 1; x++) cols.push([x, z]);
  for (const [x, z] of [...tunnel]) if (x < rect.minX || x > rect.maxX || z < rect.minZ || z > rect.maxZ) cols.push([x, z]);
  const seen = new Set();
  for (const [x, z] of cols) {
    const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = topAt(x, z), g = p.groundAt(x, z);
    const vs = (voids.get(key) ?? []).slice().sort((a, b) => a[0] - b[0]);
    if (t !== null && t > g) {
      // solid runs from the land's ground + 1 to the top, less the voids; the top cell's material by the tree line
      let y = g + 1;
      for (const [v0, v1] of [...vs, [t + 1, t + 1]]) {
        const a = y, b = Math.min(t, v0 - 1);
        if (b >= a) {
          // the surface layers only on the column's top run
          if (b === t) {
            const surf = t <= treeLine;
            const sub0 = surf ? Math.max(a, t - 3) : t + 1;
            if (sub0 - 1 >= a) mass.push(x, z, a, sub0 - 1, M_ROCK);
            if (surf) { if (t - 1 >= sub0) mass.push(x, z, sub0, t - 1, M_SUB); mass.push(x, z, t, t, M_SURF); }
          } else mass.push(x, z, a, b, M_ROCK);
        }
        y = Math.max(y, v1 + 1);
      }
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; if (t > by1) by1 = t;
    }
    // the voids where the land itself stands (a real mountain): cut to air, natural cells only
    for (const [v0, v1] of vs) { const top = Math.min(v1, g); if (top >= v0) cut.push(x, z, v0, top, 0); }
    const fy = floors.get(key);
    if (fy !== undefined) floorOps.push(x, z, fy, fy, lit.has(`${x},${fy},${z}`) ? M_LIGHT : M_ROCK);
    if (vs.length) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; }
  }
  const MATS = ['rock', 'subsurface', 'surface', 'minecraft:shroomlight'];
  const ops = [];
  if (mass.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: mass, materials: MATS, cond: 2, walk: false });
  if (cut.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: cut, materials: [null], cond: 0, walk: false });
  if (floorOps.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: floorOps, materials: MATS, cond: 3, walk: false });
  const bounds = { minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1, minY: Math.min(base, ...gs.slice(0, 1)), maxY: by1 };
  // the form's own cells, for an affordance analysis over its virtual land
  const voidAt = (x, y, z) => (voids.get(`${x},${z}`) ?? []).some(([a, b]) => y >= a && y <= b);
  const solidAt = (x, y, z) => {
    if (voidAt(x, y, z)) return false;
    const t = topAt(x, z);
    return y <= Math.max(p.groundAt(x, z), t ?? -Infinity);
  };
  return {
    generator: GENERATOR, version: VERSION, seed,
    params: { rect: p.rect, height: H, halls: p.halls, entrance: p.entrance },
    ops, bounds, base, floorY, topAt, solid: solidAt, void: voidAt, lights,
    cavern: { box: { minX: cavX0, maxX: cavX1, minZ: cavZ0, maxZ: cavZ1, minY: floorY, maxY: floorY + domeH - 1 }, ledge: { side: back, cells: ledgeCells, y: floorY + LEDGE.rise } },
    halls, entrance: { side: p.entrance, mouth, cells: tunnel.length },
  };
}

function hallBox(ox, oz, sx, sz, depth, half, y0, y1) {
  const xs = [ox + sx, ox + sx * depth], zs = [oz + sz, oz + sz * depth];
  if (sz !== 0) { xs[0] = ox - half; xs[1] = ox + half; }
  if (sx !== 0) { zs[0] = oz - half; zs[1] = oz + half; }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: y0, maxY: y1, minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}
