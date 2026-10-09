// ARVX: frozen 3D site volumes (docs/CONTRACT.md 6b §5, kit/REGIONS.md "ARVX"). The mod writes them (Survey.volume); the
// kit decodes them for the virtual world (the checker) and `r.needVolume`. The file is gzip(ARVX bytes) and the volume's
// sha is SHA-256 of the uncompressed bytes.
import zlib from 'node:zlib';
import { sha256Hex } from './pack.mjs';

export const VOXEL_CLASSES = ['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING'];
export const VC = Object.freeze(Object.fromEntries(VOXEL_CLASSES.map((c, i) => [c, i])));

/** The uncompressed ARVX bytes of a (possibly gzipped) file. */
export function arvxBytes(file) {
  const b = file instanceof Uint8Array ? file : Uint8Array.from(file);
  return b[0] === 0x1f && b[1] === 0x8b ? new Uint8Array(zlib.gunzipSync(b)) : b;
}

/**
 * Decode an ARVX volume (gzip or raw). Returns `{sha, box, width, height, depth, classes: Uint8Array (index
 * ((x - minX) * depth + (z - minZ)) * height + (y - minY)), owners: [entry id], ownerOf: Map(cellIndex -> owner index),
 * counts: {CLASS: n}}`.
 */
export function decodeArvx(file) {
  const b = arvxBytes(file);
  if (b.length < 32 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x56 || b[3] !== 0x58) throw new Error('ARVX: bad magic');
  if (b[4] !== 1) throw new Error(`ARVX: version ${b[4]} (this kit reads 1)`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const box = { minX: dv.getInt32(8, true), minY: dv.getInt32(12, true), minZ: dv.getInt32(16, true), maxX: dv.getInt32(20, true), maxY: dv.getInt32(24, true), maxZ: dv.getInt32(28, true) };
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  if (!(W > 0 && H > 0 && D > 0)) throw new Error('ARVX: empty box');
  let o = 32;
  const varint = () => {
    let v = 0, mul = 1, byte;
    do {
      if (o >= b.length) throw new Error('ARVX: truncated');
      byte = b[o++]; v += (byte & 127) * mul; mul *= 128;
    } while (byte & 128);
    return v;
  };
  const classes = new Uint8Array(W * H * D);
  const counts = {};
  const ownedRuns = [];
  for (let col = 0; col < W * D; col++) {
    let y = 0;
    while (y < H) {
      const cls = b[o++];
      if (cls >= VOXEL_CLASSES.length) throw new Error(`ARVX: class ${cls} out of range`);
      const len = varint();
      if (len < 1 || y + len > H) throw new Error(`ARVX: column ${col} runs past the box`);
      classes.fill(cls, col * H + y, col * H + y + len);
      counts[VOXEL_CLASSES[cls]] = (counts[VOXEL_CLASSES[cls]] ?? 0) + len;
      if (cls === VC.OWNED) ownedRuns.push([col * H + y, len]);
      y += len;
    }
  }
  const owners = [];
  const nOwners = varint();
  for (let i = 0; i < nOwners; i++) { const n = varint(); owners.push(new TextDecoder().decode(b.subarray(o, o + n))); o += n; }
  const nRuns = varint();
  if (nRuns !== ownedRuns.length) throw new Error(`ARVX: ${nRuns} owner entries for ${ownedRuns.length} OWNED runs`);
  const ownerOf = new Map();
  for (const [start, len] of ownedRuns) { const k = varint(); for (let i = 0; i < len; i++) ownerOf.set(start + i, k); }
  if (o !== b.length) throw new Error(`ARVX: ${b.length - o} trailing bytes`);
  return { sha: sha256Hex(b), box, width: W, height: H, depth: D, classes, owners, ownerOf, counts };
}

/** The class at a world cell (MISSING outside the box). */
export function classAt(v, x, y, z) {
  if (x < v.box.minX || x > v.box.maxX || y < v.box.minY || y > v.box.maxY || z < v.box.minZ || z > v.box.maxZ) return VC.MISSING;
  return v.classes[((x - v.box.minX) * v.depth + (z - v.box.minZ)) * v.height + (y - v.box.minY)];
}

/** Encode (tests and fixtures; the mod is the real writer): `classes` as decodeArvx returns them. Returns the raw bytes. */
export function encodeArvx(box, classes, owners = [], ownerOf = new Map()) {
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const out = [];
  const head = new Uint8Array(32);
  head.set([0x41, 0x52, 0x56, 0x58, 1, 0, 0, 0]);
  const dv = new DataView(head.buffer);
  [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ].forEach((v, i) => dv.setInt32(8 + 4 * i, v, true));
  out.push(...head);
  const varint = (v) => { do { let byte = v % 128; v = Math.floor(v / 128); if (v) byte |= 128; out.push(byte); } while (v); };
  const ownedRunOwners = [];
  for (let col = 0; col < W * D; col++) {
    let y = 0;
    while (y < H) {
      const c = classes[col * H + y];
      const own = c === VC.OWNED ? ownerOf.get(col * H + y) : undefined;
      let n = 1;
      while (y + n < H && classes[col * H + y + n] === c && (c !== VC.OWNED || ownerOf.get(col * H + y + n) === own)) n++;
      out.push(c); varint(n);
      if (c === VC.OWNED) ownedRunOwners.push(own ?? 0);
      y += n;
    }
  }
  varint(owners.length);
  for (const s of owners) { const bs = new TextEncoder().encode(s); varint(bs.length); out.push(...bs); }
  varint(ownedRunOwners.length);
  for (const k of ownedRunOwners) varint(k);
  return Uint8Array.from(out);
}
