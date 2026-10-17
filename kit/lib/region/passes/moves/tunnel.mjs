// (6c T3) The tunnel move of the route pass (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §6): row 8 of route.mjs's SPECIAL_MOVES,
// opt-in per edge (`spans` includes 'tunnel': tunnel edges with `once: 'tunnel'`, auto edges without). Slice T3b owns this file.
//
// The foundation's stub is inert: init returns null (no edge searches with the move, so the pass is byte for byte as without the
// row), and every other hook is a no-op. T3b replaces the bodies, keeping the names and signatures route.mjs imports:
//   tunnelInit(env, intent) -> state | null       intent.tunnel: the pass-level input (the frozen volumes, the walls for posterns)
//   tunnelActive(state, edge) -> bool              edge.spans includes 'tunnel'; edge.t3?.tunnel: the edge's own options
//   tunnelNeedsFlag(state, edge) -> bool           onceOf(edge) === 'tunnel'
//   tunnelBlocks(state) -> Uint8Array | null       cells every edge treats as hard (none)
//   tunnelExpand(state, S)                         the bore candidates (S: route.mjs's expanded state)
//   tunnelCells(state, m) -> {cells, data}         the path cells after the move's start cell, and the segment's data
//   tunnelCommit(state, env, edgeOut, moves, lat)  edgeOut.tunnels for the links stage
//   tunnelFail(state, edgeOut, inS) -> bool        why a tunnel edge found no route (edgeOut.failed = 'TUNNEL', edgeOut.tunnel)
//   tunnelPrune(state, from, to) -> note | null    a postern under a sealed wall
// Under the realise lint (integer math; Math.floor/abs/min/max only).

/** The pass-level state, or null when no edge asks for tunnels (the foundation: always null). */
export function tunnelInit(env, intent) {
  void env; void intent;
  return null;
}

/** Whether an edge searches with the tunnel move. */
export function tunnelActive(state, edge) {
  void edge;
  return !!state && false;
}

/** Whether an edge's goal needs the flag bit (a tunnel edge: exactly one bore). */
export function tunnelNeedsFlag(state, edge) {
  void state; void edge;
  return false;
}

/** Cells every edge treats as hard obstacles: none. */
export function tunnelBlocks(state) {
  void state;
  return null;
}

/** Relax the move's candidates from an expanded state: none. */
export function tunnelExpand(state, S) {
  void state; void S;
}

/** A tunnel move's path cells (after its start cell) and the segment's data. */
export function tunnelCells(state, m) {
  void state;
  return { cells: [[m.x1, m.y1, m.z1]], data: {} };
}

/** After an edge routes: its bores, for the links stage. */
export function tunnelCommit(state, env, edgeOut, moves) {
  void state; void env; void edgeOut; void moves;
}

/** Why a tunnel edge found no route: not answered (false: route.mjs goes on to T2's own check). */
export function tunnelFail(state, edgeOut, inS) {
  void state; void edgeOut; void inS;
  return false;
}

/** A reason no route can exist before the search (a postern under a sealed wall): none. */
export function tunnelPrune(state, from, to) {
  void state; void from; void to;
  return null;
}
