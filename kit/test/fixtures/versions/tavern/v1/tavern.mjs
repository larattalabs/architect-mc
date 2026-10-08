// Tavern, hand-written version 1 of the phase 5b fixture chain (docs/CONTRACT.md "Phase 5b gate" item 2;
// kit/tools/delta-fixtures.mjs builds them, the in-game gate installs them with dev.entry.installVersion).
// v1: the kit tavern with its parts renamed for deltas (main, porch, roof, taproom, stairs, guest_rooms); a porch replaces the awning.
// Like kit/designs/tavern.mjs: a two-storey timber-framed inn, every material from the palette.
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'tavern';

export const params = {
  length: { type: 'int', min: 12, max: 18, default: 14, label: 'Length' },
  roof: { type: 'enum', options: ['gable', 'hip'], default: 'gable', label: 'Roof' },
  chimney: { type: 'bool', default: true, label: 'Chimney' },
};

export default function build({ palette: p = PALETTES.rustic, length = 14, roof = 'gable', chimney = true } = {}) {
  const X = length - 1; // east wall
  const Z = 8; // south wall
  const D = Math.floor((X - 1) / 2); // the double door: x = D, D+1
  const frame = p.accentLog;
  const infill = p.plaster;
  const ridge = 10 + Math.floor((Z + 2) / 2);
  const bp = new Blueprint({
    id,
    name: 'The Crooked Tankard',
    description: 'A two-storey timber-framed tavern (fixture version 1).',
    type: 'tavern',
    tags: ['medieval', 'timber-frame', 'fixture'],
    size: [X + 6, (chimney ? ridge + 2 : ridge) + 1, 13],
    origin: [1, 0, 1],
    groundY: 1,
    front: 'south',
    palette: p,
    interior: [1, 1, 1, X - 1, 9, Z - 1],
    approach: { length: 3, width: 3 },
  });

  bp.part('main', () => {
    // ground storey (stone)
    bp.floor(0, 0, X, Z, 0, p.stone);
    bp.floor(1, 1, X - 1, Z - 1, 0, p.planks);
    bp.carve([1, 1, 1, X - 1, 4, Z - 1]);
    bp.walls(0, 0, X, Z, 1, 4, { block: p.stone, corners: p.log });
    bp.floor(1, 1, X - 1, Z - 1, 5, p.planks);
    bp.beam(0, 5, 0, X, 0, frame);
    bp.beam(0, 5, Z, X, Z, frame);
    bp.beam(0, 5, 1, 0, Z - 1, frame);
    bp.beam(X, 5, 1, X, Z - 1, frame);
    // upper storey (timber frame)
    bp.carve([1, 6, 1, X - 1, 9, Z - 1]);
    bp.walls(0, 0, X, Z, 6, 9, { block: infill, corners: frame });
    for (const x of [3, D, D + 1, X - 3]) for (const z of [0, Z]) bp.post(x, z, 6, 9, frame);
    for (const z of [3, 5]) for (const x of [0, X]) bp.post(x, z, 6, 9, frame);
    bp.beam(0, 10, 0, X, 0, frame);
    bp.beam(0, 10, Z, X, Z, frame);
    bp.beam(0, 10, 1, 0, Z - 1, frame);
    bp.beam(X, 10, 1, X, Z - 1, frame);
    bp.floor(1, 1, X - 1, Z - 1, 10, p.planks);
    // doors and windows
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
  });

  bp.part('porch', () => {
    // a covered porch in front of the door: a plank deck, two posts, a slab roof
    bp.porch(D - 2, Z + 1, D + 3, Z + 2, { roofY: 4, posts: [[D - 2, Z + 2], [D + 3, Z + 2]] });
    for (const x of [D - 2, D + 3]) bp.torch(x, 3, Z + 1, 'south');
  });

  bp.part('roof', () => {
    const m = {};
    if (roof === 'gable') {
      bp.roofGable(-1, -1, X + 1, Z + 1, 10, { ridge: 'x', pitch: 1, gable: infill, gableInset: 1, gableFrom: 11, ...m });
      for (const x of [0, X]) {
        bp.post(x, 4, 11, 13, frame);
        bp.window(x, 12, 3, x, 12, 3);
        bp.window(x, 12, 5, x, 12, 5);
      }
    } else {
      bp.roofHip(-1, -1, X + 1, Z + 1, 10, m.stairs ? { stairs: m.stairs, top: m.full, lining: m.lining } : {});
    }
    if (chimney) bp.chimney(X + 1, 4, 0, ridge + 1, { block: p.stone });
  }, { roof });

  bp.part('taproom', () => {
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
    bp.stairRun(1, 1, 7, 'north', 5);
    for (const z of [4, 5]) bp.set(2, 6, z, p.fence);
    bp.set(1, 6, 6, p.fence);
    bp.set(2, 6, 6, p.fence);
  });

  bp.part('guest_rooms', () => {
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

  // gate item 2 "shape updates": a fence and a glass pane that stand where v2's wing_east adds a wall (z 7) and v5 takes it away
  bp.part('yard', () => {
    bp.set(X + 4, 0, 8, p.stone);
    bp.set(X + 3, 0, 8, p.stone);
    bp.set(X + 4, 1, 8, p.fence);
    bp.set(X + 3, 1, 8, 'minecraft:glass_pane');
    // a free-standing gate door that v2 re-materials (oak -> spruce): an opened one still counts as the site's (gate item 2)
    bp.set(X + 1, 0, 9, p.stone);
    bp.door(X + 1, 1, 9, 'south', { block: 'minecraft:oak_door' });
  });

  // the path and the anchors (in no part)
  bp.floor(D, Z + 3, D + 1, Z + 3, 0, p.path);
  bp.spot('entrance', D, Z + 1, 180);
  bp.spot('spawn', D + 1, Z + 3, 180);
  bp.camera('overview', [-9, 14, Z + 16], [X / 2, 5, 4]);
  return bp;
}
