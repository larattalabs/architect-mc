import { blueprint } from '../lib/kit.mjs';

export const id = 'cabin';

export const params = {
  floors: { type: 'int', min: 1, max: 3, default: 1, label: 'Floors' },
  porch: { type: 'bool', default: true, label: 'Porch' },
};

export default function cabin({ palette, floors = 1, porch = true } = {}) {
  // named parts: floors 1 with a porch matches massings/cabin.mjs exactly
  const parts = { hall: { box: [0, 0, 0, 10, 4 + 4 * floors, 9], cells: 11 * (5 + 4 * floors) * 10, roof: 'gable' }, ...(porch ? { porch: { box: [0, 0, 10, 10, 3, 12], cells: 11 * 4 * 3, roof: 'shed' } } : {}) };
  return blueprint({ id, name: 'Cabin', description: 'A fixture cabin.', type: 'cabin', size: { x: 11, y: 5 + 4 * floors, z: porch ? 13 : 10 }, parts, ...(palette ? { palette } : {}) });
}
