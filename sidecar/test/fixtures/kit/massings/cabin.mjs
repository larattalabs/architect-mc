// Test fixture: the example massing matching designs/cabin.mjs (floors 1, porch): the same parts and size. `wings`
// grows it (a redirect in the sim bumps it): 1 adds wing_east, 2 also a tower.
import { massing } from '../lib/massing.mjs';

export const id = 'cabin';

export const params = {
  wings: { type: 'int', min: 0, max: 2, default: 0, label: 'Wings' },
};

export default function cabinMassing({ wings = 0 } = {}) {
  const m = massing({ id, name: 'Cabin massing', description: 'A fixture massing.', type: 'cabin' });
  m.mass('hall', [0, 0, 0, 10, 8, 9], { roof: 'gable', ridge: 'x', storeys: 1 });
  m.mass('porch', [0, 0, 10, 10, 3, 12], { roof: 'shed' });
  if (wings >= 1) m.mass('wing_east', [11, 0, 0, 16, 6, 9], { roof: 'gable', ridge: 'z' });
  if (wings >= 2) m.mass('tower', [11, 0, 10, 14, 14, 12], { roof: 'hip' });
  m.opening('door', 'south', [5, 0, 12], [1, 2]);
  return m.build();
}
