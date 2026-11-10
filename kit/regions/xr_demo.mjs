// xr_demo: slice XR's fixture (docs/CONTRACT.md "Slice XR"): on a flat claim, every way one survival writer writes over a cell another
// writer of the region built and paid for. Not in the catalogue; a gate fixture with fixed blocks (as rp_demo). Ground read once at the
// claim's centre (cx, gy); all on the ground row gy unless named:
//   pave    (ground)  a paid stone-brick pavement x cx-14..cx+14, z cz-9..cz+4, replacing the grass
//   street  (street)  a 4e ground road along z = cz over the pavement: a construction road over paid cells (it lays its path there)
//   cap     (street)  cobblestone over three of the pavement's cells (x cx+10..cx+12, z cz+3): a later target over a paid target cell
//   cap2    (props)   over the same three: spruce planks, stone bricks again (A-B-A), and air (a cut): three writers on one cell
//   stair   (ground)  a stone-brick stair facing east at gy+1 on (cx+8, cz+3); (props) the same stair facing north: the same block in
//                     another state, a later target built by matching
//   h1      (lots)    a 9x9 lot over the pavement's north rows (x cx-4..cx+4, z cz-9..cz-1, floor gy+1): its own foundation row (gy) and
//                     its approach path are written over the paid pavement (a lot over a paid target cell)
// Deterministic: no randomness.
import { region, COND } from '../lib/region/program.mjs';

export const id = 'xr_demo';
export const catalogue = false;
export const params = {};

export default function xrDemo(ctx) {
  const { claim, survey } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 48 || D < 40) throw new Error(`xr_demo needs a claim of at least 48x40 (got ${W}x${D})`);
  const cx = claim.minX + (W >> 1), cz = claim.minZ + (D >> 1);
  const gy = survey.groundAt(cx, cz);
  const r = region(ctx);
  r.stages(['ground', 'street', 'lots', 'props']);
  r.anchor('entrance', [cx, gy + 1, cz + 6]);
  r.anchor('spawn', [cx, gy + 1, cz + 6]);
  const at = (x, y, z) => ({ kind: 'box', min: [x, { abs: y }, z], max: [x, { abs: y }, z] });
  const pave = r.part('pave', { stage: 'ground' });
  pave.fill({ kind: 'box', min: [cx - 14, { abs: gy }, cz - 9], max: [cx + 14, { abs: gy }, cz + 4] }, 'minecraft:stone_bricks', { cond: COND.ALWAYS_OURS });
  pave.fill(at(cx + 8, gy + 1, cz + 3), 'minecraft:stone_brick_stairs[facing=east]', { cond: COND.ALWAYS_OURS });
  const street = r.part('street', { stage: 'street', set: 'path' });
  street.road([[cx - 16, gy, cz], [cx + 16, gy, cz]], { width: 3, surface: 'minecraft:gravel', lanterns: false, mode: 'ground', id: 'xr_street' });
  const cap = r.part('cap', { stage: 'street' });
  for (let k = 0; k < 3; k++) cap.fill(at(cx + 10 + k, gy, cz + 3), 'minecraft:cobblestone', { cond: COND.ALWAYS_OURS });
  const cap2 = r.part('cap2', { stage: 'props' });
  cap2.fill(at(cx + 10, gy, cz + 3), 'minecraft:spruce_planks', { cond: COND.ALWAYS_OURS });
  cap2.fill(at(cx + 11, gy, cz + 3), 'minecraft:stone_bricks', { cond: COND.ALWAYS_OURS });
  cap2.fill(at(cx + 12, gy, cz + 3), null, { cond: COND.ALWAYS_OURS });
  cap2.fill(at(cx + 8, gy + 1, cz + 3), 'minecraft:stone_brick_stairs[facing=north]', { cond: COND.ALWAYS_OURS });
  const lots = r.part('lots', { stage: 'lots' });
  lots.lot('h1', { at: [cx - 4, cz - 9], size: [9, 9], floor: gy + 1, front: 'south', pad: { maxCut: 2, maxFill: 2, edge: 'wall' } });
  return r;
}
