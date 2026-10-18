// plan-p0 item 3 (determinism), plans 0, 3, 6, ... of the valid/ fixtures and the per-class plans (housekeeping 2 split).
import test from 'node:test';
import { determinism } from './plan-p0-shared.mjs';

test('item 3 (part 1 of 3): three checks of each crafted plan give identical answers and artifact shas; 1 and 4 tile workers give equal tile shas', async () => {
  await determinism(0, 3);
});
