// Region realise (docs/CONTRACT.md "Region realise", kit/REGIONS.md "evalTile"): evaluate a Region IR over one
// 64x64-column tile against a frozen heightfield window and return the packed cell list (ARTL). Pure and
// deterministic: the same (ir, key, heights, stage, set) gives byte-identical bytes in any worker, in any order, on any
// OS. Under the realise lint.
//
// Work is per column: every op whose x/z bounds hold the column computes the column's [lo, hi] y span (shapes analytically,
// `columns` ops from their y-refs) and tests sd <= 0 only inside it; results go into a dense per-chunk buffer (last op
// wins), which is scanned in (sy, y, z, x) order, i.e. ARTL order.
import { compileShape, yrefFn } from './sdf.mjs';
import { ByteWriter, FLAG_MISSING, asColumns, sha256Hex, stateBytes, writeArtlHeader } from './region/pack.mjs';

export const AIR = 'minecraft:air';
export const OP_KINDS = ['shape', 'columns'];
export const SETS = ['terrain', 'path'];
/** Max ops in an IR (also the evaluator's buffer encoding limit). */
export const MAX_OPS = 20000;
const OP_SLOTS = 32768; // buffer value = (op index + 1) + material * OP_SLOTS
const EPS = 1e-6;
/** How far beyond the claim's y range clipped cells are counted. */
const CLIP_COUNT_MARGIN = 64;

const compiled = new WeakMap();

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
export function compileIR(ir) {
  if (typeof ir === 'string') ir = JSON.parse(ir);
  let c = compiled.get(ir);
  if (c) return c;
  if (!ir || ir.format !== 1) throw new Error('IR: format must be 1');
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
        const node = compileShape(o.shape, ir.blobs);
        ops.push({ ...base, kind: 0, node, mat: mat(o.material), minX: node.minX, maxX: node.maxX, minZ: node.minZ, maxZ: node.maxZ });
      } else if (o.op === 'columns') {
        const cols = o.cols;
        if (!Array.isArray(cols) || cols.length % 5 !== 0) throw new Error(`${where}: cols must be a flat array of [x, z, a, b, m] entries`);
        const materials = (o.materials ?? []).map(mat);
        if (!materials.length) throw new Error(`${where}: columns op needs materials`);
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
        ops.push({ ...base, kind: 1, from: yrefFn(o.from ?? { abs: 0 }), to: yrefFn(o.to ?? { abs: 0 }), entries: e, index: idx, minX, maxX, minZ, maxZ });
      } else throw new Error(`${where}: unknown op '${o.op}' (shape, columns)`);
    }
  }
  if (ops.length >= OP_SLOTS) throw new Error('IR: too many ops');
  c = { claim, ops, mats, parts, matBytes: mats.map(stateBytes), isAir: mats.map((s) => s === AIR) };
  compiled.set(ir, c);
  return c;
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
  const C = compileIR(ir);
  const [tx, tz] = parseKey(key);
  const cols = asColumns(heights);
  if (cols.resolution !== 1) throw new Error(`evalTile: heights must have resolution 1 (got ${cols.resolution})`);
  const { stage = null, set = null, countOnly = false } = opts;
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
  let clipped = 0, missing = 0, count = 0, removed = 0, added = 0;
  const body = countOnly ? null : new ByteWriter(1 << 16);
  let sections = 0;
  const nMats = C.mats.length;
  const local = new Int32Array(nMats).fill(-1);
  const col = { g: 0, h: 0, f: 0 };
  const cMinY = claim.minY, cMaxY = claim.maxY;

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
                for (let y = a; y <= b; y++, row++) {
                  if (node.sd(y) <= 0) { buf[row * 256 + cell] = val; any = true; }
                }
                if (any) { if (a - yBase < wLo) wLo = a - yBase; if (b - yBase > wHi) wHi = b - yBase; }
              } else {
                const list = o.index.get(colKey(wx, wz));
                if (!list) continue;
                const fy = o.from(col), ty = o.to(col);
                const E = o.entries;
                for (let q = 0; q < list.length; q++) {
                  const ei = list[q] * 5;
                  let a = -Math.floor(-(fy + E[ei + 2] - EPS)), b = Math.floor(ty + E[ei + 3] + EPS);
                  if (a > b) continue;
                  if (!inClaimXZ) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); continue; }
                  if (a < cMinY) { clipped += span(Math.max(a, cMinY - CLIP_COUNT_MARGIN), Math.min(b, cMinY - 1)); a = cMinY; }
                  if (b > cMaxY) { clipped += span(Math.max(a, cMaxY + 1), Math.min(b, cMaxY + CLIP_COUNT_MARGIN)); b = cMaxY; }
                  if (a > b) continue;
                  const val = tag + E[ei + 4] * OP_SLOTS;
                  for (let y = a, row = a - yBase; y <= b; y++, row++) buf[row * 256 + cell] = val;
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
          let n = 0;
          const pal = [];
          for (let p = 0; p < 4096; p++) {
            const v = buf[off + p];
            if (v === 0) continue;
            buf[off + p] = 0;
            const opi = (v % OP_SLOTS) - 1;
            const m = (v - opi - 1) / OP_SLOTS;
            const o = C.ops[opi];
            if (C.isAir[m]) { removed++; partStats[o.part][0]++; } else { added++; partStats[o.part][1]++; }
            if (!countOnly) {
              let li = local[m];
              if (li < 0) { li = pal.length; local[m] = li; pal.push(m); }
              SCRATCH_P[n] = p | (o.cond << 12) | (o.walk << 14);
              SCRATCH_V[n] = li;
            }
            n++;
          }
          if (!n) continue;
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
  if (countOnly) return { payload: null, count, sha: null, removed, added, notes };
  const w = new ByteWriter(body.len + 16);
  writeArtlHeader(w);
  w.varint(sections);
  w.bytes(body.buf.subarray(0, body.len));
  const payload = w.result();
  return { payload, count, sha: sha256Hex(payload), removed, added, notes };
}
