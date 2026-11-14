// (M5 FK, S-M5-3) A Steward-shaped filter hall for the filled-container tests. It stands in for Steward's `storage_hall@1`
// (steward-mc docs/MODULES.md §3.2), which Steward owns; this one is only test data, and it doesn't sort.
//
//   - the core (fixed blocks, never a role): `slots` filter hoppers in a row at y2, each over a chest at y1 (the hopper faces down into
//     it); a comparator behind each hopper; a lever on the stone block at the row's west end, the lock cell (the template holds it
//     unpowered, unlocked; it is built powered, locked);
//   - the shell (from the palette's roles): a floor at y0 and a walkway in front.
//   - the fill: each filter hopper holds `count` of its item in slot 0 and one filler (`filler`) in each of slots 1-4.
//
//   x ->   0      1 .. slots
//   y2     stone  hopper (declared)       z=1
//   y3     lever  (the lock: on the stone)
//   y1     stone  chest
//   z=2    comparators behind the hoppers (y2)
import { Blueprint, PALETTES } from '../lib/kit.mjs';

export const id = 'fk_hall';

export const params = {
  slots: { type: 'int', min: 1, max: 8, default: 4, label: 'Filter slots' },
  count: { type: 'int', min: 1, max: 64, default: 18, label: 'Filter items per slot' },
};

const FILTERS = ['minecraft:cobblestone', 'minecraft:dirt', 'minecraft:gravel', 'minecraft:sand', 'minecraft:andesite', 'minecraft:diorite',
  'minecraft:granite', 'minecraft:oak_log'];
export const FILLER = 'minecraft:stick';

export default function build({ palette = PALETTES.rustic, slots = 4, count = 18 } = {}) {
  const p = palette;
  const W = slots + 2;
  const bp = new Blueprint({
    id,
    name: 'Filter Hall',
    description: `A row of ${slots} filter hoppers over chests, locked by a lever until filled.`,
    type: 'storage_hall',
    profile: ['no_floating'],
    tags: ['module', 'storage'],
    size: [W, 4, 4],
    groundY: 1,
    front: 'south',
    palette: p,
    approach: false,
  });
  bp.part('shell', () => {
    for (let x = 0; x < W; x++) for (let z = 0; z < 4; z++) bp.set(x, 0, z, p.floor ?? p.path);
  });
  const containers = [];
  bp.part('core', () => {
    bp.set(0, 1, 1, 'minecraft:stone');
    bp.set(0, 2, 1, 'minecraft:stone');
    bp.set(0, 3, 1, 'minecraft:lever', { face: 'floor', facing: 'east', powered: 'false' });
    for (let i = 0; i < slots; i++) {
      const x = i + 1;
      bp.set(x, 1, 1, 'minecraft:chest', { facing: 'south' });
      bp.set(x, 2, 1, 'minecraft:hopper', { facing: 'down', enabled: 'true' });
      bp.set(x, 2, 2, 'minecraft:comparator', { facing: 'south' });
      containers.push({ at: [x, 2, 1], items: [{ slot: 0, id: FILTERS[i], count }, ...[1, 2, 3, 4].map((slot) => ({ slot, id: FILLER, count: 1 }))] });
    }
  });
  bp.fill({ containers, locks: [{ at: [0, 3, 1], locked: { powered: 'true' } }] });
  bp.spot('entrance', 1, 3, 180);
  bp.spot('spawn', 1, 3, 180);
  return bp;
}
