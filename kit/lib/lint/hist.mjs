// (fast checks P2) The historical bugs' fixtures (kit/test/fixtures/lint/hist/<name>.json) as lint cases: a flat claim, a frozen volume
// whose cells the fixture names block by block (an ARVX v2: classes and block ids), the fixture's parts and roads planned by
// hist/program.mjs, and the build records and protected areas the plan honours. The lint's world reads the volume's blocks (a dirt
// path the region did not write, a tree's branch) where the survey's 2.5D columns can't hold them.
import path from 'node:path';
import { planRegion } from '../region/plan.mjs';
import { makeColumns, encodeColumns } from '../region/pack.mjs';
import { encodeArvx, decodeArvx, VC } from '../region/volume.mjs';
import { voxelClassOf } from '../blocks.mjs';

/** -> the lint case {ir, meta, survey, blobs, volumes, protected, builds, plan: null}. */
export async function histPlan(fx, kitDir) {
  const [x0, z0, x1, z1] = fx.claim, y = fx.ground ?? 64;
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const c = makeColumns(x0, z0, W, D, 1);
  for (let k = 0; k < W * D; k++) { c.ground[k] = y; c.height[k] = y; c.floor[k] = y; c.flags[k] = 0; }
  const survey = Buffer.from(encodeColumns(c));
  const volumes = [];
  if (fx.volume) {
    const [bx0, by0, bz0, bx1, by1, bz1] = fx.volume.box;
    const box = { minX: bx0, minY: by0, minZ: bz0, maxX: bx1, maxY: by1, maxZ: bz1 };
    const VW = bx1 - bx0 + 1, VH = by1 - by0 + 1, VD = bz1 - bz0 + 1;
    const classes = new Uint8Array(VW * VH * VD);
    const blockOf = new Array(VW * VH * VD).fill(null);
    for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) for (let yy = by0; yy <= by1; yy++) {
      const i = ((x - bx0) * VD + (z - bz0)) * VH + (yy - by0);
      classes[i] = yy > y ? VC.AIR : yy >= y - 3 ? VC.SOIL : VC.ROCK;
      blockOf[i] = yy > y ? 'minecraft:air' : yy === y ? 'minecraft:grass_block' : yy >= y - 3 ? 'minecraft:dirt' : 'minecraft:stone';
    }
    for (const [ax, ay, az, bx, by, bz, block] of fx.volume.blocks ?? []) for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z++) for (let yy = ay; yy <= by; yy++) {
      const i = ((x - bx0) * VD + (z - bz0)) * VH + (yy - by0);
      const cl = voxelClassOf(block);
      classes[i] = VC[cl] ?? VC.ROCK;
      blockOf[i] = block;
    }
    const pal = ['minecraft:air', ...[...new Set(blockOf.filter((b) => b !== 'minecraft:air'))].sort()];
    const ids = new Uint16Array(blockOf.length);
    blockOf.forEach((b, i) => { ids[i] = pal.indexOf(b); });
    const bytes = encodeArvx(box, classes, [], new Map(), { palette: pal, index: ids });
    volumes.push({ box, bytes, decoded: decodeArvx(bytes) });
  }
  const res = await planRegion({ programFile: path.join(kitDir, 'test', 'fixtures', 'lint', 'hist', 'program.mjs'), params: { spec: fx.spec }, survey, seed: '1', claim: { minX: x0, minZ: z0, maxX: x1, maxZ: z1, minY: -64, maxY: 319 }, roles: {}, keepOut: [], ...(volumes.length ? { volumes: volumes.map((v) => ({ box: v.box, sha: v.decoded.sha, bytes: v.bytes, decoded: v.decoded })) } : {}) });
  return { ir: res.ir, meta: res.meta, survey, blobs: (sha) => res.blobs.get(sha) ?? null, volumes: volumes.map((v) => v.decoded), protected: fx.protected ?? [], builds: fx.builds ?? [], plan: null };
}
