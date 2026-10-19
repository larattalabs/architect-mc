// (6c VOC-b) Rarity budgets and the vocabulary rules' shared parts (docs/CONTRACT.md "Phase 6c slice VOC" §4, §5): a bible's style
// (its `rarity` member, opted in or not, and the blocks that are its own), the rarity measure of a block histogram (a design's cells,
// a region's written cells, a plan part's), and the cell predicates the building and region rules share (pair halves, waterlogged
// cells, the hazards.json reaches). VOC-b owns this module; the vocabulary's facts come from kit/lib/vocab.mjs (VOC-a's interface).
//
// The measure (§4.1, Steward's S-VOC-3):
//   - `cells` counts the measured cells (a design's non-air cells; a region's non-terrain written cells), fittings included;
//   - the style's own blocks (the blocks its roles name and the palette built from them, its patterns' mats, `allow`) are exempt from
//     the tier shares, the rare-family count and the colour checks; a `families` cap counts every cell of its family (an explicit
//     cap); precious cells are counted everywhere, the style's own included;
//   - `over` lists each budget the numbers break: {rule: 'rarity' | 'coherence', what, value, max}.
import { BLOCKS, qualify } from '../blocks.mjs';
import { palette } from '../kit.mjs';
import { patternMats } from '../pattern.mjs';
import { colourOf, drifts, familyOf, tierOf, HAZARDS } from '../vocab.mjs';
import { RARITY_DEFAULTS, allowedBlocks, validateRarity } from './rarity.mjs';

const round3 = (x) => Math.round(x * 1000) / 1000;
const base = (s) => qualify(String(s).replace(/\[.*$/, ''));

/**
 * A bible's style for the budgets: `{opted, rarity, own}`. `opted`: the bible carries a valid `rarity` (budget overruns are then
 * warnings and region findings); `rarity`: its budget with the defaults filled in (the defaults alone when it carries none);
 * `own`: the style's own blocks (a Set of qualified ids). A null bible: not opted, the defaults, nothing of its own.
 */
export function styleOf(bible) {
  const own = new Set();
  const roles = bible?.roles && typeof bible.roles === 'object' ? bible.roles : {};
  for (const v of Object.values(roles)) if (typeof v === 'string') own.add(base(v));
  try {
    const p = palette({ bible: { id: 'style', version: 1, roles } });
    for (const v of Object.values(p)) if (typeof v === 'string' && v.startsWith('minecraft:') && BLOCKS[base(v)]) own.add(base(v));
  } catch { /* roles that build no palette (a region bible): the roles alone */ }
  if (bible?.patterns && typeof bible.patterns === 'object') {
    for (const spec of Object.values(bible.patterns)) {
      let mats = [];
      try { mats = patternMats(spec); } catch { /* an invalid pattern: validateBible says so */ }
      for (const m of mats) {
        if (m === null || m === undefined) continue;
        const r = roles[m];
        own.add(base(typeof r === 'string' ? r : m));
      }
    }
  }
  let rarity = { ...RARITY_DEFAULTS };
  let opted = false;
  if (bible?.rarity !== undefined && bible?.rarity !== null) {
    const v = validateRarity(bible.rarity);
    if (v.rarity) { rarity = v.rarity; opted = true; for (const b of allowedBlocks(v.rarity)) own.add(b); }
  }
  return { opted, rarity, own };
}

/**
 * The rarity measure of a histogram `{block (qualified, no state): cells}` against a style (styleOf). `scope`: 'building' (precious
 * against preciousMax) or 'region' (preciousRegionMax). Returns the contract's shape (§4.4): {cells, uncommon, rare, precious, shares:
 * {uncommon, rare}, preciousBlocks, colours, rareFamilies, over}.
 */
export function measureRarity(hist, style, scope = 'building') {
  const r = style?.rarity ?? RARITY_DEFAULTS;
  const own = style?.own ?? new Set();
  let cells = 0, uncommon = 0, rare = 0, precious = 0;
  const preciousBlocks = {};
  const colours = new Set();
  const rareFamilies = new Set();
  const famCells = {};
  for (const [b, n] of Object.entries(hist).sort(([a], [c]) => (a < c ? -1 : a > c ? 1 : 0))) {
    if (!n) continue;
    cells += n;
    const t = tierOf(b);
    const mine = own.has(b);
    const fam = familyOf(b);
    if (fam) famCells[fam] = (famCells[fam] ?? 0) + n;
    if (t === 'precious') { precious += n; preciousBlocks[b] = (preciousBlocks[b] ?? 0) + n; }
    if (mine) continue;
    if (t === 'uncommon') uncommon += n;
    else if (t === 'rare') rare += n;
    if ((t === 'rare' || t === 'precious') && fam) rareFamilies.add(fam);
    const col = colourOf(b);
    if (col) colours.add(col);
  }
  const shares = { uncommon: cells ? round3(uncommon / cells) : 0, rare: cells ? round3(rare / cells) : 0 };
  const over = [];
  if (shares.uncommon > r.uncommonShareMax) over.push({ rule: 'rarity', what: 'uncommonShare', value: shares.uncommon, max: r.uncommonShareMax });
  if (shares.rare > r.rareShareMax) over.push({ rule: 'rarity', what: 'rareShare', value: shares.rare, max: r.rareShareMax });
  const pmax = scope === 'region' ? r.preciousRegionMax : r.preciousMax;
  if (precious > pmax) over.push({ rule: 'rarity', what: scope === 'region' ? 'preciousRegion' : 'precious', value: precious, max: pmax });
  for (const [f, max] of Object.entries(r.families ?? {}).sort()) {
    const s = cells ? round3((famCells[f] ?? 0) / cells) : 0;
    if (s > max) over.push({ rule: 'rarity', what: `family:${f}`, value: s, max });
  }
  const cl = [...colours].sort();
  if (cl.length > r.coloursMax) over.push({ rule: 'coherence', what: 'colours', value: cl.length, max: r.coloursMax });
  if (Array.isArray(r.colours)) {
    const out = cl.filter((c) => !r.colours.includes(c));
    if (out.length) over.push({ rule: 'coherence', what: `colour:${out.join(',')}`, value: out.length, max: 0 });
  }
  const rf = [...rareFamilies].sort();
  if (rf.length > r.rareFamiliesMax) over.push({ rule: 'coherence', what: 'rareFamilies', value: rf.length, max: r.rareFamiliesMax });
  return { cells, uncommon, rare, precious, shares, preciousBlocks, colours: cl, rareFamilies: rf, over };
}

/** The building warnings of a measure (`rarity: ...`, `coherence: ...`), for an opted-in bible only. */
export function rarityWarnings(m) {
  const out = [];
  for (const o of m.over) {
    if (o.what === 'uncommonShare') out.push(`rarity: uncommon blocks are ${o.value} of the cells, over the bible's uncommonShareMax ${o.max} (dyed, Nether and metal blocks outside the style's own: use the style's blocks)`);
    else if (o.what === 'rareShare') out.push(`rarity: rare blocks are ${o.value} of the cells, over the bible's rareShareMax ${o.max} (gold, amethyst, prismarine, End and deep-dark blocks outside the style's own)`);
    else if (o.what === 'precious') out.push(`rarity: ${o.value} precious block(s) (${Object.entries(m.preciousBlocks).map(([b, n]) => `${b.replace('minecraft:', '')} ${n}`).join(', ')}), over the bible's preciousMax ${o.max}`);
    else if (o.what.startsWith('family:')) out.push(`rarity: the ${o.what.slice(7)} family is ${o.value} of the cells, over the bible's cap ${o.max}`);
    else if (o.what === 'colours') out.push(`coherence: ${o.value} dye colours (${m.colours.join(', ')}), over the bible's coloursMax ${o.max}`);
    else if (o.what.startsWith('colour:')) out.push(`coherence: colour(s) ${o.what.slice(7)} outside the bible's colours`);
    else if (o.what === 'rareFamilies') out.push(`coherence: ${o.value} rare families (${m.rareFamilies.join(', ')}), over the bible's rareFamiliesMax ${o.max}`);
  }
  return out;
}

// ------------------------------------------------------------------ cell predicates (the `state` and `hazard` rules, M27, M20)

/** A pair half: {dx, dy, dz} to its other half, or null. Doors and tall plants (`half` upper/lower), beds (`part` head/foot). */
export function pairOffset(state) {
  const name = base(state.name);
  const row = BLOCKS[name];
  if (!row?.props) return null;
  const p = state.props ?? {};
  if (row.props.half?.includes('upper') && row.props.half.includes('lower')) {
    const h = p.half ?? row.defaults?.half;
    if (h === 'upper') return [0, -1, 0];
    // a pitcher crop under age 3 has no upper half
    if (name === 'minecraft:pitcher_crop' && Number(p.age ?? row.defaults?.age ?? 0) < 3) return null;
    return [0, 1, 0];
  }
  if (row.props.part?.includes('head') && row.props.part.includes('foot')) {
    const f = p.facing ?? row.defaults?.facing;
    const v = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[f];
    if (!v) return null;
    return (p.part ?? row.defaults?.part) === 'head' ? [-v[0], 0, -v[1]] : [v[0], 0, v[1]];
  }
  return null;
}

/** Is `other` the pair of `state` (the same block, the other half)? */
export function isPairOf(state, other) {
  if (!other || base(other.name) !== base(state.name)) return false;
  const row = BLOCKS[base(state.name)];
  const p = state.props ?? {}, q = other.props ?? {};
  if (row.props.half) return (p.half ?? row.defaults?.half) !== (q.half ?? row.defaults?.half);
  return (p.part ?? row.defaults?.part) !== (q.part ?? row.defaults?.part);
}

/** A waterlogged=true state. */
export const isWaterlogged = (state) => (state.props ?? {}).waterlogged === 'true';

/** The hazards.json rows by kind, read once (the probe may correct the table: never hard-code a reach). */
export const HAZARD = Object.freeze(Object.fromEntries(HAZARDS.rows.map((r) => [r.kind, r])));
/** The fire reach (hazards.json's `fire` row; M20's FIRE_REACH). */
export const FIRE_REACH_TABLE = Object.freeze({ ...HAZARD.fire.reach.fire });
/** The hazard kind of a block (concrete_powder, sponge, magma, soul_sand), or null; fire and lava are `fire` and `lava`. */
export function hazardKindOf(name) {
  const n = base(name);
  if (/_concrete_powder$/.test(n)) return 'concrete_powder';
  if (n === 'minecraft:sponge') return 'sponge';
  if (n === 'minecraft:magma_block') return 'magma';
  if (n === 'minecraft:soul_sand') return 'soul_sand';
  if (n === 'minecraft:fire' || n === 'minecraft:soul_fire') return 'fire';
  if (n === 'minecraft:lava') return 'lava';
  return null;
}

/**
 * The cells within a water reach of a hazards.json row: `{face}` (face-adjacent), `{above}` (the cell above), `{taxicab: n}` (every
 * cell within n steps). Returns [dx, dy, dz] offsets (deterministic order).
 */
export function waterReachOffsets(reach) {
  if (reach.face) return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  if (reach.above) return [[0, 1, 0]];
  const n = reach.taxicab ?? 0;
  const out = [];
  for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (let dz = -n; dz <= n; dz++) {
    const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    if (d >= 1 && d <= n) out.push([dx, dy, dz]);
  }
  return out;
}

// ------------------------------------------------------------------ drift (state:drift, M27:drift)

/** A log (or stem, wood, hyphae): what keeps leaves from decaying within 6 steps (26.3 LeavesBlock's distance). */
export const isLogName = (name) => /_(log|wood|stem|hyphae)$/.test(base(name));
/** The leaves' reach (LeavesBlock.DECAY_DISTANCE - 1): a log within 6 taxicab steps keeps them. */
export const LEAF_REACH = 6;

/**
 * Does a written state drift where it stands (§5.1 state:drift, §5.2 M27:drift)? vocab.mjs drifts(), less ice and snow (they melt only by
 * a light: M17's concern), and less `persistent=false` leaves with a log within LEAF_REACH (M18's reach: they don't decay). `logNear(dx..)`:
 * is there a log at that offset.
 */
export function driftsWhere(state, logNear) {
  if (!drifts(state)) return false;
  const n = base(state.name);
  if (n === 'minecraft:ice' || n === 'minecraft:snow') return false;
  if (/leaves$/.test(n)) {
    for (let dx = -LEAF_REACH; dx <= LEAF_REACH; dx++) for (let dy = -LEAF_REACH; dy <= LEAF_REACH; dy++) for (let dz = -LEAF_REACH; dz <= LEAF_REACH; dz++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > LEAF_REACH) continue;
      if (logNear(dx, dy, dz)) return false;
    }
  }
  return true;
}
