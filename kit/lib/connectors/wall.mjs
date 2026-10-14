// (7a K1a) Walls and gates in the plan compiler (docs/CONTRACT.md "Phase 7a slice K1" §3, §4): the hooks compile.mjs calls.
//
// STUB (the K1 foundation): K1a fills these in.

/** The kinds this module compiles. */
export const WALL_KINDS = Object.freeze(['wall', 'gate']);

/** Compile order step 2: wall lines and gates placed `at` an endpoint (answers the parts it can't place). */
export function planWalls(K) {
  for (const p of K.k1Parts.filter((q) => WALL_KINDS.includes(q.kind))) {
    if (K.answers.has(p.id)) continue;
    K.ans(p, { class: 'refused', reasons: [{ code: 'NO_ROOM', message: `${p.block} is compiled by slice K1a (not on this branch yet)`, evidence: { block: p.block } }] });
  }
}

/** The route pass's `walls` input (the gate move), or null when the plan has no wall. */
export function wallsPassInput(K) {
  void K;
  return null;
}

/** After a route pass that routed (not rolled back): the gates its edges opened stay open for the later passes. */
export function wallsRouted(K, edges) {
  void K; void edges;
}

/** Compile order step 4: gates by crossing, auto gates and gates.min, from the routed edges (K.routed). */
export function finishGates(K) {
  void K;
}

/** The links stage: emit every wall and gate under a checkpoint each. */
export function emitWalls(K) {
  void K;
}
