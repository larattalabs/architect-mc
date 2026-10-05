// Cabin: a one-room log cabin with a covered porch, a gable roof and a stone chimney.
//
//   x ->  -1 0 1 2 3 4 5 6 7 8 9
//   z=-1   roof overhang (north eave)
//   z=0      L = = = = = = = L        north wall (window pair), bed + chest inside
//   z=1..5   |   room 7 x 5    | C    C = chimney through the east overhang (x=9, z=3)
//   z=6      L = W = D = W = L        south wall (front): door at x=4, windows at x=2, x=6
//   z=7..9     porch deck, posts at z=9, railings on the sides
//   z=10           path (spawn)
//
// Rows: y0 floor (cobblestone sill under the walls, planks inside), y1..4 log walls (horizontal logs, stripped-log
// corner posts), y5 the top plate (log beams) and the ceiling, y5..9 the gable roof (pitch 1, 1-cell overhang),
// y10 the chimney top with a campfire for smoke. Feet row = groundY = 1. Design coordinates are relative to the
// walls; the template origin is shifted by (1,0,1) for the overhang.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'cabin';

export default function build({ palette = PALETTES.rustic } = {}) {
  const p = palette;
  const X = 8; // east wall
  const Z = 6; // south (front) wall
  const bp = new Blueprint({
    id,
    name: 'Log Cabin',
    description: 'A one-room log cabin with a covered porch, a gable roof and a stone chimney.',
    type: 'cabin',
    tags: ['rustic', 'small', 'porch', 'chimney'],
    size: [11, 12, 12],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, X - 1, 4, Z - 1],
    approach: { length: 4, width: 3 },
  });

  // ---------------------------------------------------------------- floor + walls
  bp.floor(0, 0, X, Z, 0, p.stone); // sill under the walls
  bp.floor(1, 1, X - 1, Z - 1, 0, p.planks);
  bp.carve([1, 1, 1, X - 1, 4, Z - 1]);
  for (let y = 1; y <= 4; y++) {
    for (let x = 1; x < X; x++) for (const z of [0, Z]) bp.set(x, y, z, p.log, { axis: 'x' });
    for (let z = 1; z < Z; z++) for (const x of [0, X]) bp.set(x, y, z, p.log, { axis: 'z' });
  }
  for (const [x, z] of [[0, 0], [X, 0], [0, Z], [X, Z]]) bp.post(x, z, 1, 5, p.strippedLog);
  // top plate: log beams on the walls, ceiling planks inside
  bp.beam(1, 5, 0, X - 1, 0);
  bp.beam(1, 5, Z, X - 1, Z);
  bp.beam(0, 5, 1, 0, Z - 1);
  bp.beam(X, 5, 1, X, Z - 1);
  bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);

  // ---------------------------------------------------------------- door + windows
  bp.door(4, 1, Z, 'south');
  for (const x of [2, 6]) {
    bp.window(x, 2, Z, x, 3, Z);
    bp.window(x, 2, 0, x, 3, 0);
  }
  for (const x of [0, X]) bp.window(x, 2, 3, x, 3, 3);
  // flower boxes under the front windows
  for (const x of [2, 6]) bp.set(x, 1, Z + 1, p.trapdoor, { facing: 'south', half: 'top', open: 'false' });

  // ---------------------------------------------------------------- roof
  bp.roofGable(-1, -1, X + 1, Z + 1, 5, { ridge: 'x', pitch: 1, gable: p.planks, gableInset: 1, gableFrom: 6 });
  // a small window in each gable
  for (const x of [0, X]) bp.window(x, 7, 3, x, 7, 3);

  // ---------------------------------------------------------------- chimney (east side, through the overhang)
  bp.chimney(X + 1, 3, 0, 10, { block: p.stone });

  // ---------------------------------------------------------------- porch
  bp.porch(1, Z + 1, X - 1, Z + 3, {
    roofY: 4, deck: p.planks, posts: [[1, Z + 3], [X - 1, Z + 3]], post: p.log,
    roof: p.slab, rail: p.fence, railSides: ['west', 'east'],
  });
  bp.lantern(4, 3, Z + 2, true);
  bp.floor(3, Z + 4, 5, Z + 4, 0, p.path); // the start of the path

  // ---------------------------------------------------------------- inside
  bp.bed(1, 1, 1, 'north', 'red');
  bp.set(2, 1, 1, 'minecraft:chest', { facing: 'south' });
  bp.set(X - 1, 1, 1, 'minecraft:crafting_table');
  bp.set(X - 2, 1, 1, 'minecraft:furnace', { facing: 'south' });
  bp.set(X - 1, 1, 2, 'minecraft:barrel', { facing: 'up' });
  bp.table(X - 2, 1, 4);
  bp.chair(X - 3, 1, 4, 'east');
  bp.chair(X - 1, 1, 4, 'west');
  bp.rug(3, 2, 5, 4, 1, { fill: 'minecraft:red_carpet', border: 'minecraft:brown_carpet' });
  bp.set(1, 1, Z - 1, 'minecraft:bookshelf');
  bp.plant(1, 2, Z - 1);
  bp.ceilingLights(1, 1, X - 1, Z - 1, 4);

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', 4, Z + 1, 180);
  bp.spot('spawn', 4, Z + 4, 180);
  bp.camera('overview', [-8, 10, Z + 12], [4, 3, 3]);
  bp.camera('interior', [X - 1.5, 2.6, Z - 1.5], [1.5, 1.5, 1.5]);
  return bp;
}
