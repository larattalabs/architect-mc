// Tavern: a two-storey timber-framed inn. A stone taproom with a bar and tables below, guest beds above, a gable or
// hip roof, a chimney, a double door under a little awning.
//
//   x ->  -1 0 1 . . D D+1 . . X X+1          (defaults: length 14 -> X = 13, D = 6)
//   z=0      north wall: bar back (barrels), beds upstairs
//   z=1..7   taproom; stairs up along the west wall (x=1, climbing north from z=7 to z=3)
//   z=8      south wall (front): double door at x=D..D+1, windows either side
//   z=9..10  awning + path (entrance z=9, spawn z=10)
//
// Rows: y0 floor, y1..4 stone ground storey, y5 the upper floor (log beams outside), y6..9 timber frame (the
// palette's accent logs, plaster infill), y10 the top plate / ceiling, y10.. the roof (pitch 1, 1-cell overhang), the
// chimney (x=X+1) one row above the ridge. Every material comes from the palette.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'tavern';

export const params = {
  length: { type: 'int', min: 12, max: 18, default: 14, label: 'Length' },
  roof: { type: 'enum', options: ['gable', 'hip'], default: 'gable', label: 'Roof' },
  chimney: { type: 'bool', default: true, label: 'Chimney' },
};

export default function build({ palette: p = PALETTES.rustic, length = 14, roof = 'gable', chimney = true } = {}) {
  const X = length - 1; // east wall
  const Z = 8; // south (front) wall
  const D = Math.floor((X - 1) / 2); // the double door: x = D, D+1
  const frame = p.accentLog;
  const infill = p.plaster;
  const ridge = 10 + Math.floor((Z + 2) / 2); // the roof's top row (both roof forms)
  const bp = new Blueprint({
    id,
    name: 'The Crooked Tankard',
    description: `A two-storey timber-framed tavern: a stone taproom with a bar and tables, guest beds upstairs${chimney ? ', a chimney' : ''}.`,
    type: 'tavern',
    tags: ['medieval', 'timber-frame', 'two-storey', ...(chimney ? ['chimney'] : [])],
    size: [X + 3, (chimney ? ridge + 2 : ridge) + 1, 12],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, X - 1, 9, Z - 1],
    approach: { length: 4, width: 3 },
  });

  bp.part('ground_storey', () => {
    // ---------------------------------------------------------------- ground storey (stone)
    bp.floor(0, 0, X, Z, 0, p.stone);
    bp.floor(1, 1, X - 1, Z - 1, 0, p.planks);
    bp.carve([1, 1, 1, X - 1, 9, Z - 1]);
    bp.walls(0, 0, X, Z, 1, 4, { block: p.stone, corners: p.log });
    // upper floor + beams
    bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);
    bp.beam(0, 5, 0, X, 0, frame);
    bp.beam(0, 5, Z, X, Z, frame);
    bp.beam(0, 5, 1, 0, Z - 1, frame);
    bp.beam(X, 5, 1, X, Z - 1, frame);
  });
  bp.part('upper_storey', () => {
    // ---------------------------------------------------------------- upper storey (timber frame)
    bp.walls(0, 0, X, Z, 6, 9, { block: infill, corners: frame });
    for (const x of [3, D, D + 1, X - 3]) for (const z of [0, Z]) bp.post(x, z, 6, 9, frame);
    for (const z of [3, 5]) for (const x of [0, X]) bp.post(x, z, 6, 9, frame);
    bp.beam(0, 10, 0, X, 0, frame);
    bp.beam(0, 10, Z, X, Z, frame);
    bp.beam(0, 10, 1, 0, Z - 1, frame);
    bp.beam(X, 10, 1, X, Z - 1, frame);
    bp.floor(1, 1, X - 1, Z - 1, 10, p.planks);
  });

  bp.part('openings', () => {
    // ---------------------------------------------------------------- doors + windows
    bp.doubleDoor(D, 1, Z, 'south');
    bp.set(D, 3, Z, p.log, { axis: 'x' });
    bp.set(D + 1, 3, Z, p.log, { axis: 'x' });
    for (const [a, b] of [[2, D - 3], [D + 4, X - 2]]) bp.window(a, 2, Z, b, 3, Z);
    for (const [a, b] of [[4, D - 1], [D + 2, X - 4], [1, 2], [X - 2, X - 1]]) {
      bp.window(a, 7, Z, b, 8, Z);
      bp.window(a, 7, 0, b, 8, 0);
    }
    for (const x of [0, X]) {
      bp.window(x, 2, 3, x, 3, 5);
      bp.window(x, 7, 4, x, 8, 4);
    }
    bp.window(4, 2, 0, X - 4, 3, 0); // behind the bar
    // awning over the door with torches
    for (let x = D - 1; x <= D + 2; x++) bp.stairs(x, 4, Z + 1, 'north', { block: p.accentStairs });
    for (const x of [D - 2, D + 3]) bp.torch(x, 3, Z + 1, 'south');
  });

  bp.part('roof', () => {
    // ---------------------------------------------------------------- roof + chimney
    if (roof === 'gable') {
      bp.roofGable(-1, -1, X + 1, Z + 1, 10, { ridge: 'x', pitch: 1, gable: infill, gableInset: 1, gableFrom: 11 });
      for (const x of [0, X]) {
        bp.post(x, 4, 11, 13, frame);
        bp.window(x, 12, 3, x, 12, 3);
        bp.window(x, 12, 5, x, 12, 5);
      }
    } else {
      bp.roofHip(-1, -1, X + 1, Z + 1, 10);
    }
    if (chimney) bp.chimney(X + 1, 4, 0, ridge + 1, { block: p.stone });
  });

  bp.part('taproom', () => {
    // ---------------------------------------------------------------- taproom
    // the bar: a counter of top slabs on barrels in front of a barrel wall
    for (let x = 4; x <= X - 4; x++) {
      bp.set(x, 1, 2, 'minecraft:barrel', { facing: 'south' });
      bp.slab(x, 2, 2, 'top', p.accentSlab);
      bp.set(x, 1, 1, 'minecraft:barrel', { facing: 'south' });
    }
    bp.set(X - 3, 1, 2, p.accentPlanks);
    bp.slab(X - 3, 2, 2, 'top', p.accentSlab);
    bp.set(X - 3, 1, 1, 'minecraft:barrel', { facing: 'up' });
    bp.air(X - 3, 2, 1);
    bp.candle(5, 3, 2, 3);
    bp.candle(X - 5, 3, 2, 2);
    for (let x = 4; x <= X - 5; x += 2) bp.chair(x, 1, 3, 'north');
    // tables
    for (const [tx, tz] of [[4, 6], [X - 4, 6], [X - 2, 4]]) {
      bp.table(tx, 1, tz);
      bp.chair(tx - 1, 1, tz, 'east');
      bp.chair(tx + 1, 1, tz, 'west');
    }
    bp.set(X - 1, 1, 1, 'minecraft:crafting_table');
    bp.set(X - 1, 1, Z - 1, 'minecraft:barrel', { facing: 'up' });
    bp.ceilingLights(2, 1, X - 1, Z - 1, 4, { spacing: 5 });
  });

  bp.part('stairs', () => {
    // ---------------------------------------------------------------- stairs up (west wall) + railing
    bp.stairRun(1, 1, 7, 'north', 5);
    for (const z of [4, 5]) bp.set(2, 6, z, p.fence);
    bp.set(1, 6, 6, p.fence);
    bp.set(2, 6, 6, p.fence);
  });

  bp.part('guest_rooms', () => {
    // ---------------------------------------------------------------- guest rooms upstairs
    const beds = [];
    for (let x = 4; x + 1 <= X - 2; x += 3) beds.push(x);
    beds.forEach((x, i) => {
      bp.bed(x, 6, 1, 'north', i % 2 ? 'green' : 'red');
      bp.set(x + 1, 6, 1, 'minecraft:chest', { facing: 'south' });
      if (i < beds.length - 1) bp.lantern(x + 1, 7, 1);
    });
    bp.rug(5, 4, X - 3, 6, 6, { fill: 'minecraft:green_carpet', border: 'minecraft:brown_carpet' });
    bp.set(X - 1, 6, Z - 1, 'minecraft:bookshelf');
    bp.plant(X - 1, 7, Z - 1, 'minecraft:potted_red_tulip');
    bp.ceilingLights(3, 1, X - 1, Z - 1, 9, { spacing: 5 });
  });

  // ---------------------------------------------------------------- path + anchors
  bp.floor(D - 1, Z + 1, D + 2, Z + 2, 0, p.stone);
  bp.floor(D, Z + 1, D + 1, Z + 2, 0, p.path);
  bp.spot('entrance', D, Z + 1, 180);
  bp.spot('spawn', D + 1, Z + 2, 180);
  bp.camera('overview', [-9, 14, Z + 16], [X / 2, 5, 4]);
  bp.camera('taproom', [X - 1.5, 2.6, 6.5], [5, 1.5, 2]);
  return bp;
}
