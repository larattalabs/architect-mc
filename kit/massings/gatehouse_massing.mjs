// Gatehouse massing: the volumes of designs/gatehouse.mjs (defaults) with its part names. One stone block over the
// road with a 3-wide passage through it, a flat crenellated roof (part `roof`), the road running out of both mouths.
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';

export const id = 'gatehouse_massing';

export default function build({ palette: p = PALETTES.fortress } = {}) {
  const bp = new Blueprint({ id, name: 'Gatehouse (massing)', type: 'gatehouse', size: [11, 12, 10], origin: [0, 0, 2], palette: p, front: 'south' });
  const m = massing(bp);
  m.mass('main', [0, 0, 0, 10, 8, 6], { wall: 'foundation', roof: 'flat', roofPart: 'roof', crenels: true });
  for (const face of ['south', 'north']) m.opening('main', face, [4, 1], [3, 4], { kind: 'arch' }); // the passage
  bp.part('main', () => bp.floor(4, -2, 6, 7, 0, p.path)); // the road through
  bp.spot('entrance', 5, 7, 180);
  bp.spot('spawn', 5, 7, 180);
  return bp;
}
