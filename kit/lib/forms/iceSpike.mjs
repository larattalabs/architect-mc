// The `iceSpike` generator, version 1 (docs/CONTRACT.md 6c F1 §3, SETTLEMENTS §9.2). Plan time only: a cluster of thin spikes,
// each a chain of vertical `cone` segments 8 tall (a leaning spike shifts its segments by an integer offset per 8 of height), the
// whole cluster ONE op of at most 32 primitives (forms/rules.mjs). Each spike's base reaches SKIRT (6) below the plan ground as a
// straight cylinder, so drift up to 6 is absorbed. Materials: a `packed_ice` core, `blue_ice` accents (a noise clause) and
// `snow_block` caps (facing up, depth 0). Never `ice` or snow layers (they melt at block light 11 and 12: M17). Integer or exactly
// specified maths only (no trig, no Math.random, no Date): the same params and seed give byte-identical ops.
import { fnv64, splitmix64 } from '../noise.mjs';
import { MAX_PRIMITIVES, SKIRT, settleForm } from './rules.mjs';

export const GENERATOR = 'iceSpike';
export const VERSION = 1;
const isInt = Number.isInteger;
const r2 = (v) => Math.round(v * 100) / 100;

/** Bundled presets (species). A bible may name others within the schema below. */
export const PRESETS = Object.freeze({
  classic: { spikes: [2, 4], radius: [2, 4], height: [14, 40], lean: 0.25, spread: 5 },
  needles: { spikes: [3, 5], radius: [1, 2], height: [10, 30], lean: 0.4, spread: 6 },
  stubby: { spikes: [2, 4], radius: [2, 3], height: [8, 16], lean: 0, spread: 4 },
});

/** The default material rule (block states; no roles). */
export function iceRule(seed) {
  const accent = { kind: 'value', dims: 3, scale: 4, octaves: 1, seed: fnv64(seed, 'ice-accent').hex };
  return { rule: [
    { when: { depth: [0, 0], facing: 'up' }, mat: 'minecraft:snow_block' },
    { when: { noise: accent, gte: 0.45 }, mat: 'minecraft:blue_ice' },
  ], default: 'minecraft:packed_ice', dither: 'ordered4' };
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
export function iceParams(p) {
  const preset = p.preset ?? 'classic';
  const base = PRESETS[preset];
  if (!base) throw new Error(`iceSpike: unknown preset '${preset}' (${Object.keys(PRESETS).join(', ')})`);
  const o = { at: p.at, preset, seed: String(p.seed ?? '1'), spikes: p.spikes ?? base.spikes, radius: p.radius ?? base.radius, height: p.height ?? base.height,
    lean: p.lean ?? base.lean, spread: p.spread ?? base.spread };
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('iceSpike: at must be [x, y, z] integers (y: the plan ground)');
  if (!range(o.spikes, 1, 8)) throw new Error('iceSpike: spikes must be [min, max] in 1..8');
  if (!range(o.radius, 1, 4)) throw new Error('iceSpike: radius must be [min, max] in 1..4');
  if (!range(o.height, 8, 48)) throw new Error('iceSpike: height must be [min, max] in 8..48');
  if (!(typeof o.lean === 'number' && o.lean >= 0 && o.lean <= 1)) throw new Error('iceSpike: lean must be a share 0..1');
  if (!(isInt(o.spread) && o.spread >= 0 && o.spread <= 12)) throw new Error('iceSpike: spread must be 0..12');
  return o;
}

/** The primitives one spike takes: the skirt cylinder plus one cone per 8 of height. */
export const spikePrimitives = (h) => 1 + Math.ceil(h / 8);

/**
 * Grow one cluster. `groundAt(x, z)` gives the plan ground (default: `at[1]` everywhere). Returns `{ops: [one shape op],
 * bounds, spikes: [{at, r, h, lean}], generator, version, params, seed}`.
 */
export function iceSpike(params, { groundAt = null } = {}) {
  const p = iceParams(params);
  const [x0, y0, z0] = p.at;
  const ground = groundAt ?? (() => y0);
  const rr = rng(p.seed, 'cluster');
  const want = rr.int(p.spikes[0], p.spikes[1]);
  const shapes = [];
  const spikes = [];
  let prims = 0;
  for (let i = 0; i < want; i++) {
    // the first spike is the cluster's tallest, at its centre; the others around it, shorter
    const h = i === 0 ? rr.int(Math.max(p.height[0], Math.floor((p.height[0] + p.height[1]) / 2)), p.height[1]) : rr.int(p.height[0], Math.max(p.height[0], Math.floor((p.height[0] + p.height[1]) / 2)));
    if (prims + spikePrimitives(h) > MAX_PRIMITIVES) break;
    const r = i === 0 ? p.radius[1] : rr.int(p.radius[0], p.radius[1]);
    const ox = i === 0 ? 0 : rr.int(-p.spread, p.spread), oz = i === 0 ? 0 : rr.int(-p.spread, p.spread);
    const leaning = i > 0 && rr() < p.lean;
    // a leaning spike leans away from the cluster's centre, 1 per 8 of height
    let lx = leaning ? Math.sign(ox) : 0, lz = leaning ? Math.sign(oz) : 0;
    if (leaning && !lx && !lz) lx = 1;
    const bx = x0 + ox, bz = z0 + oz;
    const g = ground(bx, bz);
    // the skirt: a cylinder of the base radius from SKIRT below the ground up to it
    shapes.push({ kind: 'cone', c: [bx, { abs: g - SKIRT }, bz], r0: r + 0.5, r1: r + 0.5, h: SKIRT });
    // the spike: cones 8 tall, the radius falling linearly to 0 at the top, each shifted by the lean
    const segs = Math.ceil(h / 8);
    for (let s = 0; s < segs; s++) {
      const a = s * 8, b = Math.min(h, a + 8);
      const ra = r + 0.5 - ((r + 0.5) * a) / h, rb = r + 0.5 - ((r + 0.5) * b) / h;
      shapes.push({ kind: 'cone', c: [bx + lx * s, { abs: g + a }, bz + lz * s], r0: r2(ra), r1: r2(Math.max(0, rb)), h: b - a });
    }
    prims += spikePrimitives(h);
    spikes.push({ at: [bx, g, bz], r, h, lean: [lx, lz] });
  }
  const shape = { kind: 'union', of: shapes };
  // M3 at plan time: a tip the evaluator splits off is cancelled; an overhang over 4 (a sharp lean) gets a packed-ice support
  const settled = settleForm([{ op: 'shape', shape, material: { rule: iceRule(p.seed) }, cond: 0, walk: false }], (x, z) => ground(x, z), { material: 'minecraft:packed_ice' });
  const ops = settled.ops;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of spikes) {
    const segs = Math.ceil(s.h / 8);
    const ex = [s.at[0], s.at[0] + s.lean[0] * (segs - 1)], ez = [s.at[2], s.at[2] + s.lean[1] * (segs - 1)];
    minX = Math.min(minX, ...ex.map((v) => v - s.r - 1)); maxX = Math.max(maxX, ...ex.map((v) => v + s.r + 1));
    minZ = Math.min(minZ, ...ez.map((v) => v - s.r - 1)); maxZ = Math.max(maxZ, ...ez.map((v) => v + s.r + 1));
    minY = Math.min(minY, s.at[1] - SKIRT); maxY = Math.max(maxY, s.at[1] + s.h);
  }
  return {
    generator: GENERATOR, version: VERSION, seed: p.seed,
    params: { at: p.at, preset: p.preset, spikes: p.spikes, radius: p.radius, height: p.height, lean: p.lean, spread: p.spread },
    ops, bounds: { minX, maxX, minZ, maxZ, minY, maxY }, spikes, primitives: prims, trimmed: settled.trimmed, supports: settled.supports,
  };
}
