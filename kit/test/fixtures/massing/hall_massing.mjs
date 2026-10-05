// Test fixture (test/massing.test.mjs): a massing with a hall under a gable roof (part `roof`) and a corner tower under a
// hip roof. hall_bad.mjs is a deliberately non-conforming "detail" of it.
import { Blueprint, PALETTES } from '../../../lib/kit.mjs';
import { massing } from '../../../lib/massing.mjs';

export const id = 'hall_massing';

export default function build({ palette: p = PALETTES.oak } = {}) {
  const bp = new Blueprint({ id, type: 'house', size: [15, 15, 9], origin: [1, 0, 1], palette: p });
  const m = massing(bp);
  m.mass('hall', [0, 0, 0, 8, 5, 6], { roof: 'gable', ridge: 'x', roofPart: 'roof' });
  m.opening('hall', 'south', [4, 1], [1, 2]);
  m.mass('tower', [9, 0, 0, 12, 12, 3], { roof: 'hip', wall: 'foundation' });
  bp.spot('entrance', 4, 7, 180);
  bp.spot('spawn', 4, 7, 180);
  return bp;
}
