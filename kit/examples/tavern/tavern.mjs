// Tavern: a two-storey timber-framed inn. A stone taproom with a bar and tables below, guest beds above, a gable
// roof with a chimney, a double door under a little awning.
//
//   x ->  -1 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14
//   z=0      north wall: bar back (barrels), beds upstairs
//   z=1..7   taproom 12 x 7; stairs up along the west wall (x=1, climbing north from z=7 to z=3)
//   z=8      south wall (front): double door at x=6..7, windows either side
//   z=9..10  awning + path (entrance z=9, spawn z=10)
//
// Rows: y0 floor, y1..4 cobblestone ground storey, y5 the upper floor (log beams outside), y6..9 timber frame
// (dark logs, calcite infill), y10 the top plate / ceiling, y10..16 the gable roof (pitch 1, 1-cell overhang).
import { Blueprint, palette } from '../lib/kit.mjs';

export const id = 'tavern';

export default function build({ palette: p = palette({ wood: 'spruce', stone: 'cobblestone', roof: 'dark_oak', wall: 'minecraft:calcite', frame: 'minecraft:stripped_dark_oak_log' }) } = {}) {
  const X = 13; // east wall
  const Z = 8; // south (front) wall
  const bp = new Blueprint({
    id,
    name: 'The Crooked Tankard',
    description: 'A two-storey timber-framed tavern: a stone taproom with a bar and tables, guest beds upstairs, a chimney.',
    type: 'tavern',
    tags: ['medieval', 'timber-frame', 'two-storey', 'chimney'],
    size: [16, 18, 12],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, X - 1, 9, Z - 1],
    approach: { length: 4, width: 3 },
  });

  // ---------------------------------------------------------------- ground storey (stone)
  bp.floor(0, 0, X, Z, 0, p.stone);
  bp.floor(1, 1, X - 1, Z - 1, 0, p.planks);
  bp.carve([1, 1, 1, X - 1, 9, Z - 1]);
  bp.walls(0, 0, X, Z, 1, 4, { block: p.stone, corners: p.log });
  // upper floor + beams
  bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);
  bp.beam(0, 5, 0, X, 0);
  bp.beam(0, 5, Z, X, Z);
  bp.beam(0, 5, 1, 0, Z - 1);
  bp.beam(X, 5, 1, X, Z - 1);
  // ---------------------------------------------------------------- upper storey (timber frame)
  bp.walls(0, 0, X, Z, 6, 9, { block: p.wall, corners: p.frame });
  for (const x of [3, 6, 7, 10]) for (const z of [0, Z]) bp.post(x, z, 6, 9, p.frame);
  for (const z of [3, 5]) for (const x of [0, X]) bp.post(x, z, 6, 9, p.frame);
  bp.beam(0, 10, 0, X, 0);
  bp.beam(0, 10, Z, X, Z);
  bp.beam(0, 10, 1, 0, Z - 1);
  bp.beam(X, 10, 1, X, Z - 1);
  bp.floor(1, 1, X - 1, Z - 1, 10, p.planks);

  // ---------------------------------------------------------------- doors + windows
  bp.doubleDoor(6, 1, Z, 'south');
  bp.set(6, 3, Z, p.log, { axis: 'x' });
  bp.set(7, 3, Z, p.log, { axis: 'x' });
  for (const [a, b] of [[2, 3], [10, 11]]) bp.window(a, 2, Z, b, 3, Z);
  for (const [a, b] of [[4, 5], [8, 9], [1, 2], [11, 12]]) {
    bp.window(a, 7, Z, b, 8, Z);
    bp.window(a, 7, 0, b, 8, 0);
  }
  for (const x of [0, X]) {
    bp.window(x, 2, 3, x, 3, 5);
    bp.window(x, 7, 4, x, 8, 4);
  }
  bp.window(4, 2, 0, 9, 3, 0); // behind the bar
  // awning over the door with lanterns
  for (let x = 5; x <= 8; x++) bp.stairs(x, 4, Z + 1, 'north', { block: p.accentStairs });
  for (const x of [4, 9]) bp.torch(x, 3, Z + 1, 'south');

  // ---------------------------------------------------------------- roof + chimney
  bp.roofGable(-1, -1, X + 1, Z + 1, 10, { ridge: 'x', pitch: 1, gable: p.wall, gableInset: 1, gableFrom: 11 });
  for (const x of [0, X]) {
    bp.post(x, 4, 11, 13, p.frame);
    bp.window(x, 12, 3, x, 12, 3);
    bp.window(x, 12, 5, x, 12, 5);
  }
  bp.chimney(X + 1, 4, 0, 16, { block: p.stone });

  // ---------------------------------------------------------------- taproom
  // the bar: a counter of top slabs on barrels in front of a barrel wall
  for (let x = 4; x <= 9; x++) {
    bp.set(x, 1, 2, 'minecraft:barrel', { facing: 'south' });
    bp.slab(x, 2, 2, 'top', p.accentSlab);
    bp.set(x, 1, 1, 'minecraft:barrel', { facing: 'south' });
  }
  bp.set(10, 1, 2, p.accentPlanks);
  bp.slab(10, 2, 2, 'top', p.accentSlab);
  bp.set(10, 1, 1, 'minecraft:barrel', { facing: 'up' });
  bp.air(10, 2, 1);
  bp.candle(5, 3, 2, 3);
  bp.candle(8, 3, 2, 2);
  for (const x of [4, 6, 8]) bp.chair(x, 1, 3, 'north');
  // tables
  for (const [tx, tz] of [[4, 6], [9, 6], [11, 4]]) {
    bp.table(tx, 1, tz);
    bp.chair(tx - 1, 1, tz, 'east');
    bp.chair(tx + 1, 1, tz, 'west');
  }
  bp.set(X - 1, 1, 1, 'minecraft:crafting_table');
  bp.set(X - 1, 1, Z - 1, 'minecraft:barrel', { facing: 'up' });
  bp.ceilingLights(2, 1, X - 1, Z - 1, 4, { spacing: 5 });

  // ---------------------------------------------------------------- stairs up (west wall) + railing
  bp.stairRun(1, 1, 7, 'north', 5);
  for (const z of [4, 5]) bp.set(2, 6, z, p.fence);
  bp.set(1, 6, 6, p.fence);
  bp.set(2, 6, 6, p.fence);

  // ---------------------------------------------------------------- guest rooms upstairs
  for (const x of [4, 7, 10]) bp.bed(x, 6, 1, 'north', x === 7 ? 'green' : 'red');
  for (const x of [5, 8, 11]) bp.set(x, 6, 1, 'minecraft:chest', { facing: 'south' });
  for (const x of [5, 8]) bp.lantern(x, 7, 1);
  bp.rug(5, 4, 10, 6, 6, { fill: 'minecraft:green_carpet', border: 'minecraft:brown_carpet' });
  bp.set(X - 1, 6, Z - 1, 'minecraft:bookshelf');
  bp.plant(X - 1, 7, Z - 1, 'minecraft:potted_red_tulip');
  bp.ceilingLights(3, 1, X - 1, Z - 1, 9, { spacing: 5 });

  // ---------------------------------------------------------------- path + anchors
  bp.floor(5, Z + 1, 8, Z + 2, 0, p.stone);
  bp.floor(6, Z + 1, 7, Z + 2, 0, p.path);
  bp.spot('entrance', 6, Z + 1, 180);
  bp.spot('spawn', 7, Z + 2, 180);
  bp.camera('overview', [-9, 14, Z + 16], [6.5, 5, 4]);
  bp.camera('taproom', [11.5, 2.6, 6.5], [5, 1.5, 2]);
  return bp;
}
