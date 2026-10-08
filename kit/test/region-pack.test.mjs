// Phase 6a: the region byte formats (kit/REGIONS.md): ARSV columns round trips, ARTL pack/unpack round trips,
// gzipPinned's pinned header, canonical JSON; and the 64-bit helpers and noise of lib/noise.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { canonicalJson, decodeColumns, encodeColumns, gunzip, gzipPinned, makeColumns, pack, sha256Hex, unpack } from '../lib/region/pack.mjs';
import { add64, fnv64, fromDecimal64, fromHex64, makeNoise, mul64, splitmix64, toDecimal64, toHex64 } from '../lib/noise.mjs';

const big = (hi, lo) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
const halves = (b) => [Number((b >> 32n) & 0xffffffffn), Number(b & 0xffffffffn)];
const M64 = (1n << 64n) - 1n;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
}

test('ARSV: encode/decode round trip, header layout and size checks', () => {
  const c = makeColumns(-72, 5, 13, 7, 4);
  const r = lcg(1);
  for (let i = 0; i < 13 * 7; i++) { c.ground[i] = (r() % 400) - 64; c.height[i] = c.ground[i] + (r() % 5); c.floor[i] = c.ground[i] - (r() % 3); c.flags[i] = r() % 16; }
  const b = encodeColumns(c);
  assert.equal(b.length, 28 + 7 * 13 * 7);
  assert.deepEqual([...b.subarray(0, 8)], [0x41, 0x52, 0x53, 0x56, 1, 0, 0, 0]);
  const dv = new DataView(b.buffer);
  assert.deepEqual([dv.getInt32(8, true), dv.getInt32(12, true), dv.getInt32(16, true), dv.getInt32(20, true), dv.getInt32(24, true)], [-72, 5, 13, 7, 4]);
  const d = decodeColumns(b);
  for (const k of ['minX', 'minZ', 'width', 'depth', 'resolution']) assert.equal(d[k], c[k]);
  for (const k of ['ground', 'height', 'floor', 'flags']) assert.deepEqual([...d[k]], [...c[k]]);
  assert.deepEqual(encodeColumns(d), b);
  assert.throws(() => decodeColumns(b.subarray(0, b.length - 1)), /bytes, expected/);
  const bad = Uint8Array.from(b); bad[0] = 0;
  assert.throws(() => decodeColumns(bad), /magic/);
});

test('ARTL: pack/unpack round trips (random cells, negative sections, big palettes, cond and walk bits)', () => {
  const r = lcg(7);
  for (const nStates of [1, 3, 300]) {
    const states = Array.from({ length: nStates }, (_, i) => (i === 0 ? 'minecraft:air' : `minecraft:stone_${i}[a=b]`));
    const want = new Map();
    for (let i = 0; i < 3000; i++) {
      const c = { x: (r() % 200) - 100, y: (r() % 300) - 64, z: (r() % 200) - 100, state: states[r() % nStates], cond: r() % 4, walk: r() % 2 === 1 };
      want.set(`${c.x},${c.y},${c.z}`, c);
    }
    const bytes = pack([...want.values()]);
    const u = unpack(bytes);
    assert.equal(u.cells.length, want.size);
    for (const c of u.cells) assert.deepEqual(c, want.get(`${c.x},${c.y},${c.z}`));
    // sections sorted by (sx, sz, sy), positions ascending; palette encoding per size
    for (let i = 1; i < u.sections.length; i++) {
      const a = u.sections[i - 1], b = u.sections[i];
      assert.ok(a.sx < b.sx || (a.sx === b.sx && (a.sz < b.sz || (a.sz === b.sz && a.sy < b.sy))));
    }
    assert.deepEqual(pack(u.cells), bytes, 'repacking gives the same bytes');
  }
  const empty = pack([]);
  assert.deepEqual([...empty], [0x41, 0x52, 0x54, 0x4c, 1, 0, 0, 0, 0]);
  assert.deepEqual(unpack(empty).cells, []);
});

test('gzipPinned: level 6, mtime 0, OS byte 255, and it decompresses', () => {
  const data = pack([{ x: 1, y: 2, z: 3, state: 'minecraft:stone' }]);
  const g = gzipPinned(data);
  assert.equal(g[0], 0x1f); assert.equal(g[1], 0x8b);
  assert.deepEqual([...g.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(g[9], 255);
  assert.deepEqual(new Uint8Array(gunzip(g)), data);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(g)), data);
});

test('canonical JSON sorts keys recursively, drops undefined, refuses non-finite numbers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' }, u: undefined }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.throws(() => canonicalJson({ a: NaN }), /non-finite/);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('64-bit helpers match BigInt; FNV-1a 64 and splitmix64 reference values', () => {
  const r = lcg(3);
  for (let i = 0; i < 2000; i++) {
    const a = [r(), r()], b = [r(), r()];
    assert.deepEqual(mul64(a[0], a[1], b[0], b[1]), halves((big(...a) * big(...b)) & M64));
    assert.deepEqual(add64(a[0], a[1], b[0], b[1]), halves((big(...a) + big(...b)) & M64));
    const dec = big(...a).toString();
    assert.deepEqual(fromDecimal64(dec), a.map((v) => v >>> 0));
    assert.equal(toDecimal64(a[0], a[1]), dec);
    assert.deepEqual(fromHex64(toHex64(a[0], a[1])), a.map((v) => v >>> 0));
  }
  assert.deepEqual(fromDecimal64('-1'), [0xffffffff, 0xffffffff]);
  assert.equal(toDecimal64(0xffffffff, 0xffffffff), '18446744073709551615');
  // FNV-1a 64 of "" and "a"
  assert.equal(fnv64('').hex, 'cbf29ce484222325');
  assert.equal(fnv64('a').hex, 'af63dc4c8601ec8c');
  assert.equal(fnv64('foobar').hex, '85944171f73967e8');
  // splitmix64 seeded with 0: the reference sequence
  const g = splitmix64(0, 0);
  assert.equal(toHex64(...g.next()), 'e220a8397b1dcdaf');
  assert.equal(toHex64(...g.next()), '6e789e6aa1b965f4');
  assert.equal(toHex64(...g.next()), '06c45d188009454f');
});

test('noise: deterministic, in [-1, 1], seed-dependent, octaves', () => {
  for (const kind of ['value', 'simplex']) {
    for (const dims of [2, 3]) {
      const spec = { kind, dims, scale: 17.5, octaves: 3, seed: fnv64('t', kind, dims).hex };
      const f = makeNoise(spec), g = makeNoise({ ...spec }), h = makeNoise({ ...spec, seed: fnv64('other').hex });
      let diff = 0, lo = 1, hi = -1;
      for (let i = 0; i < 2000; i++) {
        const x = (i * 7.31) % 300 - 150, y = (i * 3.7) % 90, z = (i * 13.1) % 300 - 150;
        const v = f(x, y, z);
        assert.equal(v, g(x, y, z));
        assert.ok(v >= -1 && v <= 1);
        if (v !== h(x, y, z)) diff++;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      assert.ok(diff > 1900, `${kind}${dims}: another seed differs`);
      assert.ok(hi - lo > 0.6, `${kind}${dims}: has range (${lo}..${hi})`);
    }
  }
  assert.throws(() => makeNoise({ kind: 'perlin', dims: 2, scale: 1, octaves: 1, seed: '0'.repeat(16) }), /kind/);
});
