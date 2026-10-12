// The `rockSpire` generator, version 1 (docs/CONTRACT.md 6c F1 §4, SETTLEMENTS §9.2). Plan time only: a stack of `warp`ed cone
// segments, each segment ONE op (forms/rules.mjs: at most 32 primitives) holding its cone and its ledges (a ledge is a `clipY`ped
// `ellipsoid` lobe: a flat top, a rounded underside). Every segment rests on the one below (the next starts one under its top, its
// centre within its own top radius), the first on the ground with its base SKIRT (6) below the plan ground. M3: a ledge that would
// overhang the layer under it by more than 4 gets a `capsuleChain` buttress down into the spire at 45 degrees.
// Materials: strata bands (stone, andesite, tuff; deepslate below y 0), a weathered skin by `age` noise, moss on up-facing skin by
// the `wet` field when the IR has one (T1/H) or else by noise. Integer or exactly specified maths only (no trig, no Math.random, no
// Date; directions from region/geom.mjs compassDir).
import { fnv64, splitmix64 } from '../noise.mjs';
import { compassDir } from '../region/geom.mjs';
import { MAX_PRIMITIVES, SKIRT, settleForm } from './rules.mjs';

export const GENERATOR = 'rockSpire';
export const VERSION = 1;
/** A ledge protruding more than this past the layer below gets a buttress (M3's overhang limit). */
export const OVERHANG_MAX = 4;
/** A ledge lobe's vertical radius: its flat top and one ring under it (0.75 of its radius). */
const LEDGE_RY = 1.5;
const isInt = Number.isInteger;
const round = (v) => Math.floor(v + 0.5);
const r2 = (v) => Math.round(v * 100) / 100;

/** Bundled presets (species). */
export const PRESETS = Object.freeze({
  pinnacle: { height: [28, 48], radius: [5, 7], segment: [8, 12], ledges: [1, 3], ledge: [3, 5], warp: 2, taper: 0.75 },
  tower: { height: [20, 32], radius: [6, 9], segment: [8, 10], ledges: [2, 4], ledge: [3, 6], warp: 2, taper: 0.55 },
  hoodoo: { height: [14, 22], radius: [3, 5], segment: [6, 8], ledges: [1, 1], ledge: [4, 6], warp: 1, taper: 0.4 },
});

/** The default material rule (block states). `wet`: an IR field name for moss, or null (moss by noise). */
export function rockRule(seed, { wet = null, bandsFrom = -32 } = {}) {
  const age = { kind: 'value', dims: 3, scale: 5, octaves: 2, seed: fnv64(seed, 'rock-age').hex };
  const moss = { kind: 'value', dims: 3, scale: 6, octaves: 1, seed: fnv64(seed, 'rock-moss').hex };
  const clauses = [
    wet ? { when: { depth: [0, 0], facing: 'up', field: wet, gte: 170 }, mat: 'minecraft:moss_block' } : { when: { depth: [0, 0], facing: 'up', noise: moss, gte: 0.35 }, mat: 'minecraft:moss_block' },
    { when: { depth: [0, 0], noise: age, gte: 0.4 }, mat: 'minecraft:cobblestone' },
    { when: { yAbs: [-64, -1] }, mat: 'minecraft:deepslate' },
  ];
  // strata: bands every 3 cells over the spire's own height; andesite and tuff between stone
  for (let b = bandsFrom; b < bandsFrom + 40; b++) {
    if (((b % 3) + 3) % 3 === 0) clauses.push({ when: { band: [b, b] }, mat: 'minecraft:andesite' });
    else if (((b % 3) + 3) % 3 === 1) clauses.push({ when: { band: [b, b] }, mat: 'minecraft:tuff' });
  }
  return { rule: clauses, default: 'minecraft:stone', dither: 'ordered4' };
}

function rng(seed, label) {
  const h = fnv64(seed, GENERATOR, label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  return f;
}

const range = (v, lo, hi) => Array.isArray(v) && v.length === 2 && v.every(isInt) && v[0] <= v[1] && v[0] >= lo && v[1] <= hi;

/** Validate the params (a preset's values under the given ones); returns them filled. */
export function spireParams(p) {
  const preset = p.preset ?? 'pinnacle';
  const base = PRESETS[preset];
  if (!base) throw new Error(`rockSpire: unknown preset '${preset}' (${Object.keys(PRESETS).join(', ')})`);
  const o = { at: p.at, preset, seed: String(p.seed ?? '1'), height: p.height ?? base.height, radius: p.radius ?? base.radius, segment: p.segment ?? base.segment,
    ledges: p.ledges ?? base.ledges, ledge: p.ledge ?? base.ledge, warp: p.warp ?? base.warp, taper: p.taper ?? base.taper, wet: p.wet ?? null };
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('rockSpire: at must be [x, y, z] integers (y: the plan ground)');
  if (!range(o.height, 8, 96)) throw new Error('rockSpire: height must be [min, max] in 8..96');
  if (!range(o.radius, 2, 16)) throw new Error('rockSpire: radius must be [min, max] in 2..16');
  if (!range(o.segment, 4, 16)) throw new Error('rockSpire: segment must be [min, max] in 4..16');
  if (!range(o.ledges, 0, 4)) throw new Error('rockSpire: ledges (per segment) must be [min, max] in 0..4');
  if (!range(o.ledge, 2, 8)) throw new Error('rockSpire: ledge (radius) must be [min, max] in 2..8');
  if (!(isInt(o.warp) && o.warp >= 0 && o.warp <= 3)) throw new Error('rockSpire: warp must be 0..3');
  if (!(typeof o.taper === 'number' && o.taper >= 0.2 && o.taper <= 0.9)) throw new Error('rockSpire: taper must be 0.2..0.9');
  if (o.wet !== null && typeof o.wet !== 'string') throw new Error('rockSpire: wet must be a field name or null');
  return o;
}

/**
 * Grow one spire. `groundAt(x, z)`: the plan ground (default `at[1]`). `_unsafe.noButtress` (tests only) leaves every ledge
 * unbuttressed and unsettled, `_unsafe.ledgeOut` pushes every ledge out past the skin by that much. Returns `{ops, bounds, segments, ledges, buttresses, generator, version, params, seed}`.
 */
export function rockSpire(params, { groundAt = null, _unsafe = {} } = {}) {
  const p = spireParams(params);
  const [x0, y0, z0] = p.at;
  const ground = groundAt ?? (() => y0);
  const rr = rng(p.seed, 'spire');
  const H = rr.int(p.height[0], p.height[1]);
  const R = rr.int(p.radius[0], p.radius[1]);
  const g = ground(x0, z0);
  // the radius at height t over the ground (linear taper to (1 - taper) * R at the top)
  const radiusAt = (t) => R * (1 - (p.taper * Math.max(0, Math.min(H, t))) / H);
  const segs = [];
  let t = 0, cx = x0, cz = z0;
  const leanDir = compassDir(rr.int(0, 359));
  while (t < H) {
    const sh = Math.min(H - t, rr.int(p.segment[0], p.segment[1]));
    const ra = radiusAt(t), rb = radiusAt(t + sh);
    segs.push({ y: g + t, h: sh, c: [cx, cz], r0: ra, r1: rb });
    // the next segment's centre: at most a third of this one's top radius off, so it rests on it
    const step = Math.max(0, Math.floor(rb / 3));
    if (step && rr() < 0.5) { cx += round(leanDir[0] * step) === 0 ? 0 : Math.sign(leanDir[0]); cz += round(leanDir[1] * step) === 0 ? 0 : Math.sign(leanDir[1]); }
    t += sh - 1; // one cell of overlap
    if (sh <= 1) break;
  }
  const warpNoise = { kind: 'value', dims: 3, scale: 9, octaves: 1, seed: fnv64(p.seed, 'spire-warp').hex };
  const bandsFrom = Math.floor((g - SKIRT - 8) / 3);
  const rule = rockRule(p.seed, { wet: p.wet, bandsFrom });
  const ops = [];
  const ledges = [], buttresses = [];
  segs.forEach((s, i) => {
    const prims = [];
    // the first segment carries the skirt: a cylinder SKIRT below the ground
    // (one cell into the segment: stacked slabs that only touch open a fractional gap under the warp)
    if (i === 0) prims.push({ kind: 'cone', c: [s.c[0], { abs: s.y - SKIRT }, s.c[1]], r0: r2(s.r0), r1: r2(s.r0), h: SKIRT + 1 });
    prims.push({ kind: 'cone', c: [s.c[0], { abs: s.y }, s.c[1]], r0: r2(s.r0), r1: r2(s.r1), h: s.h });
    const nl = rr.int(p.ledges[0], p.ledges[1]);
    for (let k = 0; k < nl && prims.length + 2 <= MAX_PRIMITIVES; k++) {
      const d = compassDir(rr.int(0, 359));
      const ly = s.y + rr.int(1, Math.max(1, s.h - 2));
      const lr = rr.int(p.ledge[0], p.ledge[1]);
      const body = radiusAt(ly - g);
      // the lobe's centre sits on the spire's skin; its flat top at ly, its rounded underside 2 deep
      const out0 = body + (_unsafe.ledgeOut ?? 0); // (tests only: a ledge pushed out past the skin)
      const lc = [round(s.c[0] + d[0] * out0), ly, round(s.c[1] + d[1] * out0)];
      prims.push({ kind: 'clipY', y0: null, y1: { abs: ly }, of: { kind: 'ellipsoid', c: [lc[0], { abs: ly }, lc[2]], r: [lr, LEDGE_RY, lr] } });
      // how far the lobe's lowest ring (radius 0.75 lr, one under its top) stands out past the spire under it, plus 1 for the warp
      const protrude = Math.ceil(0.75 * lr) + (p.warp ? 1 : 0);
      const ledge = { at: lc, r: lr, protrude, buttress: false };
      if (protrude >= OVERHANG_MAX && !_unsafe.noButtress) {
        // a buttress: from under the lobe's outer edge down and in at 45 degrees to inside the spire
        const out = lr - 1;
        const a = [lc[0] + round(d[0] * out), ly - 2, lc[2] + round(d[1] * out)];
        const run = out + 2;
        const b = [lc[0] - round(d[0] * 2), ly - 2 - run, lc[2] - round(d[1] * 2)];
        prims.push({ kind: 'capsuleChain', points: [a, b], radii: [1.6, 2.2] });
        ledge.buttress = true;
        buttresses.push({ from: a, to: b });
      }
      ledges.push(ledge);
    }
    let shape = { kind: 'union', of: prims };
    if (p.warp) shape = { kind: 'warp', amp: p.warp, noise: warpNoise, of: shape };
    shape = { kind: 'strata', bands: { every: 3, offset: 0 }, of: shape };
    ops.push({ op: 'shape', shape, material: { rule }, cond: 0, walk: false });
  });
  // M3 at plan time: fragments the warp cut off are cancelled, and any overhang the buttresses missed gets a support
  const settled = _unsafe.noButtress ? { ops, trimmed: 0, supports: 0 } : settleForm(ops, (x, z) => ground(x, z));
  ops.splice(0, ops.length, ...settled.ops);
  const reach = R + p.ledge[1] + p.warp + 2;
  const top = g + H + p.warp;
  const xs = segs.map((s) => s.c[0]), zs = segs.map((s) => s.c[1]);
  return {
    generator: GENERATOR, version: VERSION, seed: p.seed,
    params: { at: p.at, preset: p.preset, height: p.height, radius: p.radius, segment: p.segment, ledges: p.ledges, ledge: p.ledge, warp: p.warp, taper: p.taper, wet: p.wet },
    ops, segments: segs.length, ledges, buttresses, trimmed: settled.trimmed, supports: settled.supports, height: H, radius: R,
    bounds: { minX: Math.min(...xs) - reach, maxX: Math.max(...xs) + reach, minZ: Math.min(...zs) - reach, maxZ: Math.max(...zs) + reach, minY: g - SKIRT - p.warp, maxY: top },
  };
}
