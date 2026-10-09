// Phase 6b gate item 1 (kit): the format-2 shapes against analytic fixtures and a plain reference evaluation over random
// trees (spans and skipping stay exact), array/instances equal to the explicit union, warp bounds, material rules (each
// condition, first match, dither, determinism), `requires` computed = walked, the format-2 compile errors (unknown op,
// shape, rule or member), the inline-blob refusal, side blobs and PLAN_STALE.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BIG, columnCells, compileShape, polygonDistance, sdAt, shapeBounds, shapeError } from '../lib/sdf.mjs';
import { fnv64, makeNoise } from '../lib/noise.mjs';
import { warpFields } from '../lib/sdf.mjs';
import { compileIR, decodeArbl, encodeArbl, evalTile, KINDS_FORMAT2, staleReason, walkKinds, semverCompare, EVAL_KIT_VERSION } from '../lib/realise.mjs';
import { KIT_VERSION } from '../lib/region/plan.mjs';
import { makeColumns, sha256Hex, unpack } from '../lib/region/pack.mjs';

const Y0 = -10, Y1 = 160;
const colAt = (x, z) => ({ g: 64 + ((x * 3 + z * 5) % 7 + 7) % 7, h: 66 + ((x * 3 + z * 5) % 7 + 7) % 7, f: 62 + (((x + z) % 3) + 3) % 3 });

function cellsOf(shape, x0, x1, z0, z1, col = colAt, blobs) {
  const n = compileShape(shape, blobs);
  const out = new Set();
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const c = typeof col === 'function' ? col(x, z) : col;
    columnCells(n, x, z, c, Y0, Y1, (y) => out.add(`${x},${y},${z}`));
  }
  return out;
}
function cellsWhere(f, x0, x1, z0, z1) {
  const out = new Set();
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = Y0; y <= Y1; y++) if (f(x, y, z)) out.add(`${x},${y},${z}`);
  return out;
}
function same(a, b, what) {
  const onlyA = [...a].filter((k) => !b.has(k)), onlyB = [...b].filter((k) => !a.has(k));
  assert.ok(!onlyA.length && !onlyB.length, `${what}: ${onlyA.length} extra (${onlyA.slice(0, 5)}), ${onlyB.length} missing (${onlyB.slice(0, 5)})`);
}

// ---- a plain reference evaluator, extended with the 6b shapes
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
    case 'union': return Math.min(...s.of.map((k) => refSd(k, x, y, z, c)));
    case 'intersect': return Math.max(...s.of.map((k) => refSd(k, x, y, z, c)));
    case 'subtract': return Math.max(refSd(s.of[0], x, y, z, c), -Math.min(...s.of.slice(1).map((k) => refSd(k, x, y, z, c))));
    case 'offset': return refSd(s.of, x, y, z, c) - s.d;
    case 'clipY': return Math.max(refSd(s.of, x, y, z, c), s.y0 == null ? -BIG : Y(s.y0) - y, s.y1 == null ? -BIG : y - Y(s.y1));
    case 'ellipsoid': {
      const y0 = Y(s.c[1]);
      return (Math.sqrt(((x - s.c[0]) / s.r[0]) ** 2 + ((y - y0) / s.r[1]) ** 2 + ((z - s.c[2]) / s.r[2]) ** 2) - 1) * Math.min(...s.r);
    }
    case 'capsuleChain': {
      let best = BIG;
      for (let i = 0; i + 1 < s.points.length; i++) {
        const a = s.points[i], b = s.points[i + 1];
        const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], p = [x - a[0], y - a[1], z - a[2]];
        const l2 = e[0] ** 2 + e[1] ** 2 + e[2] ** 2;
        let t = l2 > 0 ? (p[0] * e[0] + p[1] * e[1] + p[2] * e[2]) / l2 : 0;
        t = Math.min(1, Math.max(0, t));
        const d = Math.sqrt((p[0] - e[0] * t) ** 2 + (p[1] - e[1] * t) ** 2 + (p[2] - e[2] * t) ** 2) - (s.radii[i] + (s.radii[i + 1] - s.radii[i]) * t);
        best = Math.min(best, d);
      }
      return best;
    }
    case 'wedge': {
      // the wedge's own distance-like function: max(box xz, below the floor, above the slope / k)
      const qxz = Math.max(s.min[0] - x, x - s.max[0], s.min[2] - z, z - s.max[2]);
      const y0 = Y(s.min[1]), y1 = Y(s.max[1]);
      const ns = s.rise === 'n' || s.rise === 's', len = ns ? s.max[2] - s.min[2] : s.max[0] - s.min[0];
      let t = len === 0 ? 1 : s.rise === 'n' ? (s.max[2] - z) / len : s.rise === 's' ? (z - s.min[2]) / len : s.rise === 'e' ? (x - s.min[0]) / len : (s.max[0] - x) / len;
      t = Math.min(1, Math.max(0, t));
      const k = Math.sqrt(1 + (len > 0 ? (y1 - y0) / len : 0) ** 2);
      return Math.max(qxz, y0 - y, (y - (y0 + (y1 - y0) * t)) / k);
    }
    case 'array': {
      let best = BIG;
      for (let k = 0; k < s.n; k++) best = Math.min(best, refSd(s.of, x - k * s.step[0], y - k * s.step[1], z - k * s.step[2], c));
      return best;
    }
    case 'instances': {
      let best = BIG;
      for (const t of s.transforms) {
        let u = x - t.t[0], v = z - t.t[2];
        const r = t.rot ?? 0;
        if (r === 90) [u, v] = [v, -u]; else if (r === 180) [u, v] = [-u, -v]; else if (r === 270) [u, v] = [-v, u];
        if (t.mirror === 'x') u = -u; else if (t.mirror === 'z') v = -v;
        best = Math.min(best, refSd(s.of, u, y - t.t[1], v, c));
      }
      return best;
    }
    case 'warp': {
      const [fx, fy, fz] = (s.__f ??= warpFields(s.noise));
      return refSd(s.of, x + s.amp * fx(x, y, z), y + s.amp * fy(x, y, z), z + s.amp * fz(x, y, z), c);
    }
    case 'strata': return refSd(s.of, x, y, z, c);
    default: throw new Error(s.kind);
  }
}

function randomShape(r, depth = 0, absOnly = false) {
  const n = (a, b) => a + r() * (b - a);
  const i = (a, b) => Math.floor(n(a, b + 1));
  const yr = () => (absOnly || r() < 0.5 ? i(58, 74) : { surface: i(-6, 4) });
  if (depth >= 3 || r() < 0.35) {
    const k = i(0, 4);
    if (k === 0) return { kind: 'ellipsoid', c: [i(-6, 6), yr(), i(-6, 6)], r: [n(1, 7), n(1, 5), n(1, 7)] };
    if (k === 1) { const pts = Array.from({ length: i(2, 4) }, () => [i(-8, 8), i(58, 72), i(-8, 8)]); return { kind: 'capsuleChain', points: pts, radii: pts.map(() => n(0.5, 3.5)) }; }
    if (k === 2) { const x = i(-8, 4), z = i(-8, 4), y = i(58, 66); return { kind: 'wedge', min: [x, y, z], max: [x + i(0, 8), y + i(1, 8), z + i(0, 8)], rise: ['n', 's', 'e', 'w'][i(0, 3)] }; }
    if (k === 3) { const x = i(-8, 4), z = i(-8, 4), y = i(56, 70); return { kind: 'box', min: [x, y, z], max: [x + i(0, 8), y + i(0, 8), z + i(0, 8)] }; }
    return { kind: 'sphere', c: [i(-6, 6), yr(), i(-6, 6)], r: n(1, 6) };
  }
  const k = i(0, 7);
  const kid = () => randomShape(r, depth + 1, absOnly);
  if (k === 0) return { kind: 'union', of: [kid(), kid()] };
  if (k === 1) return { kind: 'subtract', of: [kid(), kid()] };
  if (k === 2) return { kind: 'array', step: [i(-5, 5), i(-2, 2), i(-5, 5)], n: i(1, 4), of: kid() };
  if (k === 3) return { kind: 'instances', transforms: Array.from({ length: i(1, 3) }, () => ({ t: [i(-6, 6), i(-2, 2), i(-6, 6)], rot: [0, 90, 180, 270][i(0, 3)], mirror: [null, 'x', 'z'][i(0, 2)] })), of: kid() };
  if (k === 4) return { kind: 'offset', d: n(-1.5, 2), of: kid() };
  if (k === 5) return { kind: 'strata', bands: { every: i(1, 5), offset: i(0, 3) }, of: kid() };
  if (k === 6) { const s = randomShape(r, depth + 1, true); return { kind: 'warp', amp: i(1, 4), noise: { kind: 'value', dims: 3, scale: n(4, 12), octaves: 1, seed: fnv64('w', r()).hex }, of: s }; }
  return { kind: 'clipY', y0: r() < 0.3 ? null : yr(), y1: { surface: i(-2, 6) }, of: kid() };
}

test('format-2 shapes: the column evaluator equals a plain evaluation over 200 random trees', () => {
  let s = 777;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  let total = 0;
  for (let t = 0; t < 200; t++) {
    const shape = randomShape(r);
    assert.equal(shapeError(shape), null, JSON.stringify(shape));
    const fast = cellsOf(structuredClone(shape), -14, 14, -14, 14);
    const slow = cellsWhere((x, y, z) => y >= 40 && y <= 100 && refSd(shape, x, y, z, colAt(x, z)) <= 0, -14, 14, -14, 14);
    same(fast, slow, `tree ${t} ${JSON.stringify(shape).slice(0, 240)}`);
    total += fast.size;
  }
  assert.ok(total > 10000, `the trees are not all empty (${total} cells)`);
});

test('analytic fixtures: ellipsoid, capsuleChain, wedge, prism', () => {
  const E = { kind: 'ellipsoid', c: [0, { abs: 64 }, 0], r: [6, 3, 4] };
  same(cellsOf(E, -8, 8, -8, 8), cellsWhere((x, y, z) => (x / 6) ** 2 + ((y - 64) / 3) ** 2 + (z / 4) ** 2 <= 1, -8, 8, -8, 8), 'ellipsoid');
  const C = { kind: 'capsuleChain', points: [[0, 60, 0], [8, 60, 0]], radii: [1, 3] };
  const capRef = (x, y, z) => { const t = Math.min(1, Math.max(0, x / 8)); return Math.sqrt((x - 8 * t) ** 2 + (y - 60) ** 2 + z * z) <= 1 + 2 * t; };
  same(cellsOf(C, -4, 12, -4, 4), cellsWhere(capRef, -4, 12, -4, 4), 'capsuleChain (round cone)');
  const W = { kind: 'wedge', min: [0, 60, 0], max: [4, 64, 8], rise: 'n' };
  same(cellsOf(W, -2, 6, -2, 10), cellsWhere((x, y, z) => x >= 0 && x <= 4 && z >= 0 && z <= 8 && y >= 60 && y <= 60 + 4 * ((8 - z) / 8) + 1e-9, -2, 6, -2, 10), 'wedge rising north');
  const P = { kind: 'prism', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]], y0: 60, y1: 64, apex: { line: [[0, 3], [8, 3]], y: 67 } };
  const pref = (x, y, z) => polygonDistance(P.polygon, x, z) <= 0 && y >= 60 && y <= 64 + 3 * Math.max(0, 1 - Math.abs(z - 3) / 3) + 1e-9;
  same(cellsOf(P, -2, 10, -2, 8), cellsWhere(pref, -2, 10, -2, 8), 'prism (gable roof)');
  const top = [...cellsOf(P, 4, 4, 3, 3)].map((k) => Number(k.split(',')[1]));
  assert.equal(Math.max(...top), 67, 'the ridge reaches apex.y');
  assert.deepEqual(shapeBounds(P), { minX: 0, maxX: 8, minZ: 0, maxZ: 6, minY: 60, maxY: 67 });
});

test('array and instances equal the explicit union of their copies', () => {
  const B = { kind: 'box', min: [0, 60, 0], max: [1, 62, 2] };
  const arr = { kind: 'array', of: B, step: [5, 1, 0], n: 4 };
  const explicit = { kind: 'union', of: [0, 1, 2, 3].map((k) => ({ kind: 'box', min: [5 * k, 60 + k, 0], max: [5 * k + 1, 62 + k, 2] })) };
  same(cellsOf(arr, -2, 20, -2, 4), cellsOf(explicit, -2, 20, -2, 4), 'array');
  const L = { kind: 'box', min: [0, 60, 0], max: [3, 60, 0] }; // a bar along +x
  const inst = { kind: 'instances', of: L, transforms: [{ t: [10, 0, 10] }, { t: [10, 0, 10], rot: 90 }, { t: [10, 0, 10], rot: 180 }, { t: [10, 0, 10], rot: 270 }, { t: [0, 2, 0], mirror: 'x' }] };
  // rot 90 clockwise from above maps +x to +z
  const want = new Set(['10,60,10', '11,60,10', '12,60,10', '13,60,10', '10,60,11', '10,60,12', '10,60,13', '9,60,10', '8,60,10', '7,60,10', '10,60,9', '10,60,8', '10,60,7', '0,62,0', '-1,62,0', '-2,62,0', '-3,62,0']);
  same(cellsOf(inst, -6, 16, -6, 16), want, 'instances (rotations clockwise, mirror)');
});

test('warp: no cell outside of +- amp; same seed, same cells', () => {
  const S = { kind: 'ellipsoid', c: [0, { abs: 70 }, 0], r: [6, 4, 6] };
  const noise = { kind: 'simplex', dims: 3, scale: 6, octaves: 2, seed: fnv64('warp-test').hex };
  for (const amp of [1, 4, 8]) {
    const w = cellsOf({ kind: 'warp', amp, noise, of: S }, -20, 20, -20, 20);
    const grown = cellsWhere((x, y, z) => (Math.abs(x) <= 6 + amp && Math.abs(z) <= 6 + amp && Math.abs(y - 70) <= 4 + amp), -20, 20, -20, 20);
    for (const k of w) assert.ok(grown.has(k), `amp ${amp}: ${k} is outside the shape's box + amp`);
    assert.ok(w.size > 50, `amp ${amp}: the warped shape is not empty`);
    same(w, cellsOf({ kind: 'warp', amp, noise, of: S }, -20, 20, -20, 20), 'deterministic');
  }
  assert.match(shapeError({ kind: 'warp', amp: 9, noise, of: S }), /amp must be an integer 1\.\.8/);
  assert.match(shapeError({ kind: 'warp', amp: 2, noise, of: { kind: 'sphere', c: [0, { surface: 0 }, 0], r: 3 } }), /absolute y/);
});

// ---- IR helpers

const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: 40, maxY: 120 };
function flatWindow(key = '0,0', g = 64) {
  const [tx, tz] = key.split(',').map(Number);
  const c = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
  c.ground.fill(g); c.height.fill(g); c.floor.fill(g);
  return c;
}
function ir2(ops, extra = {}) {
  const ir = { format: 2, id: 't', programSha: 'x', kitVersion: KIT_VERSION, node: 'test', params: {}, seed: '1', claim: CLAIM, roles: {}, stages: ['main'],
    parts: [{ id: 'p', stage: 'main', set: 'terrain', ops }], lots: [], roads: [], paths: [], anchors: {}, rules: {}, budget: { cells: 0, removed: 0, added: 0 },
    tiles: { main: { terrain: ['0,0'], path: [] } }, ...extra };
  ir.requires = walkKinds(ir);
  return ir;
}
function cellsOfTile(ir, opts = {}, g = 64) {
  const e = evalTile(ir, '0,0', flatWindow('0,0', g), opts);
  const m = new Map();
  for (const c of unpack(e.payload).cells) m.set(`${c.x},${c.y},${c.z}`, c.state);
  return m;
}

test('material rules: each condition, first match wins, default, dither and determinism', () => {
  const ball = { kind: 'ellipsoid', c: [20, { abs: 80 }, 20], r: [8, 6, 8] };
  const rule = { rule: [
    { when: { depth: [0, 0], facing: 'up' }, mat: 'minecraft:grass_block' },
    { when: { depth: [1, 2] }, mat: 'minecraft:dirt' },
    { when: { yAbs: [40, 76] }, mat: 'minecraft:deepslate' },
    { when: { band: [1, 1] }, mat: 'minecraft:tuff' },
  ], default: 'minecraft:stone', dither: 'none' };
  const ir = ir2([{ op: 'shape', shape: { kind: 'strata', bands: { every: 4, offset: 0 }, of: ball }, material: { rule }, cond: 0, walk: false }]);
  assert.deepEqual(ir.requires, ['material:rule', 'shape:ellipsoid', 'shape:strata']);
  const m = cellsOfTile(ir);
  const node = compileShape(ball);
  for (const [k, st] of m) {
    const [x, y, z] = k.split(',').map(Number);
    const sd = sdAt(node, x, y, z, { g: 64, h: 64, f: 64 });
    const up = sdAt(node, x, y + 1, z, { g: 64, h: 64, f: 64 }) > 0;
    const d = Math.floor(-sd);
    const band = Math.floor(y / 4);
    const want = d === 0 && up ? 'minecraft:grass_block' : d >= 1 && d <= 2 ? 'minecraft:dirt' : y <= 76 ? 'minecraft:deepslate' : band === 1 ? 'minecraft:tuff' : 'minecraft:stone';
    assert.equal(st, want, `${k} sd ${sd}`);
  }
  const counts = {};
  for (const st of m.values()) counts[st] = (counts[st] ?? 0) + 1;
  assert.ok(counts['minecraft:grass_block'] > 20 && counts['minecraft:dirt'] > 20 && counts['minecraft:deepslate'] > 20 && counts['minecraft:stone'] > 20, JSON.stringify(counts));
  // determinism, and the dither changes some depth boundaries but stays deterministic
  assert.deepEqual([...cellsOfTile(ir)], [...m]);
  const dith = ir2([{ op: 'shape', shape: ball, material: { rule: { ...rule, rule: rule.rule.slice(0, 2), dither: 'ordered4' } }, cond: 0, walk: false }]);
  const a = cellsOfTile(dith), b = cellsOfTile(dith);
  assert.deepEqual([...a], [...b]);
  // facing: side and down
  const sideRule = { rule: [{ when: { facing: 'down' }, mat: 'minecraft:cobblestone' }, { when: { facing: 'side' }, mat: 'minecraft:andesite' }], default: 'minecraft:stone' };
  const fm = cellsOfTile(ir2([{ op: 'shape', shape: { kind: 'box', min: [10, 70, 10], max: [14, 72, 14] }, material: { rule: sideRule }, cond: 0, walk: false }]));
  assert.equal(fm.get('12,70,12'), 'minecraft:cobblestone');
  assert.equal(fm.get('10,71,12'), 'minecraft:andesite');
  assert.equal(fm.get('12,71,12'), 'minecraft:stone');
  assert.equal(fm.get('12,72,12'), 'minecraft:stone', 'the top is not side or down');
});

test('material rules: slope, field, noise with age; columns ops', () => {
  // a field blob: u8, value = x * 4
  const W = 64, D = 64, vals = new Uint8Array(W * D);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) vals[i + j * W] = i * 4;
  const sha = sha256Hex(vals);
  const blobs = { [sha]: vals };
  const rule = { rule: [{ when: { field: 'wet', gte: 128 }, mat: 'minecraft:mud' }, { when: { noise: { kind: 'value', dims: 3, scale: 4, octaves: 1, seed: fnv64('n').hex }, gte: 0.5, age: 0.2 }, mat: 'minecraft:mossy_cobblestone' }], default: 'minecraft:stone' };
  const ir = ir2([{ op: 'shape', shape: { kind: 'box', min: [0, 70, 0], max: [63, 70, 3] }, material: { rule }, cond: 0, walk: false }],
    { blobs: { wet: { sha, bytes: vals.length, kind: 'field' } }, fields: { wet: { blob: 'wet', type: 'u8', minX: 0, minZ: 0, width: W, depth: D, res: 1 } } });
  assert.deepEqual(ir.requires, ['blobs:side', 'fields', 'material:rule']);
  const m = cellsOfTile(ir, { blobs });
  const noise = makeNoise(rule.rule[1].when.noise);
  for (const [k, st] of m) {
    const [x, y, z] = k.split(',').map(Number);
    const want = x * 4 >= 128 ? 'minecraft:mud' : noise(x, y, z) + 0.2 >= 0.5 ? 'minecraft:mossy_cobblestone' : 'minecraft:stone';
    assert.equal(st, want, k);
  }
  assert.throws(() => evalTile(structuredClone(ir), '0,0', flatWindow(), {}), /blob_unknown [0-9a-f]{64}/);
  // columns op: depth counts down from the entry's top; facing up/down at its ends
  const cr = { rule: [{ when: { facing: 'up' }, mat: 'minecraft:grass_block' }, { when: { depth: [1, 3] }, mat: 'minecraft:dirt' }], default: 'minecraft:stone' };
  const cm = cellsOfTile(ir2([{ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [5, 5, 60, 66, 0], materials: [null], material: { rule: cr }, cond: 0, walk: false }]));
  assert.deepEqual([60, 61, 62, 63, 64, 65, 66].map((y) => cm.get(`5,${y},5`)), ['minecraft:stone', 'minecraft:stone', 'minecraft:stone', 'minecraft:dirt', 'minecraft:dirt', 'minecraft:dirt', 'minecraft:grass_block']);
  // slope: a window with a step
  const step = ir2([{ op: 'shape', shape: { kind: 'box', min: [0, { surface: 0 }, 0], max: [63, { surface: 0 }, 0] }, material: { rule: { rule: [{ when: { slopeGte: 3 }, mat: 'minecraft:gravel' }], default: 'minecraft:grass_block' } }, cond: 0, walk: false }]);
  const w = flatWindow();
  for (let j = 0; j < 80; j++) for (let i = 0; i < 80; i++) if (i - 8 >= 32) { w.ground[i + j * 80] = 70; w.height[i + j * 80] = 70; w.floor[i + j * 80] = 70; }
  const sm = new Map(unpack(evalTile(step, "0,0", w).payload).cells.map((c) => [`${c.x},${c.z}`, c.state]));
  assert.equal(sm.get('31,0'), 'minecraft:gravel');
  assert.equal(sm.get('32,0'), 'minecraft:gravel');
  assert.equal(sm.get('30,0'), 'minecraft:grass_block');
});

test('requires is computed by walking the IR; format 1 stays format 1', () => {
  const plain = ir2([{ op: 'shape', shape: { kind: 'box', min: [1, 70, 1], max: [2, 71, 2] }, material: 'minecraft:stone', cond: 0, walk: false }]);
  assert.deepEqual(plain.requires, []);
  const all = ir2([{ op: 'shape', shape: { kind: 'array', step: [2, 0, 0], n: 2, of: { kind: 'warp', amp: 1, noise: { kind: 'value', dims: 3, scale: 4, octaves: 1, seed: fnv64('a').hex }, of: { kind: 'capsuleChain', points: [[0, 70, 0], [3, 70, 0]], radii: [1, 1] } } }, material: 'minecraft:stone', cond: 0, walk: false }], { forms: [{ id: 'f', generator: 'g', version: 1, params: {}, seed: '1', bounds: {}, ops: [0] }] });
  assert.deepEqual(all.requires, ['forms', 'shape:array', 'shape:capsuleChain', 'shape:warp']);
  for (const k of all.requires) assert.ok(KINDS_FORMAT2.includes(k));
  assert.doesNotThrow(() => compileIR(all));
});

test('format-2 compile errors: unknown op, shape, rule, member; inline blobs; missing requires; format-1 misuse', () => {
  const box = { kind: 'box', min: [1, 70, 1], max: [2, 71, 2] };
  const base = () => ir2([{ op: 'shape', shape: box, material: 'minecraft:stone', cond: 0, walk: false }]);
  const a = base(); a.parts[0].ops[0].op = 'relief';
  assert.throws(() => compileIR(a), /IR: unknown op 'relief' \(supported: shape, columns\)/);
  const b = base(); b.parts[0].ops[0].shape = { kind: 'union', of: [box, { kind: 'blob3d' }] };
  assert.throws(() => compileIR(b), /IR: unknown shape 'blob3d' \(supported: /);
  const c = base(); c.parts[0].ops[0].material = { rule: { rule: [{ when: { wetness: 3 }, mat: 'minecraft:mud' }] } }; c.requires = ['material:rule'];
  assert.throws(() => compileIR(c), /IR: unknown rule 'wetness' \(supported: /);
  const d = base(); d.graph = { nodes: [] };
  assert.throws(() => compileIR(d), /IR: unknown member 'graph'/);
  const e = base(); e.blobs = { h: { minX: 0, minZ: 0, width: 1, depth: 1, data: 'AAA=' } };
  assert.throws(() => compileIR(e), /format 2 blobs are side files/);
  const f = base(); f.parts[0].ops[0].shape = { kind: 'ellipsoid', c: [0, 70, 0], r: [1, 1, 1] };
  assert.throws(() => compileIR(f), /requires misses \[shape:ellipsoid\]/);
  const g = base(); g.format = 1; delete g.requires; g.parts[0].ops[0].shape = { kind: 'ellipsoid', c: [0, 70, 0], r: [1, 1, 1] };
  assert.throws(() => compileIR(g), /shape 'ellipsoid' needs format 2/);
  // a rule with facing over more than 32 primitives
  const h = ir2([{ op: 'shape', shape: { kind: 'array', step: [1, 0, 0], n: 33, of: box }, material: { rule: { rule: [{ when: { facing: 'up' }, mat: 'minecraft:grass_block' }], default: 'minecraft:stone' } }, cond: 0, walk: false }]);
  assert.throws(() => compileIR(h), /at most 32 primitive shapes \(this op has 33\)/);
});

test('PLAN_STALE: format 3, unknown requires, a newer kit; the running kit versions agree', () => {
  assert.equal(EVAL_KIT_VERSION, KIT_VERSION, 'realise.mjs and plan.mjs agree on the kit version');
  const box = { kind: 'box', min: [1, 70, 1], max: [2, 71, 2] };
  const base = () => ir2([{ op: 'shape', shape: box, material: 'minecraft:stone', cond: 0, walk: false }]);
  assert.equal(staleReason(base()), null);
  const f3 = base(); f3.format = 3;
  assert.match(staleReason(f3), /plan needs format 3; this is kit 0\.12\.0/);
  assert.throws(() => compileIR(f3), /^Error: PLAN_STALE: plan needs format 3/);
  const k = base(); k.requires = ['shape:voronoi'];
  assert.match(staleReason(k), /kinds \[shape:voronoi\]/);
  const v = base(); v.kitVersion = '0.99.0';
  assert.match(staleReason(v), /^plan needs kit 0\.99\.0; this is kit 0\.12\.0$/);
  assert.equal(semverCompare('0.12.0', '0.11.9'), 1);
  assert.equal(semverCompare('0.12.0', '0.12.0'), 0);
  assert.equal(semverCompare('0.9.10', '0.10.0'), -1);
  const old = base(); old.kitVersion = '0.11.0';
  assert.equal(staleReason(old), null, 'an older kit version is fine');
});

test('side blobs: ARBL round trip; heightfield and mask by sha', () => {
  const hf = new Uint8Array(4 * 3 * 2);
  for (let k = 0; k < 12; k++) hf[k * 2] = k;
  const arbl = encodeArbl('heightfield', 10, 20, 4, 3, hf);
  const d = decodeArbl(arbl);
  assert.deepEqual({ kind: d.kind, minX: d.minX, minZ: d.minZ, width: d.width, depth: d.depth }, { kind: 'heightfield', minX: 10, minZ: 20, width: 4, depth: 3 });
  assert.deepEqual([...d.bytes], [...hf]);
  const sha = sha256Hex(arbl);
  const ir = ir2([{ op: 'shape', shape: { kind: 'intersect', of: [{ kind: 'heightfield', blob: 'h', scale: 1, y0: 60 }, { kind: 'box', min: [0, 58, 0], max: [63, 99, 63] }] }, material: 'minecraft:stone', cond: 0, walk: false }],
    { blobs: { h: { sha, bytes: arbl.length, kind: 'heightfield' } } });
  const m = cellsOfTile(ir, { blobs: (s) => (s === sha ? arbl : null) });
  const want = new Set();
  for (let x = 10; x < 14; x++) for (let z = 20; z < 23; z++) for (let y = 58; y <= 60 + (x - 10) + (z - 20) * 4; y++) want.add(`${x},${y},${z}`);
  same(new Set(m.keys()), want, 'heightfield over a side blob');
});
