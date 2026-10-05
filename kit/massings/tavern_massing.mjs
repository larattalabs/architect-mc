// Tavern massing: the volumes of designs/tavern.mjs (defaults) with its part names. A stone ground storey, a plaster
// upper storey under a gable roof (part `roof`, with the chimney on the east end), a double door on the south.
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';

export const id = 'tavern_massing';

export default function build({ palette: p = PALETTES.rustic } = {}) {
  const bp = new Blueprint({ id, name: 'The Crooked Tankard (massing)', type: 'tavern', size: [16, 17, 12], origin: [1, 0, 1], palette: p, front: 'south' });
  const m = massing(bp);
  m.mass('ground_storey', [0, 0, 0, 13, 5, 8], { wall: 'foundation' });
  m.opening('ground_storey', 'south', [6, 1], [2, 2]); // the double door
  m.mass('upper_storey', [0, 6, 0, 13, 10, 8], { wall: 'wall_alt', roof: 'gable', ridge: 'x', roofPart: 'roof' });
  bp.part('roof', () => bp.fill([14, 0, 4, 14, 16, 4], p.foundation)); // the chimney, up through the east overhang
  bp.floor(5, 9, 8, 10, 0, p.path);
  bp.spot('entrance', 6, 9, 180);
  bp.spot('spawn', 7, 10, 180);
  return bp;
}
