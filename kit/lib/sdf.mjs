// The closed shape library of region programs (docs/CONTRACT.md "The shape library", kit/REGIONS.md "Shapes").
// A shape is a JSON tree; compileShape() turns it into an evaluator that works one column at a time:
//   node.prep(x, z, col) -> boolean   (false: no cell of this column is inside); sets node.lo / node.hi
//   node.sd(y)           -> number    (signed distance at (x, y, z) of the prepared column; inside when <= 0)
// `col` is `{ g, h, f }`: the column's frozen ground, height and floor (y-refs resolve against it).
// Under the realise lint: only + - * / and Math.floor/sqrt/abs/min/max/imul.
import { fnv64, makeColumnNoise, makeNoise, noiseSpecError } from './noise.mjs';

/** Bigger than any distance in a world; substituted for a child known to be outside its threshold. */
export const BIG = 1e9;
const EPS = 1e-6;

export const PRIMITIVES = ['sphere', 'box', 'cylinder', 'cone', 'bowl', 'ring', 'torus', 'capsulePath', 'extrude', 'heightfield', 'mask'];
export const COMBINATORS = ['union', 'intersect', 'subtract', 'smooth', 'offset', 'displace', 'clipY'];
/** (6b) Shape kinds that only format-2 IRs may use (their `requires` kind is `shape:<kind>`). */
export const SHAPES_FORMAT2 = ['ellipsoid', 'capsuleChain', 'wedge', 'prism', 'array', 'instances', 'warp', 'strata'];
export const WEDGE_RISE = ['n', 's', 'e', 'w'];
/** (6b) Limits: array copies, instances, warp amplitude (the 8-column rule). */
export const ARRAY_MAX = 256, INSTANCES_MAX = 1024, WARP_MAX_AMP = 8;
export const BOWL_PROFILES = ['parabolic', 'spherical', 'flat'];
/** Cells above a bowl's rim it includes by default (its `h`). */
export const BOWL_DEFAULT_H = 32;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ------------------------------------------------------------------ y-refs

/**
 * A y value: a number or `{abs: n}` (absolute), `{surface: dy}` (the column's frozen ground + dy), `{floor: dy}` (the
 * first non-fluid block under the ground + dy), `{height: dy}` (max(height, ground) + dy: the top of the column, trunks
 * included), `{min: [y, ...]}`, `{max: [y, ...]}`. Returns the error message or null.
 */
export function yrefError(r, where = 'y') {
  if (isNum(r)) return null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return `${where}: a y value must be a number or {abs|surface|floor|height: n} or {min|max: [...]}`;
  const keys = Object.keys(r);
  if (keys.length !== 1) return `${where}: a y value has exactly one key (got ${keys.join(', ') || 'none'})`;
  const k = keys[0];
  if (k === 'abs' || k === 'surface' || k === 'floor' || k === 'height') return isNum(r[k]) ? null : `${where}.${k} must be a finite number`;
  if (k === 'min' || k === 'max') {
    if (!Array.isArray(r[k]) || r[k].length < 1) return `${where}.${k} must be a non-empty array`;
    for (let i = 0; i < r[k].length; i++) { const e = yrefError(r[k][i], `${where}.${k}[${i}]`); if (e) return e; }
    return null;
  }
  return `${where}: unknown y kind '${k}' (abs, surface, floor, height, min, max)`;
}

/** Compile a y-ref to `col => y`. */
export function yrefFn(r) {
  if (isNum(r)) return () => r;
  if ('abs' in r) { const v = r.abs; return () => v; }
  if ('surface' in r) { const d = r.surface; return (c) => c.g + d; }
  if ('floor' in r) { const d = r.floor; return (c) => c.f + d; }
  if ('height' in r) { const d = r.height; return (c) => (c.h > c.g ? c.h : c.g) + d; }
  const fs = (r.min ?? r.max).map(yrefFn);
  if ('min' in r) return (c) => { let m = fs[0](c); for (let i = 1; i < fs.length; i++) { const v = fs[i](c); if (v < m) m = v; } return m; };
  return (c) => { let m = fs[0](c); for (let i = 1; i < fs.length; i++) { const v = fs[i](c); if (v > m) m = v; } return m; };
}

/** The y-ref's absolute value when it does not depend on a column, else null. */
export function yrefAbs(r) {
  if (isNum(r)) return r;
  if ('abs' in r) return r.abs;
  if ('min' in r || 'max' in r) {
    const vs = (r.min ?? r.max).map(yrefAbs);
    if (vs.some((v) => v === null)) return null;
    return 'min' in r ? Math.min(...vs) : Math.max(...vs);
  }
  return null;
}

/**
 * Bounds of a y-ref over columns whose frozen values lie in [lo, hi] (`range = {lo, hi}`): `[min, max]`.
 * Without a range, a column-dependent y-ref gives [-BIG, BIG].
 */
export function yrefRange(r, range) {
  if (isNum(r)) return [r, r];
  if ('abs' in r) return [r.abs, r.abs];
  const k = Object.keys(r)[0];
  if (k === 'min' || k === 'max') {
    const rs = r[k].map((x) => yrefRange(x, range));
    if (k === 'min') return [Math.min(...rs.map((x) => x[0])), Math.min(...rs.map((x) => x[1]))];
    return [Math.max(...rs.map((x) => x[0])), Math.max(...rs.map((x) => x[1]))];
  }
  if (!range) return [-BIG, BIG];
  return [range.lo + r[k], range.hi + r[k]];
}

// ------------------------------------------------------------------ 2D polygon helpers (shared with plan time)

/** Even-odd point-in-polygon for a polygon [[x, z], ...] (boundary points count by the distance rule, not here). */
export function insidePolygon(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed distance from (x, z) to a polygon in the x/z plane (negative inside). */
export function polygonDistance(poly, x, z) {
  let best = BIG * BIG;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], az = poly[j][1];
    const ex = poly[i][0] - ax, ez = poly[i][1] - az;
    const px = x - ax, pz = z - az;
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? (px * ex + pz * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - ex * t, dz = pz - ez * t;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return insidePolygon(poly, x, z) ? -d : d;
}

// ------------------------------------------------------------------ blobs

/** Decode a base64 string to bytes (Buffer when available). */
function b64(s) {
  return Uint8Array.from(Buffer.from(String(s), 'base64'));
}

/**
 * A blob for `heightfield` / `mask`: `{ minX, minZ, width, depth, data }` with `data` base64 of u16 LE values
 * (heightfield) or of a bitset, bit i at byte i>>3, bit i&7, i = x + z*width (mask).
 */
function resolveBlob(name, blobs) {
  const b = typeof blobs === 'function' ? blobs(name) : blobs?.[name];
  if (!b) throw new Error(`shape: blob '${name}' is not in the IR's blobs`);
  if (b._dec) return b._dec;
  const bytes = b.bytes instanceof Uint8Array ? b.bytes : b64(b.data);
  const dec = { minX: b.minX, minZ: b.minZ, width: b.width, depth: b.depth, bytes };
  Object.defineProperty(b, '_dec', { value: dec, enumerable: false });
  return dec;
}

// ------------------------------------------------------------------ validation

/** Validate a shape tree; returns the first error (with its path) or null. */
export function shapeError(s, where = 'shape', depth = 0) {
  if (depth > 64) return `${where}: shape nesting is deeper than 64`;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return `${where}: a shape must be an object { kind, ... }`;
  const k = s.kind;
  const num = (f, pos = false) => (isNum(s[f]) && (!pos || s[f] > 0) ? null : `${where}.${f} must be a ${pos ? 'positive ' : ''}number`);
  const vec3 = (f) => {
    const v = s[f];
    if (!Array.isArray(v) || v.length !== 3 || !isNum(v[0]) || !isNum(v[2])) return `${where}.${f} must be [x, y, z]`;
    return yrefError(v[1], `${where}.${f}[1]`);
  };
  const first = (...errs) => errs.find((e) => e) ?? null;
  switch (k) {
    case 'sphere': return first(vec3('c'), num('r'));
    case 'box': {
      const e = first(vec3('min'), vec3('max'));
      if (e) return e;
      if (s.min[0] > s.max[0] || s.min[2] > s.max[2]) return `${where}: box min must be <= max in x and z`;
      return null;
    }
    case 'cylinder': return first(vec3('c'), num('r'), num('h', true));
    case 'cone': return first(vec3('c'), num('r0'), num('r1'), num('h', true));
    case 'bowl': {
      const e = first(vec3('c'), num('r', true), num('depth', true));
      if (e) return e;
      if (s.profile !== undefined && !BOWL_PROFILES.includes(s.profile)) return `${where}.profile must be one of ${BOWL_PROFILES.join(', ')}`;
      if (s.h !== undefined && !(isNum(s.h) && s.h >= 0)) return `${where}.h must be a number >= 0`;
      return null;
    }
    case 'ring': {
      const e = first(vec3('c'), num('r0'), num('r1'), num('h', true));
      if (e) return e;
      return s.r0 < s.r1 ? null : `${where}: ring r0 must be < r1`;
    }
    case 'torus': return first(vec3('c'), num('R'), num('r', true));
    case 'capsulePath': {
      if (!Array.isArray(s.points) || s.points.length < 1) return `${where}.points must be a non-empty array of [x, y, z]`;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) return `${where}.points[${i}] must be [x, y, z] numbers`;
      }
      return num('r', true);
    }
    case 'extrude': {
      if (!Array.isArray(s.polygon) || s.polygon.length < 3) return `${where}.polygon must have 3+ [x, z] points`;
      for (let i = 0; i < s.polygon.length; i++) {
        const p = s.polygon[i];
        if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) return `${where}.polygon[${i}] must be [x, z]`;
      }
      return first(yrefError(s.y0, `${where}.y0`), yrefError(s.y1, `${where}.y1`));
    }
    case 'heightfield': {
      if (typeof s.blob !== 'string') return `${where}.blob must be a blob name`;
      return first(num('scale'), yrefError(s.y0, `${where}.y0`));
    }
    case 'mask': return typeof s.blob === 'string' ? null : `${where}.blob must be a blob name`;
    case 'union': case 'intersect': case 'subtract': {
      if (!Array.isArray(s.of) || s.of.length < (k === 'subtract' ? 2 : 1)) return `${where}.of must be an array of ${k === 'subtract' ? '2+' : '1+'} shapes`;
      for (let i = 0; i < s.of.length; i++) { const e = shapeError(s.of[i], `${where}.of[${i}]`, depth + 1); if (e) return e; }
      return null;
    }
    case 'smooth': {
      if (!Array.isArray(s.of) || s.of.length !== 2) return `${where}.of must be [a, b]`;
      return first(num('k', true), shapeError(s.of[0], `${where}.of[0]`, depth + 1), shapeError(s.of[1], `${where}.of[1]`, depth + 1));
    }
    case 'offset': return first(num('d'), shapeError(s.of, `${where}.of`, depth + 1));
    case 'displace': {
      const ne = noiseSpecError(s.noise);
      if (ne) return `${where}.noise: ${ne}`;
      return first(num('amp'), shapeError(s.of, `${where}.of`, depth + 1));
    }
    case 'clipY': {
      if (s.y0 == null && s.y1 == null) return `${where}: clipY needs y0 or y1`;
      return first(s.y0 == null ? null : yrefError(s.y0, `${where}.y0`), s.y1 == null ? null : yrefError(s.y1, `${where}.y1`), shapeError(s.of, `${where}.of`, depth + 1));
    }
    // ---- format 2 (6b)
    case 'ellipsoid': {
      const e = vec3('c');
      if (e) return e;
      if (!Array.isArray(s.r) || s.r.length !== 3 || !s.r.every((v) => isNum(v) && v > 0)) return `${where}.r must be [rx, ry, rz] > 0`;
      return null;
    }
    case 'capsuleChain': {
      if (!Array.isArray(s.points) || s.points.length < 2) return `${where}.points must have 2+ [x, y, z]`;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i];
        if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) return `${where}.points[${i}] must be [x, y, z] numbers`;
      }
      if (!Array.isArray(s.radii) || s.radii.length !== s.points.length || !s.radii.every((v) => isNum(v) && v >= 0)) return `${where}.radii must be ${s.points.length} numbers >= 0 (one per point)`;
      return null;
    }
    case 'wedge': {
      const e = first(vec3('min'), vec3('max'));
      if (e) return e;
      if (s.min[0] > s.max[0] || s.min[2] > s.max[2]) return `${where}: wedge min must be <= max in x and z`;
      return WEDGE_RISE.includes(s.rise) ? null : `${where}.rise must be one of ${WEDGE_RISE.join(', ')}`;
    }
    case 'prism': {
      if (!Array.isArray(s.polygon) || s.polygon.length < 3) return `${where}.polygon must have 3+ [x, z] points`;
      for (let i = 0; i < s.polygon.length; i++) {
        const p = s.polygon[i];
        if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) return `${where}.polygon[${i}] must be [x, z]`;
      }
      const a = s.apex;
      if (!a || !Array.isArray(a.line) || a.line.length !== 2 || !a.line.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum)) || !isNum(a.y)) return `${where}.apex must be {line: [[x, z], [x, z]], y}`;
      return first(yrefError(s.y0, `${where}.y0`), yrefError(s.y1, `${where}.y1`));
    }
    case 'array': {
      if (!Array.isArray(s.step) || s.step.length !== 3 || !s.step.every(Number.isInteger)) return `${where}.step must be [dx, dy, dz] integers`;
      if (!(Number.isInteger(s.n) && s.n >= 1 && s.n <= ARRAY_MAX)) return `${where}.n must be 1..${ARRAY_MAX}`;
      return shapeError(s.of, `${where}.of`, depth + 1);
    }
    case 'instances': {
      if (!Array.isArray(s.transforms) || s.transforms.length < 1 || s.transforms.length > INSTANCES_MAX) return `${where}.transforms must be 1..${INSTANCES_MAX} transforms`;
      for (let i = 0; i < s.transforms.length; i++) {
        const t = s.transforms[i];
        if (!t || !Array.isArray(t.t) || t.t.length !== 3 || !t.t.every(Number.isInteger)) return `${where}.transforms[${i}].t must be [dx, dy, dz] integers`;
        if (t.rot !== undefined && ![0, 90, 180, 270].includes(t.rot)) return `${where}.transforms[${i}].rot must be 0, 90, 180 or 270`;
        if (t.mirror !== undefined && t.mirror !== null && t.mirror !== 'x' && t.mirror !== 'z') return `${where}.transforms[${i}].mirror must be 'x', 'z' or null`;
      }
      return shapeError(s.of, `${where}.of`, depth + 1);
    }
    case 'warp': {
      const ne = noiseSpecError(s.noise);
      if (ne) return `${where}.noise: ${ne}`;
      if (!(Number.isInteger(s.amp) && s.amp >= 1 && s.amp <= WARP_MAX_AMP)) return `${where}.amp must be an integer 1..${WARP_MAX_AMP}`;
      const e = shapeError(s.of, `${where}.of`, depth + 1);
      if (e) return e;
      return staticY(s.of) ? null : `${where}: a warp's shape needs an absolute y extent (no surface-relative y inside a warp)`;
    }
    case 'strata': {
      const b = s.bands;
      if (!b || !(isNum(b.every) && b.every >= 1) || (b.offset !== undefined && !isNum(b.offset))) return `${where}.bands must be {every >= 1, offset?, noise?, amp?}`;
      if (b.noise !== undefined) { const ne = noiseSpecError(b.noise); if (ne) return `${where}.bands.noise: ${ne}`; }
      if (b.amp !== undefined && !isNum(b.amp)) return `${where}.bands.amp must be a number`;
      return shapeError(s.of, `${where}.of`, depth + 1);
    }
    default: return `${where}: unknown shape kind '${k}' (${[...PRIMITIVES, ...COMBINATORS, ...SHAPES_FORMAT2].join(', ')})`;
  }
}

// ------------------------------------------------------------------ compiled nodes
// Each node has a band [L, e] (fixed at compile time) over which its parent needs its exact value; below L or above e
// only the side matters. prep() returning false, or y outside [lo, hi], guarantees sd(y) > e, so the parent may
// substitute BIG there. The root's band is [0, 0]. Children: union/intersect/clipY [L, e]; offset d [L+d, e+d];
// displace amp [L-|amp|, e+|amp|]; smooth k [L, e + 5k/4]; subtract's base [L, e] and its cutters [-e, -L].

class Node {
  constructor(e, L = e) { this.e = e; this.L = L; this.lo = 0; this.hi = 0; this.minX = -BIG; this.maxX = BIG; this.minZ = -BIG; this.maxZ = BIG; }
  /** within the node's x/z bounds */
  inXZ(x, z) { return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ; }
}

class Sphere extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cy = yrefFn(s.c[1]); this.r = s.r;
    this.R = s.r + e;
    const R = this.R > 0 ? this.R : 0;
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  prep(x, z, c) {
    if (this.R < 0) return false;
    const dx = x - this.cx, dz = z - this.cz;
    this.d2 = dx * dx + dz * dz;
    const s = this.R * this.R - this.d2;
    if (s < 0) return false;
    this.y0 = this.cy(c);
    const hh = Math.sqrt(s);
    this.lo = this.y0 - hh; this.hi = this.y0 + hh;
    return true;
  }
  sd(y) { const dy = y - this.y0; return Math.sqrt(this.d2 + dy * dy) - this.r; }
}

class Box extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.x0 = s.min[0]; this.x1 = s.max[0]; this.z0 = s.min[2]; this.z1 = s.max[2];
    this.y0f = yrefFn(s.min[1]); this.y1f = yrefFn(s.max[1]);
    const g = e > 0 ? e : 0;
    this.minX = this.x0 - g; this.maxX = this.x1 + g; this.minZ = this.z0 - g; this.maxZ = this.z1 + g;
  }
  prep(x, z, c) {
    const qx = Math.max(this.x0 - x, x - this.x1), qz = Math.max(this.z0 - z, z - this.z1);
    if (qx > this.e || qz > this.e) return false;
    this.qx = qx; this.qz = qz;
    const ox = qx > 0 ? qx : 0, oz = qz > 0 ? qz : 0;
    this.o2 = ox * ox + oz * oz;
    this.y0 = this.y0f(c); this.y1 = this.y1f(c);
    this.lo = this.y0 - this.e; this.hi = this.y1 + this.e;
    return this.lo <= this.hi;
  }
  sd(y) {
    const qy = Math.max(this.y0 - y, y - this.y1);
    const oy = qy > 0 ? qy : 0;
    const out = Math.sqrt(this.o2 + oy * oy);
    const m = Math.max(this.qx, qy, this.qz);
    return out + (m < 0 ? m : 0);
  }
}

class Cylinder extends Node {
  // vertical, base y = c[1], h cells (top = base + h - 1)
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]); this.r = s.r; this.h = s.h;
    const R = Math.max(0, s.r + e);
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  prep(x, z, c) {
    const dx = x - this.cx, dz = z - this.cz;
    this.dr = Math.sqrt(dx * dx + dz * dz) - this.r;
    if (this.dr > this.e) return false;
    this.y0 = this.cyf(c); this.y1 = this.y0 + this.h - 1;
    this.lo = this.y0 - this.e; this.hi = this.y1 + this.e;
    return true;
  }
  sd(y) { return Math.max(this.dr, this.y0 - y, y - this.y1); }
}

class Cone extends Node {
  // radius r0 at the base y, r1 at the top (base + h - 1)
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]); this.r0 = s.r0; this.h = s.h;
    this.s = s.h > 1 ? (s.r1 - s.r0) / (s.h - 1) : 0;
    this.k = Math.sqrt(1 + this.s * this.s);
    const R = Math.max(0, Math.max(s.r0, s.r1) + Math.abs(e) * this.k + 1);
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  prep(x, z, c) {
    const dx = x - this.cx, dz = z - this.cz;
    this.d = Math.sqrt(dx * dx + dz * dz);
    this.y0 = this.cyf(c); this.y1 = this.y0 + this.h - 1;
    let lo = this.y0 - this.e, hi = this.y1 + this.e;
    const need = this.d - this.r0 - this.e * this.k; // need s*(y - y0) >= need
    if (this.s > 0) lo = Math.max(lo, this.y0 + need / this.s);
    else if (this.s < 0) hi = Math.min(hi, this.y0 + need / this.s);
    else if (need > 0) return false;
    this.lo = lo; this.hi = hi;
    return lo <= hi;
  }
  sd(y) {
    const r = this.r0 + this.s * (y - this.y0);
    return Math.max((this.d - r) / this.k, this.y0 - y, y - this.y1);
  }
}

class Bowl extends Node {
  // the void of a bowl: rim centre c (rim y = c[1]), radius r, depth; inside = above the profile, up to rim + h
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]); this.r = s.r; this.depth = s.depth;
    this.profile = s.profile ?? 'parabolic'; this.h = s.h ?? BOWL_DEFAULT_H;
    if (this.profile === 'spherical') this.R = (s.r * s.r + s.depth * s.depth) / (2 * s.depth);
    const R = Math.max(0, s.r + e);
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  /** the profile's depth below the rim and its slope at horizontal distance d */
  static profileAt(profile, r, depth, R, d) {
    if (d > r) return [0, 0];
    if (profile === 'flat') return [depth, 0];
    if (profile === 'spherical') {
      const q = Math.sqrt(R * R - d * d);
      return [depth - R + q, d / q];
    }
    const t = d / r;
    return [depth * (1 - t * t), (2 * depth * d) / (r * r)];
  }
  prep(x, z, c) {
    const dx = x - this.cx, dz = z - this.cz;
    this.d = Math.sqrt(dx * dx + dz * dz);
    if (this.d - this.r > this.e) return false;
    const [dep, slope] = Bowl.profileAt(this.profile, this.r, this.depth, this.R, this.d);
    this.yr = this.cyf(c);
    this.yp = this.yr - dep;
    this.k = Math.sqrt(1 + slope * slope);
    this.top = this.yr + this.h;
    this.lo = this.yp - this.e * this.k; this.hi = this.top + this.e;
    return this.lo <= this.hi;
  }
  sd(y) { return Math.max(this.d - this.r, (this.yp - y) / this.k, y - this.top); }
}

class Ring extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]); this.r0 = s.r0; this.r1 = s.r1; this.h = s.h;
    const R = Math.max(0, s.r1 + e);
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  prep(x, z, c) {
    const dx = x - this.cx, dz = z - this.cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    this.dr = Math.max(this.r0 - d, d - this.r1);
    if (this.dr > this.e) return false;
    this.y0 = this.cyf(c); this.y1 = this.y0 + this.h - 1;
    this.lo = this.y0 - this.e; this.hi = this.y1 + this.e;
    return true;
  }
  sd(y) { return Math.max(this.dr, this.y0 - y, y - this.y1); }
}

class Torus extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]); this.R = s.R; this.r = s.r;
    const R = Math.max(0, s.R + s.r + e);
    this.minX = this.cx - R; this.maxX = this.cx + R; this.minZ = this.cz - R; this.maxZ = this.cz + R;
  }
  prep(x, z, c) {
    const dx = x - this.cx, dz = z - this.cz;
    const q = Math.sqrt(dx * dx + dz * dz) - this.R;
    const re = this.r + this.e;
    const s = re * re - q * q;
    if (re < 0 || s < 0) return false;
    this.q2 = q * q;
    this.y0 = this.cyf(c);
    const hh = Math.sqrt(s);
    this.lo = this.y0 - hh; this.hi = this.y0 + hh;
    return true;
  }
  sd(y) { const dy = y - this.y0; return Math.sqrt(this.q2 + dy * dy) - this.r; }
}

class CapsulePath extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    const pts = s.points.length === 1 ? [s.points[0], s.points[0]] : s.points;
    const n = pts.length - 1;
    this.n = n; this.r = s.r;
    this.seg = new Float64Array(n * 7); // ax ay az ex ey ez l2
    this.box = new Float64Array(n * 4); // minX maxX minZ maxZ (expanded)
    this.cand = new Int32Array(n);
    this.nc = 0;
    const g = Math.max(0, s.r + e);
    this.reach = s.r + e;
    let mnx = BIG, mxx = -BIG, mnz = BIG, mxz = -BIG;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1];
      const o = i * 7;
      this.seg[o] = a[0]; this.seg[o + 1] = a[1]; this.seg[o + 2] = a[2];
      this.seg[o + 3] = b[0] - a[0]; this.seg[o + 4] = b[1] - a[1]; this.seg[o + 5] = b[2] - a[2];
      this.seg[o + 6] = this.seg[o + 3] * this.seg[o + 3] + this.seg[o + 4] * this.seg[o + 4] + this.seg[o + 5] * this.seg[o + 5];
      const bx0 = Math.min(a[0], b[0]) - g, bx1 = Math.max(a[0], b[0]) + g, bz0 = Math.min(a[2], b[2]) - g, bz1 = Math.max(a[2], b[2]) + g;
      this.box[i * 4] = bx0; this.box[i * 4 + 1] = bx1; this.box[i * 4 + 2] = bz0; this.box[i * 4 + 3] = bz1;
      if (bx0 < mnx) mnx = bx0; if (bx1 > mxx) mxx = bx1; if (bz0 < mnz) mnz = bz0; if (bz1 > mxz) mxz = bz1;
    }
    this.minX = mnx; this.maxX = mxx; this.minZ = mnz; this.maxZ = mxz;
  }
  prep(x, z) {
    if (this.reach < 0) return false;
    let nc = 0, lo = BIG, hi = -BIG;
    const re = this.reach;
    for (let i = 0; i < this.n; i++) {
      const b = i * 4;
      if (x < this.box[b] || x > this.box[b + 1] || z < this.box[b + 2] || z > this.box[b + 3]) continue;
      const o = i * 7;
      // 2D distance in x/z to the projected segment is a lower bound of the 3D distance
      const ex = this.seg[o + 3], ez = this.seg[o + 5];
      const px = x - this.seg[o], pz = z - this.seg[o + 2];
      const l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? (px * ex + pz * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ex * t, dz = pz - ez * t;
      if (dx * dx + dz * dz > re * re) continue;
      this.cand[nc++] = i;
      const ay = this.seg[o + 1], by = ay + this.seg[o + 4];
      const l = Math.min(ay, by) - re, h = Math.max(ay, by) + re;
      if (l < lo) lo = l; if (h > hi) hi = h;
    }
    this.nc = nc;
    if (!nc) return false;
    this.x = x; this.z = z; this.lo = lo; this.hi = hi;
    return true;
  }
  sd(y) {
    let best = BIG * BIG;
    for (let k = 0; k < this.nc; k++) {
      const o = this.cand[k] * 7;
      const px = this.x - this.seg[o], py = y - this.seg[o + 1], pz = this.z - this.seg[o + 2];
      const ex = this.seg[o + 3], ey = this.seg[o + 4], ez = this.seg[o + 5], l2 = this.seg[o + 6];
      let t = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best) - this.r;
  }
}

class Extrude extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.poly = s.polygon.map((p) => [p[0], p[1]]);
    this.y0f = yrefFn(s.y0); this.y1f = yrefFn(s.y1);
    const g = e > 0 ? e : 0;
    this.minX = Math.min(...this.poly.map((p) => p[0])) - g; this.maxX = Math.max(...this.poly.map((p) => p[0])) + g;
    this.minZ = Math.min(...this.poly.map((p) => p[1])) - g; this.maxZ = Math.max(...this.poly.map((p) => p[1])) + g;
  }
  prep(x, z, c) {
    this.d2 = polygonDistance(this.poly, x, z);
    if (this.d2 > this.e) return false;
    this.y0 = this.y0f(c); this.y1 = this.y1f(c);
    this.lo = this.y0 - this.e; this.hi = this.y1 + this.e;
    return this.lo <= this.hi;
  }
  sd(y) { return Math.max(this.d2, this.y0 - y, y - this.y1); }
}

class Heightfield extends Node {
  // solid at and below y0 + scale * v(x, z) over the blob's area
  constructor(s, e, blobs, L) {
    super(e, L);
    this.b = resolveBlob(s.blob, blobs);
    this.scale = s.scale; this.y0f = yrefFn(s.y0);
    this.minX = this.b.minX; this.maxX = this.b.minX + this.b.width - 1; this.minZ = this.b.minZ; this.maxZ = this.b.minZ + this.b.depth - 1;
  }
  prep(x, z, c) {
    const i = x - this.b.minX, j = z - this.b.minZ;
    if (i < 0 || j < 0 || i >= this.b.width || j >= this.b.depth) return false;
    const o = (i + j * this.b.width) * 2;
    const v = this.b.bytes[o] | (this.b.bytes[o + 1] << 8);
    this.top = this.y0f(c) + this.scale * v;
    this.lo = -BIG; this.hi = this.top + this.e;
    return true;
  }
  sd(y) { return y - this.top; }
}

class Mask extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.b = resolveBlob(s.blob, blobs);
    this.minX = this.b.minX; this.maxX = this.b.minX + this.b.width - 1; this.minZ = this.b.minZ; this.maxZ = this.b.minZ + this.b.depth - 1;
  }
  prep(x, z) {
    const i = x - this.b.minX, j = z - this.b.minZ;
    let on = false;
    if (i >= 0 && j >= 0 && i < this.b.width && j < this.b.depth) {
      const k = i + j * this.b.width;
      on = ((this.b.bytes[k >> 3] >> (k & 7)) & 1) === 1;
    }
    this.v = on ? -0.5 : 0.5;
    if (this.v > this.e) return false;
    this.lo = -BIG; this.hi = BIG;
    return true;
  }
  sd() { return this.v; }
}

/** min over children inside their [lo, hi] (others are > e: BIG) */
class Union extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.kids = s.of.map((k) => compileNode(k, e, blobs, L));
    this.on = new Uint8Array(this.kids.length);
    this.minX = Math.min(...this.kids.map((k) => k.minX)); this.maxX = Math.max(...this.kids.map((k) => k.maxX));
    this.minZ = Math.min(...this.kids.map((k) => k.minZ)); this.maxZ = Math.max(...this.kids.map((k) => k.maxZ));
  }
  prep(x, z, c) {
    let any = false, lo = BIG, hi = -BIG;
    for (let i = 0; i < this.kids.length; i++) {
      const k = this.kids[i];
      const on = k.inXZ(x, z) && k.prep(x, z, c);
      this.on[i] = on ? 1 : 0;
      if (on) { any = true; if (k.lo < lo) lo = k.lo; if (k.hi > hi) hi = k.hi; }
    }
    this.lo = lo; this.hi = hi;
    return any;
  }
  sd(y) {
    let m = BIG;
    for (let i = 0; i < this.kids.length; i++) {
      if (!this.on[i]) continue;
      const k = this.kids[i];
      if (y < k.lo - EPS || y > k.hi + EPS) continue;
      const v = k.sd(y);
      if (v < m) m = v;
    }
    return m;
  }
}

class Intersect extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.kids = s.of.map((k) => compileNode(k, e, blobs, L));
    this.minX = Math.max(...this.kids.map((k) => k.minX)); this.maxX = Math.min(...this.kids.map((k) => k.maxX));
    this.minZ = Math.max(...this.kids.map((k) => k.minZ)); this.maxZ = Math.min(...this.kids.map((k) => k.maxZ));
  }
  prep(x, z, c) {
    let lo = -BIG, hi = BIG;
    for (const k of this.kids) {
      if (!k.inXZ(x, z) || !k.prep(x, z, c)) return false;
      if (k.lo > lo) lo = k.lo; if (k.hi < hi) hi = k.hi;
    }
    this.lo = lo; this.hi = hi;
    return lo <= hi + 2 * EPS;
  }
  sd(y) {
    let m = -BIG;
    for (const k of this.kids) {
      if (y < k.lo - EPS || y > k.hi + EPS) return BIG;
      const v = k.sd(y);
      if (v > m) m = v;
    }
    return m;
  }
}

class Subtract extends Node {
  // of[0] minus the union of the rest: max(a, -b)
  constructor(s, e, blobs, L) {
    super(e, L);
    this.a = compileNode(s.of[0], e, blobs, L);
    this.b = compileNode(s.of.length === 2 ? s.of[1] : { kind: 'union', of: s.of.slice(1) }, -L, blobs, -e);
    this.minX = this.a.minX; this.maxX = this.a.maxX; this.minZ = this.a.minZ; this.maxZ = this.a.maxZ;
  }
  prep(x, z, c) {
    if (!this.a.prep(x, z, c)) return false;
    this.bon = this.b.inXZ(x, z) && this.b.prep(x, z, c);
    this.lo = this.a.lo; this.hi = this.a.hi;
    return true;
  }
  sd(y) {
    const a = this.a.sd(y);
    if (!this.bon || y < this.b.lo - EPS || y > this.b.hi + EPS) return a;
    const nb = -this.b.sd(y);
    return a > nb ? a : nb;
  }
}

class Smooth extends Node {
  // polynomial smooth union: min(a, b) - h*h*k/4, h = max(k - |a - b|, 0) / k
  constructor(s, e, blobs, L) {
    super(e, L);
    this.k = s.k;
    const ce = e + 1.25 * s.k;
    this.a = compileNode(s.of[0], ce, blobs, L);
    this.b = compileNode(s.of[1], ce, blobs, L);
    this.minX = Math.min(this.a.minX, this.b.minX); this.maxX = Math.max(this.a.maxX, this.b.maxX);
    this.minZ = Math.min(this.a.minZ, this.b.minZ); this.maxZ = Math.max(this.a.maxZ, this.b.maxZ);
  }
  prep(x, z, c) {
    this.aon = this.a.inXZ(x, z) && this.a.prep(x, z, c);
    this.bon = this.b.inXZ(x, z) && this.b.prep(x, z, c);
    if (!this.aon && !this.bon) return false;
    this.lo = Math.min(this.aon ? this.a.lo : BIG, this.bon ? this.b.lo : BIG);
    this.hi = Math.max(this.aon ? this.a.hi : -BIG, this.bon ? this.b.hi : -BIG);
    return true;
  }
  sd(y) {
    const a = this.aon && y >= this.a.lo - EPS && y <= this.a.hi + EPS ? this.a.sd(y) : BIG;
    const b = this.bon && y >= this.b.lo - EPS && y <= this.b.hi + EPS ? this.b.sd(y) : BIG;
    const h = Math.max(this.k - Math.abs(a - b), 0) / this.k;
    return Math.min(a, b) - h * h * this.k * 0.25;
  }
}

class Offset extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.d = s.d;
    this.a = compileNode(s.of, e + s.d, blobs, L + s.d);
    this.minX = this.a.minX; this.maxX = this.a.maxX; this.minZ = this.a.minZ; this.maxZ = this.a.maxZ;
  }
  prep(x, z, c) {
    if (!this.a.prep(x, z, c)) return false;
    this.lo = this.a.lo; this.hi = this.a.hi;
    return true;
  }
  sd(y) { return this.a.sd(y) - this.d; }
}

class Displace extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.amp = s.amp;
    this.n = makeNoise(s.noise);
    this.a = compileNode(s.of, e + Math.abs(s.amp), blobs, L - Math.abs(s.amp));
    this.minX = this.a.minX; this.maxX = this.a.maxX; this.minZ = this.a.minZ; this.maxZ = this.a.maxZ;
  }
  prep(x, z, c) {
    if (!this.a.prep(x, z, c)) return false;
    this.x = x; this.z = z;
    this.lo = this.a.lo; this.hi = this.a.hi;
    return true;
  }
  sd(y) { return this.a.sd(y) + this.amp * this.n(this.x, y, this.z); }
}

class ClipY extends Node {
  constructor(s, e, blobs, L) {
    super(e, L);
    this.y0f = s.y0 == null ? null : yrefFn(s.y0);
    this.y1f = s.y1 == null ? null : yrefFn(s.y1);
    this.a = compileNode(s.of, e, blobs, L);
    this.minX = this.a.minX; this.maxX = this.a.maxX; this.minZ = this.a.minZ; this.maxZ = this.a.maxZ;
  }
  prep(x, z, c) {
    if (!this.a.prep(x, z, c)) return false;
    this.y0 = this.y0f ? this.y0f(c) : -BIG;
    this.y1 = this.y1f ? this.y1f(c) : BIG;
    this.lo = Math.max(this.a.lo, this.y0 - this.e);
    this.hi = Math.min(this.a.hi, this.y1 + this.e);
    return this.lo <= this.hi;
  }
  sd(y) { return Math.max(this.a.sd(y), this.y0 - y, y - this.y1); }
}

// ------------------------------------------------------------------ format-2 shapes (6b; kit/REGIONS.md "IR format 2")

class Ellipsoid extends Node {
  // (|p/r| - 1) * min(r): inside exactly the ellipsoid; bound-safe in the sense that it never exceeds the true distance
  constructor(s, e, blobs, L) {
    super(e, L);
    [this.cx, , this.cz] = s.c; this.cyf = yrefFn(s.c[1]);
    [this.rx, this.ry, this.rz] = s.r;
    this.m = Math.min(this.rx, this.ry, this.rz);
    this.k = 1 + e / this.m; // sd <= e  <=>  |p/r| <= k
    const k = this.k > 0 ? this.k : 0;
    this.minX = this.cx - this.rx * k; this.maxX = this.cx + this.rx * k; this.minZ = this.cz - this.rz * k; this.maxZ = this.cz + this.rz * k;
  }
  prep(x, z, c) {
    if (this.k < 0) return false;
    const u = (x - this.cx) / this.rx, w = (z - this.cz) / this.rz;
    this.q = u * u + w * w;
    const s = this.k * this.k - this.q;
    if (s < 0) return false;
    this.y0 = this.cyf(c);
    const hh = this.ry * Math.sqrt(s);
    this.lo = this.y0 - hh; this.hi = this.y0 + hh;
    return true;
  }
  sd(y) { const v = (y - this.y0) / this.ry; return (Math.sqrt(this.q + v * v) - 1) * this.m; }
}

class CapsuleChain extends Node {
  // round cones: per segment, the distance to the nearest point of the segment minus the radius interpolated there
  constructor(s, e, blobs, L) {
    super(e, L);
    const pts = s.points, rs = s.radii;
    const n = pts.length - 1;
    this.n = n;
    this.seg = new Float64Array(n * 9); // ax ay az ex ey ez l2 ra dr
    this.box = new Float64Array(n * 6); // minX maxX minZ maxZ minY maxY (grown by rmax + e)
    this.cand = new Int32Array(n);
    let mnx = BIG, mxx = -BIG, mnz = BIG, mxz = -BIG;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1], o = i * 9;
      this.seg[o] = a[0]; this.seg[o + 1] = a[1]; this.seg[o + 2] = a[2];
      this.seg[o + 3] = b[0] - a[0]; this.seg[o + 4] = b[1] - a[1]; this.seg[o + 5] = b[2] - a[2];
      this.seg[o + 6] = this.seg[o + 3] * this.seg[o + 3] + this.seg[o + 4] * this.seg[o + 4] + this.seg[o + 5] * this.seg[o + 5];
      this.seg[o + 7] = rs[i]; this.seg[o + 8] = rs[i + 1] - rs[i];
      const g = Math.max(rs[i], rs[i + 1]) + e;
      const B = i * 6;
      this.box[B] = Math.min(a[0], b[0]) - g; this.box[B + 1] = Math.max(a[0], b[0]) + g;
      this.box[B + 2] = Math.min(a[2], b[2]) - g; this.box[B + 3] = Math.max(a[2], b[2]) + g;
      this.box[B + 4] = Math.min(a[1], b[1]) - g; this.box[B + 5] = Math.max(a[1], b[1]) + g;
      if (g >= 0) {
        if (this.box[B] < mnx) mnx = this.box[B]; if (this.box[B + 1] > mxx) mxx = this.box[B + 1];
        if (this.box[B + 2] < mnz) mnz = this.box[B + 2]; if (this.box[B + 3] > mxz) mxz = this.box[B + 3];
      }
    }
    this.minX = mnx; this.maxX = mxx; this.minZ = mnz; this.maxZ = mxz;
  }
  prep(x, z) {
    let nc = 0, lo = BIG, hi = -BIG;
    for (let i = 0; i < this.n; i++) {
      const B = i * 6;
      if (x < this.box[B] || x > this.box[B + 1] || z < this.box[B + 2] || z > this.box[B + 3] || this.box[B + 4] > this.box[B + 5]) continue;
      const o = i * 9;
      const ex = this.seg[o + 3], ez = this.seg[o + 5];
      const px = x - this.seg[o], pz = z - this.seg[o + 2];
      const l2 = ex * ex + ez * ez;
      let t = l2 > 0 ? (px * ex + pz * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ex * t, dz = pz - ez * t;
      const g = this.box[B + 5] - Math.max(this.seg[o + 1], this.seg[o + 1] + this.seg[o + 4]); // rmax + e
      if (g < 0 || dx * dx + dz * dz > g * g) continue;
      this.cand[nc++] = i;
      if (this.box[B + 4] < lo) lo = this.box[B + 4]; if (this.box[B + 5] > hi) hi = this.box[B + 5];
    }
    this.nc = nc;
    if (!nc) return false;
    this.x = x; this.z = z; this.lo = lo; this.hi = hi;
    return true;
  }
  sd(y) {
    let best = BIG;
    for (let k = 0; k < this.nc; k++) {
      const o = this.cand[k] * 9;
      const px = this.x - this.seg[o], py = y - this.seg[o + 1], pz = this.z - this.seg[o + 2];
      const ex = this.seg[o + 3], ey = this.seg[o + 4], ez = this.seg[o + 5], l2 = this.seg[o + 6];
      let t = l2 > 0 ? (px * ex + py * ey + pz * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - (this.seg[o + 7] + this.seg[o + 8] * t);
      if (d < best) best = d;
    }
    return best;
  }
}

class Wedge extends Node {
  // a box whose top slopes linearly from max.y on the `rise` side to min.y on the opposite side
  constructor(s, e, blobs, L) {
    super(e, L);
    this.x0 = s.min[0]; this.x1 = s.max[0]; this.z0 = s.min[2]; this.z1 = s.max[2];
    this.y0f = yrefFn(s.min[1]); this.y1f = yrefFn(s.max[1]); this.rise = s.rise;
    const g = e > 0 ? e : 0;
    this.minX = this.x0 - g; this.maxX = this.x1 + g; this.minZ = this.z0 - g; this.maxZ = this.z1 + g;
  }
  prep(x, z, c) {
    const qx = Math.max(this.x0 - x, x - this.x1), qz = Math.max(this.z0 - z, z - this.z1);
    if (qx > this.e || qz > this.e) return false;
    this.qxz = Math.max(qx, qz);
    const y0 = this.y0f(c), y1 = this.y1f(c);
    const r = this.rise;
    const len = r === 'n' || r === 's' ? this.z1 - this.z0 : this.x1 - this.x0;
    let f = 1;
    if (len > 0) {
      const t = r === 'n' ? (this.z1 - z) / len : r === 's' ? (z - this.z0) / len : r === 'e' ? (x - this.x0) / len : (this.x1 - x) / len;
      f = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const slope = len > 0 ? (y1 - y0) / len : 0;
    this.k = Math.sqrt(1 + slope * slope);
    this.y0 = y0; this.top = y0 + (y1 - y0) * f;
    this.lo = y0 - this.e; this.hi = this.top + this.e * this.k;
    return this.lo <= this.hi;
  }
  sd(y) { return Math.max(this.qxz, this.y0 - y, (y - this.top) / this.k); }
}

class Prism extends Node {
  // walls: the polygon from y0 to y1; roof: from y1 up to apex.y at the ridge line, falling linearly to y1 at the
  // polygon vertex farthest from the line (a gable roof over a rectangle with the ridge on its centre line)
  constructor(s, e, blobs, L) {
    super(e, L);
    this.poly = s.polygon.map((p) => [p[0], p[1]]);
    this.y0f = yrefFn(s.y0); this.y1f = yrefFn(s.y1);
    const [[ax, az], [bx, bz]] = s.apex.line;
    const lx = bx - ax, lz = bz - az, ll = Math.sqrt(lx * lx + lz * lz);
    this.ax = ax; this.az = az; this.nx = ll > 0 ? -lz / ll : 0; this.nz = ll > 0 ? lx / ll : 1;
    this.ay = s.apex.y;
    let dmax = 0;
    for (const p of this.poly) { const d = Math.abs((p[0] - ax) * this.nx + (p[1] - az) * this.nz); if (d > dmax) dmax = d; }
    this.dmax = dmax > 0 ? dmax : 1;
    const g = e > 0 ? e : 0;
    this.minX = Math.min(...this.poly.map((p) => p[0])) - g; this.maxX = Math.max(...this.poly.map((p) => p[0])) + g;
    this.minZ = Math.min(...this.poly.map((p) => p[1])) - g; this.maxZ = Math.max(...this.poly.map((p) => p[1])) + g;
  }
  prep(x, z, c) {
    this.pd = polygonDistance(this.poly, x, z);
    if (this.pd > this.e) return false;
    const y0 = this.y0f(c), y1 = this.y1f(c);
    const d = Math.abs((x - this.ax) * this.nx + (z - this.az) * this.nz);
    const f = 1 - d / this.dmax;
    const rise = this.ay - y1;
    const slope = rise / this.dmax;
    this.k = Math.sqrt(1 + slope * slope);
    this.y0 = y0; this.top = y1 + rise * (f < 0 ? 0 : f);
    this.lo = y0 - this.e; this.hi = this.top + this.e * this.k;
    return this.lo <= this.hi;
  }
  sd(y) { return Math.max(this.pd, this.y0 - y, (y - this.top) / this.k); }
}

/** A copy of a sub-shape under an integer transform: world = R(M(local)) + t (rot clockwise seen from above). */
class Transform extends Node {
  constructor(s, e, blobs, L, t, rot = 0, mirror = null) {
    super(e, L);
    this.tx = t[0]; this.ty = t[1]; this.tz = t[2]; this.rot = rot; this.mirror = mirror;
    this.a = compileNode(s, e, blobs, L);
    const cs = [[this.a.minX, this.a.minZ], [this.a.maxX, this.a.minZ], [this.a.minX, this.a.maxZ], [this.a.maxX, this.a.maxZ]].map(([x, z]) => this.fwd(x, z));
    this.minX = Math.min(...cs.map((p) => p[0])); this.maxX = Math.max(...cs.map((p) => p[0]));
    this.minZ = Math.min(...cs.map((p) => p[1])); this.maxZ = Math.max(...cs.map((p) => p[1]));
  }
  fwd(x, z) {
    let u = this.mirror === 'x' ? -x : x, v = this.mirror === 'z' ? -z : z;
    const r = this.rot;
    if (r === 90) { const w = u; u = -v; v = w; } else if (r === 180) { u = -u; v = -v; } else if (r === 270) { const w = u; u = v; v = -w; }
    return [u + this.tx, v + this.tz];
  }
  prep(x, z, c) {
    let u = x - this.tx, v = z - this.tz;
    const r = this.rot;
    if (r === 90) { const w = u; u = v; v = -w; } else if (r === 180) { u = -u; v = -v; } else if (r === 270) { const w = u; u = -v; v = w; }
    if (this.mirror === 'x') u = -u; else if (this.mirror === 'z') v = -v;
    if (!this.a.inXZ(u, v) || !this.a.prep(u, v, c)) return false;
    this.lo = this.a.lo + this.ty; this.hi = this.a.hi + this.ty;
    return true;
  }
  sd(y) { return this.a.sd(y - this.ty); }
}

class ArrayShape extends Union {
  constructor(s, e, blobs, L) {
    const copies = [];
    for (let k = 0; k < s.n; k++) copies.push({ __t: [k * s.step[0], k * s.step[1], k * s.step[2]] });
    super({ of: [] }, e, blobs, L);
    this.kids = copies.map((cp) => new Transform(s.of, e, blobs, L, cp.__t));
    this.on = new Uint8Array(this.kids.length);
    this.minX = Math.min(...this.kids.map((k) => k.minX)); this.maxX = Math.max(...this.kids.map((k) => k.maxX));
    this.minZ = Math.min(...this.kids.map((k) => k.minZ)); this.maxZ = Math.max(...this.kids.map((k) => k.maxZ));
  }
}

class Instances extends Union {
  constructor(s, e, blobs, L) {
    super({ of: [] }, e, blobs, L);
    this.kids = s.transforms.map((t) => new Transform(s.of, e, blobs, L, t.t, t.rot ?? 0, t.mirror ?? null));
    this.on = new Uint8Array(this.kids.length);
    this.minX = Math.min(...this.kids.map((k) => k.minX)); this.maxX = Math.max(...this.kids.map((k) => k.maxX));
    this.minZ = Math.min(...this.kids.map((k) => k.minZ)); this.maxZ = Math.max(...this.kids.map((k) => k.maxZ));
  }
}

/** The three seeded lookups of a warp (one field per axis, derived from the spec's seed). */
export function warpFields(noise) {
  return ['x', 'y', 'z'].map((a) => makeNoise({ ...noise, dims: 3, seed: fnv64(noise.seed, 'warp', a).hex }));
}

class Warp extends Node {
  // `of` evaluated at p + amp * (nx, ny, nz)(p); `of` must have an absolute y extent. A column's y span comes from a table of
  // the child's spans over its x/z bounds, dilated by amp + 1 columns (a warped point stays within amp of its cell).
  constructor(s, e, blobs, L) {
    super(e, L);
    this.amp = s.amp;
    this.n3 = ['x', 'y', 'z'].map((a) => makeColumnNoise({ ...s.noise, dims: 3, seed: fnv64(s.noise.seed, 'warp', a).hex }));
    this.a = compileNode(s.of, e, blobs, L);
    const ys = staticY(s.of);
    this.ylo = ys[0] - s.amp - Math.abs(e) - 1; this.yhi = ys[1] + s.amp + Math.abs(e) + 1;
    this.minX = this.a.minX - s.amp; this.maxX = this.a.maxX + s.amp; this.minZ = this.a.minZ - s.amp; this.maxZ = this.a.maxZ + s.amp;
    // the span table holds only when no y in the subtree depends on the column
    this.tab = /"(surface|floor|height)":/.test(JSON.stringify(s.of)) ? false : null;
  }
  _table() {
    const a = this.a, R = this.amp + 1;
    const x0 = Math.floor(a.minX) - 1, x1 = -Math.floor(-a.maxX) + 1, z0 = Math.floor(a.minZ) - 1, z1 = -Math.floor(-a.maxZ) + 1;
    const W = x1 - x0 + 1, D = z1 - z0 + 1;
    if (!(W > 0 && D > 0) || W * D > 4194304) { this.tab = false; return; }
    const col = { g: 0, h: 0, f: 0 };
    let lo = new Float64Array(W * D).fill(BIG), hi = new Float64Array(W * D).fill(-BIG);
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      const x = x0 + i, z = z0 + j;
      if (a.inXZ(x, z) && a.prep(x, z, col)) { lo[i + j * W] = a.lo; hi[i + j * W] = a.hi; }
    }
    // dilate by R columns: separable min (lo) / max (hi) over x, then z
    const dil = (src, isMin, horiz) => {
      const out = new Float64Array(W * D);
      for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
        let m = isMin ? BIG : -BIG;
        for (let k = -R; k <= R; k++) {
          const ii = horiz ? i + k : i, jj = horiz ? j : j + k;
          if (ii < 0 || jj < 0 || ii >= W || jj >= D) continue;
          const v = src[ii + jj * W];
          if (isMin ? v < m : v > m) m = v;
        }
        out[i + j * W] = m;
      }
      return out;
    };
    lo = dil(dil(lo, true, true), true, false);
    hi = dil(dil(hi, false, true), false, false);
    this.tab = { x0, z0, W, D, R, lo, hi };
  }
  prep(x, z, c) {
    if (this.tab === null) this._table();
    let lo = this.ylo, hi = this.yhi;
    const t = this.tab;
    if (t) {
      const i = Math.floor(x) - t.x0, j = Math.floor(z) - t.z0;
      if (i < -t.R || j < -t.R || i >= t.W + t.R || j >= t.D + t.R) return false;
      const ii = i < 0 ? 0 : i >= t.W ? t.W - 1 : i, jj = j < 0 ? 0 : j >= t.D ? t.D - 1 : j;
      const l = t.lo[ii + jj * t.W], h = t.hi[ii + jj * t.W];
      if (l > h) return false;
      lo = Math.max(lo, l - this.amp - 1); hi = Math.min(hi, h + this.amp + 1);
      if (lo > hi) return false;
    }
    this.x = x; this.z = z; this.c = c;
    this.n3[0].col(x, z); this.n3[1].col(x, z); this.n3[2].col(x, z);
    this.lo = lo; this.hi = hi;
    return true;
  }
  sd(y) {
    const A = this.amp, x = this.x, z = this.z;
    const qx = x + A * this.n3[0].at(y), qy = y + A * this.n3[1].at(y), qz = z + A * this.n3[2].at(y);
    const a = this.a;
    if (!a.inXZ(qx, qz) || !a.prep(qx, qz, this.c)) return BIG;
    if (qy < a.lo - EPS || qy > a.hi + EPS) return BIG;
    return a.sd(qy);
  }
}

class Strata extends Node {
  // the same geometry as `of`; the band index is read by material rules (lib/material.mjs)
  constructor(s, e, blobs, L) {
    super(e, L);
    this.a = compileNode(s.of, e, blobs, L);
    this.minX = this.a.minX; this.maxX = this.a.maxX; this.minZ = this.a.minZ; this.maxZ = this.a.maxZ;
  }
  prep(x, z, c) {
    if (!this.a.prep(x, z, c)) return false;
    this.lo = this.a.lo; this.hi = this.a.hi;
    return true;
  }
  sd(y) { return this.a.sd(y); }
}

const CLASSES = {
  sphere: Sphere, box: Box, cylinder: Cylinder, cone: Cone, bowl: Bowl, ring: Ring, torus: Torus, capsulePath: CapsulePath,
  extrude: Extrude, heightfield: Heightfield, mask: Mask, union: Union, intersect: Intersect, subtract: Subtract,
  smooth: Smooth, offset: Offset, displace: Displace, clipY: ClipY,
  // format 2 (6b)
  ellipsoid: Ellipsoid, capsuleChain: CapsuleChain, wedge: Wedge, prism: Prism, array: ArrayShape, instances: Instances, warp: Warp, strata: Strata,
};

function compileNode(s, e, blobs, L = e) {
  const C = CLASSES[s?.kind];
  if (!C) throw new Error(`shape: unknown kind '${s?.kind}'`);
  return new C(s, e, blobs, L);
}

/** (6b) Every shape kind used in a shape tree (a Set), for an IR's `requires`. */
export function shapeKinds(s, out = new Set()) {
  if (!s || typeof s !== 'object') return out;
  out.add(s.kind);
  if (Array.isArray(s.of)) for (const k of s.of) shapeKinds(k, out);
  else if (s.of) shapeKinds(s.of, out);
  return out;
}

/** (6b) The bands spec of the first `strata` node in a shape tree (depth first), or null. */
export function strataOf(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'strata') return s.bands;
  for (const k of Array.isArray(s.of) ? s.of : s.of ? [s.of] : []) { const b = strataOf(k); if (b) return b; }
  return null;
}

/**
 * Compile a (validated) shape tree. `blobs` is the IR's `blobs` map or a resolver `name => blob`.
 * The result has `minX..maxZ` (conservative x/z bounds), `prep(x, z, col)` and `sd(y)`.
 */
export function compileShape(shape, blobs) {
  const err = shapeError(shape);
  if (err) throw new Error(err);
  return compileNode(shape, 0, blobs);
}

/**
 * Evaluate a compiled shape over one column: calls `cb(y)` for every integer y in [ylo, yhi] that is inside
 * (sd <= 0), ascending. Returns the number of inside cells. Plan-time helper (the evaluator inlines this loop).
 */
export function columnCells(node, x, z, col, ylo, yhi, cb) {
  if (!node.inXZ(x, z) || !node.prep(x, z, col)) return 0;
  const a = Math.max(ylo, -Math.floor(-(node.lo - EPS))), b = Math.min(yhi, Math.floor(node.hi + EPS));
  let n = 0;
  for (let y = a; y <= b; y++) if (node.sd(y) <= 0) { n++; if (cb) cb(y); }
  return n;
}

/** Signed distance of a shape at one point (plan time and tests). */
export function sdAt(node, x, y, z, col) {
  if (!node.inXZ(x, z) || !node.prep(x, z, col)) return BIG;
  if (y < node.lo - EPS || y > node.hi + EPS) return BIG;
  return node.sd(y);
}

/**
 * Conservative world bounds of a shape: `{minX, maxX, minZ, maxZ}` (integers, from the compiled node) plus
 * `minY`/`maxY` when the shape's y extent does not depend on columns (else null).
 */
export function shapeBounds(shape, blobs) {
  const n = compileShape(shape, blobs);
  const b = { minX: Math.floor(n.minX) + 0, maxX: -Math.floor(-n.maxX) + 0, minZ: Math.floor(n.minZ) + 0, maxZ: -Math.floor(-n.maxZ) + 0, minY: null, maxY: null };
  const ys = staticY(shape);
  if (ys) { b.minY = Math.floor(ys[0]) + 0; b.maxY = -Math.floor(-ys[1]) + 0; }
  return b;
}

/** [lo, hi] of a shape's y extent when absolute (null when column-dependent or unbounded). */
export function staticY(s) {
  const A = (r) => yrefAbs(r);
  switch (s.kind) {
    case 'sphere': { const y = A(s.c[1]); return y === null ? null : [y - s.r, y + s.r]; }
    case 'box': { const a = A(s.min[1]), b = A(s.max[1]); return a === null || b === null ? null : [a, b]; }
    case 'cylinder': case 'ring': case 'cone': { const y = A(s.c[1]); return y === null ? null : [y, y + s.h - 1]; }
    case 'bowl': { const y = A(s.c[1]); return y === null ? null : [y - s.depth, y + (s.h ?? BOWL_DEFAULT_H)]; }
    case 'torus': { const y = A(s.c[1]); return y === null ? null : [y - s.r, y + s.r]; }
    case 'capsulePath': { const ys = s.points.map((p) => p[1]); return [Math.min(...ys) - s.r, Math.max(...ys) + s.r]; }
    case 'extrude': { const a = A(s.y0), b = A(s.y1); return a === null || b === null ? null : [a, b]; }
    case 'heightfield': case 'mask': return null;
    case 'ellipsoid': { const y = A(s.c[1]); return y === null ? null : [y - s.r[1], y + s.r[1]]; }
    case 'capsuleChain': {
      const rmax = Math.max(...s.radii);
      const ys = s.points.map((p) => p[1]);
      return [Math.min(...ys) - rmax, Math.max(...ys) + rmax];
    }
    case 'wedge': { const a = A(s.min[1]), b = A(s.max[1]); return a === null || b === null ? null : [a, b]; }
    case 'prism': { const a = A(s.y0), b = A(s.y1); return a === null || b === null ? null : [a, Math.max(b, s.apex.y)]; }
    case 'array': { const r = staticY(s.of); if (!r) return null; const d = (s.n - 1) * s.step[1]; return [r[0] + Math.min(0, d), r[1] + Math.max(0, d)]; }
    case 'instances': { const r = staticY(s.of); if (!r) return null; const ds = s.transforms.map((t) => t.t[1]); return [r[0] + Math.min(...ds), r[1] + Math.max(...ds)]; }
    case 'warp': { const r = staticY(s.of); return r ? [r[0] - s.amp, r[1] + s.amp] : null; }
    case 'strata': return staticY(s.of);
    case 'union': case 'smooth': {
      const rs = s.of.map(staticY);
      if (rs.some((r) => !r)) return null;
      const pad = s.kind === 'smooth' ? s.k : 0;
      return [Math.min(...rs.map((r) => r[0])) - pad, Math.max(...rs.map((r) => r[1])) + pad];
    }
    case 'intersect': {
      const rs = s.of.map(staticY).filter(Boolean);
      if (!rs.length) return null;
      return [Math.max(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1]))];
    }
    case 'subtract': return staticY(s.of[0]);
    case 'offset': { const r = staticY(s.of); return r ? [r[0] - Math.abs(s.d), r[1] + Math.abs(s.d)] : null; }
    case 'displace': { const r = staticY(s.of); return r ? [r[0] - Math.abs(s.amp), r[1] + Math.abs(s.amp)] : null; }
    case 'clipY': {
      const r = staticY(s.of);
      const a = s.y0 == null ? null : A(s.y0), b = s.y1 == null ? null : A(s.y1);
      if (r) return [a === null ? r[0] : Math.max(r[0], a), b === null ? r[1] : Math.min(r[1], b)];
      if (a !== null && b !== null) return [a, b];
      return null;
    }
    default: return null;
  }
}
