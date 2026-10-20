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
import { ROTATIONS, decodeVoxels, turnState, turnXZ, voxelAt, voxelsBounds } from './region/voxels.mjs';
import { compileMask, maskError, maskUses } from './mask.mjs';
import { compilePattern, isPattern, patternError } from './pattern.mjs';
import { VOXEL_CLASSES, blockAt as volumeBlockAt, classAt as volumeClassAt, decodeArvx } from './region/volume.mjs';
import { compileScatter, compileStamp, scatterTileCells, stampTileCells } from './region/scatter.mjs';

export const AIR = 'minecraft:air';
export const OP_KINDS = ['shape', 'columns', 'voxels', 'relief', 'scatter', 'stamp', 'fluid'];
export const SETS = ['terrain', 'path'];
/** (6b) The IR formats this evaluator reads (kit/REGIONS.md "IR format 2"). */
export const IR_FORMATS = Object.freeze([1, 2]);
/** (6b) Every format-2 kind an IR's `requires` may name; any of them makes the IR format 2. */
export const KINDS_FORMAT2 = Object.freeze(['blobs:side', 'fields', 'forms', 'material:rule', 'shape:array', 'shape:capsuleChain', 'shape:ellipsoid',
  'shape:instances', 'shape:prism', 'shape:strata', 'shape:warp', 'shape:wedge', 'volumes', 'road:lamp', 'voxels',
  'mask', 'pattern', 'relief', 'scatter', 'stamp', 'volume:blocks', 'fluid', 'volume:fluids']);
// (6c W) 'road:lamp': a 4e road's `lamp` (the bible's lamp fixture for its lanterns; kit/lib/region/fixtures.mjs roadLamp). A mod
// before 0.18.0 would lay its own fence and lantern, so the plan needs it (PLAN_STALE there).
// (6c MP) `mask` (an op's mask) and `pattern` (a pattern anywhere a material goes) from kit 0.19.0
// (6c T1) 'relief': a `relief` op (kit/REGIONS.md "The relief op"); a kit before 0.20.0 throws on the op kind.
// (6c F2) 'scatter' and 'stamp': the `scatter` and `stamp` ops (kit/REGIONS.md "Kit 0.22.0"; lib/region/scatter.mjs).
// (6c B) 'volume:blocks': a frozen volume with block ids (ARVX version 2, `volumes[name].blocks`), read by a mask's `block` term; a
// kit before 0.23.0 can't decode it, so the plan needs the kind (PLAN_STALE there).
// (6c H) 'fluid': a fluid body (kit/lib/fluids/body.mjs): its sources and ice cap are evaluated here, the rest (shell, spill, watched
// cells, the settle) is the mod's `fluids` stage; a mod or kit before 0.35.0 refuses the plan PLAN_STALE. 'volume:fluids': a frozen volume
// with the fluid layer (ARVX version 3, `volumes[name].fluids`), which a kit before 0.35.0 can't decode.
/** Max ops in an IR (also the evaluator's buffer encoding limit). */
export const MAX_OPS = 20000;
const OP_SLOTS = 32768; // buffer value = (op index + 1) + material * OP_SLOTS
const EPS = 1e-6;
/** How far beyond the claim's y range clipped cells are counted. */
const CLIP_COUNT_MARGIN = 64;

/** (6b) Op kinds reserved for later phases (they throw as unknown until then). (6c F1) `voxels`, (6c T1) `relief` and (6c F2) `scatter`
 * and `stamp` are built: none is reserved now. */
export const OPS_RESERVED = [];
/** (6b) The members a format-2 IR may have (anything else throws). */
// ((6c H-a) `biomes`: the biome grid's sha a plan records when it reads ctx.biomes (D2), now also in format 2: a body's ice cap reads it)
export const MEMBERS_FORMAT2 = ['anchors', 'biomes', 'blobs', 'blockTags', 'budget', 'claim', 'fields', 'floating', 'format', 'forms', 'graph', 'id', 'keepOut', 'kitVersion', 'lots', 'node', 'params',
  'parts', 'paths', 'programSha', 'requires', 'roads', 'roles', 'rules', 'seed', 'stages', 'tiles', 'utility', 'volumes'];
// (6c V) `graph` (the settlement graph, SETTLEMENTS §8.1) and `keepOut` (the protected rects a program honoured) are known
// members from kit 0.16.0, in format 1 and 2; the evaluator ignores them. An older kit refuses such a plan PLAN_STALE by the
// kitVersion bump.
/** (6b) The running kit's version (kept equal to lib/region/plan.mjs KIT_VERSION by a test). */
export const EVAL_KIT_VERSION = '0.35.1';

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
  const isPat = (m) => !!m && typeof m === 'object' && m.pattern !== undefined;
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) {
    if (o.op === 'shape') for (const s of shapeKinds(o.shape)) if (SHAPES_FORMAT2.includes(s)) k.add(`shape:${s}`);
    if (o.material && typeof o.material === 'object') {
      if (o.material.rule) {
        k.add('material:rule');
        if (isPat(o.material.rule.default) || (o.material.rule.rule ?? []).some((c) => isPat(c?.mat))) k.add('pattern');
      } else if (isPat(o.material)) k.add('pattern');
    }
    if (o.op === 'columns' && (o.materials ?? []).some(isPat)) k.add('pattern');
    if (o.mask !== undefined) k.add('mask');
    if (o.op === 'voxels') k.add('voxels'); // (6c F1)
    if (o.op === 'relief') { k.add('relief'); if (o.fill && typeof o.fill === 'object' && o.fill.rule) k.add('material:rule'); } // (6c T1)
    if (o.op === 'scatter') k.add('scatter'); // (6c F2)
    if (o.op === 'stamp') k.add('stamp');
    if (o.op === 'fluid') k.add('fluid'); // (6c H)
  }
  if (ir.blobs && Object.values(ir.blobs).some((b) => b && b.sha !== undefined)) k.add('blobs:side');
  if (ir.fields && Object.keys(ir.fields).length) k.add('fields');
  if (ir.volumes && Object.keys(ir.volumes).length) k.add('volumes');
  if (ir.volumes && Object.values(ir.volumes).some((v) => v && v.blocks === true)) k.add('volume:blocks'); // (6c B)
  if (ir.volumes && Object.values(ir.volumes).some((v) => v && v.fluids === true)) k.add('volume:fluids'); // (6c H)
  if (Array.isArray(ir.forms) && ir.forms.length) k.add('forms');
  if ((ir.roads ?? []).some((r) => r.lamp)) k.add('road:lamp');
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
  let blobBytes = null; // (6c F1) a side blob's bytes by IR blob name (format 2)
  let blobFn = ir.blobs, fieldFn = () => { throw new Error('IR: fields need format 2'); };
  if (f2) {
    for (const k of Object.keys(ir)) if (!MEMBERS_FORMAT2.includes(k)) throw new Error(`IR: unknown member '${k}' (supported: ${MEMBERS_FORMAT2.join(', ')})`);
    const req = Array.isArray(ir.requires) ? ir.requires : [];
    const walked = walkKinds(ir);
    const miss = walked.filter((k) => !req.includes(k));
    if (miss.length) throw new Error(`IR: requires misses [${miss.join(', ')}]`);
    const get = blobGetter(opts.blobs);
    blobBytes = (name) => {
      const b = ir.blobs?.[name];
      if (!b) throw new Error(`IR: blob '${name}' is not in the IR's blobs`);
      return get(b.sha);
    };
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
  // (6c MP) a class mask reads the IR's frozen volumes (ARVX side blobs), decoded once on first use
  let classFn = null, classIdx = null;
  let blockFn = null;
  if (f2 && Object.keys(ir.volumes ?? {}).length) {
    const get = blobGetter(opts.blobs);
    let vols = null;
    const decoded = () => (vols ??= Object.values(ir.volumes).map((v) => decodeArvx(get(ir.blobs?.[v.blob]?.sha ?? v.sha))));
    // (6c F2) the class index of a cell, or null outside every volume (scatter's anchors)
    classIdx = (x, y, z) => {
      for (const v of decoded()) { const c = volumeClassAt(v, x, y, z); if (c !== 14) return c; }
      return null;
    };
    classFn = (x, y, z) => { const c = classIdx(x, y, z); return c === null ? 'MISSING' : VOXEL_CLASSES[c]; };
    // (6c B) a block mask reads the volumes that carry block ids (`blocks: true`, ARVX version 2); a cell outside them has none
    if (Object.values(ir.volumes).some((v) => v && v.blocks === true)) {
      blockFn = (x, y, z) => {
        for (const v of decoded()) { if (!v.blocks) continue; const b = volumeBlockAt(v, x, y, z); if (b !== null) return b; }
        return null;
      };
    }
  }
  const tagFn = (t) => (ir.blockTags && Object.prototype.hasOwnProperty.call(ir.blockTags, t) ? ir.blockTags[t] : null);
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
      const base = { index: ops.length, part: pi, cond, walk: o.walk ? 1 : 0, mask: compileOpMask(o, where, f2, fieldNames, fieldFn, classFn, blockFn, tagFn) };
      if (o.op === 'shape') {
        for (const k of shapeKinds(o.shape)) {
          if (!f2 && SHAPES_FORMAT2.includes(k)) throw new Error(`${where}: shape '${k}' needs format 2`);
          if (f2 && !PRIMITIVES.includes(k) && !SHAPES_FORMAT2.includes(k) && !COMBINATORS.includes(k)) throw new Error(`IR: unknown shape '${k}' (supported: ${[...PRIMITIVES, ...COMBINATORS, ...SHAPES_FORMAT2].join(', ')})`);
        }
        const node = compileShape(o.shape, blobFn);
        const rule = compileOpRule(o, where, f2, fieldNames, fieldFn, mat, () => compileShape(o.shape, blobFn), o.shape, ir.seed);
        const paint = rule ? null : compileOpPattern(o.material, `${where} material`, f2, fieldNames, fieldFn, mat, ir.seed);
        ops.push({ ...base, kind: 0, node, rule, paint, mat: rule || paint ? 0 : mat(o.material), minX: node.minX, maxX: node.maxX, minZ: node.minZ, maxZ: node.maxZ });
      } else if (o.op === 'columns') {
        const cols = o.cols;
        if (!Array.isArray(cols) || cols.length % 5 !== 0) throw new Error(`${where}: cols must be a flat array of [x, z, a, b, m] entries`);
        const rule = compileOpRule(o, where, f2, fieldNames, fieldFn, mat, null, null, ir.seed);
        // (6c MP) a pattern entry is a per-cell material: its index is stored as -(k + 1) into `paints`
        const paints = [];
        const materials = rule ? [0] : (o.materials ?? []).map((m, i) => {
          const pt = compileOpPattern(m, `${where} materials[${i}]`, f2, fieldNames, fieldFn, mat, ir.seed);
          if (!pt) return mat(m);
          paints.push(pt);
          return -paints.length;
        });
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
        ops.push({ ...base, kind: 1, rule, paints, from: yrefFn(o.from ?? { abs: 0 }), to: yrefFn(o.to ?? { abs: 0 }), entries: e, colIndex: idx, minX, maxX, minZ, maxZ });
      } else if (o.op === 'voxels') {
        // (6c F1) baked cells from an ARVB side blob, copied pointwise by position (tile-independent)
        if (!f2) throw new Error(`${where}: a voxels op needs format 2`);
        // (v0.19.0, F1 + MP) masks are on shape and columns ops only (CONTRACT MP as built); refused, never silently dropped
        if (o.mask !== undefined) throw new Error(`${where}: a voxels op takes no mask (masks are on shape and columns ops)`);
        const org = o.origin;
        if (!Array.isArray(org) || org.length !== 3 || !org.every(Number.isInteger)) throw new Error(`${where}: voxels origin must be [x, y, z] integers`);
        const rot = o.rotation ?? 0;
        if (!ROTATIONS.includes(rot)) throw new Error(`${where}: voxels rotation must be 0, 90, 180 or 270`);
        if (typeof o.blob !== 'string') throw new Error(`${where}: voxels blob must be a blob name`);
        const v = decodeVoxels(blobBytes(o.blob), `blob ${o.blob}`);
        const k = ROTATIONS.indexOf(rot);
        const palMat = v.palette.map((st) => mat(st === AIR ? null : turnState(st, k)));
        const lists = new Map();
        for (let i = 0; i < v.count; i++) {
          const [lx, ly, lz] = voxelAt(v, i);
          const [dx, dz] = turnXZ(lx, lz, v.size[0], v.size[2], k);
          const key = colKey(org[0] + dx, org[2] + dz);
          let l = lists.get(key);
          if (!l) { l = []; lists.set(key, l); }
          l.push(org[1] + ly, palMat[v.pal[i]]);
        }
        const idx = new Map();
        for (const [key, l] of lists) idx.set(key, Int32Array.from(l));
        const bb = voxelsBounds(v, org, rot);
        ops.push({ ...base, kind: 2, colIndex: idx, minX: bb.minX, maxX: bb.maxX, minZ: bb.minZ, maxZ: bb.maxZ });
      } else if (o.op === 'relief') {
        ops.push({ ...base, ...compileRelief(o, where, f2, fieldNames, fieldFn, mat) });
      } else if (o.op === 'scatter' || o.op === 'stamp') {
        // (6c F2) evaluated per tile into column lists (lib/region/scatter.mjs), then copied like voxels
        if (!f2) throw new Error(`${where}: a ${o.op} op needs format 2`);
        const sctx = { blobBytes, mat, fieldNames, fieldFn, seed: ir.seed, lots: ir.lots, keepOut: ir.keepOut, claim, keep: (ir.parts ?? []).flatMap((q) => q.keep ?? []),
          compileMask: (spec, w) => compileOpMask({ mask: spec }, w, f2, fieldNames, fieldFn, classFn) };
        const si = (ir.stages ?? []).indexOf(p.stage);
        // the relief ops before it in an earlier or the same stage: the ground a scatter anchor stands on
        const reliefs = o.op === 'scatter' ? ops.filter((q) => q.kind === 3 && (ir.stages ?? []).indexOf(parts[q.part].stage) <= si) : [];
        if (o.op === 'scatter') ops.push({ ...base, mask: null, ...compileScatter(o, where, sctx), reliefs, classIdx });
        else ops.push({ ...base, ...compileStamp(o, where, sctx) });
      } else if (o.op === 'fluid') {
        // (6c H) a fluid body: its sources (and its ice cap, written after them, so ice wins its cells) copied by position like voxels
        if (!f2) throw new Error(`${where}: a fluid op needs format 2`);
        if (o.mask !== undefined) throw new Error(`${where}: a fluid op takes no mask`);
        if (o.fluid !== 'water' && o.fluid !== 'lava') throw new Error(`${where}: fluid must be water or lava`);
        if (o.ice !== undefined && o.ice.length && o.fluid !== 'water') throw new Error(`${where}: only water is capped with ice`);
        const src = mat(typeof o.state === 'string' ? o.state : `minecraft:${o.fluid}`), ice = mat('minecraft:ice');
        const lists = new Map();
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const [runs, m] of [[o.cells, src], [o.ice ?? [], ice]]) {
          if (!Array.isArray(runs)) throw new Error(`${where}: fluid cells must be column runs [[x, z, y0, y1], ...]`);
          for (const q of runs) {
            if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isInteger) || q[2] > q[3]) throw new Error(`${where}: a fluid run must be [x, z, y0, y1] integers, y0 <= y1`);
            const key = colKey(q[0], q[1]);
            let l = lists.get(key);
            if (!l) { l = []; lists.set(key, l); }
            for (let y = q[2]; y <= q[3]; y++) l.push(y, m);
            if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0]; if (q[1] < minZ) minZ = q[1]; if (q[1] > maxZ) maxZ = q[1];
          }
        }
        const idx = new Map();
        for (const [key, l] of lists) idx.set(key, Int32Array.from(l));
        ops.push({ ...base, kind: 2, colIndex: idx, minX, maxX, minZ, maxZ });
      } else throw new Error(`IR: unknown op '${o.op}' (supported: ${OP_KINDS.join(', ')})`);
    }
  }
  if (ops.length >= OP_SLOTS) throw new Error('IR: too many ops');
  c = { claim, ops, mats, parts, matBytes: mats.map(stateBytes), isAir: mats.map((s) => s === AIR), format: ir.format };
  compiled.set(ir, c);
  return c;
}

/** Count the primitive shapes of a shape tree (array/instances count their copies). */
export function primitiveCount(s) {
  if (!s || typeof s !== 'object') return 0;
  if (PRIMITIVES.includes(s.kind) || ['ellipsoid', 'capsuleChain', 'wedge', 'prism'].includes(s.kind)) return 1;
  const kids = Array.isArray(s.of) ? s.of : s.of ? [s.of] : [];
  const n = kids.reduce((a, k) => a + primitiveCount(k), 0);
  if (s.kind === 'array') return n * s.n;
  if (s.kind === 'instances') return n * s.transforms.length;
  return n;
}

/** Compile an op's material rule (format 2), or null for a plain material. */
function compileOpRule(o, where, f2, fieldNames, fieldFn, mat, second, shape, seed) {
  const m = o.material;
  if (!m || typeof m !== 'object' || m.rule === undefined) return null;
  if (!f2) throw new Error(`${where}: a material rule needs format 2`);
  const r = m.rule;
  const err = ruleError(r, `${where} material`, fieldNames);
  if (err) throw new Error(err);
  if (ruleUsesFacing(r) && shape && primitiveCount(shape) > FACING_MAX_PRIMITIVES) throw new Error(`${where}: a rule with facing allows at most ${FACING_MAX_PRIMITIVES} primitive shapes (this op has ${primitiveCount(shape)})`);
  const pick = compileRule(r, { mat, fields: fieldFn, bands: shape ? strataOf(shape) : null, paint: (p, w) => compileOpPattern(p, w, f2, fieldNames, fieldFn, mat, seed) });
  return { pick, facing: ruleUsesFacing(r), node2: ruleUsesFacing(r) && second ? second() : null };
}

/** (6c MP) Compile a `{pattern: spec}` material (format 2) to `pick(x, y, z, g)`, or null for anything else. */
function compileOpPattern(m, where, f2, fieldNames, fieldFn, mat, seed) {
  if (!m || typeof m !== 'object' || m.pattern === undefined) return null;
  if (!f2) throw new Error(`${where}: a pattern needs format 2`);
  for (const k of Object.keys(m)) if (k !== 'pattern') throw new Error(`${where}: a pattern material is {pattern: spec} (unexpected '${k}')`);
  if (!isPattern(m.pattern)) throw new Error(`${where}: a pattern is {mix} or {gradient}`);
  const err = patternError(m.pattern, `${where}.pattern`, { fields: fieldNames });
  if (err) throw new Error(err);
  for (const x of m.pattern.mix ?? m.pattern.gradient.stops) if (x.mat !== null && x.mat !== undefined && !/^minecraft:/.test(x.mat)) throw new Error(`${where}.pattern: '${x.mat}' is not a block state (an IR names blocks; roles resolve at plan time)`);
  return compilePattern(m.pattern, { mat, fields: fieldFn, seed: seed ?? '0' });
}

/** (6c MP) Compile an op's mask (format 2) to `test(x, y, z, col)`, or null when it has none. */
function compileOpMask(o, where, f2, fieldNames, fieldFn, classFn, blockFn = null, tagFn = null) {
  if (o.mask === undefined) return null;
  if (!f2) throw new Error(`${where}: a mask needs format 2`);
  const err = maskError(o.mask, `${where} mask`, { fields: fieldNames });
  if (err) throw new Error(err);
  if (maskUses(o.mask, 'class') && !classFn) throw new Error(`MASK_NEEDS_VOLUME: ${where}: a mask's class term reads the frozen volumes, and the IR has none (r.needVolume(box) over the masked ops)`);
  // (6c B) a block term needs a volume with block ids (r.needVolume(box, {blocks: true}): ARVX version 2); a version-1 volume holds
  // classes only, so the refusal stays for it
  if (maskUses(o.mask, 'block') && !blockFn) throw new Error(`MASK_NEEDS_VOLUME: ${where}: a mask's block term needs a frozen volume with block ids (r.needVolume(box, {blocks: true})), and the IR has none`);
  return compileMask(o.mask, { fields: fieldFn, classAt: classFn, blockAt: blockFn, tagBlocks: tagFn });
}

/** (6c T1) A relief field's "no value here" sample: the op writes nothing in that column (also outside the field). */
export const RELIEF_NONE = -32768;
/** (6c T1) The relief op's modes and its clamp limit. */
export const RELIEF_MODES = ['delta', 'target'];
export const RELIEF_MAX_CLAMP = 64;
/** (6c T1) How far above the old ground a relief column clears (short and tall plants on a cut or a shallow fill). */
export const RELIEF_CLEAR = 2;

/**
 * (6c T1) Compile a `relief` op: `{op: 'relief', field, mode: 'delta'|'target', cut: cond, fill: blockState|{rule}, maxCut, maxFill}`
 * (SETTLEMENTS §4.1, kit/REGIONS.md "The relief op"). An i16 field over the op's columns: in `delta` mode the new ground is
 * `g + dh`, in `target` mode exactly `dh` (an absolute y), both clamped per column to `g - maxCut .. g + maxFill`. `cut` is the
 * op's write condition (default IF_NATURAL).
 */
function compileRelief(o, where, f2, fieldNames, fieldFn, mat) {
  if (!f2) throw new Error(`${where}: a relief op needs format 2`);
  if (typeof o.field !== 'string' || !fieldNames.has(o.field)) throw new Error(`${where}: relief field '${o.field}' is not one of the IR's fields`);
  const mode = o.mode ?? 'delta';
  if (!RELIEF_MODES.includes(mode)) throw new Error(`${where}: relief mode must be ${RELIEF_MODES.join(' or ')}`);
  const cut = o.cut ?? 0;
  if (!(Number.isInteger(cut) && cut >= 0 && cut <= 3)) throw new Error(`${where}: relief cut must be a cond 0..3`);
  for (const k of ['maxCut', 'maxFill']) if (!(Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= RELIEF_MAX_CLAMP)) throw new Error(`${where}: relief ${k} must be 0..${RELIEF_MAX_CLAMP}`);
  if (o.fill === undefined || o.fill === null || (typeof o.fill !== 'string' && !(typeof o.fill === 'object' && o.fill.rule))) throw new Error(`${where}: relief fill must be a block state or a material rule`);
  // (v0.21.0, T1 over F1 + MP) masks are on shape and columns ops only; refused, never silently dropped
  if (o.mask !== undefined) throw new Error(`${where}: a relief op takes no mask (masks are on shape and columns ops)`);
  const f = fieldFn(o.field);
  if (f.type !== 'i16') throw new Error(`${where}: relief field '${o.field}' must be i16`);
  const rule = typeof o.fill === 'object' ? compileOpRule({ material: o.fill }, `${where} fill`, f2, fieldNames, fieldFn, mat, null, null) : null;
  return {
    kind: 3, cond: cut, field: f, target: mode === 'target', rule, mat: rule ? 0 : mat(o.fill), maxCut: o.maxCut, maxFill: o.maxFill,
    minX: f.minX, maxX: f.minX + f.width * f.res - 1, minZ: f.minZ, maxZ: f.minZ + f.depth * f.res - 1,
  };
}

/** (6c T1) A relief field's sample at (x, z): nearest at res 1, the covering sample at res 4; RELIEF_NONE outside. */
function reliefAt(f, x, z) {
  const i = Math.floor((x - f.minX) / f.res), j = Math.floor((z - f.minZ) / f.res);
  if (i < 0 || j < 0 || i >= f.width || j >= f.depth) return RELIEF_NONE;
  return f.values[i + j * f.width];
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
    g: () => col.g,
    up: () => (R.cols ? R.y === R.b : R.y + 1 > R.hi + EPS || R.node.sd(R.y + 1) > 0),
    down: () => (R.cols ? R.y === R.a : R.y - 1 < R.lo - EPS || R.node.sd(R.y - 1) > 0),
    side: () => (R.cols || !R.node2 ? false : outsideAt(1, 0) || outsideAt(-1, 0) || outsideAt(0, 1) || outsideAt(0, -1)),
    slope: () => {
      const g = col.g;
      return Math.max(Math.abs(groundAt(R.x + 1, R.z) - g), Math.abs(groundAt(R.x - 1, R.z) - g), Math.abs(groundAt(R.x, R.z + 1) - g), Math.abs(groundAt(R.x, R.z - 1) - g));
    },
  };

  // (6c MP) the column a mask reads: the frozen ground and the slope (env.slope, at R.x / R.z)
  const MC = { g: 0, slope: env.slope };
  // (6c F2) scatter and stamp ops: their cells in this tile's columns, computed once per tile (Map op index -> Map(col -> [y, m...]))
  let tileLists = null;
  for (const o of sel) {
    if (o.kind !== 4 && o.kind !== 5) continue;
    tileLists ??= new Map();
    const gAt = (x, z) => {
      const i = x - cols.minX, j = z - cols.minZ;
      if (i < 0 || j < 0 || i >= cols.width || j >= cols.depth) return null;
      const k = i + j * cols.width;
      return cols.flags[k] & FLAG_MISSING ? null : cols.ground[k];
    };
    const fAt = (x, z) => {
      const i = x - cols.minX, j = z - cols.minZ;
      if (i < 0 || j < 0 || i >= cols.width || j >= cols.depth) return FLAG_MISSING;
      return cols.flags[i + j * cols.width];
    };
    if (o.kind === 5) { tileLists.set(o.index, stampTileCells(o, x0, z0, { groundAt: gAt })); continue; }
    const reliefTop = (x, z, g) => {
      let top = g;
      for (const q of o.reliefs) {
        const v = reliefAt(q.field, x, z);
        if (v === RELIEF_NONE) continue;
        let dh = q.target ? v - g : v;
        if (dh < -q.maxCut) dh = -q.maxCut; else if (dh > q.maxFill) dh = q.maxFill;
        if (dh === 0 && !q.target) continue;
        top = g + dh;
      }
      return top;
    };
    const mcol = { g: 0, slope: () => 0 };
    const maskCol = (x, z) => {
      const g = gAt(x, z) ?? 0;
      mcol.g = g;
      mcol.slope = () => Math.max(Math.abs((gAt(x + 1, z) ?? g) - g), Math.abs((gAt(x - 1, z) ?? g) - g), Math.abs((gAt(x, z + 1) ?? g) - g), Math.abs((gAt(x, z - 1) ?? g) - g));
      return mcol;
    };
    // (opts.scatterStats: the placement decisions counted per op, for the tests and the plan's notes; never changes a cell)
    tileLists.set(o.index, scatterTileCells(o, x0, z0, { groundAt: gAt, flagsAt: fAt, hasVolume: !!o.classIdx, classAt: o.classIdx, reliefTop, maskCol }, opts.scatterStats ? (opts.scatterStats[C.parts[o.part].id] ??= { cells: 0, fired: 0, excluded: 0, unsupported: 0, masked: 0, placed: 0 }) : null));
  }
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
            col.g = cols.ground[idx]; col.h = cols.height[idx]; col.f = cols.floor[idx]; MC.g = col.g;
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
                const mask = o.mask;
                if (mask) { R.x = wx; R.z = wz; }
                if (o.rule) {
                  const pick = o.rule.pick;
                  R.x = wx; R.z = wz; R.node = node; R.node2 = o.rule.node2; R.lo = node.lo; R.hi = node.hi; R.cols = false;
                  for (let y = a; y <= b; y++, row++) {
                    const v = node.sd(y);
                    if (v <= 0 && (mask === null || mask(wx, y, wz, MC))) { R.y = y; buf[row * 256 + cell] = tag + pick(wx, y, wz, v, env) * OP_SLOTS; any = true; }
                  }
                } else if (o.paint || mask) {
                  const paint = o.paint;
                  for (let y = a; y <= b; y++, row++) {
                    if (node.sd(y) <= 0 && (mask === null || mask(wx, y, wz, MC))) { buf[row * 256 + cell] = paint ? tag + paint(wx, y, wz, col.g) * OP_SLOTS : val; any = true; }
                  }
                } else {
                  for (let y = a; y <= b; y++, row++) {
                    if (node.sd(y) <= 0) { buf[row * 256 + cell] = val; any = true; }
                  }
                }
                if (any) { if (a - yBase < wLo) wLo = a - yBase; if (b - yBase > wHi) wHi = b - yBase; }
              } else if (o.kind === 2) {
                // (6c F1) voxels: the column's baked cells (y, material) pairs, clipped to the claim like any op
                const list = o.colIndex.get(colKey(wx, wz));
                if (!list) continue;
                if (!inClaimXZ) { for (let q = 0; q < list.length; q += 2) { const y = list[q]; if (y >= cMinY - CLIP_COUNT_MARGIN && y <= cMaxY + CLIP_COUNT_MARGIN) clipped++; } continue; }
                for (let q = 0; q < list.length; q += 2) {
                  const y = list[q];
                  if (y < cMinY || y > cMaxY) { if (y >= cMinY - CLIP_COUNT_MARGIN && y <= cMaxY + CLIP_COUNT_MARGIN) clipped++; continue; }
                  const row = y - yBase;
                  buf[row * 256 + cell] = tag + list[q + 1] * OP_SLOTS;
                  if (row < wLo) wLo = row;
                  if (row > wHi) wHi = row;
                }
              } else if (o.kind === 4 || o.kind === 5) {
                // (6c F2) scatter / stamp: this tile's (y, material) pairs of the column, clipped to the claim like any op
                const list = tileLists.get(o.index).get(colKey(wx, wz));
                if (!list) continue;
                if (!inClaimXZ) { for (let q = 0; q < list.length; q += 2) { const y = list[q]; if (y >= cMinY - CLIP_COUNT_MARGIN && y <= cMaxY + CLIP_COUNT_MARGIN) clipped++; } continue; }
                for (let q = 0; q < list.length; q += 2) {
                  const y = list[q];
                  if (y < cMinY || y > cMaxY) { if (y >= cMinY - CLIP_COUNT_MARGIN && y <= cMaxY + CLIP_COUNT_MARGIN) clipped++; continue; }
                  const row = y - yBase;
                  buf[row * 256 + cell] = tag + list[q + 1] * OP_SLOTS;
                  if (row < wLo) wLo = row;
                  if (row > wHi) wHi = row;
                }
              } else if (o.kind === 3) {
                // (6c T1) relief: the column's new ground `top` from the frozen ground and the field; cut above it (air up to
                // RELIEF_CLEAR over the old ground), fill from the old ground up to it with the fill rule (depth = top - y)
                const v = reliefAt(o.field, wx, wz);
                if (v === RELIEF_NONE) continue;
                const g = col.g;
                let dh = o.target ? v - g : v;
                if (dh < -o.maxCut) dh = -o.maxCut; else if (dh > o.maxFill) dh = o.maxFill;
                if (dh === 0 && !o.target) continue;
                const top = g + dh;
                let a = dh > 0 ? g : top, b = top > g + RELIEF_CLEAR ? top : g + RELIEF_CLEAR;
                if (!inClaimXZ) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); continue; }
                if (a < cMinY) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMinY - 1)); a = cMinY; }
                if (b > cMaxY) { clipped += span(Math.max(a, cMaxY + 1), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); b = cMaxY; }
                if (a > b) continue;
                const pick = o.rule ? o.rule.pick : null;
                if (pick) { R.x = wx; R.z = wz; R.a = a; R.b = top; R.cols = true; }
                const val = tag + o.mat * OP_SLOTS;
                for (let y = a, row = a - yBase; y <= b; y++, row++) {
                  if (y > top) buf[row * 256 + cell] = tag; // air (material 0)
                  else if (pick) { R.y = y; buf[row * 256 + cell] = tag + pick(wx, y, wz, y - top, env) * OP_SLOTS; }
                  else buf[row * 256 + cell] = val;
                }
                if (a - yBase < wLo) wLo = a - yBase;
                if (b - yBase > wHi) wHi = b - yBase;
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
                  const mask = o.mask;
                  if (mask) { R.x = wx; R.z = wz; }
                  if (o.rule) {
                    const pick = o.rule.pick;
                    R.x = wx; R.z = wz; R.a = ua; R.b = ub; R.cols = true;
                    for (let y = a, row = a - yBase; y <= b; y++, row++) {
                      if (mask !== null && !mask(wx, y, wz, MC)) continue;
                      R.y = y; buf[row * 256 + cell] = tag + pick(wx, y, wz, y - ub, env) * OP_SLOTS;
                    }
                  } else if (E[ei + 4] < 0) {
                    const paint = o.paints[-E[ei + 4] - 1];
                    for (let y = a, row = a - yBase; y <= b; y++, row++) if (mask === null || mask(wx, y, wz, MC)) buf[row * 256 + cell] = tag + paint(wx, y, wz, col.g) * OP_SLOTS;
                  } else {
                    const val = tag + E[ei + 4] * OP_SLOTS;
                    if (mask === null) for (let y = a, row = a - yBase; y <= b; y++, row++) buf[row * 256 + cell] = val;
                    else for (let y = a, row = a - yBase; y <= b; y++, row++) if (mask(wx, y, wz, MC)) buf[row * 256 + cell] = val;
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
