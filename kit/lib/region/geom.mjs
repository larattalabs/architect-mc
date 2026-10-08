// Plan-time geometry for region primitives: trig-free directions (polynomial sin/cos, exact by IEEE + - * /), 4-connected
// lines, centre-cell paths with cross sections, circle polygons. No Math.sin/cos/atan/pow anywhere, so a program's IR is
// the same on every Node major.

const PI = 3.141592653589793;

/** sin and cos of an angle in radians, |a| <= pi/4, by their Taylor series (14 terms: below 1 ulp on that range). */
function sincosSmall(a) {
  const a2 = a * a;
  let s = 0, c = 0, ts = a, tc = 1;
  for (let k = 0; k < 14; k++) {
    s += ts; c += tc;
    ts = (-ts * a2) / ((2 * k + 2) * (2 * k + 3));
    tc = (-tc * a2) / ((2 * k + 1) * (2 * k + 2));
  }
  return [s, c];
}

/**
 * The unit direction of a compass angle in degrees: 0 = north (-z), 90 = east (+x), 180 = south, 270 = west.
 * Returns [dx, dz]. Multiples of 90 are exact.
 */
export function compassDir(deg) {
  if (typeof deg !== 'number' || !Number.isFinite(deg)) throw new Error(`angle must be a number of degrees (got ${deg})`);
  let d = deg % 360;
  if (d < 0) d += 360;
  const q = Math.floor(d / 90 + 0.5) % 4; // nearest quadrant
  const r = d - Math.floor(d / 90 + 0.5) * 90; // -45..45
  const [s, c] = r === 0 ? [0, 1] : sincosSmall((r * PI) / 180);
  // base direction of the quadrant, rotated clockwise by r (in compass terms: x = sin, -z = cos)
  const base = [[0, -1], [1, 0], [0, 1], [-1, 0]][q];
  // rotate (bx, bz) clockwise (towards east from north) by r: north (0,-1) -> (sin, -cos)
  const bx = base[0], bz = base[1];
  return [bx * c - bz * s, bx * s + bz * c];
}

export const CARDINALS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/** The cardinal name of an axis-aligned unit step. */
export function cardinalOf(dx, dz) {
  if (dx === 0 && dz === -1) return 'north';
  if (dx === 1 && dz === 0) return 'east';
  if (dx === 0 && dz === 1) return 'south';
  if (dx === -1 && dz === 0) return 'west';
  throw new Error(`not a unit step: ${dx},${dz}`);
}

/** The dominant cardinal of a vector (ties go to the z axis). */
export function dominantCardinal(dx, dz) {
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : dz < 0 ? 'north' : dx >= 0 ? 'east' : 'west';
}

/** A regular n-gon approximating a circle (vertex 0 at compass angle `start`), as [[x, z], ...] floats. */
export function circlePolygon(cx, cz, r, n = 32, start = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const [dx, dz] = compassDir(start + (360 * i) / n);
    out.push([cx + r * dx, cz + r * dz]);
  }
  return out;
}

/**
 * A 4-connected grid line from (x0, z0) to (x1, z1) (integers), both ends included. A diagonal step goes through a
 * corner cell (x first), so the walk stays connected. Integer arithmetic only.
 */
export function line4(x0, z0, x1, z1) {
  const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
  const sx = x1 > x0 ? 1 : -1, sz = z1 > z0 ? 1 : -1;
  const out = [[x0, z0]];
  let x = x0, z = z0, ix = 0, iz = 0;
  while (ix < dx || iz < dz) {
    // compare the crossing parameters (ix + 1/2) / dx and (iz + 1/2) / dz
    const tx = (1 + 2 * ix) * dz, tz = (1 + 2 * iz) * dx;
    if (iz >= dz || (ix < dx && tx <= tz)) { x += sx; ix++; } else { z += sz; iz++; }
    out.push([x, z]);
  }
  return out;
}

const roundHalfUp = (v) => Math.floor(v + 0.5);

/**
 * The centre cells of a polyline [[x, z], ...] (vertices rounded to integers): consecutive 4-connected lines, joints not
 * repeated. Each cell: `{x, z, seg, i}` (segment index, index along the whole path). `vertexAt[k]` is the index of
 * vertex k's cell.
 */
export function centreCells(points) {
  const pts = points.map((p) => [roundHalfUp(p[0]), roundHalfUp(p[1])]);
  const cells = [];
  const vertexAt = [0];
  for (let s = 0; s < pts.length - 1; s++) {
    const l = line4(pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]);
    for (let k = s === 0 ? 0 : 1; k < l.length; k++) cells.push({ x: l[k][0], z: l[k][1], seg: s, i: cells.length });
    vertexAt.push(cells.length - 1);
  }
  if (pts.length === 1) cells.push({ x: pts[0][0], z: pts[0][1], seg: 0, i: 0 });
  return { cells, vertexAt, pts };
}

/**
 * The cross-section offsets of a width: -floor((w-1)/2) .. floor(w/2), the extra cell of an even width on the right of
 * the direction of travel (4e's rule).
 */
export function crossOffsets(w) {
  const out = [];
  for (let k = -Math.floor((w - 1) / 2); k <= Math.floor(w / 2); k++) out.push(k);
  return out;
}

/** The travel direction (unit, axis-aligned) of a segment: its dominant axis. */
export function segmentAxis(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) return [Math.sign(dx), 0];
  if (dz !== 0) return [0, Math.sign(dz)];
  return [1, 0];
}

/** Right of travel (x east, z south): north -> east. */
export const rightOf = (d) => [-d[1], d[0]];
