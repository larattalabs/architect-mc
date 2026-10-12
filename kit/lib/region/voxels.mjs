// ARVB: the `voxels` op's side blob (docs/CONTRACT.md 6c F1 §5, SETTLEMENTS §3.2 and §9.1): baked cells as a palette plus
// packed positions, ARTL-like. Pure and under the realise lint (lib/realise.mjs imports it): no gzip (the bytes are the identity,
// the same on every OS), no clock, only exact Math members.
//
//   'ARVB' u8 version=1 u8 0 u8 0 u8 0
//   i32 LE sizeX, sizeY, sizeZ                        the blob's box, local cells 0..size-1 on each axis
//   varint paletteCount, then per entry varint len + UTF-8 block state (canonical; 'minecraft:air' allowed)
//   varint cellCount
//   cellCount x varint delta of the local index ((y * sizeZ + z) * sizeX + x), ascending (the first delta from -1)
//   cellCount x palette index: u8 when the palette has at most 256 entries, else u16 LE
//
// The op `{op: 'voxels', blob, origin: [x, y, z], rotation: 0|90|180|270}` puts local (0, 0, 0) of the turned box at `origin`.
// A turn is clockwise seen from above (x east, z south): one quarter turn maps local (x, z) to (sizeZ - 1 - z, x), as the kit's
// renderer turns a structure; block states turn with it (facing, the four connection flags, axis, sign rotation).

const enc = new TextEncoder();
const dec = new TextDecoder();
export const ROTATIONS = [0, 90, 180, 270];
/** A blob's cell count limit (16 MB side blobs hold far fewer cells than this). */
export const VOXELS_MAX_CELLS = 8_000_000;

/**
 * Encode cells `[[x, y, z, state], ...]` (local, 0 <= x < size[0], ...; unique positions) into ARVB bytes. The palette is in
 * order of first use over the sorted cells, so equal cells give equal bytes.
 */
export function encodeVoxels(size, cells) {
  const [sx, sy, sz] = size;
  if (![sx, sy, sz].every((v) => Number.isInteger(v) && v >= 1 && v <= 4096)) throw new Error('voxels: size must be 3 integers 1..4096');
  if (cells.length > VOXELS_MAX_CELLS) throw new Error(`voxels: ${cells.length} cells (at most ${VOXELS_MAX_CELLS})`);
  const idx = cells.map((c, i) => {
    const [x, y, z] = c;
    if (!(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz)) throw new Error(`voxels: cell ${i} [${x}, ${y}, ${z}] is outside the size`);
    return [(y * sz + z) * sx + x, c[3]];
  });
  idx.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < idx.length; i++) if (idx[i][0] === idx[i - 1][0]) throw new Error('voxels: a position is given twice');
  const pal = [], pi = new Map();
  const ids = idx.map(([, s]) => {
    let k = pi.get(s);
    if (k === undefined) { k = pal.length; pal.push(s); pi.set(s, k); }
    return k;
  });
  const out = [0x41, 0x52, 0x56, 0x42, 1, 0, 0, 0];
  const i32 = (v) => { const u = v >>> 0; out.push(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255); };
  const varint = (v) => { let n = v; do { let b = n % 128; n = Math.floor(n / 128); if (n) b += 128; out.push(b); } while (n); };
  i32(sx); i32(sy); i32(sz);
  varint(pal.length);
  for (const s of pal) { const b = enc.encode(s); varint(b.length); for (const x of b) out.push(x); }
  varint(idx.length);
  let last = -1;
  for (const [p] of idx) { varint(p - last); last = p; }
  if (pal.length <= 256) for (const k of ids) out.push(k);
  else for (const k of ids) out.push(k & 255, k >>> 8);
  return Uint8Array.from(out);
}

/** Decode ARVB bytes: `{size, palette, count, pos: Int32Array (local index), pal: Uint16Array}`. Throws on a bad blob. */
export function decodeVoxels(bytes, what = 'voxels') {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < 20 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x56 || b[3] !== 0x42) throw new Error(`${what}: not an ARVB blob`);
  if (b[4] !== 1) throw new Error(`${what}: ARVB version ${b[4]} (this kit reads 1)`);
  let o = 8;
  const i32 = () => { const v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); o += 4; return v; };
  const varint = () => {
    let v = 0, mul = 1, byte;
    do {
      if (o >= b.length) throw new Error(`${what}: truncated`);
      byte = b[o++]; v += (byte & 127) * mul; mul *= 128;
    } while (byte & 128);
    return v;
  };
  const size = [i32(), i32(), i32()];
  if (!size.every((v) => v >= 1 && v <= 4096)) throw new Error(`${what}: bad size`);
  const np = varint();
  if (np < 1 || np > 65536) throw new Error(`${what}: bad palette size ${np}`);
  const palette = [];
  for (let i = 0; i < np; i++) {
    const n = varint();
    if (o + n > b.length) throw new Error(`${what}: truncated palette`);
    palette.push(dec.decode(b.subarray(o, o + n)));
    o += n;
  }
  const count = varint();
  if (count > VOXELS_MAX_CELLS) throw new Error(`${what}: ${count} cells`);
  const total = size[0] * size[1] * size[2];
  const pos = new Int32Array(count);
  let last = -1;
  for (let i = 0; i < count; i++) {
    const d = varint();
    if (d < 1) throw new Error(`${what}: positions not ascending`);
    last += d;
    if (last >= total) throw new Error(`${what}: a position is outside the size`);
    pos[i] = last;
  }
  const pal = new Uint16Array(count);
  if (np <= 256) { if (o + count > b.length) throw new Error(`${what}: truncated`); for (let i = 0; i < count; i++) pal[i] = b[o++]; }
  else { if (o + 2 * count > b.length) throw new Error(`${what}: truncated`); for (let i = 0; i < count; i++) { pal[i] = b[o] | (b[o + 1] << 8); o += 2; } }
  for (let i = 0; i < count; i++) if (pal[i] >= np) throw new Error(`${what}: palette index out of range`);
  if (o !== b.length) throw new Error(`${what}: ${b.length - o} trailing bytes`);
  return { size, palette, count, pos, pal };
}

/** The local cell of a decoded blob's i-th entry: [x, y, z]. */
export function voxelAt(v, i) {
  const [sx, , sz] = v.size;
  const p = v.pos[i];
  const x = p % sx, r = (p - x) / sx, z = r % sz, y = (r - z) / sz;
  return [x, y, z];
}

const DIRS = ['north', 'east', 'south', 'west'];
const turnDir = (d, k) => { const i = DIRS.indexOf(d); return i < 0 ? d : DIRS[(i + k) % 4]; };

/** A canonical block state turned clockwise by `k` quarter turns (facing, connections, axis, sign rotation). */
export function turnState(s, k) {
  if (!k || typeof s !== 'string') return s;
  const i = s.indexOf('[');
  if (i < 0) return s;
  const props = {};
  for (const kv of s.slice(i + 1, -1).split(',')) { const e = kv.indexOf('='); props[kv.slice(0, e)] = kv.slice(e + 1); }
  const out = { ...props };
  if (props.facing) out.facing = turnDir(props.facing, k);
  if (DIRS.every((d) => d in props)) for (const d of DIRS) out[turnDir(d, k)] = props[d];
  if (k % 2 === 1 && (props.axis === 'x' || props.axis === 'z')) out.axis = props.axis === 'x' ? 'z' : 'x';
  if (props.rotation !== undefined && /^\d+$/.test(props.rotation)) out.rotation = String((Number(props.rotation) + 4 * k) % 16);
  const keys = Object.keys(out).sort();
  return `${s.slice(0, i)}[${keys.map((x) => `${x}=${out[x]}`).join(',')}]`;
}

/** The world [dx, dz] offset from the origin of local (x, z) in a box of local size (sx, sz), after `k` quarter turns. */
export function turnXZ(x, z, sx, sz, k) {
  let a = x, c = z, w = sx, d = sz;
  for (let i = 0; i < k; i++) { const na = d - 1 - c; c = a; a = na; const t = w; w = d; d = t; }
  return [a, c];
}

/**
 * A voxels op's world placement: `{minX, maxX, minY, maxY, minZ, maxZ}` from the decoded blob, its origin and rotation (the box
 * with x and z swapped on an odd turn).
 */
export function voxelsBounds(v, origin, rotation) {
  const k = ROTATIONS.indexOf(rotation);
  const odd = k % 2 === 1;
  const w = odd ? v.size[2] : v.size[0], d = odd ? v.size[0] : v.size[2];
  return { minX: origin[0], maxX: origin[0] + w - 1, minY: origin[1], maxY: origin[1] + v.size[1] - 1, minZ: origin[2], maxZ: origin[2] + d - 1 };
}

/** The header box of ARVB bytes without decoding the cells: [sx, sy, sz]. */
export function voxelsSize(bytes) {
  const b = bytes;
  if (!b || b.length < 20 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x56 || b[3] !== 0x42) throw new Error('voxels: not an ARVB blob');
  const at = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  return [at(8), at(12), at(16)];
}
