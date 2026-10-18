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

/** Whether any part of the plan is H's (its compile runs the H steps). */
export function hasHParts(order) {
  return order.some(isHPart);
}
