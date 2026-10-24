// (7a K1) Connector style from the bible (docs/CONTRACT.md "Phase 7a slice K1" §6): bible format 2 gains an optional
// `connectors` member whose values are role names only, so a re-skin restyles walls, gates and rope bridges without replanning:
//   connectors?: { wall?: {body?, cap?, frame?}, gate?: {frame?, door?}, rope_bridge?: {deck?, rail?, post?, rope?},
//                  bridge?: {deck?, rail?, pier?, arch?}, tunnel?: {lining?, portal?, floor?} }   ((6c T3) bridge and tunnel, additive)
// (7a foundation, §5, additive) stair {tread, rail}, switchback {retaining}, ladder {ladder, landing, rail, gate}, rock_stair {tread,
// lining, portal}, lift {shell, base, door, cap}, catwalk {deck, bracket, rail}, stairs_around {tread, rail, deck}, and wall's walk and
// parapet (K2). Each slice states its slots' defaults; until then a slot's chain is empty (it resolves to null, which nothing reads).
// connectorRoles() resolves it against the plan's roles with the contract's defaults, and shapeOf() gives a role's block in the
// shape a generator needs (slab, stairs, wall block, fence, fence gate, door) from the 26.3 block tables (kit.mjs variant(), which
// reads lib/blocks.mjs), each with its stated fallback.
import { qualify } from '../blocks.mjs';
import { variant, WOODS } from '../kit.mjs';

/** The members and their slots (role names). */
export const CONNECTOR_SLOTS = Object.freeze({ wall: ['body', 'cap', 'frame', 'walk', 'parapet'], gate: ['frame', 'door'], rope_bridge: ['deck', 'rail', 'post', 'rope'], bridge: ['deck', 'rail', 'pier', 'arch'], tunnel: ['lining', 'portal', 'floor'],
  stair: ['tread', 'rail'], switchback: ['retaining'], ladder: ['ladder', 'landing', 'rail', 'gate'], rock_stair: ['tread', 'lining', 'portal'], lift: ['shell', 'base', 'door', 'cap'], catwalk: ['deck', 'bracket', 'rail'], stairs_around: ['tread', 'rail', 'deck'] });

/**
 * The default role chain of each slot (§6, N-K1-1, N-K1-2): the first role the plan resolves wins. `door` defaults to the frame's
 * wood family (else oak), so it has no role chain; `rope` defaults to chains (N-K1-2: they make it read as a rope bridge), which the
 * bible turns off with "none".
 */
export const CONNECTOR_DEFAULTS = Object.freeze({
  // ((7a K2, N-K2-1) the walk's surface in the cap's chain (trim), the parapet's wall-block course in trim then the body's chain (the
  // first whose block has a wall variant, wall.mjs; none: a full-block parapet two high))
  wall: { body: ['structure', 'foundation', 'wall'], cap: ['trim'], frame: ['trim'], walk: ['trim'], parapet: ['trim', 'structure', 'foundation', 'wall'] },
  gate: { frame: ['trim'], door: [] },
  rope_bridge: { deck: ['floor', 'path'], rail: ['rail'], post: ['frame'], rope: [] },
  // (6c T3 §7, N-T3-1, N-T3-3) a bridge's deck in path then floor, rails trim (its wall variant) then rail, piers and the arch in
  // structure, foundation, wall; a tunnel's lining in foundation then structure, its portal in trim, its floor path then floor
  bridge: { deck: ['path', 'floor'], rail: ['trim', 'rail'], pier: ['structure', 'foundation', 'wall'], arch: ['structure', 'foundation', 'wall'] },
  tunnel: { lining: ['foundation', 'structure'], portal: ['trim'], floor: ['path', 'floor'] },
  // (7a foundation) each 7a slice sets its own chains (empty until then: the slot resolves to null)
  // ((7a CL, N-CL-1) stairs in the path role's stairs (where it has them; else T2's structure), rails the rail role; switchback retaining
  // in structure, then foundation (capped with the trim's slab); a ladder's rest landing the floor role's slab, its rails and gate the
  // rail role's; the ladder block itself is vanilla's (no role))
  stair: { tread: ['path'], rail: ['rail'] }, switchback: { retaining: ['structure', 'foundation'] }, ladder: { ladder: [], landing: ['floor'], rail: ['rail'], gate: ['rail'] },
  rock_stair: { tread: [], lining: [], portal: [] }, lift: { shell: [], base: [], door: [], cap: [] },
  catwalk: { deck: ['floor', 'path'], bracket: ['frame'], rail: ['rail'] }, // ((7a CW, N-CW-1) a plank deck in floor then path, brackets in frame, fence rails)
  stairs_around: { tread: [], rail: [], deck: [] },
});

/** A bible's `connectors` member checked: null when fine, else a message (role names must be roles of the bible). */
export function connectorsError(c, roles = null) {
  if (c === undefined) return null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return `connectors must be an object { ${Object.keys(CONNECTOR_SLOTS).map((k) => `${k}?`).join(', ')} }`;
  for (const [k, v] of Object.entries(c)) {
    if (!CONNECTOR_SLOTS[k]) return `connectors: unknown member '${k}' (one of ${Object.keys(CONNECTOR_SLOTS).join(', ')})`;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `connectors.${k} must be an object { ${CONNECTOR_SLOTS[k].join(', ')} }`;
    for (const [s, r] of Object.entries(v)) {
      if (!CONNECTOR_SLOTS[k].includes(s)) return `connectors.${k}: unknown slot '${s}' (one of ${CONNECTOR_SLOTS[k].join(', ')})`;
      if (k === 'rope_bridge' && s === 'rope' && r === 'none') continue;
      if (typeof r !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(r)) return `connectors.${k}.${s} must be a role name`;
      if (roles && !roles[r]) return `connectors.${k}.${s}: '${r}' is not a role of this bible`;
    }
  }
  return null;
}

/**
 * The role name each slot resolves to: `{wall: {body, cap, frame}, gate: {frame, door}, rope_bridge: {deck, rail, post, rope}}`.
 * `roles`: the plan's resolved roles ({role: blockState}); `given`: the bible's `connectors` (or null). A slot the bible names wins when
 * the plan resolves that role; else the first role of its default chain the plan has. `door` and `rope` are null by default (the
 * door is the frame's wood family; the rope is chains), `rope` is 'none' when the bible turns chains off.
 */
export function connectorRoles(roles, given = null) {
  const out = {};
  for (const [k, slots] of Object.entries(CONNECTOR_SLOTS)) {
    out[k] = {};
    for (const s of slots) {
      const g = given?.[k]?.[s];
      if (k === 'rope_bridge' && s === 'rope' && g === 'none') { out[k][s] = 'none'; continue; }
      if (typeof g === 'string' && roles?.[g]) { out[k][s] = g; continue; }
      out[k][s] = CONNECTOR_DEFAULTS[k][s].find((r) => roles?.[r]) ?? null;
    }
  }
  return out;
}

/** The wood family of a block (spruce_log -> spruce, dark_oak_planks -> dark_oak), or null. */
export function woodOf(block) {
  const b = qualify(String(block ?? '')).replace(/^minecraft:/, '').replace(/\[.*$/, '');
  const ws = [...WOODS].sort((a, c) => c.length - a.length);
  for (const w of ws) if (b === `${w}_planks` || b.startsWith(`${w}_`) || b.startsWith(`stripped_${w}_`)) return w;
  return null;
}

/**
 * A block in a shape: `slab`, `stairs`, `wall` (the wall block), `fence`, `fence_gate`, `door`, from the 26.3 tables; `null` when the
 * block has no such variant (the caller's stated fallback applies). A log or wood takes its wood family's planks' variants.
 */
export function shapeOf(block, shape) {
  if (!block) return null;
  const base = String(block).replace(/\[.*$/, '');
  const v = variant(base, shape);
  if (v) return v;
  const w = woodOf(base);
  if (w) return variant(`minecraft:${w}_planks`, shape);
  return null;
}

/** The door of a gate: the frame's wood family's door, else oak's (§3). */
export function doorOf(frameBlock) {
  const w = woodOf(frameBlock);
  return (w && variant(`minecraft:${w}_planks`, 'door')) || 'minecraft:oak_door';
}

/** (7a CL theme, Noah 2026-10-24) Functional blocks a connector may write that no role themes: ladders, air, fluids, chains, cauldrons, beds. */
export const UNTHEMED_OK = Object.freeze(new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:ladder', 'minecraft:water', 'minecraft:lava', 'minecraft:chain', 'minecraft:iron_chain', 'minecraft:scaffolding', 'minecraft:vine', 'minecraft:water_cauldron', 'minecraft:cauldron',
  // (theme rest, Noah 2026-10-24) iron, where nothing else does the job: bars hold HY-c's water gate (still water passes, mobs don't:
  // a fence would not, and the grate state is shared with the mod's fluid op); iron's door and trapdoor are the only doors VOC-c's
  // no-wood rule can swap a wooden one for when the plan's roles have none of their own (a copper role gives copper_door first)
  'minecraft:iron_bars', 'minecraft:iron_door', 'minecraft:iron_trapdoor']));
const SHAPES = Object.freeze(['slab', 'stairs', 'wall', 'fence', 'fence_gate', 'door', 'trapdoor', 'pressure_plate', 'button']);
/**
 * The role a block traces to (Noah: "everything should be themed"): the role whose block, or one of whose shape variants (slab,
 * stairs, wall, fence, fence gate, door, ...), the block is; the light role's W fixture counts as the light role. null when no role
 * gives it (and it is not in UNTHEMED_OK: then 'functional').
 */
export function traceRole(block, roles, { lightFixture = null } = {}) {
  const name = String(block).replace(/\[.*$/, '');
  if (UNTHEMED_OK.has(name) || /_bed$/.test(name)) return 'functional'; // (a bed: a villager's workstation of sleep, any colour)
  for (const [r, b] of Object.entries(roles ?? {})) {
    const base = String(b).replace(/\[.*$/, '');
    if (base === name) return r;
    for (const sh of SHAPES) { const v = shapeOf(base, sh); if (v && v.replace(/\[.*$/, '') === name) return `${r}.${sh}`; }
  }
  if (lightFixture && String(lightFixture).replace(/\[.*$/, '') === name) return 'light';
  return null;
}
