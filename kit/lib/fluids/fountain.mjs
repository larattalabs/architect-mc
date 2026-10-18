// (6c H) form.fountain in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §7, §8, §15). Slice H-a owns this file; it must not
// import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): place the part. res = {klass: 'fits' | 'adjusted' | 'refused' |
//                                 'incomplete', rect?, footprints?: [[x0, z0, x1, z1]] (what later zones and forms keep off), reasons?,
//                                 deviations?, notes?, wouldFit?}; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass,
//                                 tolOf, judge, notes, taken: the rects of the zones and forms placed before it}
//   emit(K, p, res)               compile step 3 (before the routes, so the route pass sees its water): write it (r.fluidBody for a
//                                 body, its shell in its own stage); throw 'CODE: message' to refuse it (the part rolls back)
//   answer(K, p, res) -> extra    compile step 6: the answer's fields ({geometry, cost, notes, deviations}) over the default, or null
//
// The foundation's stub (H-core): the part answers refused UNREACHABLE (until Ha) at resolve, so nothing is emitted and every plan
// compiles exactly as without the part.

/** Place the part: the foundation refuses it (slice H-a builds it). */
export function resolve(C, p) {
  void C;
  return { klass: 'refused', reasons: [{ code: 'UNREACHABLE', message: 'form.fountain is built by slice H-a (this build has H-core only)', until: 'Ha', evidence: { kind: p.kind } }] };
}

/** Write the part: nothing in the foundation (resolve never answers fits). */
export function emit(K, p, res) {
  void K; void p; void res;
}

/** The part's answer fields: none in the foundation. */
export function answer(K, p, res) {
  void K; void p; void res;
  return null;
}
