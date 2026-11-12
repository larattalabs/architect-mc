// (M5 GP, S-M5-1) A Steward-shaped module program for the given-program tests: a fenced, lit crop field. It stands in for Steward's
// `crop_farm@1` (steward-mc docs/MODULES.md §3.1), which Steward owns; this one is only test data.
//
//   - the core (fixed blocks, never a role): farmland (moisture 7) under every field cell, the crop at its settled (ripe) age;
//   - the shell (from the palette's roles): a path ring, a fence ring on it with a gate in the middle of the front, a lamp on each
//     corner post;
//   - the lot's reserved cells (`reserved`, in the lot's frame: kit/lib/reserved.mjs, e.g. IRR's irrigation lotCells) are left air,
//     so the checker's reserved rule passes for a lot whose cells fall on the field.
//
//   x ->  0 . . . . S+1                 S = side (the field's width and depth)
//   z=0      F F F F F F                fence ring on the path ring (y0 path, y1 fence, a lamp on each corner post at y2)
//   z=1..S   F field . F                y0 farmland, y1 the crop
//   z=S+1    F F G F F F                the front (south): a gate in the middle
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { frameToTemplate } from '../lib/reserved.mjs';

export const id = 'gp_crop_field';

export const params = {
  side: { type: 'int', min: 5, max: 27, default: 9, label: 'Field side' },
  crop: { type: 'enum', options: ['wheat', 'carrots', 'potatoes', 'beetroots'], default: 'wheat', label: 'Crop' },
};

const RIPE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 };

export default function build({ palette = PALETTES.rustic, side = 9, crop = 'wheat', reserved } = {}) {
  const p = palette;
  const W = side + 2;
  const size = [W, 3, W];
  const bp = new Blueprint({
    id,
    name: 'Crop Field',
    description: `A fenced ${side}x${side} ${crop} field with a lamp on each corner.`,
    type: 'crop_field',
    profile: ['no_floating'],
    tags: ['module', 'farm'],
    size,
    groundY: 1,
    front: 'south',
    palette: p,
    approach: false,
  });
  // the reserved cells as template cells (this template is the lot when the lot is W x W)
  const keep = new Set();
  if (reserved) {
    for (const [u, y, v] of reserved.cells) {
      const t = frameToTemplate(u, y, v, { size, groundY: 1, front: 'south' }, reserved);
      if (t) keep.add(t.join(','));
    }
  }
  const put = (x, y, z, block, props) => {
    if (!keep.has(`${x},${y},${z}`)) bp.set(x, y, z, block, props);
  };
  bp.part('field', () => {
    for (let x = 1; x <= side; x++) {
      for (let z = 1; z <= side; z++) {
        put(x, 0, z, 'minecraft:farmland', { moisture: '7' });
        put(x, 1, z, `minecraft:${crop}`, { age: String(RIPE[crop]) });
      }
    }
  });
  bp.part('shell', () => {
    const gate = Math.floor(W / 2);
    for (let i = 0; i < W; i++) {
      for (const [x, z] of [[i, 0], [i, W - 1], [0, i], [W - 1, i]]) {
        put(x, 0, z, p.path);
        if (x === gate && z === W - 1) continue;
        put(x, 1, z, p.fence);
      }
    }
    for (const [x, z] of [[0, 0], [W - 1, 0], [0, W - 1], [W - 1, W - 1]]) put(x, 2, z, p.light);
  });
  // the way in: the gap in the front fence
  bp.spot('entrance', Math.floor(W / 2), W - 1, 180);
  bp.spot('spawn', Math.floor(W / 2), W - 1, 180);
  return bp;
}
