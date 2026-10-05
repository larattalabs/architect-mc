// Cabin massing: the volumes of designs/cabin.mjs (defaults) with its part names. The main room under a gable roof
// (kept in its own part `roof`, as the detail design does), a stone chimney on the east, an open porch on the south.
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';

export const id = 'cabin_massing';

export default function build({ palette: p = PALETTES.rustic } = {}) {
  const bp = new Blueprint({ id, name: 'Log Cabin (massing)', type: 'cabin', size: [11, 12, 12], origin: [1, 0, 1], palette: p, front: 'south' });
  const m = massing(bp);
  m.mass('main', [0, 0, 0, 8, 5, 6], { roof: 'gable', ridge: 'x', roofPart: 'roof' });
  m.opening('main', 'south', [4, 1], [1, 2]); // the front door
  for (const x of [2, 6]) m.opening('main', 'south', [x, 2], [1, 2]); // a window either side (glass)
  for (const face of ['east', 'west']) m.opening('main', face, [3, 2], [1, 2]);
  m.mass('chimney', [9, 0, 3, 9, 11, 3], { wall: 'foundation' });
  // the porch: a deck, two posts, a slab roof against the front wall, and the start of the path
  bp.part('porch', () => {
    bp.floor(1, 7, 7, 9, 0, p.floor);
    bp.floor(3, 10, 5, 10, 0, p.path);
    bp.fill([1, 4, 7, 7, 4, 9], p.roofSlab, { type: 'bottom' });
  });
  m.stilts('porch', [1, 1, 9, 7, 3, 9], 6);
  bp.spot('entrance', 4, 7, 180);
  bp.spot('spawn', 4, 10, 180);
  return bp;
}
