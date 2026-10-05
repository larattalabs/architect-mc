// Gatehouse: a stone gate building over a road. A passage 3 wide and 4 tall runs through it front to back,
// a guard room on each side (doors on the front face), a hall above the passage reached by a ladder from the west
// guard room, and a crenellated flat roof.
//
//   x ->  0 1 2 3 4 5 6 7 8 9 10
//   z=0    W W W W . . . W W W W     north face: the passage mouth at x=4..6
//   z=1..5 W g g W . . . W g g W     g = guard rooms (x=1..2, x=8..9), ladder at (1, z=1) in the west room
//   z=6    W W D W . . . W D W W     south face (front): guard-room doors at x=2 and x=8
//   z=-1, z=7: the road continues out of both mouths (entrance z=7, spawn z=8)
//
// Rows: y0 the road and the room floors, y1..4 the passage (open) and the guard rooms, y5 the hall floor over
// everything, y6..8 the hall, y9 the roof deck, y10..11 the crenellated parapet. Banners of torches flank the
// front mouth. Feet row = groundY = 1; the origin is shifted by (0,0,2) for the road behind.
import { Blueprint, palette } from '../lib/kit.mjs';

export const id = 'gatehouse';

export default function build({ palette: p = palette({ wood: 'spruce', stone: 'stone_bricks', roof: 'dark_oak' }) } = {}) {
  const X = 10;
  const Z = 6;
  const bp = new Blueprint({
    id,
    name: 'Gatehouse',
    description: 'A stone gatehouse over a road: a 3-wide passage, two guard rooms, a hall above and a crenellated roof.',
    type: 'gatehouse',
    tags: ['medieval', 'stone', 'fortification'],
    size: [11, 12, 10],
    origin: [0, 0, 2],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 6, 1, X - 1, 8, Z - 1],
    approach: { length: 4, width: 3 },
  });

  // ---------------------------------------------------------------- base, walls
  bp.floor(0, 0, X, Z, 0, p.stone);
  bp.floor(4, -2, 6, Z + 1, 0, 'minecraft:cobblestone'); // the road through
  bp.floor(1, 1, 2, Z - 1, 0, p.planks);
  bp.floor(8, 1, 9, Z - 1, 0, p.planks);
  // guard-room blocks on each side of the passage (rows 1..4)
  for (const [x0, x1] of [[0, 3], [7, X]]) {
    bp.carve([x0 + 1, 1, 1, x1 - 1, 4, Z - 1]);
    bp.walls(x0, 0, x1, Z, 1, 4, { block: p.stone, corners: p.stone });
  }
  bp.carve([4, 1, 0, 6, 4, Z]); // the passage
  // the hall over everything (a band of polished stone outside, where the floor is)
  bp.floor(0, 0, X, Z, 5, p.stone === 'minecraft:stone_bricks' ? 'minecraft:polished_andesite' : p.stone);
  bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);
  bp.carve([1, 6, 1, X - 1, 8, Z - 1]);
  bp.walls(0, 0, X, Z, 6, 8, { block: p.stone, corners: p.stone });
  // arch trim over both mouths: upside-down stairs at the passage corners
  for (const z of [0, Z]) {
    bp.stairs(4, 4, z, 'west', { block: p.stoneStairs, half: 'top' });
    bp.stairs(6, 4, z, 'east', { block: p.stoneStairs, half: 'top' });
  }

  // ---------------------------------------------------------------- roof
  bp.roofFlat(0, 0, X, Z, 9, { deck: p.stone, parapet: p.stone, crenels: true });
  bp.floor(1, 1, X - 1, Z - 1, 9, p.stoneSlab);
  for (const [x, z] of [[1, 1], [X - 1, 1], [1, Z - 1], [X - 1, Z - 1]]) bp.slab(x, 9, z, 'double', p.stoneSlab);

  // ---------------------------------------------------------------- doors, windows, torches
  bp.door(2, 1, Z, 'south');
  bp.door(8, 1, Z, 'south', { hinge: 'right' });
  for (const z of [0, Z]) for (const x of [2, 5, 8]) bp.window(x, 7, z, x, 7, z, 'minecraft:iron_bars');
  for (const x of [0, X]) bp.window(x, 7, 2, x, 7, 4, 'minecraft:iron_bars');
  for (const x of [0, X]) bp.window(x, 2, 3, x, 3, 3, 'minecraft:iron_bars');
  for (const x of [3, 7]) for (const z of [Z + 1, -1]) bp.torch(x, 3, z, z > 0 ? 'south' : 'north');

  // ---------------------------------------------------------------- ladder (west guard room) to the hall
  bp.ladder(1, 1, 1, 5, 'south');

  // ---------------------------------------------------------------- rooms
  for (const x of [2, 8]) bp.lantern(x, 4, 3, true);
  bp.lantern(5, 4, 3, true); // over the road
  bp.set(2, 1, 1, 'minecraft:barrel', { facing: 'up' });
  bp.set(8, 1, 1, 'minecraft:chest', { facing: 'south' });
  bp.set(9, 1, 1, 'minecraft:barrel', { facing: 'up' });
  bp.set(9, 1, 5, 'minecraft:barrel', { facing: 'up' });
  bp.set(1, 1, 5, 'minecraft:crafting_table');
  bp.ceilingLights(1, 1, X - 1, Z - 1, 8, { spacing: 5 });
  bp.bed(3, 6, 1, 'north', 'blue');
  bp.bed(7, 6, 1, 'north', 'blue');
  bp.table(5, 6, 3);
  bp.chair(4, 6, 3, 'east');
  bp.chair(6, 6, 3, 'west');
  bp.set(X - 1, 6, Z - 1, 'minecraft:chest', { facing: 'west' });
  for (const z of [3, 4]) bp.set(X - 1, 6, z, 'minecraft:bookshelf');

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', 5, Z + 1, 180);
  bp.spot('spawn', 5, Z + 1, 180);
  bp.camera('overview', [-8, 12, Z + 13], [5, 4, 3]);
  return bp;
}
