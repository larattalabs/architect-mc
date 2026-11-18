// (8c WM) wm_demo: a test-only region (not in the catalogue) for slice WM's water model: h_core_demo's spout and basin with the spout
// simulated by the opt-in model (`model: 'wm'`): its frozen volume asked with levels (ARVX version 4), the IR requiring
// `flowingWater` and `volume:levels`. Its basin is an H body, planned as before.
import { region } from '../../../lib/region/program.mjs';

export const id = 'wm_demo';
export const catalogue = false;
export const params = {};

export default function wmDemo(ctx) {
  const { claim, survey } = ctx;
  const cx = claim.minX + ((claim.maxX - claim.minX + 1) >> 1), cz = claim.minZ + ((claim.maxZ - claim.minZ + 1) >> 1);
  const r = region(ctx);
  r.stages(['ground', 'fluids']);
  const g = (x, z) => survey.groundAt(x, z);
  r.anchor('entrance', [cx, g(cx, cz) + 1, cz - 14]);
  r.anchor('spawn', [cx, g(cx, cz) + 1, cz - 14]);
  const bx = cx, bz = cz;
  let low = Infinity;
  for (let x = bx - 3; x <= bx + 3; x++) for (let z = bz - 3; z <= bz + 3; z++) low = Math.min(low, g(x, z));
  const level = low - 1;
  const basin = [];
  for (let x = bx - 2; x <= bx + 2; x++) for (let z = bz - 2; z <= bz + 2; z++) if (x !== bx || z !== bz) basin.push([x, level, z]);
  const carve = r.part('basin_carve', { stage: 'ground' });
  const cols = [];
  for (const [x, y, z] of basin) cols.push(x, z, y, g(x, z), 0);
  carve.columns({ abs: 0 }, { abs: 0 }, cols, [null], { cond: 0 });
  const top = low + 2;
  const pillar = r.part('pillar', { stage: 'ground' });
  pillar.columns({ abs: 0 }, { abs: 0 }, [bx, bz, level, top - 1, 0], ['minecraft:stone_bricks'], { cond: 3 });
  const solid = [];
  for (let y = level; y <= top - 1; y++) solid.push([bx, y, bz]);
  r.fluidBody(basin, { id: 'basin', kind: 'fountain', stage: 'ground', level, shellRole: 'minecraft:stone_bricks', solid });
  const outlets = [[bx + 1, top, bz], [bx - 1, top, bz], [bx, top, bz + 1], [bx, top, bz - 1]];
  r.fluidBody([[bx, top, bz]], { id: 'spout', kind: 'fountain', stage: 'ground', level: top, outlets, shellRole: 'minecraft:stone_bricks', solid, model: 'wm',
    world: (x, y, z) => (basin.some((c) => c[0] === x && c[1] === y && c[2] === z) ? 'water' : null) });
  return r;
}
