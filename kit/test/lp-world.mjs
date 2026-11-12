// (7b LP) Synthetic land for the link pass's units (kit/test/lp.test.mjs): a flat claim with boxes of classes set in a frozen volume,
// and a plan over it with site lots and port links. Shared by the gate's unit step (tools/gate7blp.mjs). Deterministic.
import { region } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns, encodeColumns } from '../lib/region/pack.mjs';
import { decodeArvx, encodeArvx, VC } from '../lib/region/volume.mjs';

/** The world: the volume box (x/z the claim, y from `ground - 16` to `ground + 48`), ground at `ground` (SOIL to 3 under it, ROCK under that). */
export function makeWorld({ claim = [1000, 2000, 1095, 2095], ground = 64, edits = [] } = {}) {
  const box = { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3], minY: ground - 16, maxY: ground + 48 };
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
    const wy = box.minY + y;
    classes[(x * D + z) * H + y] = wy > ground ? VC.AIR : wy >= ground - 3 ? VC.SOIL : VC.ROCK;
  }
  for (const e of edits) {
    const [x0, y0, z0, x1, y1, z1] = e.box;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ || y < box.minY || y > box.maxY) continue;
      classes[((x - box.minX) * D + (z - box.minZ)) * H + (y - box.minY)] = VC[e.class];
    }
  }
  const bytes = encodeArvx(box, classes);
  const vol = decodeArvx(bytes);
  // the survey: flat at the ground; columns under a solid edit raised to its top (a cliff), trees left to the volume
  const c = makeColumns(box.minX, box.minZ, W, D, 1);
  for (let n = 0; n < W * D; n++) { c.ground[n] = ground; c.height[n] = ground; c.floor[n] = ground; }
  for (const e of edits) {
    if (!['ROCK', 'SOIL'].includes(e.class)) continue;
    const [x0, , z0, x1, y1, z1] = e.box;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      const n = (x - box.minX) + (z - box.minZ) * W;
      if (y1 > c.ground[n]) { c.ground[n] = y1; c.height[n] = y1; c.floor[n] = y1; }
    }
  }
  return { box, vol, bytes, survey: encodeColumns(c), claim: { minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ, minY: box.minY, maxY: box.maxY } };
}

/** A tree: a 3x3 log trunk from ground + 1 for `h` cells, a leaf layer `r` round it 5 thick over it. */
export const tree = (x, z, ground, h = 20, r = 7) => [
  { box: [x - 1, ground + 1, z - 1, x + 1, ground + h, z + 1], class: 'LOG' },
  { box: [x - r, ground + h + 1, z - r, x + r, ground + h + 5, z + r], class: 'LEAVES' },
];

/**
 * Plan a region over the world: `body(r)` adds site lots and port links; `links` the realise's input (null: plan time). Returns
 * {res, out} (out: body's return) or throws.
 */
export async function planWorld(world, body, { links = null, seed = '7', id = 'lp_t' } = {}) {
  let out;
  const b = world.box;
  const program = { id, default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground', 'lots', 'props']);
    r.needVolume(world.vol.box);
    out = body(r);
    r.anchor('entrance', [b.minX + 2, 65, b.minZ + 2]);
    r.anchor('spawn', [b.minX + 2, 65, b.minZ + 2]);
    return r;
  } };
  const res = await planRegion({ program, programSource: id, survey: world.survey, claim: world.claim, seed, roles: {}, volumes: [{ sha: world.vol.sha, box: world.vol.box, bytes: world.bytes, decoded: world.vol }], ...(links ? { links } : {}) });
  return { res, out };
}
