// (7a K1b) Rope bridges and `connector.auto` in the plan compiler (docs/CONTRACT.md "Phase 7a slice K1" §3, §4): the hooks
// kit/lib/plan/compile.mjs calls for those kinds (K = the compiler's context, compile.mjs `k1Context`).
//
// STUB (the K1 foundation): K1b fills these in. Until then a rope_bridge or auto part is refused before routing, named.

/** The kinds this module compiles. */
export const ROPE_KINDS = Object.freeze(['rope_bridge', 'auto']);

/**
 * Before routing: an answer that stops the part (`{class, reasons, ...}`), or null to route it. `p`: the validated part.
 */
export function ropeResolve(K, p) {
  void K;
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `${p.block} is compiled by slice K1b (not on this branch yet)`, evidence: { block: p.block } }] };
}

/** A rope_bridge or auto connector's leg options for the route pass (spans, spanOnce, span, approach). */
export function ropeLeg(K, p) {
  void K; void p;
  return {};
}

/** The route pass's pass-level `rope` input (site-solid, the gap test's inputs), or null. */
export function ropePassInput(K) {
  void K;
  return null;
}

/** After routing, a routed rope_bridge or auto connector's answer fields to merge ({geometry, deviations, notes, ...}), or null. */
export function ropeAnswer(K, p, legs) {
  void K; void p; void legs;
  return null;
}

/** The links stage: emit every routed edge's rope spans (deck, rails, posts, lamps) under a checkpoint each. */
export function emitRopes(K) {
  void K;
}
