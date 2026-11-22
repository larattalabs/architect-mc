// river_demo (docs/CONTRACT.md "Phase 8c" §9, slice 8cF): 8c's hand-built river, through the plan compiler, for the in-game lane (WU,
// CR): a head reach, a current of 6 runs of 6 cells each ending in a 1-block step (the last over a meadow's natural grass, whose
// flowers are the wash rule's cells) and a terminal pool (kit/lib/fluids/handriver.mjs). The plan is one channel part carrying ext
// 'architect_mc:unsafe' {handRiver}; compiled exactly as Regions.checkPlan does (kit/lib/plan/compile.mjs runCheck). Not in the
// catalogue. On a claim of at least 72x32 with level ground (a flat world).
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';
import { VARIANTS, riverLayout } from '../lib/fluids/handriver.mjs';

export const id = 'river_demo';
export const description = '8c\'s hand-built river (a head reach, a 36-cell current of six riffle runs, a terminal pool) through the plan compiler.';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  variant: { type: 'enum', options: [...VARIANTS], default: 'none', label: 'Variant' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** The layout's origin (the head's west end) for a claim: 26 west of its centre. */
export function riverOrigin(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = (P.cx ?? AUTO) === AUTO ? claim.minX + (W >> 1) : P.cx, cz = (P.cz ?? AUTO) === AUTO ? claim.minZ + (D >> 1) : P.cz;
  return [cx - 26, cz];
}

/** The plan/0 for a claim and params: {plan, anchors, origin}. */
export function riverPlan(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 72 || D < 32) throw new Error(`river_demo needs a claim of at least 72x32 (got ${W}x${D})`);
  const o = riverOrigin(claim, P);
  const variant = P.variant ?? 'none';
  const anchors = { rv_head: [o[0] + 1, 65, o[1]], rv_tail: [o[0] + 50, 65, o[1]] };
  const connectors = [{ id: 'river', kind: 'channel', label: 'a river: a spring reach, a long current, a pool', look: 'built', from: { anchor: 'rv_head' }, to: { anchor: 'rv_tail' },
    ext: { 'architect_mc:unsafe': { handRiver: { role: 'river', origin: o, variant } } } }];
  return { plan: { schemaVersion: 'plan/0', planId: `river_demo_${variant}`, zones: [], forms: [], connectors, rules: [] }, anchors, origin: o };
}

export { riverLayout };

export default function riverDemo(ctx) {
  const { plan, anchors, origin } = riverPlan(ctx.claim, ctx.params);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`river_demo: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  const g = ctx.survey.groundAt(origin[0] - 1, origin[1] + 5);
  r.anchor('cam_high', [origin[0] + 26, Math.min(ctx.claim.maxY, g + 24), origin[1] - 20]);
  return r;
}
