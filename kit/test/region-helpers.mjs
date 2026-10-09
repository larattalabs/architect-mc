// Shared helpers for the region tests (not a test file itself).
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile } from '../lib/realise.mjs';
import { makeColumns, unpack } from '../lib/region/pack.mjs';
import { synthWorld } from '../lib/region/synth.mjs';

/** A world function: synthetic land (seeded), or flat at `flat`. */
export function worldOf({ seed = 'prim', flat = null } = {}) {
  if (flat !== null) return () => ({ g: flat, h: flat, f: flat, flags: 0 });
  return synthWorld(seed);
}

export function columnsOf(world, minX, minZ, width, depth, res = 1) {
  const c = makeColumns(minX, minZ, width, depth, res);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) {
    const v = world(minX + i * res, minZ + j * res);
    const k = i + j * width;
    c.ground[k] = v.g; c.height[k] = v.h; c.floor[k] = v.f; c.flags[k] = v.flags;
  }
  return c;
}

export const windowOf = (world, key) => {
  const [tx, tz] = key.split(',').map(Number);
  return columnsOf(world, tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
};

/** Plan an inline program `fn(ctx)` over a claim (resolution-1 survey from `world` when the claim is <= 256). */
export async function planInline(fn, { claim = { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 }, world = worldOf(), params, seed = '42', id = 'inline_test', programParams } = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const res = W <= 256 && D <= 256 ? 1 : 4;
  const survey = columnsOf(world, claim.minX, claim.minZ, Math.ceil(W / res), Math.ceil(D / res), res);
  const program = { id, default: fn, ...(programParams ? { params: programParams } : {}) };
  return planRegion({ program, programSource: fn.toString(), params, survey, seed, claim, node: 'test' });
}

/**
 * Evaluate every tile of an IR (all stages and sets, or one) against `world` and return a Map "x,y,z" -> cell
 * {x, y, z, state, cond, walk, stage, set}. Later stages overwrite earlier ones in the map (as the mod would write them).
 */
export function realiseAll(ir, world, { stage = null } = {}) {
  const cells = new Map();
  let clipped = 0;
  for (const s of ir.stages) {
    if (stage !== null && s !== stage) continue;
    for (const set of ['terrain', 'path']) {
      for (const key of ir.tiles[s][set]) {
        const r = evalTile(ir, key, windowOf(world, key), { stage: s, set });
        clipped += r.notes.clipped;
        for (const c of unpack(r.payload).cells) cells.set(`${c.x},${c.y},${c.z}`, { ...c, stage: s, set });
      }
    }
  }
  cells.clipped = clipped;
  return cells;
}

/** A small seeded PRNG for property tests. */
export function prng(seed) {
  let s = seed >>> 0;
  const f = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
  return f;
}
