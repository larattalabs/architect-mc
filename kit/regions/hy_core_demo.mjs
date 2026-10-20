// hy_core_demo (docs/CONTRACT.md "Phase 6c slice HY" §14, §15 step 1): HY-core's hand-built course, through the plan compiler. It writes
// a plan/0 of two channel parts carrying ext 'architect_mc:unsafe' {handCourse} (kit/lib/fluids/handcourse.mjs) and compiles it exactly
// as Regions.checkPlan does (kit/lib/plan/compile.mjs runCheck), so the gate sends the same plan through Regions.checkPlan and
// realiseApproved in game. Not in the catalogue. On a claim of at least 64x48 with level ground (a flat world):
//   stream  a three-reach course cut into a stone mound (handcourse.mjs's layout): a weir head (r1, beside a natural lake the gate or
//           the test makes: hyCoreLake), a fall of 3 into r2, a spillway of 1 into r3, the tail
//   feed    (feed: true, default) a basin on the mound, its own part, that overflows into r1 (the overflow hook: the stream names it in
//           `from`), so a failing reach drains it too (the cross-part upstream drain)
// `variant` builds one of the gate's broken variants (handcourse.mjs VARIANTS).
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';
import { VARIANTS, hyCoreFootprint, hyCoreLake } from '../lib/fluids/handcourse.mjs';

export const id = 'hy_core_demo';
export const description = 'HY-core\'s hand-built course (three reaches, a fall, a spillway, a weir, a feeding basin) through the plan compiler (6c HY).';
export const catalogue = false;

const AUTO = -30000000;
export const params = {
  variant: { type: 'enum', options: [...VARIANTS], default: 'none', label: 'Broken variant' },
  feed: { type: 'bool', default: true, label: 'Feeding basin (overflow)' },
  cx: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre x' },
  cz: { type: 'int', min: -30000000, max: 30000000, default: AUTO, label: 'Centre z' },
};

/** The layout's origin (the head's lake side, on the ground) for a claim: 14 west of its centre. */
export function hyCoreOrigin(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = (P.cx ?? AUTO) === AUTO ? claim.minX + (W >> 1) : P.cx, cz = (P.cz ?? AUTO) === AUTO ? claim.minZ + (D >> 1) : P.cz;
  return [cx - 14, cz];
}

/** The plan/0 for a claim ({minX, minZ, maxX, maxZ}) and params: {plan, anchors, origin}. Anchors as [x, y, z] (the y is the compiler's). */
export function hyCorePlan(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 64 || D < 48) throw new Error(`hy_core_demo needs a claim of at least 64x48 (got ${W}x${D})`);
  const o = hyCoreOrigin(claim, P);
  const variant = P.variant ?? 'none', feed = P.feed !== false;
  const anchors = { hc_head: [o[0] - 2, 65, o[1]], hc_tail: [o[0] + 32, 65, o[1]], hc_feed: [o[0] + 9, 65, o[1] + 5] };
  const unsafe = (role) => ({ 'architect_mc:unsafe': { handCourse: { role, origin: o, variant } } });
  const connectors = [];
  if (feed) connectors.push({ id: 'feed', kind: 'channel', label: 'a basin that overflows into the stream', from: { anchor: 'hc_feed' }, to: { anchor: 'hc_head' }, ext: unsafe('feed') });
  connectors.push({ id: 'stream', kind: 'channel', label: 'a stream: a weir head, a fall and a spillway', look: 'built', from: feed ? { part: 'feed' } : { anchor: 'hc_head' }, to: { anchor: 'hc_tail' }, ext: unsafe('stream') });
  return { plan: { schemaVersion: 'plan/0', planId: `hy_core_${variant}`, zones: [], forms: [], connectors, rules: [] }, anchors, origin: o };
}

export { hyCoreLake, hyCoreFootprint };

export default function hyCoreDemo(ctx) {
  const { plan, anchors, origin } = hyCorePlan(ctx.claim, ctx.params);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`hy_core_demo: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  const g = ctx.survey.groundAt(origin[0] + 16, origin[1] + 7);
  r.anchor('cam_high', [origin[0] + 14, Math.min(ctx.claim.maxY, g + 24), origin[1] - 20]);
  return r;
}
