// (7a K1) The exact bill of materials of a K1 part's emitted cells (docs/CONTRACT.md "Phase 7a slice K1" §7: `cost.bom`, so
// Steward can show what a wall or a bridge costs), by C26's block-to-item rules (mod survival/SurvivalItems.java): a block costs its
// item, except the upper half of a two-part block (doors) and a bed's head (the pair is charged once), a double slab (2 slabs), the
// wall variants of torches, signs, banners, heads and coral fans (their standing item), the obtainability map's special cases
// (COSTS: a copy of mod/src/main/resources/data/architect_mc/survival_items.json `costs`, held equal by a test) and blocks with
// no item (air, fluids: nothing). Regions stay INSTANT-only (N-K1-3): this is a report, not a charge.
import { SURVIVAL_CREATIVE_ONLY } from '../check.mjs';

/** survival_items.json `costs` (block -> item, or [] for no item). */
export const COSTS = Object.freeze({
  'minecraft:dirt_path': 'minecraft:dirt', 'minecraft:farmland': 'minecraft:dirt', 'minecraft:grass_block': 'minecraft:dirt',
  'minecraft:attached_melon_stem': 'minecraft:melon_seeds', 'minecraft:attached_pumpkin_stem': 'minecraft:pumpkin_seeds',
  'minecraft:melon_stem': 'minecraft:melon_seeds', 'minecraft:pumpkin_stem': 'minecraft:pumpkin_seeds',
  'minecraft:cave_vines_plant': 'minecraft:glow_berries', 'minecraft:cave_vines': 'minecraft:glow_berries', 'minecraft:kelp_plant': 'minecraft:kelp',
  'minecraft:twisting_vines_plant': 'minecraft:twisting_vines', 'minecraft:weeping_vines_plant': 'minecraft:weeping_vines',
  'minecraft:big_dripleaf_stem': 'minecraft:big_dripleaf', 'minecraft:bamboo_sapling': 'minecraft:bamboo', 'minecraft:tall_seagrass': 'minecraft:seagrass',
  'minecraft:water_cauldron': 'minecraft:cauldron', 'minecraft:lava_cauldron': 'minecraft:cauldron', 'minecraft:powder_snow_cauldron': 'minecraft:cauldron',
  'minecraft:redstone_wire': 'minecraft:redstone', 'minecraft:tripwire': 'minecraft:string',
  'minecraft:fire': [], 'minecraft:soul_fire': [], 'minecraft:water': [], 'minecraft:lava': [], 'minecraft:bubble_column': [], 'minecraft:moving_piston': [],
  'minecraft:piston_head': [], 'minecraft:frosted_ice': [],
});
const NONE = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** One cell's items: `[[item, n]]` (empty when it costs nothing). `state`: `name` or `name[k=v,...]`. */
export function itemsOf(state) {
  const m = /^([a-z0-9_:]+)(?:\[([^\]]*)\])?$/.exec(String(state));
  if (!m) return [];
  const name = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  if (NONE.has(name) || SURVIVAL_CREATIVE_ONLY.has(name)) return [];
  const props = Object.fromEntries((m[2] ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')));
  if (props.half === 'upper' || props.part === 'head') return [];
  const c = COSTS[name];
  if (c !== undefined) return (Array.isArray(c) ? c : [c]).map((i) => [i, 1]);
  if (name.endsWith('_slab') && props.type === 'double') return [[name, 2]];
  const wall = /^(minecraft:)(.*)_wall_(torch|sign|banner|head|skull|fan)$/.exec(name);
  if (wall) return [[`${wall[1]}${wall[2]}_${wall[3]}`, 1]];
  if (name === 'minecraft:wall_torch') return [['minecraft:torch', 1]];
  return [[name, 1]];
}

/** A bill of materials from cell states: `{item: n}`, items in code-point order. `cells`: an iterable of states (one per cell). */
export function bomOf(cells) {
  const n = new Map();
  for (const s of cells) for (const [i, c] of itemsOf(s)) n.set(i, (n.get(i) ?? 0) + c);
  return Object.fromEntries([...n].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
