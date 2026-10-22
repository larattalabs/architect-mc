// The `giantMushroom` generator, version 1 (docs/CONTRACT.md 6c F3 §2, SETTLEMENTS §9.2). Plan time only.
//
// Skeleton (F1's rules: at most 32 primitives an op, absolute y, seeded fnv64(seed, generator, label)): a stem `capsuleChain` of
// `mushroom_stem` (a slight lean), a cap `ellipsoid` cut by `clipY` (brown: a flat plate, 2 thick at its middle; red: a domed shell 1
// thick whose rim hangs over the stem), and gills under the cap (a ring of `mushroom_stem` under the cap's underside, in radial
// stripes). The cells are evaluated by the kit's evaluator and every face fixed as vanilla's updateShape sets it (forms/states.mjs: a
// face is false next to the same block); a soil cell under the stem's foot is dirt (no grass dies under it). Always baked.
// Presets brown and red; sizes 8 to 32 high (2-4x vanilla's huge mushrooms).
import { fnv64, splitmix64 } from '../noise.mjs';
import { formCells } from './rules.mjs';
import { AIR, columnRuns, connectedTo, fixStates, isMushroomBlock, key, unkey } from './states.mjs';

export const GENERATOR = 'giantMushroom';
export const VERSION = 1;
const FOOT = 3;
const isInt = Number.isInteger;
const r2 = (v) => Math.round(v * 100) / 100;

export const PRESETS = Object.freeze({
  brown: { cap: 'minecraft:brown_mushroom_block', shape: 'flat', height: [10, 24], capR: [0.55, 0.7] },
  red: { cap: 'minecraft:red_mushroom_block', shape: 'dome', height: [12, 28], capR: [0.32, 0.42] },
});
export const SIZE = Object.freeze({ height: [8, 32] });
const STEM = 'minecraft:mushroom_stem';

function rng(seed, label) {
  const h = fnv64(seed, GENERATOR, label);
  const g = splitmix64(h.hi, h.lo);
  const f = () => g.float();
  f.int = (a, b) => a + Math.floor(g.float() * (b - a + 1));
  return f;
}

/** Validate the params; returns them filled. */
export function mushroomParams(p) {
  const preset = p.preset ?? 'brown';
  const base = PRESETS[preset];
  if (!base) throw new Error(`giantMushroom: unknown preset '${preset}' (${Object.keys(PRESETS).join(', ')})`);
  let height = p.height ?? base.height;
  if (isInt(height)) height = [height, height];
  const o = { at: p.at, preset, seed: String(p.seed ?? '1'), height };
  if (!Array.isArray(o.at) || o.at.length !== 3 || !o.at.every(isInt)) throw new Error('giantMushroom: at must be [x, y, z] integers (y: the plan ground)');
  if (!(Array.isArray(height) && height.length === 2 && height.every(isInt) && height[0] <= height[1] && height[0] >= SIZE.height[0] && height[1] <= SIZE.height[1])) throw new Error(`giantMushroom: height must be an integer or [min, max] in ${SIZE.height[0]}..${SIZE.height[1]}`);
  return o;
}

/**
 * Grow one mushroom. `groundAt(x, z)`: the plan ground (default `at[1]`). `_unsafe.mushroomFaces`: every face written true (the broken
 * variant: lint STATE). Returns `{generator, version, seed, params, ops, cells, columns, bounds, stats}` as giantTree's.
 */
export function giantMushroom(params, { groundAt = null, _unsafe = null } = {}) {
  const p = mushroomParams(params);
  const P = PRESETS[p.preset];
  const [x0, y0, z0] = p.at;
  const ground = groundAt ?? (() => y0);
  const rr = rng(p.seed, 'mushroom');
  const H = rr.int(p.height[0], p.height[1]);
  const g = ground(x0, z0);
  const top = g + H;
  const capR = Math.max(3, Math.round(H * (P.capR[0] + rr() * (P.capR[1] - P.capR[0]))));
  const stemR = H >= 20 ? 2 : H >= 12 ? 1.5 : 1;
  const lx = rr.int(-1, 1), lz = rr.int(-1, 1);
  const cx = x0 + lx, cz = z0 + lz;
  const ops = [];
  // the cap
  let cap;
  if (P.shape === 'flat') {
    // a plate: the ellipsoid's top 2 layers (its rim one lower: a slight droop)
    const ry = 3;
    const cy = top - ry + 1;
    cap = { kind: 'clipY', y0: { abs: top - 2 }, of: { kind: 'ellipsoid', c: [cx, { abs: cy }, cz], r: [capR + 0.5, ry + 0.5, capR + 0.5] } };
  } else {
    const ry = Math.max(3, Math.round(capR * 0.9));
    const cy = top - ry;
    cap = { kind: 'clipY', y0: { abs: cy - Math.max(1, Math.round(ry * 0.3)) }, of: { kind: 'subtract', of: [
      { kind: 'ellipsoid', c: [cx, { abs: cy }, cz], r: [capR + 0.5, ry + 0.5, capR + 0.5] },
      { kind: 'ellipsoid', c: [cx, { abs: cy - 1 }, cz], r: [capR - 0.5, ry - 0.5, capR - 0.5] },
    ] } };
  }
  ops.push({ op: 'shape', shape: { kind: 'union', of: [cap] }, material: P.cap, cond: 0, walk: false });
  // the stem, from under the ground to the cap's underside
  const stemTop = P.shape === 'flat' ? top - 2 : top - 2;
  ops.push({ op: 'shape', shape: { kind: 'union', of: [{ kind: 'capsuleChain', points: [[x0, g - FOOT, z0], [x0 + Math.trunc(lx / 2), g + Math.round(H / 2), z0 + Math.trunc(lz / 2)], [cx, stemTop, cz]], radii: [r2(stemR + 0.5), r2(stemR), r2(stemR)] }] }, material: STEM, cond: 0, walk: false });
  const { cells: raw } = formCells(ops);
  const cells = new Map();
  for (const [k, s] of raw) if (s !== AIR) cells.set(k, s);
  // gills: under the cap's underside, a ring between the stem and the rim, in radial stripes (8 sectors, every other one)
  const under = [];
  for (const [k, s] of cells) {
    if (s !== P.cap) continue;
    const [x, y, z] = unkey(k);
    if (cells.has(key(x, y - 1, z))) continue;
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 <= (stemR + 1.5) * (stemR + 1.5) || d2 >= (capR - 1) * (capR - 1)) continue;
    // the sector by integer comparisons (no trig): which side of the axes and diagonals
    const sector = (dx >= 0 ? 0 : 4) + (dz >= 0 ? 0 : 2) + (Math.abs(dx) >= Math.abs(dz) ? 0 : 1);
    if (sector % 2 === 0) under.push(key(x, y - 1, z));
  }
  for (const k of under) if (!cells.has(k)) cells.set(k, STEM);
  // nothing floating: everything touches the stem's foot
  const base = key(x0, g, z0);
  for (const k of connectedTo(cells, (k2) => k2 === base)) cells.delete(k);
  if (!cells.has(base)) throw new Error('giantMushroom: the stem has no cell at its base');
  // a soil cell under the stem standing on the ground: dirt
  for (const [k] of [...cells]) {
    const [x, y, z] = unkey(k);
    const gy = ground(x, z);
    if (y === gy + 1 && !cells.has(key(x, gy, z))) cells.set(key(x, gy, z), 'minecraft:dirt');
  }
  const fixed = fixStates(cells);
  if (_unsafe?.mushroomFaces) for (const [k, s] of cells) if (isMushroomBlock(s)) cells.set(k, s.replace(/=false/g, '=true'));
  const columns = columnRuns(cells);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const k of cells.keys()) {
    const [x, y, z] = unkey(k);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return {
    generator: GENERATOR, version: VERSION, seed: p.seed,
    params: { at: p.at, preset: p.preset, height: p.height },
    ops, cells, columns, bounds: { minX, maxX, minZ, maxZ, minY, maxY },
    stats: { height: H, crown: capR, trunk: stemR, ops: ops.length, cells: cells.size, faces: fixed.faces, across: Math.max(maxX - minX, maxZ - minZ) + 1 },
  };
}
