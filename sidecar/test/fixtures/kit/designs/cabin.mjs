import { blueprint } from '../lib/kit.mjs';

export const id = 'cabin';

export default function cabin() {
  return blueprint({ id, name: 'Cabin', description: 'A fixture cabin.', type: 'cabin', size: { x: 11, y: 9, z: 13 } });
}
