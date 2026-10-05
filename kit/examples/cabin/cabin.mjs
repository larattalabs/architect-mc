// Cabin: a one-room log cabin with a covered porch, a gable roof and a stone chimney.
//
//   x ->  -1 0 1 . . . X X+1          (defaults: width 9 -> X = 8, depth 7 -> Z = 6)
//   z=-1   roof overhang (north eave)
//   z=0      L = = = = = = = L        north wall (window pair), bed + chest inside
//   z=1..Z-1 |   room          | C    C = chimney through the east overhang (x=X+1)
//   z=Z      L = W = D = W = L        south wall (front): door in the middle, a window either side
//   z=Z+1..Z+3 porch deck, posts at z=Z+3, railings on the sides (porch: false = just a path)
//   z=Z+4          path (spawn)
//
// Rows: y0 floor (stone sill under the walls, planks inside), y1..4 log walls (horizontal logs, stripped-log corner
// posts), y5 the top plate (log beams) and the ceiling, y5.. the gable roof (pitch 1, 1-cell overhang), the chimney
// one row above the ridge with a campfire for smoke. Feet row = groundY = 1. Design coordinates are relative to the
// walls; the template origin is shifted by (1,0,1) for the overhang. Every material comes from the palette.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'cabin';

export const params = {
  width: { type: 'int', min: 7, max: 13, default: 9, label: 'Width' },
  depth: { type: 'int', min: 6, max: 9, default: 7, label: 'Depth' },
  porch: { type: 'bool', default: true, label: 'Porch' },
};

export default function build({ palette = PALETTES.rustic, width = 9, depth = 7, porch = true } = {}) {
  const p = palette;
  const X = width - 1; // east wall
  const Z = depth - 1; // south (front) wall
  const D = Math.floor(X / 2); // the door column
  const mid = Math.floor(Z / 2); // the middle row (side and gable windows, the chimney)
  const ridge = 5 + Math.floor((Z + 2) / 2); // the roof's top row (eaves on row 5, pitch 1, overhang -1..Z+1)
  const front = porch ? Z + 4 : Z + 2; // the last row of the template (the path)
  const bp = new Blueprint({
    id,
    name: 'Log Cabin',
    description: `A one-room log cabin${porch ? ' with a covered porch' : ''}, a gable roof and a stone chimney.`,
    type: 'cabin',
    tags: ['rustic', 'small', ...(porch ? ['porch'] : []), 'chimney'],
    size: [X + 3, ridge + 3, front + 2],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, X - 1, 4, Z - 1],
    approach: { length: 4, width: 3 },
  });

  bp.part('main', () => {
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
  });

  bp.part('openings', () => {
    // ---------------------------------------------------------------- door + windows
    bp.door(D, 1, Z, 'south');
    const north = X >= 10 ? [2, D, X - 2] : [2, X - 2];
    for (const x of [2, X - 2]) bp.window(x, 2, Z, x, 3, Z);
    for (const x of north) bp.window(x, 2, 0, x, 3, 0);
    for (const x of [0, X]) bp.window(x, 2, mid, x, 3, mid);
    // flower boxes under the front windows
    for (const x of [2, X - 2]) bp.set(x, 1, Z + 1, p.trapdoor, { facing: 'south', half: 'top', open: 'false' });
  });

  bp.part('roof', () => {
    // ---------------------------------------------------------------- roof
    bp.roofGable(-1, -1, X + 1, Z + 1, 5, { ridge: 'x', pitch: 1, gable: p.planks, gableInset: 1, gableFrom: 6 });
    // a small window in each gable
    for (const x of [0, X]) bp.window(x, 7, mid, x, 7, mid);
  });

  bp.part('chimney', () => {
    // ---------------------------------------------------------------- chimney (east side, through the overhang)
    bp.chimney(X + 1, mid, 0, ridge + 1, { block: p.stone });
  });

  bp.part('porch', () => {
    // ---------------------------------------------------------------- porch, or a step and a path
    if (porch) {
      bp.porch(1, Z + 1, X - 1, Z + 3, {
        roofY: 4, deck: p.planks, posts: [[1, Z + 3], [X - 1, Z + 3]], post: p.log,
        roof: p.slab, rail: p.fence, railSides: ['west', 'east'],
      });
      bp.lantern(D, 3, Z + 2, true);
    }
    bp.floor(D - 1, front, D + 1, front, 0, p.path); // the start of the path
    if (!porch) bp.floor(D, Z + 1, D, front, 0, p.path);
  });

  bp.part('furnishings', () => {
    // ---------------------------------------------------------------- inside
    if (X - 4 >= 3) bp.rug(2, 2, X - 4, Z - 2, 1, { fill: 'minecraft:red_carpet', border: 'minecraft:brown_carpet' });
    bp.bed(1, 1, 1, 'north', 'red');
    bp.set(2, 1, 1, 'minecraft:chest', { facing: 'south' });
    bp.set(X - 1, 1, 1, 'minecraft:crafting_table');
    bp.set(X - 2, 1, 1, 'minecraft:furnace', { facing: 'south' });
    bp.set(X - 1, 1, 2, 'minecraft:barrel', { facing: 'up' });
    bp.table(X - 2, 1, Z - 2);
    bp.chair(X - 3, 1, Z - 2, 'east');
    bp.chair(X - 1, 1, Z - 2, 'west');
    bp.set(1, 1, Z - 1, 'minecraft:bookshelf');
    bp.plant(1, 2, Z - 1);
    bp.ceilingLights(1, 1, X - 1, Z - 1, 4);
  });

  // ---------------------------------------------------------------- anchors
  bp.spot('entrance', D, Z + 1, 180);
  bp.spot('spawn', D, front, 180);
  bp.camera('overview', [-8, 10, Z + 12], [X / 2, 3, Z / 2]);
  bp.camera('interior', [X - 1.5, 2.6, Z - 1.5], [1.5, 1.5, 1.5]);
  return bp;
}
