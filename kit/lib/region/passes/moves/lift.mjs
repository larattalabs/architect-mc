// (7a foundation) Route row 9, `lift` (docs/CONTRACT.md "Phase 7a foundation" §3.2): slice LF owns this file. The foundation ships its
// hooks as inert stubs with their final names: init returns null always, so the row is off and the pass is byte for byte as before.
// An edge opts in with spans ['lift'] and once 'lift'; its options ride in edge.t7.lift, the pass-level input in the intent's key.
// The hooks are route.mjs SPECIAL_MOVES' (init, active, needsFlag, blocks, expand, cells, commit; optional prune, fail).

export const liftInit = (env, intent) => { void env; void intent; return null; };
export const liftActive = (st, edge) => { void st; void edge; return false; };
export const liftNeedsFlag = (st, edge) => { void st; void edge; return false; };
export const liftBlocks = (st) => { void st; return null; };
export const liftExpand = (st, S) => { void st; void S; };
export const liftCells = (st, m) => { void st; void m; return { cells: [], data: {} }; };
export const liftCommit = (st, env, edgeOut, moves, lat) => { void st; void env; void edgeOut; void moves; void lat; };
export const liftFail = (st, edgeOut, inS) => { void st; void edgeOut; void inS; return false; };
