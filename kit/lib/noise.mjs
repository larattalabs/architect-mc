// Seeded integer hashing and noise for region programs (docs/CONTRACT.md "Seeds and determinism", kit/REGIONS.md).
// BigInt-free 64-bit arithmetic on 32-bit halves, FNV-1a 64, splitmix64, value and simplex noise in 2D and 3D, octaves.
// Under the realise lint: only + - * / and Math.floor/sqrt/abs/min/max/imul, which are exact by spec, so every value is
// bit-identical on every platform and Node version.

// ------------------------------------------------------------------ 64-bit on halves

const TWO32 = 4294967296;

/** (ah:al) * (bh:bl) mod 2^64 -> [hi, lo] (unsigned 32-bit halves). */
export function mul64(ah, al, bh, bl) {
  // 16-bit limbs; every partial product < 2^32 and every sum < 2^53, so doubles are exact
  const a0 = al & 0xffff, a1 = al >>> 16, a2 = ah & 0xffff, a3 = ah >>> 16;
  const b0 = bl & 0xffff, b1 = bl >>> 16, b2 = bh & 0xffff, b3 = bh >>> 16;
  let c0 = a0 * b0;
  let c1 = a1 * b0 + a0 * b1;
  let c2 = a2 * b0 + a1 * b1 + a0 * b2;
  let c3 = a3 * b0 + a2 * b1 + a1 * b2 + a0 * b3;
  // carry propagation in 16-bit groups
  c1 += Math.floor(c0 / 65536); c0 %= 65536;
  c2 += Math.floor(c1 / 65536); c1 %= 65536;
  c3 += Math.floor(c2 / 65536); c2 %= 65536;
  c3 %= 65536;
  return [(c3 * 65536 + c2) >>> 0, (c1 * 65536 + c0) >>> 0];
}

/** (ah:al) + (bh:bl) mod 2^64 -> [hi, lo]. */
export function add64(ah, al, bh, bl) {
  const lo = (al >>> 0) + (bl >>> 0);
  const carry = lo >= TWO32 ? 1 : 0;
  return [((ah >>> 0) + (bh >>> 0) + carry) >>> 0, lo >>> 0];
}

/** 64-bit logical right shift by s (0 < s < 32). */
function shr64(hi, lo, s) {
  return [hi >>> s, ((lo >>> s) | (hi << (32 - s))) >>> 0];
}

const hex8 = (v) => (v >>> 0).toString(16).padStart(8, '0');
/** 16 lowercase hex digits of a [hi, lo] pair. */
export const toHex64 = (hi, lo) => hex8(hi) + hex8(lo);
/** [hi, lo] from 16 hex digits (an optional 0x prefix). */
export function fromHex64(s) {
  const h = String(s).replace(/^0x/, '');
  if (!/^[0-9a-f]{1,16}$/i.test(h)) throw new Error(`not a 64-bit hex value: '${s}'`);
  const p = h.padStart(16, '0');
  return [parseInt(p.slice(0, 8), 16) >>> 0, parseInt(p.slice(8), 16) >>> 0];
}

/** [hi, lo] from a decimal string 0 .. 2^64-1 (a negative decimal wraps to its two's complement). */
export function fromDecimal64(s) {
  const str = String(s).trim();
  const m = /^(-?)(\d{1,20})$/.exec(str);
  if (!m) throw new Error(`not a decimal 64-bit integer: '${s}'`);
  let hi = 0, lo = 0;
  for (const ch of m[2]) {
    [hi, lo] = mul64(hi, lo, 0, 10);
    [hi, lo] = add64(hi, lo, 0, ch.charCodeAt(0) - 48);
  }
  if (m[1]) { // negate: ~x + 1
    [hi, lo] = add64(~hi >>> 0, ~lo >>> 0, 0, 1);
  }
  return [hi, lo];
}

/** The decimal string of an unsigned [hi, lo] pair. */
export function toDecimal64(hi, lo) {
  // four 16-bit limbs, long division by 10
  let limbs = [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff];
  if (limbs.every((x) => x === 0)) return '0';
  let out = '';
  while (limbs.some((x) => x !== 0)) {
    let rem = 0;
    const next = [];
    for (const l of limbs) {
      const cur = rem * 65536 + l;
      const q = Math.floor(cur / 10);
      rem = cur - q * 10;
      next.push(q);
    }
    out = String(rem) + out;
    limbs = next;
  }
  return out;
}

// ------------------------------------------------------------------ FNV-1a 64

const FNV_OFFSET = [0xcbf29ce4, 0x84222325];
const FNV_PRIME = [0x00000100, 0x000001b3];
const utf8 = new TextEncoder();

/**
 * FNV-1a 64 over the UTF-8 bytes of the parts joined by a 0 byte (non-strings are JSON-encoded by the caller).
 * Returns `{ hi, lo, hex }`.
 */
export function fnv64(...parts) {
  let hi = FNV_OFFSET[0], lo = FNV_OFFSET[1];
  parts.forEach((p, i) => {
    const bytes = utf8.encode(String(p));
    const all = i > 0 ? [0, ...bytes] : bytes;
    for (const byte of all) {
      lo = (lo ^ byte) >>> 0;
      [hi, lo] = mul64(hi, lo, FNV_PRIME[0], FNV_PRIME[1]);
    }
  });
  return { hi, lo, hex: toHex64(hi, lo) };
}

// ------------------------------------------------------------------ splitmix64

const GOLDEN = [0x9e3779b9, 0x7f4a7c15];
const M1 = [0xbf58476d, 0x1ce4e5b9];
const M2 = [0x94d049bb, 0x133111eb];

/** The splitmix64 finalizer of one 64-bit value -> [hi, lo]. */
export function mix64(hi, lo) {
  let z = [hi >>> 0, lo >>> 0];
  let s = shr64(z[0], z[1], 30);
  z = mul64((z[0] ^ s[0]) >>> 0, (z[1] ^ s[1]) >>> 0, M1[0], M1[1]);
  s = shr64(z[0], z[1], 27);
  z = mul64((z[0] ^ s[0]) >>> 0, (z[1] ^ s[1]) >>> 0, M2[0], M2[1]);
  s = shr64(z[0], z[1], 31);
  return [(z[0] ^ s[0]) >>> 0, (z[1] ^ s[1]) >>> 0];
}

/** A splitmix64 generator seeded with [hi, lo]: `next()` -> [hi, lo]; `float()` in [0, 1) (53 bits). */
export function splitmix64(hi, lo) {
  let sh = hi >>> 0, sl = lo >>> 0;
  return {
    next() {
      [sh, sl] = add64(sh, sl, GOLDEN[0], GOLDEN[1]);
      return mix64(sh, sl);
    },
    float() {
      const [h, l] = this.next();
      // 53 bits: 32 of hi and the top 21 of lo
      return (h * 2097152 + (l >>> 11)) / 9007199254740992;
    },
  };
}

// ------------------------------------------------------------------ lattice hashing (32-bit, per noise field)

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 32-bit hash of a lattice point under a field key [k0, k1] (the splitmix64 mix of the field's seed). */
export function hash3(k0, k1, ix, iy, iz) {
  let h = fmix32((k1 ^ Math.imul(ix | 0, 0x9e3779b1)) >>> 0);
  h = fmix32((h ^ k0 ^ Math.imul(iz | 0, 0x85ebca77)) >>> 0);
  return fmix32((h ^ Math.imul(iy | 0, 0xc2b2ae3d)) >>> 0);
}

// ------------------------------------------------------------------ value noise

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const unit = (h) => (h / 4294967296) * 2 - 1; // [-1, 1)

function value2(k0, k1, x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = fade(x - ix), fz = fade(z - iz);
  const a = unit(hash3(k0, k1, ix, 0, iz)), b = unit(hash3(k0, k1, ix + 1, 0, iz));
  const c = unit(hash3(k0, k1, ix, 0, iz + 1)), d = unit(hash3(k0, k1, ix + 1, 0, iz + 1));
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fz);
}

function value3(k0, k1, x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const v = (dx, dy, dz) => unit(hash3(k0, k1, ix + dx, iy + dy, iz + dz));
  const x00 = lerp(v(0, 0, 0), v(1, 0, 0), fx), x10 = lerp(v(0, 1, 0), v(1, 1, 0), fx);
  const x01 = lerp(v(0, 0, 1), v(1, 0, 1), fx), x11 = lerp(v(0, 1, 1), v(1, 1, 1), fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

// ------------------------------------------------------------------ simplex noise (Gustavson)

const GRAD3 = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
const SQRT3 = Math.sqrt(3);
const F2 = 0.5 * (SQRT3 - 1);
const G2 = (3 - SQRT3) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

function simplex2(k0, k1, xin, zin) {
  const s = (xin + zin) * F2;
  const i = Math.floor(xin + s), j = Math.floor(zin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t), z0 = zin - (j - t);
  const i1 = x0 > z0 ? 1 : 0, j1 = x0 > z0 ? 0 : 1;
  const x1 = x0 - i1 + G2, z1 = z0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, z2 = z0 - 1 + 2 * G2;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - z0 * z0;
  if (t0 > 0) { const g = (hash3(k0, k1, i, 0, j) % 12) * 3; t0 *= t0; n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * z0); }
  let t1 = 0.5 - x1 * x1 - z1 * z1;
  if (t1 > 0) { const g = (hash3(k0, k1, i + i1, 0, j + j1) % 12) * 3; t1 *= t1; n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * z1); }
  let t2 = 0.5 - x2 * x2 - z2 * z2;
  if (t2 > 0) { const g = (hash3(k0, k1, i + 1, 0, j + 1) % 12) * 3; t2 *= t2; n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * z2); }
  return 70 * n;
}

function simplex3(h0, h1, xin, yin, zin) {
  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
  const t = (i + j + k) * G3;
  const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
  else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
  else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  let n = 0;
  const corner = (tt, gi, gj, gk, x, y, z) => {
    if (tt <= 0) return 0;
    const g = (hash3(h0, h1, gi, gj, gk) % 12) * 3;
    tt *= tt;
    return tt * tt * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
  };
  n += corner(0.6 - x0 * x0 - y0 * y0 - z0 * z0, i, j, k, x0, y0, z0);
  n += corner(0.6 - x1 * x1 - y1 * y1 - z1 * z1, i + i1, j + j1, k + k1, x1, y1, z1);
  n += corner(0.6 - x2 * x2 - y2 * y2 - z2 * z2, i + i2, j + j2, k + k2, x2, y2, z2);
  n += corner(0.6 - x3 * x3 - y3 * y3 - z3 * z3, i + 1, j + 1, k + 1, x3, y3, z3);
  return 32 * n;
}

// ------------------------------------------------------------------ noise fields

export const NOISE_KINDS = ['value', 'simplex'];

/**
 * Validate a noise field spec `{ kind: 'value'|'simplex', dims: 2|3, scale > 0, octaves 1..8, seed: '<16 hex>' }`.
 * Returns the error message or null.
 */
export function noiseSpecError(n) {
  if (!n || typeof n !== 'object') return 'a noise field must be an object';
  if (!NOISE_KINDS.includes(n.kind)) return `noise kind must be value or simplex (got ${n.kind})`;
  if (n.dims !== 2 && n.dims !== 3) return 'noise dims must be 2 or 3';
  if (!(typeof n.scale === 'number' && n.scale > 0 && Number.isFinite(n.scale))) return 'noise scale must be a number > 0';
  if (!(Number.isInteger(n.octaves) && n.octaves >= 1 && n.octaves <= 8)) return 'noise octaves must be 1..8';
  if (typeof n.seed !== 'string' || !/^[0-9a-f]{16}$/.test(n.seed)) return 'noise seed must be 16 lowercase hex digits';
  return null;
}

/**
 * Compile a noise field spec to `f(x, y, z)` in [-1, 1] (2D fields ignore y). The lattice key is the splitmix64 mix
 * of the field's seed; octaves halve the amplitude and double the frequency, normalised by the total amplitude.
 */
export function makeNoise(spec) {
  const err = noiseSpecError(spec);
  if (err) throw new Error(err);
  const [s0, s1] = fromHex64(spec.seed);
  const [k0, k1] = mix64(s0, s1);
  const freq0 = 1 / spec.scale;
  const oct = spec.octaves;
  let norm = 0;
  for (let o = 0, a = 1; o < oct; o++, a *= 0.5) norm += a;
  const simplex = spec.kind === 'simplex';
  const three = spec.dims === 3;
  return (x, y, z) => {
    let sum = 0, amp = 1, f = freq0;
    for (let o = 0; o < oct; o++) {
      // each octave gets its own lattice key (k0 + o) so octaves are independent
      const ka = (k0 + o * 0x632be5ab) >>> 0;
      const v = three
        ? (simplex ? simplex3(ka, k1, x * f, y * f, z * f) : value3(ka, k1, x * f, y * f, z * f))
        : (simplex ? simplex2(ka, k1, x * f, z * f) : value2(ka, k1, x * f, z * f));
      sum += amp * v;
      amp *= 0.5;
      f *= 2;
    }
    const r = sum / norm;
    return r < -1 ? -1 : r > 1 ? 1 : r;
  };
}

/**
 * (6b) A noise field evaluated down columns: `col(x, z)` then `at(y)` gives exactly `makeNoise(spec)(x, y, z)` (the same
 * float operations in the same order), with 3D value noise's x/z lerps cached per lattice y plane. Other kinds fall back to
 * the plain field. Used by `warp`, which samples three fields at every cell of a column.
 */
export function makeColumnNoise(spec) {
  const plain = makeNoise(spec);
  if (!(spec.kind === 'value' && spec.dims === 3)) {
    let cx = 0, cz = 0;
    return { col(x, z) { cx = x; cz = z; }, at: (y) => plain(cx, y, cz) };
  }
  const [s0, s1] = fromHex64(spec.seed);
  const [k0, k1] = mix64(s0, s1);
  const oct = spec.octaves;
  let norm = 0;
  for (let o = 0, a = 1; o < oct; o++, a *= 0.5) norm += a;
  const freq0 = 1 / spec.scale;
  // per octave: the column's lattice x/z cell, its weights, and caches of X0(iy), X1(iy) (a window of lattice y planes)
  const N = 64;
  const O = [];
  for (let o = 0, f = freq0; o < oct; o++, f *= 2) O.push({ ka: (k0 + o * 0x632be5ab) >>> 0, f, ix: 0, iz: 0, fx: 0, fz: 0, base: 0, c0: new Float64Array(N), c1: new Float64Array(N), ok: new Uint8Array(N) });
  let cx = NaN, cz = NaN;
  const v = (q, ix, iy, iz) => unit(hash3(q.ka, k1, ix, iy, iz));
  const fill = (q, iy) => {
    const k = iy - q.base;
    if (!q.ok[k]) {
      q.c0[k] = lerp(v(q, q.ix, iy, q.iz), v(q, q.ix + 1, iy, q.iz), q.fx);
      q.c1[k] = lerp(v(q, q.ix, iy, q.iz + 1), v(q, q.ix + 1, iy, q.iz + 1), q.fx);
      q.ok[k] = 1;
    }
    return k;
  };
  return {
    col(x, z) {
      if (x === cx && z === cz) return;
      cx = x; cz = z;
      for (const q of O) {
        const xx = x * q.f, zz = z * q.f;
        q.ix = Math.floor(xx); q.iz = Math.floor(zz);
        q.fx = fade(xx - q.ix); q.fz = fade(zz - q.iz);
        q.ok.fill(0);
      }
    },
    at(y) {
      let sum = 0, amp = 1;
      for (let o = 0; o < oct; o++) {
        const q = O[o];
        const yy = y * q.f;
        const iy = Math.floor(yy);
        const fy = fade(yy - iy);
        if (iy - q.base < 0 || iy + 1 - q.base >= N) { q.base = iy - (N >> 1); q.ok.fill(0); }
        const k = fill(q, iy), k1 = fill(q, iy + 1);
        sum += amp * lerp(lerp(q.c0[k], q.c0[k1], fy), lerp(q.c1[k], q.c1[k1], fy), q.fz);
        amp *= 0.5;
      }
      const r = sum / norm;
      return r < -1 ? -1 : r > 1 ? 1 : r;
    },
  };
}
