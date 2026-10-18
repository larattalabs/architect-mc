// (6c H) What a cell holds for the flow (sim.mjs's world kinds), from a virtual world's palette (vworld.mjs Palette): 'stop' (a
// fluid-stopping block, blocks.mjs `fs`), 'open' (anything a flow can enter: air, plants, torches), 'water' / 'lava' (a source; a
// bubble column counts as water), 'flowing_water' / 'flowing_lava' (a flowing or falling cell). A leaf module: the checker and the body
// primitive share it.

const FLOWING = /level=([1-9]|1[0-5])\b/;

/** The world kind of palette state `i` of palette `P` (vworld.mjs). */
export function kindOf(P, i) {
  if (P.air[i]) return 'open';
  const s = P.states[i];
  if (P.lava[i]) return FLOWING.test(s) ? 'flowing_lava' : 'lava';
  if (s === 'minecraft:bubble_column' || s.startsWith('minecraft:bubble_column[')) return 'water';
  if (s === 'minecraft:water' || s.startsWith('minecraft:water[')) return FLOWING.test(s) ? 'flowing_water' : 'water';
  return P.fs[i] ? 'stop' : 'open';
}

/** A sim world over a virtual world (`vw`): at(x, y, z) and solid(x, y, z). */
export function vworldKinds(vw) {
  const P = vw.pal;
  return { at: (x, y, z) => kindOf(P, vw.get(x, y, z)), solid: (x, y, z) => P.solid[vw.get(x, y, z)] };
}
