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

// ------------------------------------------------------------------ (8c WM) the water model's extra world facts (sim.mjs header)

/** The blocks that hold a water source as a block with no waterlogged property (their fluid state is always a source). */
export const WATER_PLANTS = Object.freeze(['minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass', 'minecraft:tall_seagrass']);
const FACE = { east: 1, west: 2, south: 4, north: 8, up: 16, down: 32 };
// Direction.getCounterClockWise / getClockWise (a stair's inner_left / inner_right second full face)
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };

const parse = (s) => {
  const i = s.indexOf('[');
  if (i < 0) return { name: s, props: {} };
  const props = {};
  for (const kv of s.slice(i + 1, -1).split(',')) { const [k, v] = kv.split('='); props[k] = v; }
  return { name: s.slice(0, i), props };
};

/**
 * Whether a block state holds a water source as a block (a waterlogged block, kelp, seagrass), and the faces its collision shape covers
 * fully (sim.mjs FACE bits: canPassThroughWall refuses them): null when it holds none. Modelled: a stair's full back (and an inner
 * stair's second side) and its half's bottom or top, a slab's bottom or top, a closed trapdoor's bottom or top; every other waterloggable
 * (fences, walls, panes, bars, chains, lanterns, coral fans, ladders, open trapdoors) covers no face fully here, which is conservative
 * for the reach and a calibration item for the census (the PB probe).
 */
export function wlMask(state) {
  const { name, props } = parse(state);
  if (WATER_PLANTS.includes(name)) return 0;
  if (props.waterlogged !== 'true') return null;
  let m = 0;
  if (name.endsWith('_stairs')) {
    m |= props.half === 'top' ? FACE.up : FACE.down;
    const f = props.facing;
    const shape = props.shape ?? 'straight';
    if (FACE[f] && (shape === 'straight' || shape.startsWith('inner_'))) m |= FACE[f];
    if (FACE[f] && shape === 'inner_left') m |= FACE[CCW[f]];
    if (FACE[f] && shape === 'inner_right') m |= FACE[CW[f]];
  } else if (name.endsWith('_slab')) {
    m |= props.type === 'top' ? FACE.up : props.type === 'double' ? 63 : FACE.down;
  } else if (name.endsWith('_trapdoor') && props.open !== 'true') {
    m |= props.half === 'top' ? FACE.up : FACE.down;
  }
  return m;
}

/** A flowing water or lava state's LiquidBlock.LEVEL (1..15), else null. */
export function levelOf(state) {
  const { name, props } = parse(state);
  if (name !== 'minecraft:water' && name !== 'minecraft:lava') return null;
  const lv = Number(props.level ?? 0);
  return Number.isInteger(lv) && lv >= 1 && lv <= 15 ? lv : null;
}

/** The blocks that make a bubble column in the source water over them. */
export const BUBBLERS = Object.freeze(['minecraft:soul_sand', 'minecraft:magma_block']);

/**
 * The wm model's extra world facts over a virtual world (sim.mjs header): wl, level, bubbler and wash. `cleared`: the world is the one
 * after the planner's wash clears (the checker's, at the fluids stage), so a natural block still in a predicted cell is refused there,
 * not cleared. (vw.flags bit 1 is vworld.mjs's F_WRITTEN; not imported: this module stays a leaf.)
 */
export function wmKinds(vw, { cleared = false } = {}) {
  const P = vw.pal;
  const memo = new Map();
  const wlOf = (i) => { let m = memo.get(i); if (m === undefined) { m = wlMask(P.states[i]); memo.set(i, m); } return m; };
  return {
    wl: (x, y, z) => wlOf(vw.get(x, y, z)),
    level: (x, y, z) => levelOf(P.states[vw.get(x, y, z)]),
    bubbler: (x, y, z) => BUBBLERS.includes(parse(P.states[vw.get(x, y, z)]).name),
    wash: (x, y, z) => {
      const i = vw.get(x, y, z);
      if (P.air[i] || kindOf(P, i) !== 'open') return null;
      const written = (vw.flags(x, y, z) & 1) !== 0;
      if (!written && P.natural[i]) return cleared ? 'natural, not cleared before the fluids stage' : 'clear';
      return written ? "the plan's own block" : "not natural (a player's or another owner's)";
    },
  };
}
