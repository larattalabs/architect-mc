// fall_island (docs/CONTRACT.md "Phase 8c" §6, §9, slice 8cF): 8c's hand-built fall off a floating island's rim (lip: "form", on the
// island part) into a raised basin 3 deep, through the plan compiler, for the in-game lane (WU, CR; kit/lib/fluids/handriver.mjs). Not
// in the catalogue. On a claim of at least 32x24 with level ground (a flat world).
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';
import { VARIANTS, fallLayout } from '../lib/fluids/handriver.mjs';

export const id = 'fall_island';
export const description = '8c\'s hand-built fall off a floating island (a header pool, a lip run, a 13-high fall, a basin 3 deep) through the plan compiler.';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  variant: { type: 'enum', options: VARIANTS.filter((v) => v !== 'nowash'), default: 'none', label: 'Variant' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** The layout's origin (the island's west edge) for a claim: 8 west of its centre. */
export function fallOrigin(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = (P.cx ?? AUTO) === AUTO ? claim.minX + (W >> 1) : P.cx, cz = (P.cz ?? AUTO) === AUTO ? claim.minZ + (D >> 1) : P.cz;
  return [cx - 8, cz];
}

/** The plan/0 for a claim and params: {plan, anchors, origin}. */
export function fallPlan(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 32 || D < 24) throw new Error(`fall_island needs a claim of at least 32x24 (got ${W}x${D})`);
  const o = fallOrigin(claim, P);
  const variant = P.variant ?? 'none';
  const anchors = { fi_head: [o[0] + 4, 65, o[1]], fi_basin: [o[0] + 12, 65, o[1]] };
  const connectors = [{ id: 'fall', kind: 'channel', label: 'a fall off a floating island into a basin', look: 'built', from: { anchor: 'fi_head' }, to: { anchor: 'fi_basin' },
    ext: { 'architect_mc:unsafe': { handRiver: { role: 'fall', origin: o, variant, on: 'isle' } } } }];
  return { plan: { schemaVersion: 'plan/0', planId: `fall_island_${variant}`, zones: [], forms: [], connectors, rules: [] }, anchors, origin: o };
}

export { fallLayout };

export default function fallIsland(ctx) {
  const { plan, anchors, origin } = fallPlan(ctx.claim, ctx.params);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`fall_island: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  const g = ctx.survey.groundAt(origin[0] - 1, origin[1] + 5);
  r.anchor('cam_high', [origin[0] + 8, Math.min(ctx.claim.maxY, g + 30), origin[1] - 20]);
  return r;
}
