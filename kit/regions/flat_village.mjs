// flat_village (docs/CONTRACT.md "Phase 6c slice V: flat village (C10)"): on a flat claim, Steward's lots on both sides of one
// straight street (VillageLayout's geometry and scoring, ported), the shared space at the street's middle (a square, or a well
// green for small claims), a lane from each lot's entrance to the street or the square, a few props, and the villager rules that
// are cheap on flat ground. No carve, add, terrace, ring, form or cavern op: lot pads (cut and fill at most 2) and surface-layer
// swaps only. Nothing is forced: a lot that needs more goes to `unplaced`; a street that can't be a ground road fails the plan.
//
// Stages: ground (pads, the shared space, verges, lanes), street (the two road items), lots, props (into air only).
// Params: lots (the caller's lot list, region programs only), shared, squareSize, laneWidth, lamps, bell, orientation (C37), requireAll,
// (6c W) apronLamps (r.lightCover: the lot aprons and batters lit with the bible's fixture; on by default), (6c H) wellWater (the well
// holds a source: off by default, then the stage list and the IR are as before).
import { region } from '../lib/region/program.mjs';
import { STREET_RULES, streetLayout } from '../lib/region/village.mjs';
import { emitProps, lampFixture, planProps } from '../lib/region/props.mjs';
import { lightCover } from '../lib/region/light.mjs';
import { wetWell } from '../lib/fluids/pond.mjs';

export const id = 'flat_village';
export const description = 'A flat village: lots on one street, a square or well green, lanes, props, villager rules (6c V).';
/**
 * (7c TC) In Regions.design's pick (the template catalogue): a pick sends no lot list, so `houses` (pickable) lays that many of the
 * default lots (DEFAULT_LOTS, S7's ten Steward-shaped lots) when `lots` is empty. `lots` is the caller's (not pickable).
 */
export const catalogue = {
  description: 'A flat village: 4-10 house lots (a landmark hall, a trading hall, cottages, workshops, an inn, a farm) along one straight street with a square or a well green at its middle, lanes from every door, lamps and props, and the villager rules. For a plain village, hamlet or farming settlement on flat, open ground (plains, meadow, savanna): it pads lots by at most 2 blocks, so it needs land that is already flat.',
  needs: { minFlat: 0.6, water: 'ok', relief: 'flat (a lot pad cuts or fills at most 2)' },
  claim: { min: [64, 64], max: [192, 192] },
};
/** The default look (a bible's roles win): gravel lanes and paving, stone-brick foundations, lanterns. */
export const roles = { path: 'minecraft:gravel', foundation: 'minecraft:stone_bricks', light: 'minecraft:lantern' };

export const params = {
  lots: { type: 'lots', default: [], label: 'Lots' },
  // (7c TC) with no lots (a template pick): this many of DEFAULT_LOTS; left out of the resolved params at its default (S7's golden holds)
  houses: { type: 'int', min: 4, max: 10, default: 8, omitDefault: true, label: 'Houses (with no lot list)' },
  shared: { type: 'enum', options: ['square', 'well'], default: 'square', label: 'Shared space' },
  squareSize: { type: 'int', min: 9, max: 15, default: 11, label: 'Square size' },
  laneWidth: { type: 'int', min: 1, max: 3, default: 2, label: 'Lane width' },
  lamps: { type: 'enum', options: ['none', 'few', 'street'], default: 'street', label: 'Lamps' },
  bell: { type: 'bool', default: false, label: 'Place a bell' },
  apronLamps: { type: 'bool', default: true, label: 'Light the lot aprons' },
  // (C37) 'ew' / 'ns' force the street's axis (ew: it runs east-west, along x); auto (default, left out of the resolved params) is the old choice
  orientation: { type: 'enum', options: ['auto', 'ew', 'ns'], default: 'auto', omitDefault: true, label: 'Street orientation' },
  requireAll: { type: 'bool', default: false, label: 'Every lot or fail' },
  // (6c H, V's deferred) the well holds water: a 1-cell source in its shaft, its ring the shell (off by default, left out of the
  // resolved params then, so S7's golden holds)
  wellWater: { type: 'bool', default: false, omitDefault: true, label: 'Well with water' },
};

/** (7c TC) The lots a template pick lays (S7's ten, in its order: the landmark hall first), `houses` of them. */
export const DEFAULT_LOTS = Object.freeze([
  { id: 'hall_1', type: 'hall', role: 'landmark hall', size: [18, 20], landmark: true, villager: 'job', brief: 'The village hall: the landmark on the square.' },
  { id: 'trading_hall_1', type: 'trading_hall', role: 'trading hall', size: [14, 17], villager: 'trading_hall', brief: 'A trading hall with stalls.' },
  { id: 'cottage_1', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling', brief: 'A cottage.' },
  { id: 'cottage_2', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling', brief: 'A cottage.' },
  { id: 'smithy_1', type: 'smithy', role: 'smithy', size: [11, 14], villager: 'job', brief: 'A smithy.' },
  { id: 'farm_1', type: 'farm', role: 'farm', size: [14, 17], villager: 'farm', brief: 'A farm.' },
  { id: 'cottage_3', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling', brief: 'A cottage.' },
  { id: 'bakery_1', type: 'bakery', role: 'bakery', size: [11, 14], villager: 'job', brief: 'A bakery.' },
  { id: 'inn_1', type: 'tavern', role: 'inn', size: [14, 17], villager: 'job', brief: 'An inn.' },
  { id: 'cottage_4', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling', brief: 'A cottage.' },
].map((l) => Object.freeze(l)));

export default function (ctx) {
  return build(ctx);
}

/** The program, with test hooks for the broken variants (kit/test/fixtures/village): `_unsafe: {noLane, laneIntoBox}`. */
export function build(ctx, { _unsafe = {}, after } = {}) {
  const r = region(ctx);
  const p = ctx.params;
  r.stages(p.wellWater ? ['ground', 'street', 'lots', 'props', 'fluids'] : ['ground', 'street', 'lots', 'props']);
  // (7c TC) a template pick sends no lots: the first `houses` of the default lots (S7's)
  const lots = p.lots.length ? p.lots : DEFAULT_LOTS.slice(0, p.houses ?? 8).map((l) => structuredClone(l));
  const shared = p.shared === 'square' ? { kind: 'square', size: p.squareSize } : { kind: 'well', size: 7 };
  const keepOut = ctx.keepOut;
  let props = null;
  const L = streetLayout(r, lots, {
    rules: STREET_RULES, shared, laneWidth: p.laneWidth, requireAll: p.requireAll, orientation: p.orientation ?? 'auto', maxHeight: 32, _unsafe,
    planProps: ({ o, sh, res, lots }) => (props = planProps(r, { o, sh, res, lots, laneWidth: p.laneWidth, lamps: p.lamps, bell: p.bell, keepOut, rng: ctx.rng('props'), ...(p.wellWater ? { wellWater: true } : {}) })),
  });
  emitProps(r, props, { stage: 'props' });
  // (6c H) the wet well's body (its shell in `props`, the source in `fluids`)
  if (p.wellWater) for (const w of props.props.filter((q) => q.kind === 'well')) wetWell(r, w, { stage: 'props' });
  // the anchors: the entrance (M2's start) at the bell anchor, the spawn beside it; cameras for the gallery
  r.anchor('entrance', L.res.bell);
  r.anchor('spawn', L.res.bell);
  r.anchor('bell', L.res.bell);
  const c = ctx.claim, cx = Math.floor((c.minX + c.maxX) / 2), cz = Math.floor((c.minZ + c.maxZ) / 2), y = L.res.bell[1];
  const cam = (name, x, z, dy) => { const xx = Math.max(c.minX, Math.min(c.maxX, x)), zz = Math.max(c.minZ, Math.min(c.maxZ, z)); r.anchor(name, [xx, Math.min(c.maxY, y + dy), zz]); };
  cam('cam_high', cx, cz + 6, 70);
  cam('cam_north', cx, c.minZ, 30);
  cam('cam_south', cx, c.maxZ, 30);
  cam('cam_east', c.maxX, cz, 30);
  cam('cam_west', c.minX, cz, 30);
  cam('cam_ground', L.res.bell[0] + 6, L.res.bell[2] + 6, 2);
  // (6c W) light the lot aprons and batters (r.lightCover) with the bible's fixture: the checker's full M5 under 1%
  if (p.apronLamps && !_unsafe.noApronLamps) {
    const reserved = new Set([...L.res.area, ...L.res.golem].map(([x, z]) => `${x},${z}`));
    for (const k of props?.noWalk ?? []) reserved.add(k);
    const cover = lightCover(r, { fixture: lampFixture(r), stage: 'props', keepOut: keepOut ?? [], reserved, laneCells: Object.values(L.laneCells).flat() });
    r.meta.village.apronLamps = { fixture: cover.fixture, perLot: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped };
    r.meta.village.props.push(...cover.lamps.map((l, i) => ({ kind: 'apron_lamp', id: `apron_lamp_${i + 1}`, lot: l.lot, cells: l.cells })));
    r.meta.village.propCounts.apron_lamp = cover.lamps.length;
  }
  if (after) after(r, L);
  return r;
}
