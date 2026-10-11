// flat_village (docs/CONTRACT.md "Phase 6c slice V: flat village (C10)"): on a flat claim, Steward's lots on both sides of one
// straight street (VillageLayout's geometry and scoring, ported), the shared space at the street's middle (a square, or a well
// green for small claims), a lane from each lot's entrance to the street or the square, a few props, and the villager rules that
// are cheap on flat ground. No carve, add, terrace, ring, form or cavern op: lot pads (cut and fill at most 2) and surface-layer
// swaps only. Nothing is forced: a lot that needs more goes to `unplaced`; a street that can't be a ground road fails the plan.
//
// Stages: ground (pads, the shared space, verges, lanes), street (the two road items), lots, props (into air only).
// Params: lots (the caller's lot list, region programs only), shared, squareSize, laneWidth, lamps, bell, requireAll.
import { region } from '../lib/region/program.mjs';
import { STREET_RULES, streetLayout } from '../lib/region/village.mjs';
import { emitProps, planProps } from '../lib/region/props.mjs';

export const id = 'flat_village';
export const description = 'A flat village: lots on one street, a square or well green, lanes, props, villager rules (6c V).';
/** Not in Regions.design's pick (that would change the pick prompt and 6b's pick accuracy: a paid re-run, deferred). */
export const catalogue = false;
/** The default look (a bible's roles win): gravel lanes and paving, stone-brick foundations, lanterns. */
export const roles = { path: 'minecraft:gravel', foundation: 'minecraft:stone_bricks', light: 'minecraft:lantern' };

export const params = {
  lots: { type: 'lots', default: [], label: 'Lots' },
  shared: { type: 'enum', options: ['square', 'well'], default: 'square', label: 'Shared space' },
  squareSize: { type: 'int', min: 9, max: 15, default: 11, label: 'Square size' },
  laneWidth: { type: 'int', min: 1, max: 3, default: 2, label: 'Lane width' },
  lamps: { type: 'enum', options: ['none', 'few', 'street'], default: 'street', label: 'Lamps' },
  bell: { type: 'bool', default: false, label: 'Place a bell' },
  requireAll: { type: 'bool', default: false, label: 'Every lot or fail' },
};

export default function (ctx) {
  return build(ctx);
}

/** The program, with test hooks for the broken variants (kit/test/fixtures/village): `_unsafe: {noLane, laneIntoBox}`. */
export function build(ctx, { _unsafe = {}, after } = {}) {
  const r = region(ctx);
  const p = ctx.params;
  r.stages(['ground', 'street', 'lots', 'props']);
  if (!p.lots.length) throw new Error('flat village: params.lots is empty');
  const shared = p.shared === 'square' ? { kind: 'square', size: p.squareSize } : { kind: 'well', size: 7 };
  const keepOut = ctx.keepOut;
  let props = null;
  const L = streetLayout(r, p.lots, {
    rules: STREET_RULES, shared, laneWidth: p.laneWidth, requireAll: p.requireAll, maxHeight: 32, _unsafe,
    planProps: ({ o, sh, res, lots }) => (props = planProps(r, { o, sh, res, lots, laneWidth: p.laneWidth, lamps: p.lamps, bell: p.bell, keepOut, rng: ctx.rng('props') })),
  });
  emitProps(r, props, { stage: 'props' });
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
  if (after) after(r, L);
  return r;
}
