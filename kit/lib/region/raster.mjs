// A tiny deterministic raster canvas for the region previews (integer pixel ops only, no anti-aliasing): fills, lines,
// rectangles, circles and a 5x7 bitmap font. The same drawing gives byte-identical pixels on every platform; PNGs are
// written with the kit's encoder (kit/lib/png.mjs).
import { encodePng } from '../png.mjs';
import { sha256Hex } from './pack.mjs';

/** '#rrggbb' -> [r, g, b]. */
export function hex(c) {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 5x7 glyphs, rows top to bottom, 5 bits each (bit 4 = left). Lower case draws as upper case.
const G = {
  ' ': [0, 0, 0, 0, 0, 0, 0], '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12], A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], '_': [0, 0, 0, 0, 0, 0, 31], '-': [0, 0, 0, 31, 0, 0, 0], ':': [0, 12, 12, 0, 12, 12, 0],
  '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '+': [0, 4, 4, 31, 4, 4, 0], '=': [0, 0, 31, 0, 31, 0, 0], '#': [10, 10, 31, 10, 31, 10, 10], "'": [4, 4, 8, 0, 0, 0, 0], '?': [14, 17, 1, 2, 4, 0, 4],
  '!': [4, 4, 4, 4, 4, 0, 4], '%': [24, 25, 2, 4, 8, 19, 3], '>': [8, 4, 2, 1, 2, 4, 8], '<': [2, 4, 8, 16, 8, 4, 2], '*': [0, 4, 21, 14, 21, 4, 0],
};

export class Canvas {
  constructor(w, h, bg = [255, 255, 255]) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = bg[0]; this.px[i * 4 + 1] = bg[1]; this.px[i * 4 + 2] = bg[2]; this.px[i * 4 + 3] = 255; }
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.px[o] = c[0]; this.px[o + 1] = c[1]; this.px[o + 2] = c[2];
  }
  /** Blend a colour over a pixel with an integer alpha 0..256. */
  blend(x, y, c, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    for (let k = 0; k < 3; k++) this.px[o + k] = (this.px[o + k] * (256 - a) + c[k] * a) >> 8;
  }
  rect(x0, y0, x1, y1, c) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, c); }
  frame(x0, y0, x1, y1, c) { for (let x = x0; x <= x1; x++) { this.set(x, y0, c); this.set(x, y1, c); } for (let y = y0; y <= y1; y++) { this.set(x0, y, c); this.set(x1, y, c); } }
  /** Bresenham line, `t` pixels thick (a square brush). */
  line(x0, y0, x1, y1, c, t = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    const h = Math.floor((t - 1) / 2);
    for (;;) {
      for (let a = -h; a < t - h; a++) for (let b = -h; b < t - h; b++) this.set(x + a, y + b, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
  disc(cx, cy, r, c) { cx = Math.round(cx); cy = Math.round(cy); for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) this.set(cx + x, cy + y, c); }
  /** Text in the 5x7 font at scale `s` (top-left anchored); returns its width. */
  text(x, y, str, c, s = 1) {
    let cx = Math.round(x);
    for (const ch0 of String(str)) {
      const g = G[ch0] ?? G[ch0.toUpperCase()] ?? G['?'];
      for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] & (16 >> b)) for (let a = 0; a < s; a++) for (let d = 0; d < s; d++) this.set(cx + b * s + a, Math.round(y) + r * s + d, c);
      cx += 6 * s;
    }
    return cx - x;
  }
  /** Text with a 1-pixel halo for legibility over a busy background. */
  label(x, y, str, c, halo = [255, 255, 255], s = 1) {
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.text(x + dx, y + dy, str, halo, s);
    this.text(x, y, str, c, s);
  }
  png() { return encodePng(this.w, this.h, this.px); }
  pixelSha() { return sha256Hex(this.px); }
}

export const textWidth = (str, s = 1) => String(str).length * 6 * s;
