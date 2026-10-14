// (7a K1b) The rope move of the route pass (docs/CONTRACT.md "Phase 7a slice K1" §3, §4): opt-in per edge (`spans: ['rope']`, set
// only by rope_bridge and auto connectors). From a walk cell on a cardinal heading, a span of §3's geometry landing on a walk cell;
// cost 30 + 3 per deck cell (in cells: 300 + 30 per deck cell in the pass's units); a rope_bridge edge uses exactly one (the A*
// state's flag bit `spanned`, which its goal needs) and walks at most `approach` cells at each end; an auto edge uses any number.
//
// STUB (the K1 foundation): K1b fills these in. The row is off until then (init returns null), so no route changes.
// Under the realise lint (integer math; Math.floor/abs/min/max only).

/** The pass-level state from the intent and its edges, or null when no edge asks for rope spans. */
export function ropeInit(env, intent) {
  void env; void intent;
  return null;
}

/** Whether an edge searches with the rope move (`edge.spans` includes 'rope'). */
export function ropeActive(state, edge) {
  return !!state && Array.isArray(edge?.spans) && edge.spans.includes('rope');
}

/** Whether an edge's goal needs the flag bit set (a rope_bridge edge: exactly one span). */
export function ropeNeedsFlag(state, edge) {
  return !!state && !!edge?.spanOnce;
}

/** Expand the rope move from a state (see route.mjs's special-move table for S). */
export function ropeExpand(state, S) {
  void state; void S;
}

/** The path cells of a rope move (after its start cell) and the segment's data (the deck profile in half blocks). */
export function ropeCells(state, m) {
  void state; void m;
  return { cells: [], data: {} };
}

/** After an edge routes (nothing to commit for the rope move by default). */
export function ropeCommit(state, env, edgeOut, moves) {
  void state; void env; void edgeOut; void moves;
}
