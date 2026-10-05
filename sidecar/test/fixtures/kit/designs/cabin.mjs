import { blueprint } from '../lib/kit.mjs';

export const id = 'cabin';

export const params = {
  floors: { type: 'int', min: 1, max: 3, default: 1, label: 'Floors' },
  porch: { type: 'bool', default: true, label: 'Porch' },
};

export default function cabin({ palette, floors = 1, porch = true } = {}) {
  return blueprint({ id, name: 'Cabin', description: 'A fixture cabin.', type: 'cabin', size: { x: 11, y: 5 + 4 * floors, z: porch ? 13 : 10 }, ...(palette ? { palette } : {}) });
}
