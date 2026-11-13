// The `crater` generator, version 1 (docs/CONTRACT.md "Phase 7c" §3 row 2, slice BF): a free-standing bowl, crater_works' shape as a
// part (its round carved bowl lined with rock and its raised rim) without the works (no terraces, rails, bridge or lots). Plan time
// only; integer maths and Math.sqrt (exact) only. Deterministic.
//
// - The bowl: the disc of radius R (the rect's inscribed circle less the rim's width) carved to air from the land's ground down to a
//   paraboloid bottom, `depth` under the base (the median of the survey's ground over the rect) at the centre and 0 at the edge, so
//   every slope is walkable near the rim and gentle at the floor. Natural cells only (IF_NATURAL).
// - The lining: the bottom cell of every bowl column, the `rock` role (IF_SOLID_NATURAL: over natural solid land only).
// - The rim: a ring RIM wide outside the bowl raised to `rim` over the base at its crest (a parabola across the ring), the `subsurface`
//   role with the `surface` role on top, IF_AIR_OR_FLUID (land that stands higher is kept).
// The lake (`lake: true`) is the caller's: an H pond body (lib/fluids/pond.mjs emitPond) in the floor, its surface `lakeLevel`, its
// water the disc `lakeRect` (the generator returns both).
// Returns `{ops, bounds, generator, version, params, seed, base, R, centre, bottomAt(x, z), lakeRect, lakeLevel, lakeDepth}`.
export const GENERATOR = 'crater';
export const VERSION = 1;
/** The rim's width (cells) outside the bowl. */
export const RIM = 4;
const isInt = Number.isInteger;

export function craterParams(p) {
  const rect = p.rect;
  if (!rect || ![rect.minX, rect.minZ, rect.maxX, rect.maxZ].every(isInt) || rect.maxX - rect.minX < 23 || rect.maxZ - rect.minZ < 23) throw new Error('crater: rect needs integer minX..maxZ, at least 24 across');
  const side = Math.min(rect.maxX - rect.minX + 1, rect.maxZ - rect.minZ + 1);
  const depth = p.depth ?? Math.max(6, Math.min(24, Math.floor(side / 5)));
  if (!(isInt(depth) && depth >= 6 && depth <= 24)) throw new Error('crater: depth must be 6..24');
  const rim = p.rim ?? 2;
  if (!(isInt(rim) && rim >= 0 && rim <= 6)) throw new Error('crater: rim must be 0..6');
  const lakeDepth = p.lakeDepth ?? 3;
  if (!(isInt(lakeDepth) && lakeDepth >= 1 && lakeDepth <= 6)) throw new Error('crater: lakeDepth must be 1..6');
  if (typeof p.groundAt !== 'function') throw new Error('crater: groundAt(x, z) is required');
  return { rect: { minX: rect.minX, minZ: rect.minZ, maxX: rect.maxX, maxZ: rect.maxZ }, depth, rim, lake: p.lake === true, lakeDepth, seed: String(p.seed ?? '1'), groundAt: p.groundAt };
}

export function crater(params) {
  const p = craterParams(params);
  const { rect, depth } = p;
  const side = Math.min(rect.maxX - rect.minX + 1, rect.maxZ - rect.minZ + 1);
  const cx = (rect.minX + rect.maxX) >> 1, cz = (rect.minZ + rect.maxZ) >> 1;
  const R = Math.floor((side - 1) / 2) - RIM;
  const gs = [];
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) gs.push(p.groundAt(x, z));
  gs.sort((a, b) => a - b);
  const base = gs[Math.floor(gs.length / 2)];
  const d2 = (x, z) => (x - cx) * (x - cx) + (z - cz) * (z - cz);
  /** The bowl's bottom (the lining cell) at (x, z), or null outside the bowl. */
  const bottomAt = (x, z) => {
    const q = d2(x, z);
    if (q > R * R) return null;
    return base - Math.floor((depth * (R * R - q)) / (R * R));
  };
  const carve = [], lining = [], rim = [];
  let by0 = Infinity;
  for (let z = cz - R - RIM; z <= cz + R + RIM; z++) for (let x = cx - R - RIM; x <= cx + R + RIM; x++) {
    const g = p.groundAt(x, z), b = bottomAt(x, z);
    if (b !== null) {
      if (g >= b + 1) carve.push(x, z, b + 1, g, 0);
      if (b <= g) lining.push(x, z, b, b, 0);
      if (b < by0) by0 = b;
      continue;
    }
    if (!p.rim) continue;
    // the rim ring: R < r <= R + RIM, crest p.rim high at its middle (a parabola), 0 at both edges
    const r = Math.sqrt(d2(x, z));
    if (r > R + RIM) continue;
    const u = (2 * (r - R)) / RIM - 1; // -1..1 across the ring
    const h = Math.floor(p.rim * (1 - u * u) + 0.5);
    if (h <= 0) continue;
    const top = base + h;
    if (top <= g) continue;
    if (top - 1 >= g + 1) rim.push(x, z, g + 1, top - 1, 0);
    rim.push(x, z, top, top, 1);
  }
  const ops = [];
  if (carve.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: carve, materials: [null], cond: 0, walk: false });
  if (lining.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: lining, materials: ['rock'], cond: 1, walk: false });
  if (rim.length) ops.push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: rim, materials: ['subsurface', 'surface'], cond: 2, walk: false });
  // the lake: the floor's middle third (radius), its surface level with the bowl's bottom at its edge
  const lr = Math.max(2, Math.floor(R / 3));
  const lakeRect = { minX: cx - lr, minZ: cz - lr, maxX: cx + lr, maxZ: cz + lr };
  const lakeLevel = bottomAt(cx + lr, cz);
  const bounds = { minX: cx - R - RIM, maxX: cx + R + RIM, minZ: cz - R - RIM, maxZ: cz + R + RIM, minY: Math.min(by0, lakeLevel - p.lakeDepth), maxY: base + p.rim };
  return {
    generator: GENERATOR, version: VERSION, seed: p.seed,
    params: { rect: p.rect, depth, rim: p.rim, lake: p.lake, lakeDepth: p.lakeDepth },
    ops, bounds, base, R, centre: [cx, cz], bottomAt, lakeRect, lakeLevel, lakeDepth: p.lakeDepth,
  };
}
