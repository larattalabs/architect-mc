// (6c H) The compiler's H hooks (docs/CONTRACT.md "Phase 6c slice H" §15): one dispatcher by kind over the generators' modules, so
// compile.mjs names no generator. H-core owns this file; each generator module is its slice's (pond, fountain, waterfall and moat
// H-a's; quay and wet H-b's), with the signatures documented in each. No module here imports compile.mjs or program.mjs.
import * as pond from './pond.mjs';
import * as fountain from './fountain.mjs';
import * as waterfall from './waterfall.mjs';
import * as moat from './moat.mjs';
import * as quay from './quay.mjs';
import { isBodyPart, isHPart } from './kinds.mjs';

export { isBodyPart, isHPart } from './kinds.mjs';
export { wetBridgeFallback, wetWallFallback } from './wet.mjs';

const BY_KIND = Object.freeze({ pond, fountain, waterfall, quay, channel: moat });

function moduleOf(p) {
  const m = BY_KIND[p.kind];
  if (!m) throw new Error(`no H generator for kind ${p.kind}`);
  return m;
}

/** Compile step 2: place an H part (a form, or a channel compiled with the forms). */
export function fluidResolve(C, p) {
  return moduleOf(p).resolve(C, p);
}

/** Compile step 3: write an H part that fits (throws 'CODE: message' to refuse it). */
export function fluidEmit(K, p, res) {
  return moduleOf(p).emit(K, p, res);
}

/** Compile step 6: an H part's answer fields over the default ones, or null. */
export function fluidAnswer(K, p, res) {
  return moduleOf(p).answer(K, p, res);
}

/**
 * Whether the plan gets the `fluids` stage (§3.1): a body part that fits, or a part that is no body but brings one (a farm lot's
 * farmPond: pond.stageWanted). Plans without one keep their stage list, so their IR.
 */
export function fluidStageWanted(C) {
  if (C.order.some((p) => isBodyPart(p) && C.okClass(p.id))) return true;
  return !!pond.stageWanted(C);
}

/** The route pass's input for the plan's own water (the moat's): null when there is none, so the pass is byte for byte as before. */
export function fluidPassInput(K) {
  return moat.passInput(K);
}

/**
 * (H-a, additive) Compile step 3, after the zones: each farm lot's pond (S-H-1/S-H-2: farmPond: true on a lot or zone, a dry claim).
 * Returns {ponds, notes: Map(zone id -> [note])}. Only called when a zone of the plan writes farmPond (else the plan is as before).
 */
export function fluidFarmPonds(K) {
  return pond.emitFarmPonds(K);
}

/** (H-a, additive) Whether a plan's zones ask for farm ponds (a cheap test: compile.mjs makes the K context only then). */
export function asksFarmPond(order) {
  return order.some((p) => p.family === 'zone' && /"farmPond":true/.test(JSON.stringify(p.part)));
}

/** (H-a, additive) N-H-5: the clearance a street fallback's bridge keeps over the plan's own water (1), or null (T3's default). */
export function fluidFallbackClearance(K, l) {
  return moat.planWaterClearance(K, l);
}

/** Whether any part of the plan is H's (its compile runs the H steps). */
export function hasHParts(order) {
  return order.some(isHPart);
}
