// (6c T3) The bridge move of the route pass (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §6): row 7 of route.mjs's SPECIAL_MOVES,
// opt-in per edge (`spans` includes 'bridge': bridge edges with `once: 'bridge'`, auto edges without). Slice T3a owns this file.
//
// The foundation's stub is inert: init returns null (no edge searches with the move, so the pass is byte for byte as without the
// row), and every other hook is a no-op. T3a replaces the bodies, keeping the names and signatures route.mjs imports:
//   bridgeInit(env, intent) -> state | null       intent.bridge: the pass-level input (the walls, a template's land)
//   bridgeActive(state, edge) -> bool              edge.spans includes 'bridge'; edge.t3?.bridge: the edge's own options
//   bridgeNeedsFlag(state, edge) -> bool           onceOf(edge) === 'bridge'
//   bridgeExpand(state, S)                         the span candidates (S: route.mjs's expanded state)
//   bridgeCells(state, m) -> {cells, data}         the path cells after the move's start cell, and the segment's data
//   bridgeCommit(state, env, edgeOut, moves, lat)  edgeOut.bridges for the links stage
//   bridgeFail(state, edgeOut, inS) -> bool        why a bridge edge found no route (edgeOut.failed = 'BRIDGE', edgeOut.bridge)
// Under the realise lint (integer math; Math.floor/abs/min/max only).

/** The pass-level state, or null when no edge asks for bridges (the foundation: always null). */
export function bridgeInit(env, intent) {
  void env; void intent;
  return null;
}

/** Whether an edge searches with the bridge move. */
export function bridgeActive(state, edge) {
  void edge;
  return !!state && false;
}

/** Whether an edge's goal needs the flag bit (a bridge edge: exactly one span). */
export function bridgeNeedsFlag(state, edge) {
  void state; void edge;
  return false;
}

/** Relax the move's candidates from an expanded state: none. */
export function bridgeExpand(state, S) {
  void state; void S;
}

/** A bridge move's path cells (after its start cell) and the segment's data. */
export function bridgeCells(state, m) {
  void state;
  return { cells: [[m.x1, m.y1, m.z1]], data: {} };
}

/** After an edge routes: its spans, for the links stage. */
export function bridgeCommit(state, env, edgeOut, moves) {
  void state; void env; void edgeOut; void moves;
}

/** Why a bridge edge found no route: not answered (false: route.mjs goes on to T2's own check). */
export function bridgeFail(state, edgeOut, inS) {
  void state; void edgeOut; void inS;
  return false;
}
