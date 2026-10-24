// Style unification U0 (docs/STYLE-UNIFY.md §1, docs/CONTRACT.md "Style unification"): a Style is a bible plus a few optional
// fields. This module holds what the kit knows about Styles beyond the bible itself:
//   - STYLE_META: the built-in Styles' metadata (tags, suggestedFeatures, blurb, shape hints), one row per palette preset;
//   - the four main rows (Wood / Stone / Roof / Accent) and how they fan out into roles: mainOf(roles), editMain(roles, field,
//     value) and provenanceOf(roles, base);
//   - styleTable(): the same fan-out as data, for the mod (tools/gen-palettes.mjs writes it into palettes.json and the mod's
//     fallback; mod/.../library/StyleRoles.java reads it). kit/test/styles.test.mjs and StyleRolesTest hold the two equal.
//
// Fan-out (kit.mjs palette()): wood fills wall, frame and floor; stone fills foundation and trim; roof and accent fill one role
// each; wall_alt, light, glass and path are fixed. The reverse is lossy, so editMain re-derives only the roles that still
// follow a main row: a wood role whose block is of the current wood's family, a stone role of the current stone's family.
// Everything else was set by the Style (or by hand) and stays.
import { BLOCKS, isCube, normalize, qualify } from './blocks.mjs';
import { CORE_ROLES, PALETTE_PRESETS, PALETTES, STONE_FAMILIES, WOODS, fullBlockOf, stoneFamilyOf, variant, woodFamilyOf, woodSetOf } from './kit.mjs';

/** The four main rows of the Style editor, in order. */
export const MAIN_FIELDS = Object.freeze(['wood', 'stone', 'roof', 'accent']);
/** Which roles each main row drives. */
export const FAN_OUT = Object.freeze({ wood: ['wall', 'frame', 'floor'], stone: ['foundation', 'trim'], roof: ['roof'], accent: ['accent'] });
/** The roles no main row drives, at the value palette() gives them. */
export const FIXED_ROLES = Object.freeze({ wall_alt: 'minecraft:calcite', light: 'minecraft:lantern', glass: 'minecraft:glass_pane', path: 'minecraft:dirt_path' });
/** The woods palette() roofs with another wood by default (kit.mjs DARK_WOODS): fanOut's default roof. */
export const DARK_WOODS = Object.freeze(['spruce', 'dark_oak', 'mangrove', 'crimson', 'warped']);
/** The wood part a wood-driven role takes when it has none of its own (palette(): wall and floor planks, frame the log). */
export const WOOD_PART_OF_ROLE = Object.freeze({ wall: 'planks', frame: 'log', floor: 'planks', accent: 'planks' });
/** The wood parts a role block may be, in the order editMain matches them. */
export const WOOD_PARTS = Object.freeze(['planks', 'log', 'strippedLog', 'bark', 'strippedBark']);
/** Provenance tags (docs/STYLE-UNIFY.md §1): set by the Style, following a main row, or set by hand. */
export const PROVENANCE = Object.freeze(['style', 'follows_wood', 'follows_stone', 'hand']);
/** At most this many suggested features (the mod's DesignSpec.MAX_FEATURES). */
export const MAX_SUGGESTED_FEATURES = 6;
/** The feature ids a Style may suggest (the mod's DesignSpec.FEATURES; kit/test/styles.test.mjs reads DesignSpec.java to hold them equal). */
export const FEATURE_IDS = Object.freeze(['porch', 'chimney', 'balcony', 'garden', 'skylights', 'courtyard', 'big_windows', 'basement']);
/** Style origins. */
export const ORIGINS = Object.freeze(['builtin', 'claude', 'hand']);

/**
 * The built-in Styles' metadata, one row per palette preset (kit.mjs PALETTE_PRESETS). `hints` are shape hints merged into the
 * built-in bible (proportions over the defaults, roofLanguage); the ten presets of before U0 keep the default proportions, so
 * their bibles are unchanged but for the new optional fields.
 */
export const STYLE_META = Object.freeze({
  rustic: { tags: ['rustic', 'timber', 'countryside'], suggestedFeatures: ['chimney', 'porch'], blurb: 'Spruce timber on cobblestone under a dark oak roof.' },
  oak: { tags: ['temperate', 'plain', 'village'], suggestedFeatures: ['porch', 'garden'], blurb: 'Oak walls on stone bricks under a spruce roof.' },
  birch: { tags: ['light', 'calm'], suggestedFeatures: ['big_windows', 'garden'], blurb: 'Pale birch on polished andesite under a dark oak roof.' },
  dark: { tags: ['dark', 'grand'], suggestedFeatures: ['chimney', 'basement'], blurb: 'Dark oak on deepslate bricks under deepslate tiles.' },
  desert: { tags: ['warm', 'sand', 'arid'], suggestedFeatures: ['courtyard'], blurb: 'Sandstone and jungle wood with smooth sandstone plaster.' },
  brick: { tags: ['town', 'brick'], suggestedFeatures: ['chimney'], blurb: 'Brick and oak with deepslate trim and a tiled roof.' },
  cherry: { tags: ['calm', 'blossom'], suggestedFeatures: ['garden', 'balcony'], blurb: 'Cherry wood on polished tuff under a dark oak roof.' },
  mangrove: { tags: ['swamp', 'mud'], suggestedFeatures: ['porch'], blurb: 'Mangrove and mud bricks with packed mud plaster.' },
  crimson: { tags: ['nether', 'infernal'], suggestedFeatures: ['basement'], blurb: 'Crimson stems on blackstone under a nether brick roof.' },
  fortress: { tags: ['grand', 'stone', 'defensive'], suggestedFeatures: ['basement'], blurb: 'Stone bricks and spruce under deepslate tiles.' },
  medieval: {
    tags: ['medieval', 'timber frame', 'plaster', 'village'], suggestedFeatures: ['chimney', 'balcony'],
    blurb: 'Dark oak timber framing with pale daub walls and steep spruce roofs.',
    hints: { proportions: { roofPitch: 1.5 }, roofLanguage: 'steep gables, jettied upper floors' },
  },
  nordic: {
    tags: ['nordic', 'cold', 'dark wood', 'steep roof'], suggestedFeatures: ['chimney', 'porch'],
    blurb: 'Spruce halls on cobbled deepslate under steep spruce roofs.',
    hints: { proportions: { roofPitch: 1.5 }, roofLanguage: 'steep gables over long, low halls' },
  },
  japanese: {
    tags: ['japanese', 'light wood', 'paper walls', 'wide eaves'], suggestedFeatures: ['garden', 'courtyard'],
    blurb: 'Birch framing with paper-white walls and deepslate tile roofs on mossy stone.',
    hints: { proportions: { roofPitch: 0.75, overhang: 2 }, roofLanguage: 'low hipped roofs with wide eaves' },
  },
  cozy: {
    tags: ['cozy', 'small', 'warm', 'cottage'], suggestedFeatures: ['chimney', 'garden'],
    blurb: 'An oak cottage on mossy cobblestone, small windows and warm light.',
    hints: { proportions: { windowRhythm: 4 }, roofLanguage: 'low, deep gables' },
  },
  fantasy: {
    tags: ['fantasy', 'colourful', 'whimsical'], suggestedFeatures: ['balcony', 'garden'],
    blurb: 'Warped wood and purpur under crimson roofs, lit by shroomlights.',
    hints: { roofLanguage: 'tall, curving roofs and odd turrets' },
  },
  modern: {
    tags: ['modern', 'glass', 'flat roof', 'concrete'], suggestedFeatures: ['big_windows', 'skylights', 'balcony'],
    blurb: 'White concrete and smooth quartz, glass-heavy, under flat roofs.',
    hints: { proportions: { roofPitch: 0, overhang: 0 }, roofLanguage: 'flat roofs: a deck with a parapet (kit.mjs roofFlat)' },
  },
});

/** The metadata of a built-in Style (a palette preset), or null. */
export function styleMeta(name) {
  return STYLE_META[name] ?? null;
}

const short = (b) => String(b).replace(/^minecraft:/, '');
const has = (b) => !!BLOCKS[qualify(b)];
const STONE_MEMBER = new Map(Object.entries(STONE_FAMILIES).flatMap(([f, list]) => list.map((b) => [b, f])));

/** A full block with stairs and slab variants (what a palette's stone needs). */
export function isStoneBlock(b) {
  return !!b && has(b) && isCube(normalize(qualify(b))) && !!variant(b, 'stairs') && !!variant(b, 'slab');
}

/** A block with stairs and slab variants (what a roof role needs: palette() lays it in its stairs and slabs). */
export function isRoofBlock(b) {
  return !!b && has(b) && !!variant(b, 'stairs') && !!variant(b, 'slab');
}

/** The trim palette() derives from a stone: the first other full member of its family, else the stone itself. */
export function stoneTrimOf(stone) {
  const s = short(stone);
  const fam = STONE_MEMBER.get(s);
  const kin = fam ? STONE_FAMILIES[fam] : [];
  return qualify(kin.find((k) => k !== s && has(k) && isCube(normalize(k))) ?? s);
}

/** A wood's parts a role can take: planks, log, strippedLog, bark (wood/hyphae) and strippedBark. */
export function woodParts(w) {
  const s = woodSetOf(w);
  const pick = (...names) => { for (const n of names) if (has(n)) return qualify(n); return null; };
  return { planks: s.planks, log: s.log, strippedLog: s.strippedLog, bark: s.bark, strippedBark: pick(`stripped_${w}_wood`, `stripped_${w}_hyphae`) ?? s.strippedLog };
}

const woodName = (b) => (b ? (WOODS.includes(short(b)) ? short(b) : woodFamilyOf(b)) : null);

/**
 * The four main rows of a set of roles: what palette({ bible: { roles } }) derives (kit.mjs paletteFromBible): the wood of the
 * first wooden role (roles.wood, frame, accent, floor, wall, wall_alt, roof), the stone of the first stone-like role with stairs
 * and slab (foundation, wall, trim, wall_alt), the roof (its wood name when it is that wood's planks), the accent's wood.
 * @returns {{ wood: string, stone: string, roof: string, accent: string }} short names
 */
export function mainOf(roles) {
  const r = roles ?? {};
  const wood = [r.wood, r.frame, r.accent, r.floor, r.wall, r.wall_alt, r.roof].map(woodName).find(Boolean) ?? 'oak';
  const stone = [r.foundation, r.wall, r.trim, r.wall_alt].filter(Boolean).map(fullBlockOf).find(isStoneBlock) ?? 'minecraft:cobblestone';
  const roofBlock = r.roof ? fullBlockOf(r.roof) : qualify('dark_oak_planks');
  const rw = woodName(roofBlock);
  const roof = rw && roofBlock === qualify(`${rw}_planks`) ? rw : short(roofBlock);
  const accent = woodName(r.accent) ?? wood;
  return { wood, stone: short(stone), roof, accent };
}

/** Whether a role still follows its main row (wood or stone) in these roles: what editMain re-derives. */
export function follows(roles, role) {
  const b = roles?.[role];
  if (!b) return null;
  if (FAN_OUT.wood.includes(role)) return woodFamilyOf(b) === mainOf(roles).wood ? 'wood' : null;
  if (FAN_OUT.stone.includes(role)) return sameStone(b, mainOf(roles).stone) ? 'stone' : null;
  return null;
}

function sameStone(block, stone) {
  const fam = stoneFamilyOf(stone);
  return fam ? stoneFamilyOf(block) === fam : qualify(fullBlockOf(block)) === qualify(stone);
}

/**
 * One main row changed: the roles it drives that still follow it are re-derived; every other role stays as the Style (or the
 * player) set it. `field` is wood, stone, roof or accent; `value` a WOODS name (wood, accent), a full block with stairs and slab
 * (stone), or a wood name or such a block (roof). Throws when the value cannot be that row. Returns a new roles object (the
 * input is not changed); role ids are `minecraft:`-qualified.
 * - wood: wall, frame and floor of the old wood's family move to the same part of the new wood (planks stay planks, a stripped
 *   log stays a stripped log), else to the part palette() gives the role;
 * - stone: foundation and trim of the old stone's family move to the new stone and its trim (stoneTrimOf);
 * - roof: the roof role becomes the block (a wood's planks for a wood name); accent: the wood's planks.
 */
export function editMain(roles, field, value) {
  if (!MAIN_FIELDS.includes(field)) throw new Error(`editMain: field must be one of ${MAIN_FIELDS.join(', ')} (got ${JSON.stringify(field)})`);
  const q = Object.fromEntries(Object.entries(roles ?? {}).map(([k, v]) => [k, typeof v === 'string' ? qualify(v) : v]));
  const main = mainOf(q);
  const following = field === 'wood' ? FAN_OUT.wood.filter((r) => q[r] && woodFamilyOf(q[r]) === main.wood)
    : field === 'stone' ? FAN_OUT.stone.filter((r) => q[r] && sameStone(q[r], main.stone)) : [];
  return editMainFrom(roles, field, value, main[field], following);
}

/**
 * (Style unification U2) The core of editMain with the old row value and the roles that follow it given, not read back from the
 * roles: a Style form stores both (StyleForm), so a role set by hand never moves a main row (mainOf is lossy). `old` is the row's
 * value before the edit (a short name); `following` the roles that re-derive (only wood's or stone's FAN_OUT roles count). Returns
 * a new roles object, `minecraft:`-qualified; throws when the value cannot be that row.
 */
export function editMainFrom(roles, field, value, old, following) {
  if (!MAIN_FIELDS.includes(field)) throw new Error(`editMain: field must be one of ${MAIN_FIELDS.join(', ')} (got ${JSON.stringify(field)})`);
  if (typeof value !== 'string' || !/^[a-z0-9_:]+$/.test(value)) throw new Error(`editMain: ${field} must be a wood or block name`);
  const out = Object.fromEntries(Object.entries(roles ?? {}).map(([k, v]) => [k, typeof v === 'string' ? qualify(v) : v]));
  const v = short(value);
  const fol = new Set(following ?? []);
  if (field === 'wood' || field === 'accent') {
    if (!WOODS.includes(v)) throw new Error(`editMain: unknown wood '${value}' (one of ${WOODS.join(', ')})`);
    if (field === 'accent') {
      out.accent = woodSetOf(v).planks;
      return out;
    }
    const from = WOODS.includes(short(old ?? '')) ? woodParts(short(old)) : {};
    const to = woodParts(v);
    for (const role of FAN_OUT.wood) {
      if (!out[role] || !fol.has(role)) continue;
      const part = WOOD_PARTS.find((k) => from[k] === out[role]) ?? WOOD_PART_OF_ROLE[role];
      out[role] = to[part] ?? to[WOOD_PART_OF_ROLE[role]];
    }
    return out;
  }
  if (field === 'stone') {
    const s = qualify(v);
    if (!isStoneBlock(s)) throw new Error(`editMain: stone '${value}' is not a full vanilla block with stairs and slab variants`);
    for (const role of FAN_OUT.stone) {
      if (!out[role] || !fol.has(role)) continue;
      out[role] = role === 'foundation' ? s : stoneTrimOf(s);
    }
    return out;
  }
  const roof = WOODS.includes(v) ? qualify(`${v}_planks`) : qualify(v);
  if (!isRoofBlock(roof)) throw new Error(`editMain: roof '${value}' has no stairs/slab variant (pick a wood, or a block with both)`);
  out.roof = roof;
  return out;
}

/**
 * Where each role's block comes from (docs/STYLE-UNIFY.md §1): `follows_wood` / `follows_stone` (a wood or stone role that
 * still follows its main row), else `style` (equal to the base Style's role, or no base given), else `hand`.
 * @param {Record<string,string>} roles
 * @param {Record<string,string>} [base] the roles of the Style these started from
 * @returns {Record<string, 'style'|'follows_wood'|'follows_stone'|'hand'>}
 */
export function provenanceOf(roles, base) {
  const out = {};
  for (const [role, b] of Object.entries(roles ?? {})) {
    const f = follows(roles, role);
    if (f) out[role] = `follows_${f}`;
    else if (!base || (base[role] !== undefined && qualify(base[role]) === qualify(b))) out[role] = 'style';
    else out[role] = 'hand';
  }
  return out;
}

/** The roles four main inputs give with nothing else set (palette({ wood, stone, roof, accent }).roles). */
export function fanOut(inputs) {
  const { wood = 'oak', stone = 'cobblestone', roof, accent } = inputs ?? {};
  const w = woodParts(wood);
  const s = qualify(stone);
  const roofName = roof ?? (DARK_WOODS.includes(wood) ? (wood === 'dark_oak' ? 'spruce' : 'dark_oak') : 'dark_oak');
  const roofBlock = WOODS.includes(short(roofName)) ? qualify(`${short(roofName)}_planks`) : qualify(roofName);
  const acc = accent ?? (WOODS.includes(short(roofName)) ? short(roofName) : wood);
  return {
    wall: w.planks, wall_alt: FIXED_ROLES.wall_alt, trim: stoneTrimOf(s), roof: roofBlock, floor: w.planks, frame: w.log,
    accent: woodSetOf(acc).planks, light: FIXED_ROLES.light, glass: FIXED_ROLES.glass, foundation: s, path: FIXED_ROLES.path,
  };
}

/**
 * The fan-out as data, for the mod (no node there): every lookup mainOf / editMain / provenanceOf make, over the vanilla blocks.
 * `woods`: each wood's parts; `woodOf`: block -> wood family (kit.mjs woodFamilyOf); `stoneOf`: block -> stone family
 * (stoneFamilyOf); `stairsSlab`: every block with stairs and slab variants -> { cube, trim } (trim only for a full block);
 * `fullOf`: a stairs / slab / wall id -> its full block (fullBlockOf). Deterministic (sorted keys).
 */
export function styleTable() {
  const sorted = (entries) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const ids = Object.keys(BLOCKS).filter((k) => k.startsWith('minecraft:')).sort();
  const woodOf = [];
  const stoneOf = [];
  const stairsSlab = [];
  const fullOf = [];
  for (const id of ids) {
    const w = woodFamilyOf(id);
    if (w) woodOf.push([id, w]);
    const s = stoneFamilyOf(id);
    if (s) stoneOf.push([id, s]);
    if (isRoofBlock(id)) {
      const cube = isCube(normalize(id));
      stairsSlab.push([id, cube ? { cube: true, trim: stoneTrimOf(id) } : { cube: false }]);
    }
    const f = fullBlockOf(id);
    if (f !== id) fullOf.push([id, f]);
  }
  return {
    format: 1,
    note: 'generated by kit/lib/styles.mjs styleTable() (tools/gen-palettes.mjs): the Style fan-out for mod/.../library/StyleRoles.java',
    mainFields: [...MAIN_FIELDS],
    coreRoles: [...CORE_ROLES],
    fanOut: structuredClone(FAN_OUT),
    fixed: { ...FIXED_ROLES },
    darkWoods: [...DARK_WOODS],
    woodPartOfRole: { ...WOOD_PART_OF_ROLE },
    woodParts: [...WOOD_PARTS],
    woods: Object.fromEntries(WOODS.map((w) => [w, woodParts(w)])),
    woodOf: sorted(woodOf),
    stoneOf: sorted(stoneOf),
    stairsSlab: sorted(stairsSlab),
    fullOf: sorted(fullOf),
  };
}

/** The built-in Styles as the mod lists them: name -> { inputs, roles, tags, suggestedFeatures, blurb }. */
export function builtinStyles() {
  return Object.fromEntries(Object.keys(PALETTE_PRESETS).map((n) => {
    const m = STYLE_META[n] ?? { tags: [], suggestedFeatures: [], blurb: '' };
    return [n, { ...PALETTES[n].inputs, roles: { ...PALETTES[n].roles }, tags: [...m.tags], suggestedFeatures: [...m.suggestedFeatures], blurb: m.blurb }];
  }));
}

// ------------------------------------------------------------------ the Style form (Style unification U2)
//
// The model behind both design editor modes (docs/STYLE-UNIFY.md §1, §3; docs/CONTRACT.md "Style unification U2"), the JS twin of
// mod/.../library/StyleForm.java. Plain data in, plain data out: formNew / formApply return new states, formView the state as the
// editor and the wire see it. tools/gen-palettes.mjs --parity records op sequences and their views (kit/test/fixtures/style-parity.json
// `forms`); StyleFormTest replays them in Java.
//
// - A Style: { id, name, version, kind: 'preset' | 'bible' | 'inputs', roles, suggestedFeatures, tags }. `preset` is a built-in Style
//   (a palette preset), `bible` an installed one (Claude-made or hand-made), `inputs` an entry's own palette inputs (no Style; id null).
// - State: the picked Style (`base`), the roles, the four main rows (`main`) and each role's provenance (`prov`), all STORED: picking a
//   Style computes them once; a main-row edit re-derives only the roles whose stored provenance follows that row (editMainFrom), so a
//   role set by hand never moves a main row. Features (new mode): the list, which came from the Style (`from`), which the player
//   picked (`mine`) and which the player turned off (`off`).
// - Swapping Styles (new mode): the player's own picks stay, untouched suggestions are replaced by the new Style's, a feature the player
//   turned off is never added back; at most 6. Picking the same Style again reverts the materials only.
// - Output: new mode `{palette: {bible: {id, version, roles}}}` (withStyle when unedited, a custom mix based on the Style when not);
//   variant mode, only when the Style or roles changed: a preset's name (unedited preset), the four inputs (roles equal to their plain
//   fan-out), `bible: id` (an unedited installed Style: the 4b re-skin), else the roles inline based on the Style.
// - Save as style: a bible.save request {name, roles, tags, suggestedFeatures, basedOn, origin: 'hand'}.
// - (U5b) Parts: a Style with its own parts (`parts`: how many; `partsDefault`: on when picked, as a Claude-made Style is) offers
//   "Use this style's parts" in new mode (['parts', on]). On, and the materials still the Style's, the request is set mode
//   `{bible: id, bibleVersion: version}` instead of the palette; a custom mix sends the palette (the parts read the Style's own
//   roles). Picking another Style resets it to that Style's default; the hybrid (off) is the default for every other Style.

export const FORM_MODES = Object.freeze(['new', 'variant']);
const ROLE_ID = /^[a-z][a-z0-9_]{0,31}$/;
const qroles = (r) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, qualify(v)]));
const sameMap = (a, b) => {
  const ka = Object.keys(a ?? {});
  return ka.length === Object.keys(b ?? {}).length && ka.every((k) => (b ?? {})[k] === a[k]);
};
const styleKey = (s) => (s ? `${s.kind}:${s.id ?? ''}:${s.version ?? 1}:${s.kind === 'inputs' ? JSON.stringify(s.inputs ?? {}) : ''}` : '');

/** A Style as the form takes it (see above); `inputs` kind: `{ inputs: {wood, stone, roof, accent} }` gives the roles (fanOut). */
export function formStyle(s) {
  const kind = s.kind ?? 'bible';
  const roles = kind === 'inputs' ? fanOut(s.inputs ?? {}) : qroles(s.roles);
  return {
    id: kind === 'inputs' ? null : s.id, name: s.name ?? s.id ?? 'custom', version: s.version ?? 1, kind,
    ...(kind === 'inputs' ? { inputs: { ...(s.inputs ?? {}) } } : {}),
    roles, suggestedFeatures: [...(s.suggestedFeatures ?? [])].slice(0, MAX_SUGGESTED_FEATURES), tags: [...(s.tags ?? [])],
    // (U5b) its own parts, and whether "Use this style's parts" starts on
    parts: kind !== 'inputs' && Number.isInteger(s.parts) && s.parts > 0 ? s.parts : 0,
    partsDefault: kind !== 'inputs' && Number.isInteger(s.parts) && s.parts > 0 && s.partsDefault === true,
  };
}

/** A built-in Style (a palette preset) with its metadata. */
export function presetStyle(name) {
  const p = PALETTES[name];
  if (!p) throw new Error(`no built-in Style '${name}'`);
  const m = STYLE_META[name] ?? { tags: [], suggestedFeatures: [] };
  return formStyle({ id: name, name: name.charAt(0).toUpperCase() + name.slice(1), version: 1, kind: 'preset', roles: p.roles, suggestedFeatures: m.suggestedFeatures, tags: m.tags });
}

function materials(st, s) {
  st.roles = { ...s.roles };
  st.main = mainOf(st.roles);
  st.prov = provenanceOf(st.roles, st.roles);
}

/** A new form: `mode` new or variant, `style` (formStyle) or null, `features` the new mode's starting features (the player's). */
export function formNew({ mode = 'new', style = null, features = [] } = {}) {
  if (!FORM_MODES.includes(mode)) throw new Error(`form mode must be new or variant (got ${mode})`);
  const st = { mode, base: null, roles: {}, main: null, prov: {}, features: [], from: [], mine: [], off: [], original: null, useParts: false };
  if (style) {
    st.base = formStyle(style);
    materials(st, st.base);
    st.useParts = mode === 'new' && st.base.partsDefault;
  }
  if (mode === 'new') {
    st.features = [...new Set(features)].slice(0, MAX_SUGGESTED_FEATURES);
    st.mine = [...st.features];
  }
  if (mode === 'variant') st.original = { key: styleKey(st.base), roles: { ...st.roles } };
  return st;
}

const clone = (st) => structuredClone(st);

/**
 * One operation: ['pick', style] | ['unpick'] | ['revert'] | ['main', field, value] | ['role', role, block] | ['feature', id] (toggle)
 * | ['features', [ids]] (set the list, the player's). Returns a new state; throws on an invalid one (the state is unchanged).
 */
export function formApply(state, op) {
  const st = clone(state);
  const [kind, a, b] = op;
  switch (kind) {
    case 'pick': {
      const s = formStyle(a);
      const same = styleKey(s) === styleKey(st.base);
      st.base = s;
      materials(st, s);
      st.useParts = st.mode === 'new' && s.parts > 0 && (same ? st.useParts : s.partsDefault);
      if (st.mode === 'new' && !same) {
        const next = st.features.filter((f) => st.mine.includes(f));
        const from = [];
        for (const f of s.suggestedFeatures) {
          if (next.length < MAX_SUGGESTED_FEATURES && !next.includes(f) && !st.off.includes(f)) {
            next.push(f);
            from.push(f);
          }
        }
        st.features = next;
        st.from = from;
      }
      return st;
    }
    case 'unpick':
      st.useParts = false;
      st.base = null;
      st.roles = {};
      st.main = null;
      st.prov = {};
      if (st.mode === 'new') {
        st.features = st.features.filter((f) => !st.from.includes(f));
        st.from = [];
      }
      return st;
    case 'revert':
      if (st.base) materials(st, st.base);
      return st;
    case 'main': {
      if (!st.base) throw new Error('pick a Style first');
      if (!MAIN_FIELDS.includes(a)) throw new Error(`editMain: field must be one of ${MAIN_FIELDS.join(', ')} (got ${JSON.stringify(a)})`);
      const following = Object.keys(st.prov).filter((r) => st.prov[r] === `follows_${a}`);
      st.roles = editMainFrom(st.roles, a, b, st.main[a], following);
      const v = short(b);
      st.main[a] = a === 'stone' ? short(qualify(v)) : a === 'roof' && !WOODS.includes(v) ? short(qualify(v)) : v;
      if (a === 'roof' || a === 'accent') st.prov[a] = st.roles[a] === st.base.roles[a] ? 'style' : 'hand';
      return st;
    }
    case 'role': {
      if (!st.base) throw new Error('pick a Style first');
      if (st.base.kind === 'inputs') throw new Error('pick a Style to set a single role (these are plain palette inputs)');
      if (typeof a !== 'string' || !ROLE_ID.test(a)) throw new Error(`role must match ${ROLE_ID}`);
      if (typeof b !== 'string' || !/^[a-z0-9_:]+$/.test(b)) throw new Error(`role ${a}: a block id`);
      st.roles[a] = qualify(b);
      st.prov[a] = 'hand';
      return st;
    }
    case 'feature': {
      if (st.mode !== 'new') throw new Error('a variant\'s features are fixed (they are in the design\'s code)');
      if (!FEATURE_IDS.includes(a)) throw new Error(`unknown feature '${a}'`);
      if (st.features.includes(a)) {
        st.features = st.features.filter((f) => f !== a);
        st.from = st.from.filter((f) => f !== a);
        st.mine = st.mine.filter((f) => f !== a);
        if (!st.off.includes(a)) st.off.push(a);
      } else {
        if (st.features.length >= MAX_SUGGESTED_FEATURES) throw new Error(`at most ${MAX_SUGGESTED_FEATURES} features`);
        st.features.push(a);
        if (!st.mine.includes(a)) st.mine.push(a);
        st.off = st.off.filter((f) => f !== a);
      }
      return st;
    }
    case 'features': {
      if (st.mode !== 'new') throw new Error('a variant\'s features are fixed (they are in the design\'s code)');
      const list = [...new Set(a ?? [])];
      for (const f of list) if (!FEATURE_IDS.includes(f)) throw new Error(`unknown feature '${f}'`);
      if (list.length > MAX_SUGGESTED_FEATURES) throw new Error(`at most ${MAX_SUGGESTED_FEATURES} features`);
      st.off = [...new Set([...st.off.filter((f) => !list.includes(f)), ...st.features.filter((f) => !list.includes(f))])];
      st.features = list;
      st.mine = [...list];
      st.from = [];
      return st;
    }
    case 'parts': {
      if (st.mode !== 'new') throw new Error('a variant\'s parts are in its code');
      if (!st.base) throw new Error('pick a Style first');
      if (!(st.base.parts > 0)) throw new Error('this Style has no parts of its own (Add parts… first)');
      st.useParts = a === true;
      return st;
    }
    default:
      throw new Error(`unknown form op '${kind}'`);
  }
}

/** Whether the materials differ from the picked Style's: a custom mix. */
export function formMix(st) {
  return !!st.base && (!sameMap(st.roles, st.base.roles) || !sameMap(st.main, mainOf(st.base.roles)));
}

/** (U5b) Whether the request runs the Style's parts (set mode): new mode, a Style with parts, the toggle on, its own materials. */
export function formPartsOn(st) {
  return st.mode === 'new' && !!st.base && st.base.parts > 0 && st.useParts === true && !formMix(st);
}

/**
 * The materials half of the request (see above): new mode `{palette}`, `{bible, bibleVersion}` (the Style's parts) or `{}`;
 * variant mode `{palette}`, `{bible}` or `{}` (unchanged).
 */
export function formRequest(st) {
  const b = st.base;
  if (!b) return {};
  const inline = () => ({ palette: { bible: { id: b.id, version: b.version, roles: { ...st.roles } } } });
  const inputs = () => ({ palette: Object.fromEntries(MAIN_FIELDS.map((f) => [f, st.main[f]])) });
  if (st.mode === 'new' && formPartsOn(st)) return { bible: b.id, bibleVersion: b.version };
  if (st.mode === 'new') return b.id ? inline() : inputs();
  if (styleKey(b) === st.original.key && sameMap(st.roles, st.original.roles)) return {};
  if (b.kind === 'preset' && PALETTES[b.id] && sameMap(st.roles, qroles(PALETTES[b.id].roles))) return { palette: b.id };
  if ((b.kind === 'preset' || b.kind === 'inputs') && sameMap(st.roles, fanOut(st.main))) return inputs();
  if (b.kind === 'bible' && sameMap(st.roles, b.roles)) return { bible: b.id };
  return b.id ? inline() : inputs();
}

/** "Save as style…": the bible.save request's Style (bibleId absent: always a new hand-made Style), or null without a Style. */
export function formSaveRequest(st, name) {
  const b = st.base;
  if (!b) return null;
  return {
    name: name ?? (formMix(st) ? `${b.name} mix` : `${b.name} copy`),
    roles: { ...st.roles },
    tags: [...b.tags],
    suggestedFeatures: st.mode === 'new' ? st.features.slice(0, MAX_SUGGESTED_FEATURES) : [...b.suggestedFeatures],
    ...(b.id && b.kind !== 'inputs' ? { basedOn: { id: b.id, version: b.version } } : {}),
    origin: 'hand',
  };
}

/** The state as the editor and the wire see it (what the parity cases record). */
export function formView(st) {
  const b = st.base;
  const bm = b ? mainOf(b.roles) : null;
  return {
    mode: st.mode,
    style: b ? { id: b.id, name: b.name, version: b.version, kind: b.kind } : null,
    mix: formMix(st),
    main: st.main ? { ...st.main } : null,
    mainProvenance: st.main ? Object.fromEntries(MAIN_FIELDS.map((f) => [f, st.main[f] === bm[f] ? 'style' : 'hand'])) : null,
    roles: { ...st.roles },
    provenance: { ...st.prov },
    features: [...st.features],
    featureProvenance: Object.fromEntries(st.features.map((f) => [f, st.from.includes(f) ? 'style' : 'hand'])),
    changed: st.mode === 'variant' ? Object.keys(formRequest(st)).length > 0 : null,
    parts: b ? b.parts : 0,
    useParts: st.useParts === true,
    partsOn: formPartsOn(st),
    request: formRequest(st),
    save: formSaveRequest(st),
  };
}
