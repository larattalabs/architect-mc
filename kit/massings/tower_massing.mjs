// Tower massing: the volumes of designs/tower.mjs (defaults) with its part names. A stone shaft of three storeys, an
// open lookout crown under a hip roof, a landing in front of the door.
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';

export const id = 'tower_massing';

export default function build({ palette: p = PALETTES.fortress } = {}) {
  const bp = new Blueprint({ id, name: 'Watchtower (massing)', type: 'tower', size: [9, 24, 11], origin: [1, 0, 1], palette: p, front: 'south' });
  const m = massing(bp);
  m.mass('shaft', [0, 0, 0, 6, 15, 6], { wall: 'foundation', storeys: 3 });
  m.opening('shaft', 'south', [3, 1], [1, 2]);
  m.mass('crown', [0, 16, 0, 6, 19, 6], { roof: 'hip' });
  for (const face of ['north', 'south', 'east', 'west']) m.opening('crown', face, [1, 17], [5, 2], { kind: 'arch' }); // the open lookout
  bp.part('landing', () => bp.floor(2, 7, 4, 9, 0, p.path));
  bp.spot('entrance', 3, 7, 180);
  bp.spot('spawn', 3, 9, 180);
  return bp;
}
