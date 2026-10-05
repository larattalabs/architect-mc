// Test fixture (test/massing.test.mjs): a deliberately NON-conforming detail of hall_massing.mjs, one of each problem:
//   - part 'tower' is missing (an issue)
//   - part 'hall' runs 2 further east than the massing's (an issue: box off by more than 1)
//   - part 'roof' records a hip roof where the massing has a gable (an issue)
//   - the template is 18 wide against the massing's 15 (an ERROR: over the massing's size + 2) and 10 tall against 15
//     (an issue: more than 2 under)
import { Blueprint, PALETTES } from '../../../lib/kit.mjs';

export const id = 'hall_bad';

export default function build({ palette: p = PALETTES.oak } = {}) {
  const bp = new Blueprint({ id, type: 'custom', size: [18, 10, 9], origin: [1, 0, 1], palette: p });
  bp.part('hall', () => {
    bp.floor(0, 0, 10, 6, 0, p.stone);
    bp.carve([1, 1, 1, 9, 4, 5]);
    bp.walls(0, 0, 10, 6, 1, 5);
    bp.door(4, 1, 6, 'south');
    bp.lantern(4, 4, 3, true);
  });
  bp.part('roof', () => bp.roofHip(-1, -1, 11, 7, 5), { roof: 'hip' });
  bp.part('shed', () => bp.fill([12, 0, 2, 16, 2, 4], p.planks));
  bp.spot('entrance', 4, 7, 180);
  bp.spot('spawn', 4, 7, 180);
  return bp;
}
