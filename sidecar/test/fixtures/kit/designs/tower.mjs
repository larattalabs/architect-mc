import { blueprint } from '../lib/kit.mjs';

export const id = 'tower';

export default function tower() {
  return blueprint({ id, name: 'Tower', description: 'A fixture tower.', type: 'tower', size: { x: 7, y: 20, z: 7 }, warnings: ['tower: the top floor is dim (fixture warning)'] });
}
