// (6c MP) Seeded generators of masks and patterns for the slice's property tests and the schema drift fixture
// (kit/test/fixtures/mp/specs.json, read by the mod's MaskPatternDriftTest). Pure and deterministic: an LCG per seed.

export const CLASSES = ['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING'];
export const BLOCKS = ['minecraft:stone', 'minecraft:dirt', 'minecraft:grass_block', 'minecraft:sand', 'minecraft:gravel', 'minecraft:andesite', 'minecraft:oak_log', 'minecraft:coarse_dirt'];
export const TAGS = ['#minecraft:dirt', '#minecraft:logs', '#minecraft:sand', '#minecraft:base_stone_overworld'];

/** A seeded PRNG: `r()` in [0, 1), `r.int(a, b)`, `r.pick(arr)`. */
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

const hex16 = (r) => Array.from({ length: 16 }, () => '0123456789abcdef'[r.int(0, 15)]).join('');
export const noiseSpec = (r) => ({ kind: r.pick(['value', 'simplex']), dims: r.pick([2, 3]), scale: r.pick([4, 8, 16, 32]), octaves: r.int(1, 3), seed: hex16(r) });

/**
 * A valid random mask. `terms`: the term kinds to draw from; `fields`: field names; `depth`: how deep combinators may go.
 * Ranges are drawn around `yMid` (the test world's ground) so a mask selects a fair share of cells.
 */
export function randomMask(r, { terms = ['height', 'slope', 'depth', 'field', 'noise', 'class', 'block'], fields = ['wet'], depth = 3, yMid = 70 } = {}) {
  const term = () => {
    const k = r.pick(terms);
    switch (k) {
      case 'height': { const a = yMid + r.int(-12, 8); return { height: [a, a + r.int(0, 14)] }; }
      case 'slope': { const a = r.int(0, 3); return { slope: [a, a + r.int(0, 4)] }; }
      case 'depth': { const a = r.int(-6, 4); return { depth: [a, a + r.int(0, 8)] }; }
      case 'field': {
        const o = { field: r.pick(fields) }, u = r();
        if (u < 0.4) o.gte = r.int(0, 255); else if (u < 0.7) o.lt = r.int(1, 255); else { o.gte = r.int(0, 127); o.lt = o.gte + r.int(1, 128); }
        return o;
      }
      case 'noise': {
        const o = { noise: noiseSpec(r) }, u = r();
        if (u < 0.4) o.gte = Math.round((r() * 1.6 - 0.8) * 100) / 100; else if (u < 0.7) o.lt = Math.round((r() * 1.6 - 0.8) * 100) / 100; else { o.gte = -0.5; o.lt = Math.round(r() * 80) / 100; }
        return o;
      }
      case 'class': return { class: [...new Set(Array.from({ length: r.int(1, 4) }, () => r.pick(CLASSES)))] };
      case 'block': return { block: [...new Set(Array.from({ length: r.int(1, 4) }, () => (r() < 0.3 ? r.pick(TAGS) : r.pick(BLOCKS))))] };
      default: throw new Error(k);
    }
  };
  const build = (d) => {
    const u = r();
    if (d <= 0 || u < 0.45) return term();
    if (u < 0.7) return { all: Array.from({ length: r.int(1, 3) }, () => build(d - 1)) };
    if (u < 0.9) return { any: Array.from({ length: r.int(1, 3) }, () => build(d - 1)) };
    return { not: build(d - 1) };
  };
  return build(depth);
}

/** A valid random pattern over `mats` (block states). */
export function randomPattern(r, { mats = BLOCKS, fields = ['wet'] } = {}) {
  if (r() < 0.5) {
    const n = r.int(1, 5);
    const o = { mix: Array.from({ length: n }, () => ({ w: r.int(1, 20), mat: r.pick(mats) })) };
    if (r() < 0.5) o.seedLabel = r.pick(['wall', 'floor', 'mix', 'a1']);
    return o;
  }
  const n = r.int(2, 6);
  let at = r.int(40, 70);
  const stops = Array.from({ length: n }, () => { const s = { at, mat: r.pick(mats) }; at += r.int(1, 8); return s; });
  const by = r.pick(['y', 'depth', { field: r.pick(fields) }]);
  const o = { gradient: { by, stops } };
  if (r() < 0.7) o.dither = r.pick(['ordered4', 'none']);
  return o;
}

/** One way to break a valid mask (each breaks the schema or a rule). */
export function breakMask(r, m) {
  const c = structuredClone(m);
  // a leaf (term) to break, walking down a random branch
  const leaf = (x) => (x.all ? leaf(r.pick(x.all)) : x.any ? leaf(r.pick(x.any)) : x.not ? leaf(x.not) : x);
  const t = leaf(c);
  const k = Object.keys(t).find((q) => ['height', 'slope', 'depth', 'field', 'noise', 'class', 'block'].includes(q));
  const how = r.int(0, 11);
  switch (how) {
    case 0: return { mask: { ...c, extra: 1 }, why: 'an unknown member' };
    case 1: t.bogus = true; return { mask: c, why: 'a term with an unknown member' };
    case 2: if (Array.isArray(t[k]) && typeof t[k][0] === 'number') { t[k] = [t[k][1] + 1, t[k][0]]; return { mask: c, why: 'a range out of order' }; } t[k] = 7; return { mask: c, why: 'a term of the wrong type' };
    case 3: if (Array.isArray(t[k]) && typeof t[k][0] === 'number') { t[k] = [t[k][0]]; return { mask: c, why: 'a one-item range' }; } t[k] = []; return { mask: c, why: 'an empty list' };
    case 4: return { mask: { all: [] }, why: 'an empty all' };
    case 5: return { mask: { any: Array.from({ length: 17 }, () => ({ height: [0, 1] })) }, why: '17 children' };
    case 6: { let x = { height: [0, 1] }; for (let i = 0; i < 8; i++) x = { not: x }; return { mask: x, why: '9 deep' }; }
    case 7: return { mask: { class: ['ROCK', 'GRANITE'] }, why: 'an unknown class' };
    case 8: return { mask: { block: ['Minecraft:Stone'] }, why: 'a block id with capitals' };
    case 9: return { mask: { field: 'wet', gte: 5, lt: 5 }, why: 'gte not under lt' };
    case 10: return { mask: { noise: { ...noiseSpec(r), seed: 'xyz' }, gte: 0 }, why: 'a bad noise seed' };
    default: return { mask: { height: [1.5, 3] }, why: 'a fractional height' };
  }
}

/** One way to break a valid pattern. */
export function breakPattern(r, p) {
  const c = structuredClone(p);
  const how = r.int(0, 9);
  switch (how) {
    case 0: return { pattern: { ...c, extra: 1 }, why: 'an unknown member' };
    case 1: return { pattern: { mix: [] }, why: 'an empty mix' };
    case 2: return { pattern: { mix: [{ w: 0, mat: 'minecraft:stone' }] }, why: 'a zero weight' };
    case 3: return { pattern: { mix: [{ w: 1.5, mat: 'minecraft:stone' }] }, why: 'a fractional weight' };
    case 4: return { pattern: { gradient: { by: 'y', stops: [{ at: 64, mat: 'minecraft:sand' }, { at: 64, mat: 'minecraft:stone' }] } }, why: 'stops not increasing' };
    case 5: return { pattern: { gradient: { by: 'y', stops: [{ at: 64, mat: 'minecraft:sand' }] } }, why: 'one stop' };
    case 6: return { pattern: { gradient: { by: 'x', stops: [{ at: 1, mat: 'minecraft:sand' }, { at: 2, mat: 'minecraft:stone' }] } }, why: 'by x' };
    case 7: return { pattern: { mix: [{ w: 1, mat: 'Stone Bricks' }] }, why: 'a bad mat' };
    case 8: return { pattern: { gradient: { by: 'depth', stops: [{ at: 1, mat: 'minecraft:sand' }, { at: 2, mat: 'minecraft:stone' }] }, dither: 'bayer8' }, why: 'an unknown dither' };
    default: return { pattern: { mix: [{ w: 1, mat: 'minecraft:stone' }], gradient: { by: 'y', stops: [{ at: 1, mat: null }, { at: 2, mat: null }] } }, why: 'both mix and gradient' };
  }
}

/**
 * The drift fixture: `n` masks and `n` patterns, half valid (generated) and half broken, with the kit's verdict.
 * `verdict(kind, spec)` -> error string or null (the kit's maskError / patternError).
 */
export function driftSpecs(verdict, n = 100) {
  const out = [];
  const r = rng(6020);
  for (let i = 0; i < n; i++) {
    const m = randomMask(r);
    const s = i % 2 ? m : breakMask(r, m).mask;
    const e = verdict('mask', s);
    out.push({ kind: 'mask', spec: s, valid: e === null, error: e });
  }
  for (let i = 0; i < n; i++) {
    const p = randomPattern(r);
    const s = i % 2 ? p : breakPattern(r, p).pattern;
    const e = verdict('pattern', s);
    out.push({ kind: 'pattern', spec: s, valid: e === null, error: e });
  }
  return out;
}
