// (6c VOC-c) The two library entries VOC-c's lots bind (docs/CONTRACT.md "Phase 6c slice VOC-c" §9): an all-copper cabin (v64's bound lot,
// r03's re-bound lot) and the same cabin in oak (r03's lot that breaks "only copper"). Plain kit blueprints, deterministic. The gate
// installs both as library entries; the kit's tests measure them with `blueprintBlocks` (what the mod sends as `lotBlocks`: the non-air
// blocks of the template's first palette, by block id).
import { Blueprint, palette } from '../../../lib/kit.mjs';
import { qualify } from '../../../lib/blocks.mjs';
import { vocBible } from './voc-designs.mjs';

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** A blueprint's block histogram as the mod reads a template: non-air blocks by id (sorted keys). */
export function blueprintBlocks(bp) {
  const out = {};
  for (const e of bp.entries()) {
    const n = qualify(e.state.name);
    if (AIR.has(n)) continue;
    out[n] = (out[n] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A one-room cabin, 7 x 5 (walls x 0..6, z 0..4), 5 tall, a door on the south front and an approach of 4 rows. */
function cabin(id, name, { wall, floor, ceiling, corners, door, light, path }) {
  const p = palette({ bible: vocBible('g6cvocc_copper') });
  const X = 6, Z = 4, H = 4;
  const bp = new Blueprint({ id, name, description: name, type: 'custom', profile: ['door', 'lit'], size: [X + 1, H + 1, Z + 5], origin: [0, 0, 0], groundY: 1, front: 'south', palette: p, approach: false, interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  bp.part('main', () => bp.room([0, 0, 0, X, H, Z], { wall, floor, ceiling, corners }));
  bp.part('openings', () => {
    bp.door(Math.floor(X / 2), 1, Z, 'south', { block: door });
    const lit = light === 'minecraft:copper_bulb' ? { lit: 'true', powered: 'false' } : undefined;
    bp.set(1, 3, 1, light, lit); bp.set(X - 1, 3, Z - 1, light, lit);
  });
  bp.part('approach', () => bp.floor(Math.floor(X / 2) - 1, Z + 1, Math.floor(X / 2) + 1, Z + 4, 0, path));
  bp.spot('entrance', Math.floor(X / 2), Z + 1, 180);
  bp.spot('spawn', Math.floor(X / 2), Z + 3, 180);
  return bp;
}

/** vocc_copper_cabin: every block of the copper family (copper walls and door, cut copper floor and ceiling, copper bulbs). */
export const voccCopperCabin = () => cabin('vocc_copper_cabin', 'VOC-c Copper Cabin', { wall: 'minecraft:copper_block', floor: 'minecraft:cut_copper', ceiling: 'minecraft:cut_copper', corners: 'minecraft:waxed_cut_copper', door: 'minecraft:copper_door', light: 'minecraft:copper_bulb', path: 'minecraft:cut_copper' });
/** vocc_oak_cabin: the same cabin in oak (it breaks "only copper"). */
export const voccOakCabin = () => cabin('vocc_oak_cabin', 'VOC-c Oak Cabin', { wall: 'minecraft:oak_planks', floor: 'minecraft:oak_planks', ceiling: 'minecraft:oak_planks', corners: 'minecraft:oak_log', door: 'minecraft:oak_door', light: 'minecraft:glowstone', path: 'minecraft:oak_planks' });

/** The designs by id. */
export const VOCC_DESIGNS = Object.freeze({ vocc_copper_cabin: voccCopperCabin, vocc_oak_cabin: voccOakCabin });
