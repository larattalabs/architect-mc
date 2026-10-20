// (6c VOC) The block vocabulary's helpers (docs/CONTRACT.md "Phase 6c slice VOC" §1, §2): every 26.3 block's family, colour, tier,
// survival class, drift, fitting, block entity and feature flags, generated into kit/lib/blocks.mjs (`fam`, `col`, `t`, `sv`, `rt`, `wx`,
// `be`, `ft`, `ff`; `info(name)` returns them) by kit/tools/gen-vocab.mjs, plus the committed rule tables of kit/vocab/.
//
// These helpers live here, not in blocks.mjs: blocks.mjs's `familyOf` already names the Java family (stairs, slab, door...) that the
// kit's generators read, so the vocabulary's family is `familyOf` of this module. Nothing here changes a block a generator writes:
// the fields are read only by VOC's rules and cost members.
//
// A name is `minecraft:x`, `x`, or a state `x[k=v,...]` (the properties are read only by drifts()).
import { BLOCKS, collisionOf, isFloor, isGravity, qualify, tagBlocks } from './blocks.mjs';
import { fullBlockOf, variant } from './kit.mjs';
import ROLES from '../vocab/roles.json' with { type: 'json' };
import HAZARDS from '../vocab/hazards.json' with { type: 'json' };
import TIERS_TABLE from '../vocab/tiers.json' with { type: 'json' };

export { ROLES, HAZARDS, TIERS_TABLE };
/** The tiers, lowest first; `t` absent means common. */
export const TIERS = Object.freeze(['common', 'uncommon', 'rare', 'precious']);
/** The survival classes (`sv`): craft, drop, silk, loot, cost (another item), none (creative only). */
export const SURVIVAL_CLASSES = Object.freeze(['craft', 'drop', 'silk', 'loot', 'cost', 'none']);
/** The 16 dye colours (`col`), in vanilla's order. */
export const DYES = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);

/** `name[k=v]` -> {name: 'minecraft:name', props}. */
function parse(state) {
  if (state && typeof state === 'object') return { name: qualify(state.name), props: state.props ?? {} };
  const m = /^([a-z0-9_:]+)(?:\[([^\]]*)\])?$/.exec(String(state));
  if (!m) return { name: String(state), props: {} };
  return { name: qualify(m[1]), props: Object.fromEntries((m[2] ?? '').split(',').filter(Boolean).map((kv) => kv.split('='))) };
}
const row = (state) => BLOCKS[parse(state).name];

/** The block's vocabulary family (`copper`, `concrete`, `oak`, `stone`...), or null for an unknown block. */
export const familyOf = (name) => row(name)?.fam ?? null;
/** Its dye colour (one of DYES), or null. */
export const colourOf = (name) => row(name)?.col ?? null;
/** Its tier: 'common' | 'uncommon' | 'rare' | 'precious' (null for an unknown block). */
export const tierOf = (name) => (row(name) ? row(name).t ?? 'common' : null);
/** Its survival class: 'craft' | 'drop' | 'silk' | 'loot' | 'cost' | 'none' (null for an unknown block). */
export const survivalOf = (name) => row(name)?.sv ?? null;
/** A fitting: functional, not material (doors, glass and panes, lights that are not cubes, beds, signs, plants, redstone parts...). */
export const isFitting = (name) => !!row(name)?.ft;
/** Has a block entity. */
export const hasBlockEntity = (name) => !!row(name)?.be;
/** Random-ticks in its default state (it may change on its own; a crop only changes its age). */
export const randomTicks = (name) => !!row(name)?.rt;
/** The next weathering stage and the waxed form, qualified: {next?, waxed?}, or null. */
export function weatheringOf(name) {
  const w = row(name)?.wx;
  if (!w) return null;
  return { ...(w.next ? { next: qualify(w.next) } : {}), ...(w.waxed ? { waxed: qualify(w.waxed) } : {}) };
}
/** The feature flags the block needs beyond vanilla (none in 26.3's default world: []). */
export const featuresOf = (name) => row(name)?.ff ?? [];

const SAPLING = /_(sapling|propagule)$/;
/**
 * Does this state random-tick into another block (`state:drift`, M27:drift)? Unwaxed copper (it weathers), farmland (dries to
 * dirt), leaves with `persistent=false` (decay), saplings (grow into a tree), ice (melts by a light) and a snow layer (melts). A crop
 * random-ticks too, but only changes its age: not a drift. `state`: a name or `{name, props}` (a default property when absent).
 */
export function drifts(state) {
  const { name, props } = parse(state);
  const r = BLOCKS[name];
  if (!r?.rt) return false;
  if (r.wx?.next) return true;
  const b = name.slice('minecraft:'.length);
  if (b === 'farmland' || b === 'ice' || b === 'snow') return true;
  if (SAPLING.test(b) || b === 'mangrove_propagule') return true;
  if ('persistent' in r.props && /leaves$/.test(b)) return (props.persistent ?? r.defaults.persistent) === 'false';
  return false;
}

const NATURAL = new Set(['ROCK', 'SOIL', 'LOOSE', 'SNOW', 'ICE']);
const CHECKS = {
  cube: (n) => collisionOf({ name: n, props: BLOCKS[n].defaults }) === 'full',
  notGravity: (n) => !isGravity(n),
  notFitting: (n) => !BLOCKS[n].ft,
  stairsSlab: (n) => {
    const full = fullBlockOf(n);
    return !!variant(full, 'stairs') && !!variant(full, 'slab');
  },
  floor: (n) => isFloor({ name: n, props: BLOCKS[n].defaults }),
  emits: (n) => {
    const L = BLOCKS[n].L;
    return !!L && (typeof L === 'number' ? L > 0 : Object.values(L.v).some((x) => x > 0));
  },
  glass: (n) => BLOCKS[n].o === 'C' && (BLOCKS[n].collision === 'full' || BLOCKS[n].family === 'pane'),
  thin: (n) => BLOCKS[n].collision === 'thin',
  tall: (n) => BLOCKS[n].h === 1.5,
  natural: (n) => NATURAL.has(BLOCKS[n].v),
  obtainable: (n) => BLOCKS[n].sv !== 'none',
};
export const ROLE_CHECKS = Object.freeze(Object.keys(CHECKS));
const BY_ROLE = new Map();
for (const r of ROLES.rows) for (const role of r.roles) BY_ROLE.set(role, r);

/**
 * Role fitness (§2.3): does `block` suit `role`? -> {ok, failed: [check names]} (failed empty when ok). A role with no row takes only
 * `every` (obtainable). An unknown block fails `known`.
 */
export function fitsRole(role, block) {
  const n = parse(block).name;
  if (!BLOCKS[n]) return { ok: false, failed: ['known'] };
  const failed = [];
  for (const c of ROLES.every.all) if (!CHECKS[c](n)) failed.push(c);
  const r = BY_ROLE.get(role);
  if (r) {
    for (const c of r.all ?? []) if (!CHECKS[c](n)) failed.push(c);
    if (r.any && !r.any.some((c) => CHECKS[c](n))) failed.push(r.any.join('|'));
  }
  return { ok: failed.length === 0, failed };
}

/** The hazards.json row of a kind (concrete_powder, sponge, magma, soul_sand, fire, lava), or null. */
export const hazardOf = (kind) => HAZARDS.rows.find((r) => r.kind === kind) ?? null;

/** The blocks a hazards.json row names (`block`: an id, a #tag, or a name ending in *), qualified and sorted. */
export function hazardBlocks(row) {
  const b = row.block;
  if (b.startsWith('#')) return [...(tagBlocks(b) ?? [])];
  if (b.endsWith('*')) {
    const pre = qualify(b.slice(0, -1));
    return Object.keys(BLOCKS).filter((id) => id.startsWith(pre)).sort();
  }
  if (b.startsWith('minecraft:*')) {
    const suf = b.slice('minecraft:*'.length);
    return Object.keys(BLOCKS).filter((id) => id.endsWith(suf)).sort();
  }
  return BLOCKS[qualify(b)] ? [qualify(b)] : [];
}
