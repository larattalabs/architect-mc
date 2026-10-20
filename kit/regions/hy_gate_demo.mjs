// hy_gate_demo (docs/CONTRACT.md "Phase 6c slice HY" §8.3, §14 items 9 and 14): HY-c's water gate through the plan compiler. It writes a
// plan/0 (a walled yard: a flat_village zone, a closed wall.around with corner towers, optionally a moat round it, and a still reach
// laid across the wall's south side by kit/lib/fluids/handgate.mjs) and compiles it exactly as Regions.checkPlan does (runCheck), so the
// gate sends the same plan through Regions.checkPlan and realiseApproved in game. Not in the catalogue. On a flat claim of at least
// 112x96.
// `variant`: none | no_grate (the water under the lintel left open: item 14's in-game negative control) | sealed (the wall gates: 0: the
// reach is refused UNREACHABLE {kind: wall}) | max (gates {min: 1, max: 1} and a gate part at claim_w already open: refused, at its
// gates.max) | no_lintel (the wall leaves the crossing's columns unwritten: M2:wall closure) | lintel_low (the lintel laid on 3 cells past
// each face: M25:trap).
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';

export const id = 'hy_gate_demo';
export const description = 'HY-c\'s water gate: a walled yard whose wall stands on a lintel over a still reach behind an iron grate (6c HY).';
export const catalogue = false;

export const VARIANTS = Object.freeze(['none', 'no_grate', 'sealed', 'max', 'no_lintel', 'lintel_low']);
export const params = {
  variant: { type: 'enum', options: [...VARIANTS], default: 'none', label: 'Variant' },
  moat: { type: 'bool', default: false, label: 'Moat round the wall' },
  width: { type: 'int', min: 1, max: 3, default: 3, label: 'Water gate width' },
};

/** The plan/0 for a claim ({minX, minZ, maxX, maxZ}) and params: {plan, anchors, at}. */
export function hyGatePlan(claim, P = {}) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 112 || D < 96) throw new Error(`hy_gate_demo needs a claim of at least 112x96 (got ${W}x${D})`);
  const variant = P.variant ?? 'none';
  const cx = claim.minX + (W >> 1), cz = claim.minZ + (D >> 1);
  const at = [cx, claim.maxZ - 4];
  const anchors = { gw_head: [cx, 65, cz], gw_tail: [cx, 65, claim.maxZ - 4], gw_west: [claim.minX + 4, 65, cz] };
  const wallUnsafe = variant === 'no_lintel' ? { noLintel: true } : variant === 'lintel_low' ? { lintelLow: true } : null;
  const wall = { id: 'castle', kind: 'wall', label: 'the castle wall', where: { around: { feature: { part: 'yard' }, ring: [4, 6] } }, height: 6, corners: 'tower',
    ...(variant === 'sealed' ? { gates: 0 } : variant === 'max' ? { gates: { min: 1, max: 1 } } : {}), ...(wallUnsafe ? { ext: { 'architect_mc:unsafe': wallUnsafe } } : {}) };
  const connectors = [wall];
  if (variant === 'max') connectors.push({ id: 'west_gate', kind: 'gate', wall: 'castle', at: { anchor: 'gw_west' } });
  if (P.moat) connectors.push({ id: 'moat', kind: 'channel', label: 'the moat', where: { around: { feature: { part: 'yard' }, ring: [6, 16] } } });
  const hand = { wall: 'castle', at, width: P.width ?? 3, depth: 2, beyond: 3, ...(variant === 'no_grate' ? { variant: 'no_grate' } : {}) };
  connectors.push({ id: 'race', kind: 'channel', label: 'a still reach under the castle wall (a water gate)', look: 'built', flow: 'level', from: { anchor: 'gw_head' }, to: { anchor: 'gw_tail' }, ext: { 'architect_mc:unsafe': { handGate: hand } } });
  const zones = [{ id: 'yard', program: { template: 'flat_village', params: { lots: [{ id: 'keep', type: 'house', size: [9, 9] }, { id: 'hall', type: 'cottage', size: [9, 9] }] } } }];
  return { plan: { schemaVersion: 'plan/0', planId: `hy_gate_${variant}${P.moat ? '_moat' : ''}`, zones, forms: [], connectors, rules: [] }, anchors, at };
}

export default function hyGateDemo(ctx) {
  const { plan, anchors, at } = hyGatePlan(ctx.claim, ctx.params);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: [], regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`hy_gate_demo: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  // the camera: south-east of the water gate (the reach's rect from its answer), inside the claim
  const rc = record.answers.find((a) => a.part === 'race')?.geometry?.rect;
  const c = ctx.claim, gx = rc ? (rc[0] + rc[2]) >> 1 : at[0], gz = rc ? rc[3] : at[1];
  const cx = Math.max(c.minX, Math.min(c.maxX, gx + 12)), cz = Math.max(c.minZ, Math.min(c.maxZ, gz + 8));
  r.anchor('cam_gate', [cx, Math.min(c.maxY, ctx.survey.groundAt(cx, cz) + 10), cz]);
  return r;
}
