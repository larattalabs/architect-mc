// (6c RS) Regions in survival: the free rule per written cell (docs/CONTRACT.md "Phase 6c slice RS" §4), shared by the evaluator
// (lib/realise.mjs: a survival IR's ARTL v2 classes and its notes.survival) and the plan check (lib/plan/finish.mjs: cost.survival). Under
// the realise lint: it imports only lib/region/ (survivalData.mjs, generated with kit/lib/vocab/survival.mjs from the same data).
import { COSTS, CREATIVE_ONLY, FREE_NATURAL } from './survivalData.mjs';

export { CREATIVE_ONLY, FREE_NATURAL };

/** Cell classes in ARTL v2 (docs/CONTRACT.md slice RS; kit 0.39.0): written in the free pass, held free in a target, paid in a target. */
export const CLASS_FREE = 0;
export const CLASS_HELD = 1;
export const CLASS_PAID = 2;

/** A material's kind for the free rule. */
export const MK_AIR = 0;
export const MK_WATER = 1;
export const MK_DIRT_PATH = 2;
export const MK_NATURAL = 3;
export const MK_OTHER = 4;
export const MK_LAVA = 5;
export const MK_ICE = 6;

const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** The block name of a canonical state string (`minecraft:x[...]` -> `minecraft:x`). */
export function blockName(state) {
  const s = String(state);
  const i = s.indexOf('[');
  return i < 0 ? s : s.slice(0, i);
}

/** A state's properties ({} when none). */
function propsOf(state) {
  const s = String(state);
  const i = s.indexOf('[');
  if (i < 0) return {};
  const out = {};
  for (const kv of s.slice(i + 1, s.length - 1).split(',')) {
    const e = kv.indexOf('=');
    if (e > 0) out[kv.slice(0, e)] = kv.slice(e + 1);
  }
  return out;
}

/**
 * The material kind of a block state: air, a water source, a dirt path, a free natural block (FREE_NATURAL), lava, ice (the cap's own
 * block; also natural), or anything else.
 */
export function materialKind(state) {
  if (state === null || state === undefined) return MK_AIR;
  const name = blockName(state);
  if (AIRS.has(name)) return MK_AIR;
  if (name === 'minecraft:water') return propsOf(state).level === undefined || propsOf(state).level === '0' ? MK_WATER : MK_OTHER;
  if (name === 'minecraft:lava') return MK_LAVA;
  if (name === 'minecraft:dirt_path') return MK_DIRT_PATH;
  if (name === 'minecraft:ice') return MK_ICE;
  return FREE_NATURAL.has(name) ? MK_NATURAL : MK_OTHER;
}

/**
 * One cell's items (C26's rules, kit/lib/connectors/bom.mjs itemsOf: the same rules, a test holds them equal over every block): `[[item, n]]`.
 */
export function itemsOf(state) {
  const name = blockName(state);
  if (AIRS.has(name) || CREATIVE_ONLY.has(name)) return [];
  const props = propsOf(state);
  if (props.half === 'upper' || props.part === 'head') return [];
  const c = COSTS[name];
  if (c !== undefined) return (Array.isArray(c) ? c : [c]).map((i) => [i, 1]);
  if (name.endsWith('_slab') && props.type === 'double') return [[name, 2]];
  const wall = /^(minecraft:)(.*)_wall_(torch|sign|banner|head|skull|fan)$/.exec(name);
  if (wall) return [[`${wall[1]}${wall[2]}_${wall[3]}`, 1]];
  if (name === 'minecraft:wall_torch') return [['minecraft:torch', 1]];
  return [[name, 1]];
}

/**
 * Whether a cell is free (§4.1): a cut (air), a water source or any cell of a fluid op (its ice cap is free, lava and grates are charged
 * when the body is written, not as targets), a dirt path on the column's surface (C16's freeCell, read off the frozen ground), or a free
 * natural block written by an op a terrain kind wrote (`free: true` in a survival IR).
 */
export function freeCell(kind, opFree, opFluid, y, ground, wet) {
  if (kind === MK_AIR || kind === MK_WATER || opFluid) return true;
  if (kind === MK_DIRT_PATH) return y <= ground && !wet;
  return opFree && (kind === MK_NATURAL || kind === MK_ICE);
}

/** Whether an op could write a paid cell with this material (statically, for a group's hold: a dirt path never counts). */
export function canPay(kind, opFree, opFluid) {
  if (kind === MK_AIR || kind === MK_WATER || kind === MK_DIRT_PATH || opFluid) return false;
  return !(opFree && (kind === MK_NATURAL || kind === MK_ICE));
}

/** What a fluid op's cell costs when its body is written (§7.3: a lava bucket per lava source; HY-c's grate, its iron bars). */
export function chargedOf(state) {
  const name = blockName(state);
  if (name === 'minecraft:lava') return 'minecraft:lava_bucket';
  if (name === 'minecraft:iron_bars') return 'minecraft:iron_bars';
  return null;
}
