// Region realise (docs/CONTRACT.md "Region realise", kit/REGIONS.md "evalTile"): evaluate a Region IR over one
// 64x64-column tile against a frozen heightfield window and return the packed cell list (ARTL). Pure and
// deterministic: the same (ir, key, heights, stage, set) gives byte-identical bytes in any worker, in any order, on any
// OS. Under the realise lint.
//
// Work is per column: every op whose x/z bounds hold the column computes the column's [lo, hi] y span (shapes analytically,
// `columns` ops from their y-refs) and tests sd <= 0 only inside it; results go into a dense per-chunk buffer (last op
// wins), which is scanned in (sy, y, z, x) order, i.e. ARTL order.
import { COMBINATORS, compileShape, PRIMITIVES, SHAPES_FORMAT2, sdAt, shapeKinds, strataOf, yrefFn } from './sdf.mjs';
import { compileRule, decodeField, FACING_MAX_PRIMITIVES, ruleError, ruleUsesFacing } from './material.mjs';
import { ByteWriter, FLAG_MISSING, asColumns, sha256Hex, stateBytes, writeArtlHeader } from './region/pack.mjs';

export const AIR = 'minecraft:air';
export const OP_KINDS = ['shape', 'columns'];
export const SETS = ['terrain', 'path'];
/** (6b) The IR formats this evaluator reads (kit/REGIONS.md "IR format 2"). */
export const IR_FORMATS = Object.freeze([1, 2]);
/** (6b) Every format-2 kind an IR's `requires` may name; any of them makes the IR format 2. */
export const KINDS_FORMAT2 = Object.freeze(['blobs:side', 'fields', 'forms', 'material:rule', 'shape:array', 'shape:capsuleChain', 'shape:ellipsoid',
  'shape:instances', 'shape:prism', 'shape:strata', 'shape:warp', 'shape:wedge', 'volumes']);
/** Max ops in an IR (also the evaluator's buffer encoding limit). */
export const MAX_OPS = 20000;
const OP_SLOTS = 32768; // buffer value = (op index + 1) + material * OP_SLOTS
const EPS = 1e-6;
/** How far beyond the claim's y range clipped cells are counted. */
const CLIP_COUNT_MARGIN = 64;

/** (6b) Op kinds reserved for later phases (they throw as unknown until then). */
export const OPS_RESERVED = ['relief', 'scatter', 'voxels', 'stamp'];
/** (6b) The members a format-2 IR may have (anything else throws). */
export const MEMBERS_FORMAT2 = ['anchors', 'blobs', 'budget', 'claim', 'fields', 'floating', 'format', 'forms', 'id', 'kitVersion', 'lots', 'node', 'params',
  'parts', 'paths', 'programSha', 'requires', 'roads', 'roles', 'rules', 'seed', 'stages', 'tiles', 'utility', 'volumes'];
/** (6b) The running kit's version (kept equal to lib/region/plan.mjs KIT_VERSION by a test). */
export const EVAL_KIT_VERSION = '0.12.0';

/** Compare two semver strings (major.minor.patch, numeric): -1, 0, 1. */
export function semverCompare(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0), pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/**
 * (6b) Why an IR is too new for this kit (PLAN_STALE), or null: `format` over 2, a `requires` kind this kit lacks, or a
 * `kitVersion` newer than the running kit (CONTRACT §2.4).
 */
export function staleReason(ir, kitVersion = EVAL_KIT_VERSION) {
  if (!ir || typeof ir !== 'object') return null;
  const why = [];
  if (Number.isInteger(ir.format) && ir.format > IR_FORMATS[IR_FORMATS.length - 1]) why.push(`format ${ir.format}`);
  const missing = Array.isArray(ir.requires) ? ir.requires.filter((k) => !KINDS_FORMAT2.includes(k)) : [];
  if (missing.length) why.push(`kinds [${missing.join(', ')}]`);
  if (typeof ir.kitVersion === 'string' && semverCompare(ir.kitVersion, kitVersion) > 0) why.unshift(`kit ${ir.kitVersion}`);
  return why.length ? `plan needs ${why.join(' / ')}; this is kit ${kitVersion}` : null;
}

/**
 * (6b) Every format-2 kind an IR uses (sorted): new shape kinds, material rules, side blobs, fields, volumes, forms. The
 * planner writes this as `requires`; a format-1 IR uses none.
 */
export function walkKinds(ir) {
  const k = new Set();
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) {
    if (o.op === 'shape') for (const s of shapeKinds(o.shape)) if (SHAPES_FORMAT2.includes(s)) k.add(`shape:${s}`);
    if (o.material && typeof o.material === 'object') k.add('material:rule');
  }
  if (ir.blobs && Object.values(ir.blobs).some((b) => b && b.sha !== undefined)) k.add('blobs:side');
  if (ir.fields && Object.keys(ir.fields).length) k.add('fields');
  if (ir.volumes && Object.keys(ir.volumes).length) k.add('volumes');
  if (Array.isArray(ir.forms) && ir.forms.length) k.add('forms');
  return [...k].sort();
}

/** (6b) Decode an ARBL side blob (heightfield / mask) into the shape library's blob form. */
export function decodeArbl(bytes, what = 'blob') {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < 24 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x42 || b[3] !== 0x4c) throw new Error(`${what}: not an ARBL blob`);
  if (b[4] !== 1) throw new Error(`${what}: ARBL version ${b[4]} (this kit reads 1)`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { kind: b[5] === 1 ? 'heightfield' : 'mask', minX: dv.getInt32(8, true), minZ: dv.getInt32(12, true), width: dv.getInt32(16, true), depth: dv.getInt32(20, true), bytes: b.subarray(24) };
}

/** (6b) Encode an ARBL side blob. */
export function encodeArbl(kind, minX, minZ, width, depth, data) {
  const out = new Uint8Array(24 + data.length);
  out.set([0x41, 0x52, 0x42, 0x4c, 1, kind === 'heightfield' ? 1 : 2, 0, 0]);
  const dv = new DataView(out.buffer);
  dv.setInt32(8, minX, true); dv.setInt32(12, minZ, true); dv.setInt32(16, width, true); dv.setInt32(20, depth, true);
  out.set(data, 24);
  return out;
}

/** A blob-bytes getter from `opts.blobs` (a function sha -> bytes, a Map or a plain object), throwing `blob_unknown <sha>`. */
function blobGetter(blobs) {
  return (sha) => {
    const v = typeof blobs === 'function' ? blobs(sha) : blobs instanceof Map ? blobs.get(sha) : blobs?.[sha];
    if (!v) throw new Error(`blob_unknown ${sha}`);
    return v instanceof Uint8Array ? v : Uint8Array.from(v);
  };
}

const compiled = new WeakMap();
const textCache = []; // the last 4 IR texts (an IR passed as a string)

/** Parse a tile key "tx,tz". */
export function parseKey(key) {
  const m = /^(-?\d+),(-?\d+)$/.exec(String(key));
  if (!m) throw new Error(`tile key must be "tx,tz" (got '${key}')`);
  return [Number(m[1]), Number(m[2])];
}

const span = (a, b) => (b >= a ? b - a + 1 : 0);
const colKey = (x, z) => (x + 33554432) * 67108864 + (z + 33554432);

/**
 * Compile an IR for evaluation (cached per IR object). Throws on a malformed op.
 * @returns {{ claim, ops: object[], mats: string[], parts: object[] }}
 */
export function compileIR(ir, opts = {}) {
  if (typeof ir === 'string') {
    const hit = textCache.find((e) => e.text === ir);
    if (hit) return hit.c;
    const c = compileIR(JSON.parse(ir), opts);
    textCache.unshift({ text: ir, c });
    if (textCache.length > 4) textCache.pop();
    return c;
  }
  let c = compiled.get(ir);
  if (c) return c;
  const stale = staleReason(ir);
  if (stale) throw new Error(`PLAN_STALE: ${stale}`);
  if (!ir || !IR_FORMATS.includes(ir.format)) throw new Error(`IR: format must be one of ${IR_FORMATS.join(', ')}`);
  const f2 = ir.format === 2;
  let blobFn = ir.blobs, fieldFn = () => { throw new Error('IR: fields need format 2'); };
  if (f2) {
    for (const k of Object.keys(ir)) if (!MEMBERS_FORMAT2.includes(k)) throw new Error(`IR: unknown member '${k}' (supported: ${MEMBERS_FORMAT2.join(', ')})`);
    const req = Array.isArray(ir.requires) ? ir.requires : [];
    const walked = walkKinds(ir);
    const miss = walked.filter((k) => !req.includes(k));
    if (miss.length) throw new Error(`IR: requires misses [${miss.join(', ')}]`);
    const get = blobGetter(opts.blobs);
    const decoded = new Map();
    for (const [name, b] of Object.entries(ir.blobs ?? {})) {
      if (!b || typeof b !== 'object') throw new Error(`IR: blob ${name} must be {sha, bytes, kind}`);
      if (b.data !== undefined) throw new Error(`IR: blob ${name}: format 2 blobs are side files`);
      if (typeof b.sha !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha)) throw new Error(`IR: blob ${name}.sha must be a sha-256 hex`);
    }
    blobFn = (name) => {
      const b = ir.blobs?.[name];
      if (!b) throw new Error(`shape: blob '${name}' is not in the IR's blobs`);
      let d = decoded.get(name);
      if (!d) { d = decodeArbl(get(b.sha), `blob ${name}`); decoded.set(name, d); }
      return d;
    };
    const fieldsDec = new Map();
    fieldFn = (name) => {
      let d = fieldsDec.get(name);
      if (d) return d;
      const e = ir.fields?.[name];
      if (!e) throw new Error(`IR: field '${name}' is not in the IR's fields`);
      const b = ir.blobs?.[e.blob];
      if (!b) throw new Error(`IR: field ${name}: blob '${e.blob}' is not in the IR's blobs`);
      d = decodeField(e, get(b.sha));
      fieldsDec.set(name, d);
      return d;
    };
  } else {
    if (ir.blobs) for (const [name, b] of Object.entries(ir.blobs)) if (b && b.sha !== undefined) throw new Error(`IR: blob ${name}: side blobs need format 2`);
    for (const k of ['requires', 'fields', 'volumes', 'forms']) if (ir[k] !== undefined) throw new Error(`IR: '${k}' needs format 2`);
  }
  const fieldNames = new Set(Object.keys(ir.fields ?? {}));
  const claim = ir.claim;
  for (const k of ['minX', 'minZ', 'maxX', 'maxZ', 'minY', 'maxY']) if (!Number.isInteger(claim?.[k])) throw new Error(`IR: claim.${k} must be an integer`);
  const mats = [];
  const matIdx = new Map();
  const mat = (s) => {
    const st = s == null ? AIR : s;
    let i = matIdx.get(st);
    if (i === undefined) { i = mats.length; mats.push(st); matIdx.set(st, i); }
    return i;
  };
  mat(AIR);
  const parts = [];
  const ops = [];
  for (const p of ir.parts ?? []) {
    const pi = parts.length;
    parts.push({ id: p.id, stage: p.stage, set: p.set ?? 'terrain' });
    for (const o of p.ops ?? []) {
      const where = `IR part ${p.id} op ${ops.length}`;
      if (ops.length >= MAX_OPS) throw new Error(`IR: more than ${MAX_OPS} ops`);
      const cond = o.cond ?? 0;
      if (!(Number.isInteger(cond) && cond >= 0 && cond <= 3)) throw new Error(`${where}: cond must be 0..3`);
      const base = { index: ops.length, part: pi, cond, walk: o.walk ? 1 : 0 };
      if (o.op === 'shape') {
        for (const k of shapeKinds(o.shape)) {
          if (!f2 && SHAPES_FORMAT2.includes(k)) throw new Error(`${where}: shape '${k}' needs format 2`);
          if (f2 && !PRIMITIVES.includes(k) && !SHAPES_FORMAT2.includes(k) && !COMBINATORS.includes(k)) throw new Error(`IR: unknown shape '${k}' (supported: ${[...PRIMITIVES, ...COMBINATORS, ...SHAPES_FORMAT2].join(', ')})`);
        }
        const node = compileShape(o.shape, blobFn);
        const rule = compileOpRule(o, where, f2, fieldNames, fieldFn, mat, () => compileShape(o.shape, blobFn), o.shape);
        ops.push({ ...base, kind: 0, node, rule, mat: rule ? 0 : mat(o.material), minX: node.minX, maxX: node.maxX, minZ: node.minZ, maxZ: node.maxZ });
      } else if (o.op === 'columns') {
        const cols = o.cols;
        if (!Array.isArray(cols) || cols.length % 5 !== 0) throw new Error(`${where}: cols must be a flat array of [x, z, a, b, m] entries`);
        const rule = compileOpRule(o, where, f2, fieldNames, fieldFn, mat, null, null);
        const materials = rule ? [0] : (o.materials ?? []).map(mat);
        if (!materials.length) throw new Error(`${where}: columns op needs materials`);
        if (rule && cols.some((v, i) => i % 5 === 4 && v !== 0)) throw new Error(`${where}: a columns op with a material rule has material index 0 only`);
        const n = cols.length / 5;
        const e = new Float64Array(cols.length);
        const index = new Map();
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = cols[i * 5], z = cols[i * 5 + 1], a = cols[i * 5 + 2], b = cols[i * 5 + 3], m = cols[i * 5 + 4];
          if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`${where}: entry ${i} must be integers`);
          if (!(Number.isInteger(m) && m >= 0 && m < materials.length)) throw new Error(`${where}: entry ${i} material index out of range`);
          e[i * 5] = x; e[i * 5 + 1] = z; e[i * 5 + 2] = a; e[i * 5 + 3] = b; e[i * 5 + 4] = materials[m];
          const k = colKey(x, z);
          const l = index.get(k);
          if (l) l.push(i); else index.set(k, [i]);
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const idx = new Map();
        for (const [k, l] of index) idx.set(k, Int32Array.from(l));
        ops.push({ ...base, kind: 1, rule, from: yrefFn(o.from ?? { abs: 0 }), to: yrefFn(o.to ?? { abs: 0 }), entries: e, colIndex: idx, minX, maxX, minZ, maxZ });
      } else throw new Error(`IR: unknown op '${o.op}' (supported: ${OP_KINDS.join(', ')})`);
    }
  }
  if (ops.length >= OP_SLOTS) throw new Error('IR: too many ops');
  c = { claim, ops, mats, parts, matBytes: mats.map(stateBytes), isAir: mats.map((s) => s === AIR), format: ir.format };
  compiled.set(ir, c);
  return c;
}

/** Count the primitive shapes of a shape tree (array/instances count their copies). */
function primitiveCount(s) {
  if (!s || typeof s !== 'object') return 0;
  if (PRIMITIVES.includes(s.kind) || ['ellipsoid', 'capsuleChain', 'wedge', 'prism'].includes(s.kind)) return 1;
  const kids = Array.isArray(s.of) ? s.of : s.of ? [s.of] : [];
  const n = kids.reduce((a, k) => a + primitiveCount(k), 0);
  if (s.kind === 'array') return n * s.n;
  if (s.kind === 'instances') return n * s.transforms.length;
  return n;
}

/** Compile an op's material rule (format 2), or null for a plain material. */
function compileOpRule(o, where, f2, fieldNames, fieldFn, mat, second, shape) {
  const m = o.material;
  if (!m || typeof m !== 'object') return null;
  if (!f2) throw new Error(`${where}: a material rule needs format 2`);
  const r = m.rule;
  const err = ruleError(r, `${where} material`, fieldNames);
  if (err) throw new Error(err);
  if (ruleUsesFacing(r) && shape && primitiveCount(shape) > FACING_MAX_PRIMITIVES) throw new Error(`${where}: a rule with facing allows at most ${FACING_MAX_PRIMITIVES} primitive shapes (this op has ${primitiveCount(shape)})`);
  const pick = compileRule(r, { mat, fields: fieldFn, bands: shape ? strataOf(shape) : null });
  return { pick, facing: ruleUsesFacing(r), node2: ruleUsesFacing(r) && second ? second() : null };
}

// one evaluation buffer per thread, grown as needed
let BUF = new Int32Array(0);
const SCRATCH_V = new Int32Array(4096);
const SCRATCH_P = new Int32Array(4096);

/**
 * Evaluate one tile. `heights`: ARSV bytes or a decoded columns object covering the tile's columns (normally its 80x80
 * window at resolution 1). Options: `stage` / `set` (default all), `countOnly` (no payload or sha; same counts).
 * @returns {{ payload: Uint8Array|null, count: number, sha: string|null, removed: number, added: number,
 *             notes: { parts: Record<string, {removed: number, placed: number}>, clipped: number, missing: number } }}
 */
export function evalTile(ir, key, heights, opts = {}) {
  const C = compileIR(ir, { blobs: opts.blobs });
  const [tx, tz] = parseKey(key);
  const cols = asColumns(heights);
  if (cols.resolution !== 1) throw new Error(`evalTile: heights must have resolution 1 (got ${cols.resolution})`);
  const { stage = null, set = null, countOnly = false, cellOps = false } = opts;
  // (6b, the checker) the op index of every emitted cell, in payload order
  let opsOut = cellOps ? new Int32Array(4096) : null, opsN = 0;
  if (set !== null && !SETS.includes(set)) throw new Error(`evalTile: set must be terrain or path (got '${set}')`);
  const claim = C.claim;
  const x0 = tx * 64, z0 = tz * 64;

  // the ops of this request whose x/z bounds touch the tile
  const sel = [];
  for (const o of C.ops) {
    const p = C.parts[o.part];
    if (stage !== null && p.stage !== stage) continue;
    if (set !== null && p.set !== set) continue;
    if (o.maxX < x0 || o.minX > x0 + 63 || o.maxZ < z0 || o.minZ > z0 + 63) continue;
    sel.push(o);
  }

  const sy0 = Math.floor(claim.minY / 16), sy1 = Math.floor(claim.maxY / 16);
  const yBase = sy0 * 16;
  const ny = (sy1 - sy0 + 1) * 16;
  if (BUF.length < ny * 256) BUF = new Int32Array(ny * 256);
  const buf = BUF;
  const partStats = C.parts.map(() => [0, 0]); // removed, placed
  let clipped = 0, missing = 0, count = 0, removed = 0, added = 0, minY = null, maxY = null;
  const body = countOnly ? null : new ByteWriter(1 << 16);
  let sections = 0;
  const nMats = C.mats.length;
  const local = new Int32Array(nMats).fill(-1);
  const col = { g: 0, h: 0, f: 0 };
  const cMinY = claim.minY, cMaxY = claim.maxY;
  // (6b) material rules: the lazily evaluated neighbourhood of the current cell
  const R = { x: 0, y: 0, z: 0, node: null, node2: null, hi: 0, lo: 0, a: 0, b: 0, cols: false };
  const colN = { g: 0, h: 0, f: 0 };
  const groundAt = (x, z) => {
    const i = x - cols.minX, j = z - cols.minZ;
    if (i < 0 || j < 0 || i >= cols.width || j >= cols.depth) return col.g;
    const k = i + j * cols.width;
    return cols.flags[k] & FLAG_MISSING ? col.g : cols.ground[k];
  };
  const outsideAt = (dx, dz) => {
    const x = R.x + dx, z = R.z + dz;
    const i = x - cols.minX, j = z - cols.minZ;
    if (i < 0 || j < 0 || i >= cols.width || j >= cols.depth || cols.flags[i + j * cols.width] & FLAG_MISSING) { colN.g = col.g; colN.h = col.h; colN.f = col.f; }
    else { const k = i + j * cols.width; colN.g = cols.ground[k]; colN.h = cols.height[k]; colN.f = cols.floor[k]; }
    return sdAt(R.node2, x, R.y, z, colN) > 0;
  };
  const env = {
    up: () => (R.cols ? R.y === R.b : R.y + 1 > R.hi + EPS || R.node.sd(R.y + 1) > 0),
    down: () => (R.cols ? R.y === R.a : R.y - 1 < R.lo - EPS || R.node.sd(R.y - 1) > 0),
    side: () => (R.cols || !R.node2 ? false : outsideAt(1, 0) || outsideAt(-1, 0) || outsideAt(0, 1) || outsideAt(0, -1)),
    slope: () => {
      const g = col.g;
      return Math.max(Math.abs(groundAt(R.x + 1, R.z) - g), Math.abs(groundAt(R.x - 1, R.z) - g), Math.abs(groundAt(R.x, R.z + 1) - g), Math.abs(groundAt(R.x, R.z - 1) - g));
    },
  };

  if (sel.length) try {
    for (let cx = 0; cx < 4; cx++) {
      for (let cz = 0; cz < 4; cz++) {
        const sx = tx * 4 + cx, sz = tz * 4 + cz;
        let wLo = ny, wHi = -1; // written buffer rows (y - yBase)
        for (let lz = 0; lz < 16; lz++) {
          const wz = sz * 16 + lz;
          for (let lx = 0; lx < 16; lx++) {
            const wx = sx * 16 + lx;
            // ops touching this column
            let first = -1;
            for (let k = 0; k < sel.length; k++) {
              const o = sel[k];
              if (wx >= o.minX && wx <= o.maxX && wz >= o.minZ && wz <= o.maxZ) { first = k; break; }
            }
            if (first < 0) continue;
            const ci = wx - cols.minX, cj = wz - cols.minZ;
            if (ci < 0 || cj < 0 || ci >= cols.width || cj >= cols.depth) { missing++; continue; }
            const idx = ci + cj * cols.width;
            if (cols.flags[idx] & FLAG_MISSING) { missing++; continue; }
            col.g = cols.ground[idx]; col.h = cols.height[idx]; col.f = cols.floor[idx];
            const inClaimXZ = wx >= claim.minX && wx <= claim.maxX && wz >= claim.minZ && wz <= claim.maxZ;
            const cell = lz * 16 + lx;
            for (let k = first; k < sel.length; k++) {
              const o = sel[k];
              if (wx < o.minX || wx > o.maxX || wz < o.minZ || wz > o.maxZ) continue;
              const tag = o.index + 1;
              if (o.kind === 0) {
                const node = o.node;
                if (!node.prep(wx, wz, col)) continue;
                let a = -Math.floor(-(node.lo - EPS)), b = Math.floor(node.hi + EPS);
                const val = tag + o.mat * OP_SLOTS;
                if (!inClaimXZ) {
                  a = Math.max(a, cMinY - CLIP_COUNT_MARGIN); b = Math.min(b, cMaxY + CLIP_COUNT_MARGIN);
                  for (let y = a; y <= b; y++) if (node.sd(y) <= 0) clipped++;
                  continue;
                }
                if (a < cMinY) {
                  const e = Math.min(b, cMinY - 1);
                  for (let y = Math.max(a, cMinY - CLIP_COUNT_MARGIN); y <= e; y++) if (node.sd(y) <= 0) clipped++;
                  a = cMinY;
                }
                if (b > cMaxY) {
                  const s = Math.max(a, cMaxY + 1);
                  for (let y = s, e = Math.min(b, cMaxY + CLIP_COUNT_MARGIN); y <= e; y++) if (node.sd(y) <= 0) clipped++;
                  b = cMaxY;
                }
                if (a > b) continue;
                let row = a - yBase;
                let any = false;
                if (o.rule) {
                  const pick = o.rule.pick;
                  R.x = wx; R.z = wz; R.node = node; R.node2 = o.rule.node2; R.lo = node.lo; R.hi = node.hi; R.cols = false;
                  for (let y = a; y <= b; y++, row++) {
                    const v = node.sd(y);
                    if (v <= 0) { R.y = y; buf[row * 256 + cell] = tag + pick(wx, y, wz, v, env) * OP_SLOTS; any = true; }
                  }
                } else {
                  for (let y = a; y <= b; y++, row++) {
                    if (node.sd(y) <= 0) { buf[row * 256 + cell] = val; any = true; }
                  }
                }
                if (any) { if (a - yBase < wLo) wLo = a - yBase; if (b - yBase > wHi) wHi = b - yBase; }
              } else {
                const list = o.colIndex.get(colKey(wx, wz));
                if (!list) continue;
                const fy = o.from(col), ty = o.to(col);
                const E = o.entries;
                for (let q = 0; q < list.length; q++) {
                  const ei = list[q] * 5;
                  let a = -Math.floor(-(fy + E[ei + 2] - EPS)), b = Math.floor(ty + E[ei + 3] + EPS);
                  if (a > b) continue;
                  const ua = a, ub = b;
                  if (!inClaimXZ) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); continue; }
                  if (a < cMinY) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMinY - 1)); a = cMinY; }
                  if (b > cMaxY) { clipped += span(Math.max(a, cMaxY + 1), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); b = cMaxY; }
                  if (a > b) continue;
                  if (o.rule) {
                    const pick = o.rule.pick;
                    R.x = wx; R.z = wz; R.a = ua; R.b = ub; R.cols = true;
                    for (let y = a, row = a - yBase; y <= b; y++, row++) { R.y = y; buf[row * 256 + cell] = tag + pick(wx, y, wz, y - ub, env) * OP_SLOTS; }
                  } else {
                    const val = tag + E[ei + 4] * OP_SLOTS;
                    for (let y = a, row = a - yBase; y <= b; y++, row++) buf[row * 256 + cell] = val;
                  }
                  if (a - yBase < wLo) wLo = a - yBase;
                  if (b - yBase > wHi) wHi = b - yBase;
                }
              }
            }
          }
        }
        if (wHi < 0) continue;
        // scan the chunk's touched sections in ARTL order, then clear them
        const s0 = wLo >> 4, s1 = wHi >> 4;
        for (let s = s0; s <= s1; s++) {
          const off = s * 4096;
          let n = 0, firstP = -1, lastP = 0;
          const pal = [];
          for (let p = 0; p < 4096; p++) {
            const v = buf[off + p];
            if (v === 0) continue;
            buf[off + p] = 0;
            if (firstP < 0) firstP = p;
            lastP = p;
            const opi = (v % OP_SLOTS) - 1;
            const m = (v - opi - 1) / OP_SLOTS;
            const o = C.ops[opi];
            if (C.isAir[m]) { removed++; partStats[o.part][0]++; } else { added++; partStats[o.part][1]++; }
            if (opsOut) {
              if (opsN === opsOut.length) { const g = new Int32Array(opsN * 2); g.set(opsOut); opsOut = g; }
              opsOut[opsN++] = opi;
            }
            if (!countOnly) {
              let li = local[m];
              if (li < 0) { li = pal.length; local[m] = li; pal.push(m); }
              SCRATCH_P[n] = p | (o.cond << 12) | (o.walk << 14);
              SCRATCH_V[n] = li;
            }
            n++;
          }
          if (!n) continue;
          const y0 = yBase + s * 16 + (firstP >> 8), y1 = yBase + s * 16 + (lastP >> 8);
          if (minY === null || y0 < minY) minY = y0;
          if (maxY === null || y1 > maxY) maxY = y1;
          count += n;
          if (countOnly) continue;
          sections++;
          body.zigzag(sx); body.zigzag(sy0 + s); body.zigzag(sz);
          body.varint(pal.length);
          for (const m of pal) { const b = C.matBytes[m]; body.varint(b.length); body.bytes(b); }
          body.varint(n);
          body.ensure(n * 4);
          const bb = body.buf;
          let L = body.len;
          for (let i = 0; i < n; i++) { const w = SCRATCH_P[i]; bb[L++] = w & 255; bb[L++] = w >>> 8; }
          if (pal.length > 1) {
            if (pal.length <= 256) for (let i = 0; i < n; i++) bb[L++] = SCRATCH_V[i];
            else for (let i = 0; i < n; i++) { const w = SCRATCH_V[i]; bb[L++] = w & 255; bb[L++] = w >>> 8; }
          }
          body.len = L;
          for (const m of pal) local[m] = -1;
        }
      }
    }
  } catch (e) {
    BUF.fill(0); // never leave a dirty buffer for the next tile
    throw e;
  }

  const parts = {};
  C.parts.forEach((p, i) => {
    const [r, a] = partStats[i];
    if (r || a) {
      const cur = parts[p.id] ?? { removed: 0, placed: 0 };
      cur.removed += r; cur.placed += a;
      parts[p.id] = cur;
    }
  });
  const notes = { parts, clipped, missing };
  if (countOnly) return { payload: null, count, sha: null, removed, added, minY, maxY, notes };
  const w = new ByteWriter(body.len + 16);
  writeArtlHeader(w);
  w.varint(sections);
  w.bytes(body.buf.subarray(0, body.len));
  const payload = w.result();
  const res = { payload, count, sha: sha256Hex(payload), removed, added, minY, maxY, notes };
  if (opsOut) res.cellOps = opsOut.subarray(0, opsN);
  return res;
}
