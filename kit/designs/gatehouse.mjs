// Gatehouse: a stone gate building over a road. A passage (3 to 5 wide, 4 tall) runs through it front to back,
// a guard room on each side (doors on the front face), a hall above the passage reached by a ladder from the west
// guard room, and a flat roof with a parapet (crenellated or plain).
//
//   x ->  0 1 2 3 4 . . E E+1 . X      (defaults: passage 3 -> passage x = 4..6, E = 7, X = 10; depth 7 -> Z = 6)
//   z=0    W W W W . . . W W W W     north face: the passage mouth
//   z=1..  W g g W . . . W g g W     g = guard rooms (x=1..2, x=E+1..X-1), ladder at (1, z=1) in the west room
//   z=Z    W W D W . . . W D W W     south face (front): guard-room doors at x=2 and x=X-2
//   z=-1, z=Z+1: the road continues out of both mouths (entrance and spawn z=Z+1)
//
// Rows: y0 the road and the room floors, y1..4 the passage (open) and the guard rooms, y5 the hall floor over
// everything (a band of trim stone outside), y6..8 the hall, y9 the roof deck, y10..11 the parapet. Torches flank
// both mouths. Feet row = groundY = 1; the origin is shifted by (0,0,2) for the road behind. Every material comes
// from the palette.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'gatehouse';

export const params = {
  passage: { type: 'int', min: 3, max: 5, default: 3, label: 'Passage width' },
  depth: { type: 'int', min: 5, max: 9, default: 7, label: 'Depth' },
  crenels: { type: 'bool', default: true, label: 'Crenellations' },
};

export default function build({ palette: p = PALETTES.fortress, passage = 3, depth = 7, crenels = true } = {}) {
  const P = passage;
  const E = 4 + P; // the east guard block's west wall
  const X = E + 3; // east wall
  const Z = depth - 1; // south (front) wall
  const M = 4 + Math.floor((P - 1) / 2); // the passage's middle column
  const zc = Math.floor(Z / 2);
  const bp = new Blueprint({
    id,
    name: 'Gatehouse',
    description: `A stone gatehouse over a road: a ${P}-wide passage, two guard rooms, a hall above and a ${crenels ? 'crenellated' : 'flat'} roof.`,
    type: 'gatehouse',
    tags: ['medieval', 'stone', 'fortification'],
    size: [X + 1, crenels ? 12 : 11, Z + 4],
    origin: [0, 0, 2],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 6, 1, X - 1, 8, Z - 1],
    approach: { length: 4, width: 3 },
  });

  bp.part('main', () => {
    // ---------------------------------------------------------------- base, walls
    bp.floor(0, 0, X, Z, 0, p.stone);
    bp.floor(4, -2, E - 1, Z + 1, 0, p.stoneTrim); // the road through
    bp.floor(1, 1, 2, Z - 1, 0, p.planks);
    bp.floor(E + 1, 1, X - 1, Z - 1, 0, p.planks);
    // guard-room blocks on each side of the passage (rows 1..4)
    for (const [x0, x1] of [[0, 3], [E, X]]) {
      bp.carve([x0 + 1, 1, 1, x1 - 1, 4, Z - 1]);
      bp.walls(x0, 0, x1, Z, 1, 4, { block: p.stone, corners: p.stone });
    }
    bp.carve([4, 1, 0, E - 1, 4, Z]); // the passage
    // the hall over everything (a band of trim stone outside, where the floor is)
    bp.floor(0, 0, X, Z, 5, p.stoneTrim);
    bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);
    bp.carve([1, 6, 1, X - 1, 8, Z - 1]);
    bp.walls(0, 0, X, Z, 6, 8, { block: p.stone, corners: p.stone });
    // arch trim over both mouths: upside-down stairs at the passage corners
    for (const z of [0, Z]) {
      bp.stairs(4, 4, z, 'west', { block: p.stoneStairs, half: 'top' });
      bp.stairs(E - 1, 4, z, 'east', { block: p.stoneStairs, half: 'top' });
    }
  });

  bp.part('roof', () => {
    // ---------------------------------------------------------------- roof
    bp.roofFlat(0, 0, X, Z, 9, { deck: p.stone, parapet: p.stone, crenels });
    bp.floor(1, 1, X - 1, Z - 1, 9, p.stoneSlab);
    for (const [x, z] of [[1, 1], [X - 1, 1], [1, Z - 1], [X - 1, Z - 1]]) bp.slab(x, 9, z, 'double', p.stoneSlab);
  }, { roof: 'flat' });

  bp.part('openings', () => {
    // ---------------------------------------------------------------- doors, windows, torches
    bp.door(2, 1, Z, 'south');
    bp.door(X - 2, 1, Z, 'south', { hinge: 'right' });
    for (const z of [0, Z]) for (const x of [2, M, X - 2]) bp.window(x, 7, z, x, 7, z, 'minecraft:iron_bars');
    for (const x of [0, X]) bp.window(x, 7, 2, x, 7, Z - 2, 'minecraft:iron_bars');
    for (const x of [0, X]) bp.window(x, 2, zc, x, 3, zc, 'minecraft:iron_bars');
    for (const x of [3, E]) for (const z of [Z + 1, -1]) bp.torch(x, 3, z, z > 0 ? 'south' : 'north');
  });

  bp.part('ladder', () => {
    // ---------------------------------------------------------------- ladder (west guard room) to the hall
    bp.ladder(1, 1, 1, 5, 'south');
  });

  bp.part('rooms', () => {
    // ---------------------------------------------------------------- rooms
    for (const x of [2, X - 2]) bp.lantern(x, 4, zc, true);
    bp.lantern(M, 4, zc, true); // over the road
    bp.set(2, 1, 1, 'minecraft:barrel', { facing: 'up' });
    bp.set(X - 2, 1, 1, 'minecraft:chest', { facing: 'south' });
    bp.set(X - 1, 1, 1, 'minecraft:barrel', { facing: 'up' });
    bp.set(X - 1, 1, Z - 1, 'minecraft:barrel', { facing: 'up' });
    bp.set(1, 1, Z - 1, 'minecraft:crafting_table');
    bp.ceilingLights(1, 1, X - 1, Z - 1, 8, { spacing: 5 });
    bp.bed(3, 6, 1, 'north', 'blue');
    bp.bed(E, 6, 1, 'north', 'blue');
    bp.table(M, 6, zc);
    bp.chair(M - 1, 6, zc, 'east');
    bp.chair(M + 1, 6, zc, 'west');
    bp.set(X - 1, 6, Z - 1, 'minecraft:chest', { facing: 'west' });
    for (const z of [Z - 3, Z - 2]) if (z >= 1) bp.set(X - 1, 6, z, 'minecraft:bookshelf');
  });

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', M, Z + 1, 180);
  bp.spot('spawn', M, Z + 1, 180);
  bp.camera('overview', [-8, 12, Z + 13], [X / 2, 4, zc]);
  return bp;
}
