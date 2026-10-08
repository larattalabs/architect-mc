// Phase 6a: the shape library (lib/sdf.mjs) against analytic fixtures, and the column evaluator's skipping (per-column
// [lo, hi] spans, thresholds, BIG substitution) against a plain reference evaluation over random shape trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIG, columnCells, compileShape, insidePolygon, polygonDistance, sdAt, shapeBounds, shapeError } from '../lib/sdf.mjs';
import { fnv64, makeNoise } from '../lib/noise.mjs';

const COL = { g: 70, h: 74, f: 66 };
const Y0 = -10, Y1 = 160;

/** the inside cells of a shape over a box of columns, via the column evaluator */
function cellsOf(shape, x0, x1, z0, z1, col = COL, blobs) {
  const n = compileShape(shape, blobs);
  const out = new Set();
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const c = typeof col === 'function' ? col(x, z) : col;
    columnCells(n, x, z, c, Y0, Y1, (y) => out.add(`${x},${y},${z}`));
  }
  return out;
}
function cellsWhere(pred, x0, x1, z0, z1) {
  const out = new Set();
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = Y0; y <= Y1; y++) if (pred(x, y, z)) out.add(`${x},${y},${z}`);
  return out;
}
const same = (a, b, msg) => {
  const missing = [...b].filter((k) => !a.has(k)).slice(0, 5), extra = [...a].filter((k) => !b.has(k)).slice(0, 5);
  assert.ok(!missing.length && !extra.length, `${msg}: missing ${missing.join(' ')} extra ${extra.join(' ')}`);
};

test('primitives match their analytic definitions', () => {
  same(cellsOf({ kind: 'sphere', c: [3, 70, -2], r: 6.5 }, -10, 15, -15, 10), cellsWhere((x, y, z) => (x - 3) ** 2 + (y - 70) ** 2 + (z + 2) ** 2 <= 6.5 ** 2, -10, 15, -15, 10), 'sphere');
  same(cellsOf({ kind: 'box', min: [-2, 60, 1], max: [4, 64, 3] }, -6, 8, -3, 7), cellsWhere((x, y, z) => x >= -2 && x <= 4 && y >= 60 && y <= 64 && z >= 1 && z <= 3, -6, 8, -3, 7), 'box');
  same(cellsOf({ kind: 'cylinder', c: [0, 64, 0], r: 4.5, h: 6 }, -7, 7, -7, 7), cellsWhere((x, y, z) => x * x + z * z <= 4.5 ** 2 && y >= 64 && y <= 69, -7, 7, -7, 7), 'cylinder');
  same(cellsOf({ kind: 'cone', c: [0, 60, 0], r0: 6, r1: 1, h: 11 }, -8, 8, -8, 8), cellsWhere((x, y, z) => y >= 60 && y <= 70 && Math.sqrt(x * x + z * z) <= 6 - 0.5 * (y - 60) + 1e-9, -8, 8, -8, 8), 'cone');
  for (const profile of ['parabolic', 'spherical', 'flat']) {
    const r = 20, depth = 8, cy = 70, h = 5, R = (r * r + depth * depth) / (2 * depth);
    const yp = (d) => (profile === 'flat' ? cy - depth : profile === 'spherical' ? cy - depth + R - Math.sqrt(R * R - d * d) : cy - depth * (1 - (d / r) ** 2));
    same(cellsOf({ kind: 'bowl', c: [0, cy, 0], r, depth, profile, h }, -22, 22, -22, 22),
      cellsWhere((x, y, z) => { const d = Math.sqrt(x * x + z * z); return d <= r && y >= yp(d) - 1e-9 && y <= cy + h; }, -22, 22, -22, 22), `bowl ${profile}`);
  }
  same(cellsOf({ kind: 'ring', c: [0, 64, 0], r0: 8, r1: 11.5, h: 3 }, -13, 13, -13, 13), cellsWhere((x, y, z) => { const d = Math.sqrt(x * x + z * z); return d >= 8 && d <= 11.5 && y >= 64 && y <= 66; }, -13, 13, -13, 13), 'ring');
  same(cellsOf({ kind: 'torus', c: [0, 64, 0], R: 9, r: 2.5 }, -13, 13, -13, 13), cellsWhere((x, y, z) => (Math.sqrt(x * x + z * z) - 9) ** 2 + (y - 64) ** 2 <= 6.25, -13, 13, -13, 13), 'torus');
  const poly = [[0, 0], [12, 0], [12, 4], [5, 4], [5, 10], [0, 10]];
  same(cellsOf({ kind: 'extrude', polygon: poly, y0: 61, y1: 63 }, -3, 15, -3, 13),
    cellsWhere((x, y, z) => y >= 61 && y <= 63 && (insidePolygon(poly, x, z) || Math.abs(polygonDistance(poly, x, z)) < 1e-12), -3, 15, -3, 13), 'extrude (L shape, boundary inclusive)');
  // capsule path: distance to the segments
  const pts = [[0, 64, 0], [10, 68, 0], [10, 68, 9]];
  const segD = (p, a, b) => { const e = b.map((v, i) => v - a[i]); const w = p.map((v, i) => v - a[i]); const l2 = e.reduce((s, v) => s + v * v, 0); let t = l2 ? w.reduce((s, v, i) => s + v * e[i], 0) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(...w.map((v, i) => v - e[i] * t)); };
  same(cellsOf({ kind: 'capsulePath', points: pts, r: 2 }, -4, 14, -4, 13), cellsWhere((x, y, z) => Math.min(segD([x, y, z], pts[0], pts[1]), segD([x, y, z], pts[1], pts[2])) <= 2, -4, 14, -4, 13), 'capsulePath');
});

test('signed distances: box and sphere values; boundaries are inside', () => {
  const b = compileShape({ kind: 'box', min: [0, 0, 0], max: [4, 4, 4] });
  assert.equal(sdAt(b, 2, 2, 2, COL), -2);
  assert.equal(sdAt(b, 7, 8, 4, COL), BIG); // beyond the threshold: BIG
  assert.equal(sdAt(b, 4, 0, 4, COL), 0);
  const s = compileShape({ kind: 'sphere', c: [0, 0, 0], r: 5 });
  assert.equal(sdAt(s, 3, 4, 0, COL), 0);
  assert.equal(sdAt(s, 0, 0, 0, COL), -5);
});

test('y-refs: surface, floor, height, min/max resolve per column', () => {
  const col = (x) => ({ g: 60 + x, h: 60 + x + (x === 2 ? 5 : 0), f: 58 + x });
  same(cellsOf({ kind: 'box', min: [0, { surface: -1 }, 0], max: [3, { surface: 2 }, 0] }, 0, 3, 0, 0, col), cellsWhere((x, y, z) => z === 0 && y >= 59 + x && y <= 62 + x, 0, 3, 0, 0), 'surface');
  same(cellsOf({ kind: 'box', min: [0, { floor: 1 }, 0], max: [3, { height: 0 }, 0] }, 0, 3, 0, 0, col), cellsWhere((x, y, z) => z === 0 && y >= 59 + x && y <= 60 + x + (x === 2 ? 5 : 0), 0, 3, 0, 0), 'floor/height');
  same(cellsOf({ kind: 'box', min: [0, { min: [{ floor: 1 }, { abs: 60 }] }, 0], max: [3, { abs: 64 }, 0] }, 0, 3, 0, 0, col), cellsWhere((x, y, z) => z === 0 && y >= Math.min(59 + x, 60) && y <= 64, 0, 3, 0, 0), 'min');
});

test('combinators: union, intersect, subtract, offset, clipY, smooth contains the union', () => {
  const A = { kind: 'sphere', c: [0, 64, 0], r: 5 }, B = { kind: 'box', min: [2, 60, -2], max: [9, 66, 2] };
  const inA = (x, y, z) => x * x + (y - 64) ** 2 + z * z <= 25, inB = (x, y, z) => x >= 2 && x <= 9 && y >= 60 && y <= 66 && z >= -2 && z <= 2;
  const R = [-8, 12, -8, 8];
  same(cellsOf({ kind: 'union', of: [A, B] }, ...R), cellsWhere((x, y, z) => inA(x, y, z) || inB(x, y, z), ...R), 'union');
  same(cellsOf({ kind: 'intersect', of: [A, B] }, ...R), cellsWhere((x, y, z) => inA(x, y, z) && inB(x, y, z), ...R), 'intersect');
  same(cellsOf({ kind: 'subtract', of: [A, B] }, ...R), cellsWhere((x, y, z) => inA(x, y, z) && !(inB(x, y, z) && !(x === 2 || x === 9 || y === 60 || y === 66 || z === -2 || z === 2)), ...R), 'subtract (the cutter boundary stays)');
  same(cellsOf({ kind: 'offset', d: 1.5, of: A }, ...R), cellsWhere((x, y, z) => x * x + (y - 64) ** 2 + z * z <= 6.5 ** 2, ...R), 'offset');
  same(cellsOf({ kind: 'clipY', y0: 62, y1: { surface: -4 }, of: A }, ...R), cellsWhere((x, y, z) => inA(x, y, z) && y >= 62 && y <= 66, ...R), 'clipY');
  const sm = cellsOf({ kind: 'smooth', k: 3, of: [A, B] }, ...R), un = cellsOf({ kind: 'union', of: [A, B] }, ...R);
  for (const k of un) assert.ok(sm.has(k), `smooth contains ${k}`);
  assert.ok(sm.size > un.size, 'smooth fills the crease');
});

// ---- a plain reference evaluator (no spans, no skipping) for random trees

function refSd(s, x, y, z, c) {
  const Y = (r) => (typeof r === 'number' ? r : 'abs' in r ? r.abs : 'surface' in r ? c.g + r.surface : 'floor' in r ? c.f + r.floor : 'height' in r ? Math.max(c.h, c.g) + r.height : 'min' in r ? Math.min(...r.min.map(Y)) : Math.max(...r.max.map(Y)));
  const dxz = (cc) => Math.sqrt((x - cc[0]) ** 2 + (z - cc[2]) ** 2);
  switch (s.kind) {
    case 'sphere': return Math.sqrt(dxz(s.c) ** 2 + (y - Y(s.c[1])) ** 2) - s.r;
    case 'box': {
      const q = [Math.max(s.min[0] - x, x - s.max[0]), Math.max(Y(s.min[1]) - y, y - Y(s.max[1])), Math.max(s.min[2] - z, z - s.max[2])];
      return Math.sqrt(q.reduce((a, v) => a + Math.max(v, 0) ** 2, 0)) + Math.min(Math.max(...q), 0);
    }
    case 'cylinder': { const y0 = Y(s.c[1]); return Math.max(dxz(s.c) - s.r, y0 - y, y - (y0 + s.h - 1)); }
    case 'ring': { const y0 = Y(s.c[1]), d = dxz(s.c); return Math.max(s.r0 - d, d - s.r1, y0 - y, y - (y0 + s.h - 1)); }
    case 'torus': return Math.sqrt((dxz(s.c) - s.R) ** 2 + (y - Y(s.c[1])) ** 2) - s.r;
    case 'union': return Math.min(...s.of.map((k) => refSd(k, x, y, z, c)));
    case 'intersect': return Math.max(...s.of.map((k) => refSd(k, x, y, z, c)));
    case 'subtract': return Math.max(refSd(s.of[0], x, y, z, c), -Math.min(...s.of.slice(1).map((k) => refSd(k, x, y, z, c))));
    case 'offset': return refSd(s.of, x, y, z, c) - s.d;
    case 'smooth': {
      const a = refSd(s.of[0], x, y, z, c), b = refSd(s.of[1], x, y, z, c);
      const h = Math.max(s.k - Math.abs(a - b), 0) / s.k;
      return Math.min(a, b) - h * h * s.k * 0.25;
    }
    case 'displace': return refSd(s.of, x, y, z, c) + s.amp * makeNoise(s.noise)(x, y, z);
    case 'clipY': return Math.max(refSd(s.of, x, y, z, c), s.y0 == null ? -BIG : Y(s.y0) - y, s.y1 == null ? -BIG : y - Y(s.y1));
    default: throw new Error(s.kind);
  }
}

function randomShape(r, depth = 0) {
  const n = (a, b) => a + r() * (b - a);
  const i = (a, b) => Math.floor(n(a, b + 1));
  const yr = () => (r() < 0.5 ? i(58, 74) : { surface: i(-6, 4) });
  if (depth >= 3 || r() < 0.35) {
    const k = i(0, 4);
    if (k === 0) return { kind: 'sphere', c: [i(-6, 6), yr(), i(-6, 6)], r: n(1, 6) };
    if (k === 1) { const x = i(-8, 4), z = i(-8, 4), y = i(56, 70); return { kind: 'box', min: [x, y, z], max: [x + i(0, 8), y + i(0, 8), z + i(0, 8)] }; }
    if (k === 2) return { kind: 'cylinder', c: [i(-6, 6), yr(), i(-6, 6)], r: n(1, 6), h: i(1, 9) };
    if (k === 3) return { kind: 'ring', c: [i(-4, 4), yr(), i(-4, 4)], r0: n(1, 4), r1: n(4.5, 8), h: i(1, 6) };
    return { kind: 'torus', c: [i(-4, 4), yr(), i(-4, 4)], R: n(3, 7), r: n(1, 2.5) };
  }
  const k = i(0, 6);
  const kid = () => randomShape(r, depth + 1);
  if (k === 0) return { kind: 'union', of: [kid(), kid(), kid()] };
  if (k === 1) return { kind: 'intersect', of: [kid(), kid()] };
  if (k === 2) return { kind: 'subtract', of: [kid(), kid(), kid()] };
  if (k === 3) return { kind: 'offset', d: n(-1.5, 2.5), of: kid() };
  if (k === 4) return { kind: 'smooth', k: n(0.5, 4), of: [kid(), kid()] };
  if (k === 5) return { kind: 'displace', amp: n(-2, 2), noise: { kind: r() < 0.5 ? 'value' : 'simplex', dims: 3, scale: n(3, 9), octaves: i(1, 2), seed: fnv64('d', r()).hex }, of: kid() };
  return { kind: 'clipY', y0: r() < 0.3 ? null : yr(), y1: { surface: i(-2, 6) }, of: kid() };
}

test('the column evaluator equals a plain evaluation over 300 random shape trees (spans and skipping are exact)', () => {
  let s = 12345;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const colAt = (x, z) => ({ g: 64 + ((x * 3 + z * 5) % 7), h: 66 + ((x * 3 + z * 5) % 7), f: 62 + ((x + z) % 3) });
  let total = 0;
  for (let t = 0; t < 300; t++) {
    const shape = randomShape(r);
    assert.equal(shapeError(shape), null);
    const fast = cellsOf(shape, -12, 12, -12, 12, colAt);
    const slow = cellsWhere((x, y, z) => refSd(shape, x, y, z, colAt(x, z)) <= 0, -12, 12, -12, 12);
    same(fast, slow, `tree ${t} ${JSON.stringify(shape).slice(0, 200)}`);
    total += fast.size;
  }
  assert.ok(total > 10000, `the trees are not all empty (${total} cells)`);
});

test('bounds and validation', () => {
  assert.deepEqual(shapeBounds({ kind: 'sphere', c: [10, 64, -3], r: 2.5 }), { minX: 7, maxX: 13, minZ: -6, maxZ: 0, minY: 61, maxY: 67 });
  assert.deepEqual(shapeBounds({ kind: 'box', min: [0, { surface: 0 }, 0], max: [3, { surface: 4 }, 2] }), { minX: 0, maxX: 3, minZ: 0, maxZ: 2, minY: null, maxY: null });
  assert.match(shapeError({ kind: 'blob' }), /unknown shape kind/);
  assert.match(shapeError({ kind: 'box', min: [0, 0, 0], max: [-1, 0, 0] }), /min must be <= max/);
  assert.match(shapeError({ kind: 'sphere', c: [0, { up: 1 }, 0], r: 1 }), /unknown y kind/);
  assert.match(shapeError({ kind: 'union', of: [{ kind: 'sphere', c: [0, 0, 0] }] }), /of\[0\]\.r/);
});

test('heightfield and mask blobs', () => {
  const W = 4, D = 3;
  const hf = new Uint8Array(W * D * 2);
  for (let k = 0; k < W * D; k++) hf[k * 2] = k;
  const bits = new Uint8Array(2); bits[0] = 0b10100101;
  const blobs = { h: { minX: 10, minZ: 20, width: W, depth: D, data: Buffer.from(hf).toString('base64') }, m: { minX: 10, minZ: 20, width: W, depth: D, data: Buffer.from(bits).toString('base64') } };
  const cells = cellsOf({ kind: 'intersect', of: [{ kind: 'heightfield', blob: 'h', scale: 0.5, y0: 60 }, { kind: 'box', min: [0, 58, 0], max: [99, 99, 99] }] }, 8, 15, 18, 25, COL, blobs);
  same(cells, cellsWhere((x, y, z) => x >= 10 && x < 14 && z >= 20 && z < 23 && y >= 58 && y <= 60 + 0.5 * ((x - 10) + (z - 20) * W), 8, 15, 18, 25), 'heightfield');
  const m = cellsOf({ kind: 'intersect', of: [{ kind: 'mask', blob: 'm' }, { kind: 'box', min: [0, 64, 0], max: [99, 64, 99] }] }, 8, 15, 18, 25, COL, blobs);
  same(m, cellsWhere((x, y, z) => { const k = (x - 10) + (z - 20) * W; return y === 64 && x >= 10 && x < 14 && z >= 20 && z < 23 && k < 8 && ((0b10100101 >> k) & 1) === 1; }, 8, 15, 18, 25), 'mask');
});
