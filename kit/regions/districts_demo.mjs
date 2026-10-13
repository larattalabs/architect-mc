// districts_demo (6c D1, docs/CONTRACT.md "Phase 6c slice D" §4): the districts pass's fixture on S3's pinned claim: three districts
// at the claim's three level bands (a cloister high, a village in the middle, fields low), loopiness 0.15, soul-lantern route lamps
// (S3's snow: T2's melt note). Any claim works; on a flat claim every candidate is one band, so the bands are `any` there.
import { build } from './districts.mjs';

export const id = 'districts_demo';
export const description = 'Three districts at three level bands, joined by routes (6c D1 fixture).';
export const catalogue = false;
export const passes = ['districts', 'route'];
export const roles = { path: 'minecraft:gravel', foundation: 'minecraft:stone_bricks', light: 'minecraft:lantern' };

export const params = {
  loopiness: { type: 'int', min: 0, max: 100, default: 15, label: 'Loopiness (%)' },
  gradePct: { type: 'int', min: 5, max: 100, default: 25, label: 'Grade limit (%)' },
  lamps: { type: 'bool', default: true, label: 'Lamps' },
  routeLamp: { type: 'enum', options: ['bible', 'soul'], default: 'soul', label: 'Route lamps' },
  bands: { type: 'bool', default: true, label: 'Level bands (off: any)' },
};

/** The three districts (cottages and workshops from V's lot types). */
export const DISTRICTS = Object.freeze([
  { id: 'cloister', size: [32, 32], levelBand: 'high', shared: 'well', lots: [{ id: 'chapel_1', type: 'chapel', size: [7, 7] }, { id: 'cell_1', type: 'cottage', size: [7, 7] }] },
  { id: 'village', size: [40, 40], levelBand: 'mid', shared: 'square', lots: [{ id: 'house_1', type: 'house', size: [7, 7] }, { id: 'house_2', type: 'house', size: [7, 7] }, { id: 'smithy_1', type: 'smithy', size: [7, 7] }] },
  { id: 'fields', size: [40, 40], levelBand: 'low', shared: 'square', prefer: ['open'], lots: [{ id: 'barn_1', type: 'barn', size: [7, 7] }, { id: 'cottage_1', type: 'cottage', size: [7, 7] }, { id: 'mill_1', type: 'mill', size: [7, 7] }] },
]);

export default function (ctx) {
  const ds = DISTRICTS.map((d) => ({ ...d, ...(ctx.params.bands ? {} : { levelBand: 'any' }) }));
  return build(ctx, ds);
}
