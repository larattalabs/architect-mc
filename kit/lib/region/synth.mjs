// A deterministic synthetic heightfield (the stand-in for real terrain in tests, benches and the golden file): rolling
// overworld-like land from the kit's own noise, with lakes (water over a floor) and scattered trees. Every column is a
// pure function of (x, z, seed), so a resolution-4 plan survey and a resolution-1 tile window agree at shared columns.
import { fnv64, makeNoise, hash3 } from '../noise.mjs';
import { FLAG_TREE, FLAG_WATER, encodeColumns, makeColumns } from './pack.mjs';

export const SEA = 62;

/** `col(x, z) -> {g, h, f, flags}` for a synthetic world `seed` (any string). */
export function synthWorld(seed = 'synth') {
  const key = (label) => fnv64('synth', seed, label).hex;
  const broad = makeNoise({ kind: 'simplex', dims: 2, scale: 420, octaves: 4, seed: key('broad') });
  const hills = makeNoise({ kind: 'simplex', dims: 2, scale: 90, octaves: 3, seed: key('hills') });
  const rough = makeNoise({ kind: 'value', dims: 2, scale: 12, octaves: 2, seed: key('rough') });
  const t = fnv64('synth', seed, 'trees');
  return (x, z) => {
    const b = broad(x, 0, z), hl = hills(x, 0, z), r = rough(x, 0, z);
    const ground = Math.floor(70 + 16 * b + 9 * hl * (0.6 + 0.4 * b) + 1.5 * r);
    if (ground < SEA) return { g: SEA, h: SEA, f: ground, flags: FLAG_WATER };
    const tree = hash3(t.hi, t.lo, x, 0, z) % 97 === 0;
    return { g: ground, h: tree ? ground + 6 : ground, f: ground, flags: tree ? FLAG_TREE : 0 };
  };
}

/** A columns object over [minX, minX + width*res) x [minZ, ...) sampled from a synthetic world. */
export function synthColumns({ minX, minZ, width, depth, resolution = 1, seed = 'synth', world = null }) {
  const w = world ?? synthWorld(seed);
  const c = makeColumns(minX, minZ, width, depth, resolution);
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const v = w(minX + i * resolution, minZ + j * resolution);
      const k = i + j * width;
      c.ground[k] = v.g; c.height[k] = v.h; c.floor[k] = v.f; c.flags[k] = v.flags;
    }
  }
  return c;
}

/** The plan survey of a claim (resolution 1 up to 256x256 columns, else 4), as a columns object. */
export function synthSurvey(claim, seed = 'synth', world = null) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const res = W <= 256 && D <= 256 ? 1 : 4;
  return synthColumns({ minX: claim.minX, minZ: claim.minZ, width: Math.ceil(W / res), depth: Math.ceil(D / res), resolution: res, seed, world });
}

/** A tile's 80x80 heights window at resolution 1. */
export function synthTileWindow(key, seed = 'synth', world = null) {
  const [tx, tz] = String(key).split(',').map(Number);
  return synthColumns({ minX: tx * 64 - 8, minZ: tz * 64 - 8, width: 80, depth: 80, resolution: 1, seed, world });
}

export const synthBytes = (o) => encodeColumns(synthColumns(o));
