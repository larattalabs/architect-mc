// cu_demo: slice CU's copper fixture (docs/CONTRACT.md "Phase 6c slice CU" §8): copper written by a region's parts as CELL tiles, so its
// undo goes through "still ours" cell by cell (a lot's BOX entry would restore whatever the copper did). Not in the catalogue. On any
// claim of at least 48x48 with level ground near its centre (a flat world):
//   gallery  every form of the copper chain at least once (block, chiseled, cut, cut slab, cut stairs, bars, bulb, chain, chest, door,
//            golem statue, grate, lantern, trapdoor, lightning rod), each on a stone-brick plinth, in two rows: the unwaxed row and
//            its waxed twin 4 blocks south;
//   wall     a stone-brick wall 9 long, 2 high, trimmed with a cut-copper slab course, with a copper lantern on a post at each end;
//   rail     a cut-copper stairs rail 7 long on a stone-brick deck (the bridge rail), its waxed twin beside it;
//   field    (`field`, on by default) the other drift kinds of §5: a 3x3 farmland patch with no water, oak leaves (not persistent) with
//            no log, an oak sapling on dirt, a snow layer on stone.
// Every cell is written with cond 3 (always ours). Deterministic: no randomness, ground read once at the centre.
import { region } from '../lib/region/program.mjs';

export const id = 'cu_demo';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  field: { type: 'bool', default: true, label: 'Drift field corner' },
  cx: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** The 15 forms of the chain (their first, unwaxed stage), each as the cells a plinth holds: [dy, state]. */
export const FORMS = Object.freeze([
  ['copper_block', [[0, 'minecraft:copper_block']]],
  ['chiseled_copper', [[0, 'minecraft:chiseled_copper']]],
  ['cut_copper', [[0, 'minecraft:cut_copper']]],
  ['cut_copper_slab', [[0, 'minecraft:cut_copper_slab[type=bottom,waterlogged=false]']]],
  ['cut_copper_stairs', [[0, 'minecraft:cut_copper_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]']]],
  ['copper_bars', [[0, 'minecraft:copper_bars[east=false,north=false,south=false,waterlogged=false,west=false]']]],
  ['copper_bulb', [[0, 'minecraft:copper_bulb[lit=false,powered=false]']]],
  ['copper_chain', [[0, 'minecraft:copper_chain[axis=y,waterlogged=false]']]],
  ['copper_chest', [[0, 'minecraft:copper_chest[facing=north,type=single,waterlogged=false]']]],
  ['copper_door', [[0, 'minecraft:copper_door[facing=north,half=lower,hinge=left,open=false,powered=false]'], [1, 'minecraft:copper_door[facing=north,half=upper,hinge=left,open=false,powered=false]']]],
  ['copper_golem_statue', [[0, 'minecraft:copper_golem_statue[copper_golem_pose=standing,facing=north,waterlogged=false]']]],
  ['copper_grate', [[0, 'minecraft:copper_grate[waterlogged=false]']]],
  ['copper_lantern', [[0, 'minecraft:copper_lantern[hanging=false,waterlogged=false]']]],
  ['copper_trapdoor', [[0, 'minecraft:copper_trapdoor[facing=north,half=bottom,open=false,powered=false,waterlogged=false]']]],
  ['lightning_rod', [[0, 'minecraft:lightning_rod[facing=up,powered=false,waterlogged=false]']]],
]);

/** The waxed twin of a first-stage copper state (`waxed_` before the id; the copper block's is waxed_copper_block). */
export function waxedOf(state) {
  return state.replace(/^minecraft:([a-z_]+)/, (m, id) => `minecraft:waxed_${id}`);
}

export default function cuDemo(ctx) {
  const { claim, survey, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 48 || D < 48) throw new Error(`cu_demo needs a claim of at least 48x48 (got ${W}x${D})`);
  const cx = P.cx === AUTO ? claim.minX + (W >> 1) : P.cx;
  const cz = P.cz === AUTO ? claim.minZ + (D >> 1) : P.cz;
  const r = region(ctx);
  r.stages(['ground', 'copper']);
  const gy = survey.groundAt(cx, cz);
  const y0 = gy + 1;
  r.anchor('entrance', [cx, y0, cz - 16]);
  r.anchor('spawn', [cx, y0, cz - 16]);
  r.anchor('cam_high', [cx, y0 + 20, cz - 24]);

  // the stone-brick structure (plinths, the wall, the posts, the deck): its own part, written first
  const stone = r.part('cu_stone', { stage: 'ground' });
  const sCols = [];
  const STONE = ['minecraft:stone_bricks'];
  // the copper: one part per group, so a removal reports them apart
  const groups = { gallery: [], wall: [], rail: [] };
  const mats = { gallery: [], wall: [], rail: [] };
  const put = (g, x, y, z, state) => {
    let i = mats[g].indexOf(state);
    if (i < 0) { i = mats[g].length; mats[g].push(state); }
    groups[g].push(x, z, y, y, i);
  };

  // ---- the gallery: 15 plinths 2 apart along x, the unwaxed row at z = cz - 6, the waxed row at z = cz - 2
  const gx0 = cx - 15;
  for (const [k, [, cells]] of FORMS.entries()) {
    const x = gx0 + 2 * k;
    for (const [row, wax] of [[cz - 6, false], [cz - 2, true]]) {
      sCols.push(x, row, y0, y0, 0); // the plinth
      for (const [dy, st] of cells) put('gallery', x, y0 + 1 + dy, row, wax ? waxedOf(st) : st);
    }
  }

  // ---- the wall: 9 long at z = cz + 4, 2 high, a cut-copper slab course on top; a copper lantern on a post at each end
  for (let x = cx - 4; x <= cx + 4; x++) {
    sCols.push(x, cz + 4, y0, y0 + 1, 0);
    put('wall', x, y0 + 2, cz + 4, x % 2 === 0 ? 'minecraft:cut_copper_slab[type=bottom,waterlogged=false]' : 'minecraft:waxed_cut_copper_slab[type=bottom,waterlogged=false]');
  }
  for (const x of [cx - 6, cx + 6]) {
    sCols.push(x, cz + 4, y0, y0 + 1, 0);
    put('wall', x, y0 + 2, cz + 4, x < cx ? 'minecraft:copper_lantern[hanging=false,waterlogged=false]' : 'minecraft:waxed_copper_lantern[hanging=false,waterlogged=false]');
  }

  // ---- the rail: a deck 7 long at z = cz + 8 .. cz + 9, a cut-copper stairs rail on each edge (north unwaxed, south waxed)
  for (let x = cx - 3; x <= cx + 3; x++) {
    sCols.push(x, cz + 8, y0, y0, 0, x, cz + 9, y0, y0, 0);
    put('rail', x, y0 + 1, cz + 8, 'minecraft:cut_copper_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
    put('rail', x, y0 + 1, cz + 9, 'minecraft:waxed_cut_copper_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]');
  }
  stone.columns({ abs: 0 }, { abs: 0 }, sCols, STONE, { cond: 3 });
  for (const g of ['gallery', 'wall', 'rail']) r.part(`cu_${g}`, { stage: 'copper' }).columns({ abs: 0 }, { abs: 0 }, groups[g], mats[g], { cond: 3 });

  // ---- the field corner (§5's other drift kinds), at x = cx + 10 .. cx + 14, z = cz - 6 .. cz - 2
  if (P.field) {
    const f = r.part('cu_field', { stage: 'copper' });
    const fc = [];
    const fm = ['minecraft:farmland[moisture=0]', 'minecraft:oak_leaves[distance=7,persistent=false,waterlogged=false]', 'minecraft:oak_sapling[stage=0]', 'minecraft:dirt', 'minecraft:snow[layers=1]', 'minecraft:stone'];
    // farmland 3x3 replacing the ground (no water within 4)
    for (let x = cx + 10; x <= cx + 12; x++) for (let z = cz - 6; z <= cz - 4; z++) fc.push(x, z, gy, gy, 0);
    // leaves: a 2x1x2 clump on stone posts, no log
    for (const [x, z] of [[cx + 14, cz - 6], [cx + 14, cz - 5]]) fc.push(x, z, y0, y0, 5, x, z, y0 + 1, y0 + 1, 1);
    // a sapling on dirt, a snow layer on stone
    fc.push(cx + 14, cz - 3, gy, gy, 3, cx + 14, cz - 3, y0, y0, 2);
    fc.push(cx + 12, cz - 2, y0, y0, 5, cx + 12, cz - 2, y0 + 1, y0 + 1, 4);
    f.columns({ abs: 0 }, { abs: 0 }, fc, fm, { cond: 3 });
  }
  return r;
}
