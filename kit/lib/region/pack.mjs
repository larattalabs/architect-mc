// Region byte formats (kit/REGIONS.md): the ARSV columns codec, the ARTL packed tile, gzipPinned, canonical JSON, sha.
// Pure. Imported by lib/realise.mjs, so it is under the realise lint (no Math members but floor/sqrt/abs/min/max/imul,
// no clock, no exponent operator).
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

// ------------------------------------------------------------------ hashing, canonical JSON

/** SHA-256 (hex) of bytes or a string (UTF-8). */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Canonical JSON: object keys sorted (code-unit order), no whitespace, `undefined` members dropped. Throws on a
 * non-finite number. This string is the IR's identity.
 */
export function canonicalJson(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error(`canonical JSON: non-finite number ${v}`);
    return JSON.stringify(v);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON: cannot encode a ${t}`);
}

// ------------------------------------------------------------------ gzip, pinned

/**
 * gzip at level 6 with mtime 0 and the header's OS byte forced to 255 ("unknown"), so the same payload gives the same
 * gzip bytes on Linux and macOS for one zlib version. (Identity is the sha of the uncompressed payload, never of these.)
 */
export function gzipPinned(buf) {
  const out = zlib.gzipSync(buf, { level: 6 });
  // header: 1f 8b 08 FLG MTIME(4) XFL OS; Node writes FLG 0 and MTIME 0
  out[4] = 0; out[5] = 0; out[6] = 0; out[7] = 0;
  out[9] = 255;
  return out;
}

export const gunzip = (buf) => zlib.gunzipSync(buf);

// ------------------------------------------------------------------ ARSV: the columns codec

export const FLAG_WATER = 1;
export const FLAG_MISSING = 2;
export const FLAG_TREE = 4;
export const FLAG_LAVA = 8;

/**
 * A decoded columns object: `{ minX, minZ, width, depth, resolution, ground, height, floor (Int16Array), flags (Uint8Array) }`.
 * Column (i, j) is world (minX + i*resolution, minZ + j*resolution), index i + j*width.
 */
export function makeColumns(minX, minZ, width, depth, resolution = 1) {
  const n = width * depth;
  return { minX, minZ, width, depth, resolution, ground: new Int16Array(n), height: new Int16Array(n), floor: new Int16Array(n), flags: new Uint8Array(n) };
}

/** Encode a columns object as ARSV bytes (Uint8Array). */
export function encodeColumns(c) {
  const n = c.width * c.depth;
  const buf = new Uint8Array(28 + 7 * n);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x41; buf[1] = 0x52; buf[2] = 0x53; buf[3] = 0x56; // ARSV
  buf[4] = 1;
  dv.setInt32(8, c.minX, true); dv.setInt32(12, c.minZ, true);
  dv.setInt32(16, c.width, true); dv.setInt32(20, c.depth, true); dv.setInt32(24, c.resolution, true);
  let o = 28;
  for (const arr of [c.ground, c.height, c.floor]) {
    for (let i = 0; i < n; i++, o += 2) dv.setInt16(o, arr[i], true);
  }
  for (let i = 0; i < n; i++) buf[o++] = c.flags[i];
  return buf;
}

/** Decode ARSV bytes (Buffer / Uint8Array / ArrayBuffer) into a columns object. Throws on a malformed buffer. */
export function decodeColumns(bytes) {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!b || b.length < 28 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x53 || b[3] !== 0x56) throw new Error('ARSV: bad magic');
  if (b[4] !== 1) throw new Error(`ARSV: unsupported version ${b[4]}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const minX = dv.getInt32(8, true), minZ = dv.getInt32(12, true);
  const width = dv.getInt32(16, true), depth = dv.getInt32(20, true), resolution = dv.getInt32(24, true);
  if (!(width > 0 && depth > 0 && resolution > 0)) throw new Error(`ARSV: bad size ${width}x${depth} res ${resolution}`);
  const n = width * depth;
  if (b.length !== 28 + 7 * n) throw new Error(`ARSV: ${b.length} bytes, expected ${28 + 7 * n} for ${width}x${depth}`);
  const c = makeColumns(minX, minZ, width, depth, resolution);
  let o = 28;
  for (const arr of [c.ground, c.height, c.floor]) {
    for (let i = 0; i < n; i++, o += 2) arr[i] = dv.getInt16(o, true);
  }
  for (let i = 0; i < n; i++) c.flags[i] = b[o++];
  return c;
}

/** A columns object from either ARSV bytes or an already decoded object. */
export function asColumns(h) {
  if (h && h.ground && h.flags && typeof h.width === 'number') return h;
  return decodeColumns(h);
}

// ------------------------------------------------------------------ varints and a growable byte writer

/** A growable little-endian byte writer. */
export class ByteWriter {
  constructor(cap = 4096) { this.buf = new Uint8Array(cap); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.len++] = v; }
  u16(v) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >>> 8) & 255; }
  /** unsigned LEB128 (7 bits per byte, least significant group first, high bit = more), values 0 .. 2^32-1 */
  varint(v) {
    this.ensure(5);
    let x = v >>> 0;
    while (x >= 128) { this.buf[this.len++] = (x & 127) | 128; x >>>= 7; }
    this.buf[this.len++] = x;
  }
  /** zigzag then LEB128 (signed 32-bit) */
  zigzag(v) { this.varint(((v << 1) ^ (v >> 31)) >>> 0); }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
  result() { return this.buf.slice(0, this.len); }
}

class ByteReader {
  constructor(b) { this.b = b; this.o = 0; }
  u8() { if (this.o >= this.b.length) throw new Error('ARTL: truncated'); return this.b[this.o++]; }
  u16() { const v = this.u8(); return v | (this.u8() << 8); }
  varint() {
    let v = 0, mul = 1, byte;
    do {
      byte = this.u8();
      v += (byte & 127) * mul;
      mul *= 128;
      if (mul > 34359738368) throw new Error('ARTL: varint too long');
    } while (byte & 128);
    return v;
  }
  zigzag() { const u = this.varint(); return (u & 1) ? -((u + 1) / 2) : u / 2; }
}

// ------------------------------------------------------------------ ARTL: packed tiles

const enc = new TextEncoder();
const dec = new TextDecoder();
const encodedStates = new Map();
/** UTF-8 bytes of a block state string (cached). */
export function stateBytes(s) {
  let b = encodedStates.get(s);
  if (!b) { b = enc.encode(s); encodedStates.set(s, b); }
  return b;
}

/** The ARTL header: "ARTL" u8 1, u8 0 0 0. */
export function writeArtlHeader(w) {
  w.u8(0x41); w.u8(0x52); w.u8(0x54); w.u8(0x4c); w.u8(1); w.u8(0); w.u8(0); w.u8(0);
}

/**
 * Pack a cell list: `cells` is an array of `{x, y, z, state, cond?: 0..3, walk?: bool}` (duplicates: the last wins).
 * Sections are sorted by (sx, sz, sy), cells by pos; each section's palette is in order of first appearance in pos
 * order (the evaluator's order). Returns the uncompressed ARTL bytes.
 */
export function pack(cells) {
  const bySec = new Map();
  for (const c of cells) {
    const sx = c.x >> 4, sy = c.y >> 4, sz = c.z >> 4;
    const k = `${sx},${sy},${sz}`;
    let s = bySec.get(k);
    if (!s) { s = { sx, sy, sz, cells: new Map() }; bySec.set(k, s); }
    const pos = ((c.y & 15) << 8) | ((c.z & 15) << 4) | (c.x & 15);
    s.cells.set(pos, c);
  }
  const secs = [...bySec.values()].sort((a, b) => a.sx - b.sx || a.sz - b.sz || a.sy - b.sy);
  const w = new ByteWriter();
  writeArtlHeader(w);
  w.varint(secs.length);
  for (const s of secs) {
    w.zigzag(s.sx); w.zigzag(s.sy); w.zigzag(s.sz);
    const poses = [...s.cells.keys()].sort((a, b) => a - b);
    const pal = [];
    const palIdx = new Map();
    const idx = [];
    for (const p of poses) {
      const st = s.cells.get(p).state ?? 'minecraft:air';
      let i = palIdx.get(st);
      if (i === undefined) { i = pal.length; pal.push(st); palIdx.set(st, i); }
      idx.push(i);
    }
    w.varint(pal.length);
    for (const st of pal) { const b = stateBytes(st); w.varint(b.length); w.bytes(b); }
    w.varint(poses.length);
    for (const p of poses) {
      const c = s.cells.get(p);
      w.u16(p | ((c.cond ?? 0) & 3) << 12 | (c.walk ? 1 << 14 : 0));
    }
    if (pal.length > 1) for (const i of idx) { if (pal.length <= 256) w.u8(i); else w.u16(i); }
  }
  return w.result();
}

/**
 * Unpack ARTL bytes. Returns `{ sections: [{sx, sy, sz, palette, cells: [{x, y, z, state, cond, walk}]}], cells }` where
 * `cells` is every cell, in payload order. Throws on malformed bytes.
 */
export function unpack(payload) {
  const b = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  if (b.length < 8 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x54 || b[3] !== 0x4c) throw new Error('ARTL: bad magic');
  if (b[4] !== 1) throw new Error(`ARTL: unsupported version ${b[4]}`);
  const r = new ByteReader(b);
  r.o = 8;
  const n = r.varint();
  const sections = [];
  const all = [];
  for (let s = 0; s < n; s++) {
    const sx = r.zigzag(), sy = r.zigzag(), sz = r.zigzag();
    const pn = r.varint();
    if (pn < 1) throw new Error('ARTL: empty palette');
    const palette = [];
    for (let i = 0; i < pn; i++) {
      const len = r.varint();
      if (r.o + len > b.length) throw new Error('ARTL: truncated');
      palette.push(dec.decode(b.subarray(r.o, r.o + len)));
      r.o += len;
    }
    const cn = r.varint();
    const words = new Array(cn);
    for (let i = 0; i < cn; i++) words[i] = r.u16();
    const cells = [];
    let last = -1;
    for (let i = 0; i < cn; i++) {
      const wd = words[i];
      const pos = wd & 4095;
      if (pos <= last) throw new Error('ARTL: positions not ascending');
      if (wd & 32768) throw new Error('ARTL: bit 15 set');
      last = pos;
      const pi = pn === 1 ? 0 : pn <= 256 ? r.u8() : r.u16();
      if (pi >= pn) throw new Error('ARTL: palette index out of range');
      const c = {
        x: sx * 16 + (pos & 15), y: sy * 16 + (pos >> 8), z: sz * 16 + ((pos >> 4) & 15),
        state: palette[pi], cond: (wd >> 12) & 3, walk: !!(wd & 16384),
      };
      cells.push(c);
      all.push(c);
    }
    sections.push({ sx, sy, sz, palette, cells });
  }
  if (r.o !== b.length) throw new Error(`ARTL: ${b.length - r.o} trailing bytes`);
  return { sections, cells: all };
}
