// Tower: a stone watchtower, three floors joined by a ladder, an open lookout under a hip roof.
//
//   x ->  -1 0 1 2 3 4 5 6 7
//   z=0      S S S S S S S        north wall; the ladder hangs on its inside at x=3 (z=1), rows 1..15
//   z=1..5   S   5 x 5    S       three floors: feet rows 1, 6, 11 (floors on rows 0, 5, 10), lanterns overhead
//   z=6      S S S D S S S        south wall (front): iron door at x=3 with a button on each side of the jamb x=4
//   z=7..9         landing + path (entrance z=7, spawn z=9)
//
// Rows: y0 floor, y1..14 stone walls (a stair plinth on row 1, string courses of the stone's slab... no: a band of
// polished stone on rows 5 and 10, where the floors are), y15 the lookout deck, y16 railings between log posts
// (rows 16..18), y19..23 a hip roof with a 1-cell overhang, a lightning rod on the peak. Narrow windows on every
// floor. Feet row = groundY = 1; the origin is shifted by (1,0,1) for the plinth and the roof overhang.
import { Blueprint, palette } from '../lib/kit.mjs';

export const id = 'tower';

export default function build({ palette: p = palette({ wood: 'spruce', stone: 'stone_bricks', roof: 'deepslate_tiles' }) } = {}) {
  const N = 6; // east / south wall index (walls 0..6)
  const bp = new Blueprint({
    id,
    name: 'Watchtower',
    description: 'A stone watchtower: three floors joined by a ladder and an open lookout under a slate hip roof.',
    type: 'tower',
    tags: ['medieval', 'stone', 'lookout'],
    size: [9, 25, 11],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, N - 1, 14, N - 1],
    approach: { length: 4, width: 3 },
  });
  const band = p.stone === 'minecraft:stone_bricks' ? 'minecraft:polished_andesite' : p.stone;

  // ---------------------------------------------------------------- shell, floors
  bp.floor(0, 0, N, N, 0, p.stone);
  bp.carve([1, 1, 1, N - 1, 14, N - 1]);
  bp.walls(0, 0, N, N, 1, 14, { block: p.stone, corners: p.stone });
  for (const y of [5, 10]) {
    bp.walls(0, 0, N, N, y, y, { block: band, corners: band }); // band where the floors are
    bp.floor(1, 1, N - 1, N - 1, y, p.planks);
  }
  bp.floor(0, 0, N, N, 15, p.stone); // lookout deck
  // plinth: stone stairs around the foot of the walls
  for (let i = 0; i <= N; i++) {
    bp.stairs(i, 1, -1, 'south', { block: p.stoneStairs });
    bp.stairs(-1, 1, i, 'east', { block: p.stoneStairs });
    bp.stairs(N + 1, 1, i, 'west', { block: p.stoneStairs });
    if (i < 2 || i > 4) bp.stairs(i, 1, N + 1, 'north', { block: p.stoneStairs });
  }
  for (const [x, z, f, shape] of [[-1, -1, 'south', 'outer_right'], [N + 1, -1, 'south', 'outer_left'], [-1, N + 1, 'north', 'outer_left'], [N + 1, N + 1, 'north', 'outer_right']]) {
    bp.stairs(x, 1, z, f, { block: p.stoneStairs, shape });
  }

  // ---------------------------------------------------------------- door, windows
  bp.ironDoor(3, 1, N, 'south', { buttonSide: 1, jamb: p.stone });
  for (const y of [7, 12]) bp.window(3, y, N, 3, y + 1, N);
  for (const y of [2, 7, 12]) for (const x of [0, N]) bp.window(x, y, 3, x, y + 1, 3);
  for (const y of [7, 12]) for (const x of [2, 4]) bp.window(x, y, 0, x, y, 0);

  // ---------------------------------------------------------------- ladder (inside the north wall) up to the deck
  bp.ladder(3, 1, 1, 15, 'south');

  // ---------------------------------------------------------------- lights: a lantern under each ceiling
  for (const y of [4, 9, 14]) bp.lantern(3, y, 3, true);

  // ---------------------------------------------------------------- lookout: posts, railings, hip roof
  for (const [x, z] of [[0, 0], [N, 0], [0, N], [N, N]]) bp.post(x, z, 16, 18, p.log);
  for (let i = 1; i < N; i++) {
    bp.set(i, 16, 0, p.fence);
    bp.set(i, 16, N, p.fence);
    bp.set(0, 16, i, p.fence);
    bp.set(N, 16, i, p.fence);
  }
  bp.roofHip(-1, -1, N + 1, N + 1, 19);
  bp.set(3, 24, 3, 'minecraft:lightning_rod', { facing: 'up' });
  bp.fill([3, 19, 3, 3, 21, 3], 'minecraft:iron_chain', { axis: 'y' });
  bp.lantern(3, 18, 3, true);

  // ---------------------------------------------------------------- landing + path
  bp.floor(2, N + 1, 4, N + 3, 0, p.stone);
  bp.floor(3, N + 1, 3, N + 3, 0, p.path);

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', 3, N + 1, 180);
  bp.spot('spawn', 3, N + 3, 180);
  bp.camera('overview', [-9, 14, N + 14], [3, 10, 3]);
  bp.camera('lookout', [1.5, 17.6, 1.5], [10, 12, 10]);
  return bp;
}
