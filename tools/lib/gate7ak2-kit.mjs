// (7a K2) What slice K2 moves for its byte-identity check (tools/gate7ak2.mjs unit, docs/CONTRACT.md "Phase 7a slice K2" §6, §8), by name,
// (castle_city only: the 7a foundation is on main now, so its own movers, F7A_MOVED, plan as on the merge base). Every other committed plan fixture plans
// byte for byte as on the merge base: a wall without where.along and without walk (or params.wall_walk) emits as K1a.
import { F7A_MOVED } from './f7a-norm.mjs';

// (the foundation is on main now (merged with CW): its own movers plan as on the merge base, so K2 names only its own)
export const K2_MOVED = Object.freeze({
  'asks/castle_city.json': F7A_MOVED['asks/castle_city.json'],
});

/**
 * (7a K2 item 7) The wall columns standing in water: over each wall column's written range (its lowest cell the realise changed, up to
 * its top + 3), water in the realised world, or water there before (a wall block standing where water was). Water under that range (a
 * flooded cave beneath the footing, untouched) does not count. `cells`: the wall meta's [[x, z, T]]; `was`, `at`: (x, y, z) -> block
 * state before and after. Returns {wet, sample: [[x, y, z]]}.
 */
export function wallInWater(cells, was, at) {
  const water = (s) => /^minecraft:water/.test(s);
  let wet = 0;
  const sample = [];
  for (const [x, z, T] of cells) {
    let foot = null;
    for (let y = T - 40; y <= T + 3; y++) if (was(x, y, z) !== at(x, y, z)) { foot = y; break; }
    if (foot === null) continue;
    for (let y = foot; y <= T + 3; y++) if (water(at(x, y, z)) || water(was(x, y, z))) { wet++; if (sample.length < 8) sample.push([x, y, z]); break; }
  }
  return { wet, sample };
}
