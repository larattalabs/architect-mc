// Dependency-free PNG writer (8-bit RGBA, zlib deflate, CRC32) and reader (non-interlaced PNGs of every colour type
// and bit depth: grey, RGB, indexed with tRNS, grey+alpha, RGBA; 1/2/4/8/16 bits). No install step, so the renderer
// and the colour generator work on a fresh checkout.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba width*height*4 bytes (straight alpha) */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('rgba length does not match width*height*4');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a non-interlaced PNG to { width, height, data: RGBA bytes }. */
export function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let ctype = 6;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const ch = CHANNELS[ctype];
  if (!ch) throw new Error(`PNG colour type ${ctype} not supported`);
  const bitsPP = ch * depth;
  const bpp = Math.max(1, bitsPP >> 3); // filter unit
  const stride = Math.ceil((width * bitsPP) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  let prev = Buffer.alloc(stride);
  const maxV = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = (line[i] + add) & 0xff;
    }
    // sample n of this row (channel value 0..maxV)
    const sample = (n) => {
      if (depth === 8) return line[n];
      if (depth === 16) return line[2 * n];
      const bit = n * depth;
      return (line[bit >> 3] >> (8 - depth - (bit & 7))) & maxV;
    };
    const to8 = (v) => (depth === 16 || depth === 8 ? v : Math.round((v * 255) / maxV));
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const idx = sample(x);
        out[o] = palette[3 * idx]; out[o + 1] = palette[3 * idx + 1]; out[o + 2] = palette[3 * idx + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = to8(sample(x * ch));
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
        out[o + 3] = ctype === 4 ? to8(sample(x * ch + 1)) : 255;
      } else {
        out[o] = to8(sample(x * ch)); out[o + 1] = to8(sample(x * ch + 1)); out[o + 2] = to8(sample(x * ch + 2));
        out[o + 3] = ctype === 6 ? to8(sample(x * ch + 3)) : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}
