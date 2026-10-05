// Tower: a stone watchtower, floors joined by a ladder, crowned by an open lookout under a hip roof or by battlements.
//
//   x ->  -1 0 1 . C . N N+1          (defaults: width 7 -> N = 6, C = 3)
//   z=0      S S S S S S S        north wall; the ladder hangs on its inside at x=C (z=1), up to the deck
//   z=1..N-1 S   room     S       one room per floor: feet rows 1, 6, 11, ... (floors on rows 0, 5, 10, ...)
//   z=N      S S S D S S S        south wall (front): iron door at x=C with a button on each side of the jamb x=C+1
//   z=N+1..N+3     landing + path (entrance z=N+1, spawn z=N+3)
//
// Rows (F = floors): y0 floor, y1..5F-1 stone walls (a stair plinth on row 1, a band of trim stone where each upper
// floor is), y5F the lookout deck. roof 'hip': log posts and railings on rows 5F+1..5F+3, a hip roof with a 1-cell
// overhang from row 5F+4 and a lightning rod on the peak. roof 'battlements': a crenellated parapet with lanterns on
// the corner merlons. Narrow windows on every floor. Feet row = groundY = 1; the origin is shifted by (1,0,1) for the
// plinth and the roof overhang. Every material comes from the palette.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'tower';

export const params = {
  floors: { type: 'int', min: 3, max: 6, default: 3, label: 'Floors' },
  width: { type: 'int', min: 5, max: 9, default: 7, label: 'Width' },
  roof: { type: 'enum', options: ['hip', 'battlements'], default: 'hip', label: 'Roof' },
};

export default function build({ palette: p = PALETTES.fortress, floors = 3, width = 7, roof = 'hip' } = {}) {
  const N = width - 1; // east / south wall index (walls 0..N)
  const C = Math.floor(N / 2); // the door / ladder column
  const deck = 5 * floors; // the lookout deck row
  const rise = Math.floor((N + 2) / 2); // hip roof courses above its eaves (overhang -1..N+1)
  const top = roof === 'hip' ? deck + 4 + rise + 1 : deck + 4; // the highest row (lightning rod / corner lanterns)
  const bp = new Blueprint({
    id,
    name: 'Watchtower',
    description: `A stone watchtower: ${floors} floors joined by a ladder and ${roof === 'hip' ? 'an open lookout under a hip roof' : 'a battlemented roof'}.`,
    type: 'tower',
    tags: ['medieval', 'stone', roof === 'hip' ? 'lookout' : 'battlements'],
    size: [N + 3, top + 1, N + 5],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, N - 1, deck - 1, N - 1],
    approach: { length: 4, width: 3 },
  });

  bp.part('shaft', () => {
    // ---------------------------------------------------------------- shell, floors
    bp.floor(0, 0, N, N, 0, p.stone);
    bp.carve([1, 1, 1, N - 1, deck - 1, N - 1]);
    bp.walls(0, 0, N, N, 1, deck - 1, { block: p.stone, corners: p.stone });
    for (let y = 5; y < deck; y += 5) {
      bp.walls(0, 0, N, N, y, y, { block: p.stoneTrim, corners: p.stoneTrim }); // band where the floors are
      bp.floor(1, 1, N - 1, N - 1, y, p.planks);
    }
    bp.floor(0, 0, N, N, deck, p.stone); // lookout deck
    // plinth: stone stairs around the foot of the walls
    for (let i = 0; i <= N; i++) {
      bp.stairs(i, 1, -1, 'south', { block: p.stoneStairs });
      bp.stairs(-1, 1, i, 'east', { block: p.stoneStairs });
      bp.stairs(N + 1, 1, i, 'west', { block: p.stoneStairs });
      if (i < C - 1 || i > C + 1) bp.stairs(i, 1, N + 1, 'north', { block: p.stoneStairs });
    }
    for (const [x, z, f, shape] of [[-1, -1, 'south', 'outer_right'], [N + 1, -1, 'south', 'outer_left'], [-1, N + 1, 'north', 'outer_left'], [N + 1, N + 1, 'north', 'outer_right']]) {
      bp.stairs(x, 1, z, f, { block: p.stoneStairs, shape });
    }
  });

  bp.part('openings', () => {
    // ---------------------------------------------------------------- door, windows
    bp.ironDoor(C, 1, N, 'south', { buttonSide: 1, jamb: p.stone });
    for (let f = 0; f < floors; f++) {
      const y = 5 * f + 2;
      for (const x of [0, N]) bp.window(x, y, C, x, y + 1, C);
      if (f === 0) continue;
      bp.window(C, y, N, C, y + 1, N);
      for (const x of [C - 1, C + 1]) bp.window(x, y, 0, x, y, 0);
    }
  });

  bp.part('fittings', () => {
    // ---------------------------------------------------------------- ladder (inside the north wall) up to the deck
    bp.ladder(C, 1, 1, deck, 'south');

    // ---------------------------------------------------------------- lights: a lantern under each ceiling
    for (let y = 4; y < deck; y += 5) bp.lantern(C, y, C, true);
  });

  bp.part('crown', () => {
    // ---------------------------------------------------------------- the crown
    if (roof === 'hip') {
      for (const [x, z] of [[0, 0], [N, 0], [0, N], [N, N]]) bp.post(x, z, deck + 1, deck + 3, p.log);
      for (let i = 1; i < N; i++) {
        bp.set(i, deck + 1, 0, p.fence);
        bp.set(i, deck + 1, N, p.fence);
        bp.set(0, deck + 1, i, p.fence);
        bp.set(N, deck + 1, i, p.fence);
      }
      bp.roofHip(-1, -1, N + 1, N + 1, deck + 4);
      bp.set(C, top, C, 'minecraft:lightning_rod', { facing: 'up' });
      bp.fill([C, deck + 4, C, C, deck + 2 + rise, C], 'minecraft:iron_chain', { axis: 'y' });
      bp.lantern(C, deck + 3, C, true);
    } else {
      // a parapet ring, merlons on every other cell, taller corner merlons with a lantern on each
      for (let i = 0; i <= N; i++) {
        for (const [x, z] of [[i, 0], [i, N], [0, i], [N, i]]) {
          bp.set(x, deck + 1, z, p.stone);
          if ((x + z) % 2 === 0) bp.set(x, deck + 2, z, p.stone);
        }
      }
      for (const [x, z] of [[0, 0], [N, 0], [0, N], [N, N]]) {
        bp.post(x, z, deck + 2, deck + 3, p.stoneTrim);
        bp.lantern(x, deck + 4, z);
      }
    }
  }, { roof: roof === 'hip' ? 'hip' : 'flat' });

  bp.part('landing', () => {
    // ---------------------------------------------------------------- landing + path
    bp.floor(C - 1, N + 1, C + 1, N + 3, 0, p.stone);
    bp.floor(C, N + 1, C, N + 3, 0, p.path);
  });

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', C, N + 1, 180);
  bp.spot('spawn', C, N + 3, 180);
  bp.camera('overview', [-9, deck - 1, N + 14], [C, deck - 5, C]);
  bp.camera('lookout', [1.5, deck + 2.6, 1.5], [10, deck - 3, 10]);
  return bp;
}
