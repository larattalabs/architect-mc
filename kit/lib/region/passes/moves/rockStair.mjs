// (7a foundation) Route row 11, `rock_stair` (docs/CONTRACT.md "Phase 7a foundation" §3.2): slice RK owns this file. The foundation ships its
// hooks as inert stubs with their final names: init returns null always, so the row is off and the pass is byte for byte as before.
// An edge opts in with spans ['rock_stair'] and once 'rock_stair'; its options ride in edge.t7.rock_stair, the pass-level input in the intent's key.
// The hooks are route.mjs SPECIAL_MOVES' (init, active, needsFlag, blocks, expand, cells, commit; optional prune, fail).

export const rockStairInit = (env, intent) => { void env; void intent; return null; };
export const rockStairActive = (st, edge) => { void st; void edge; return false; };
export const rockStairNeedsFlag = (st, edge) => { void st; void edge; return false; };
export const rockStairBlocks = (st) => { void st; return null; };
export const rockStairExpand = (st, S) => { void st; void S; };
export const rockStairCells = (st, m) => { void st; void m; return { cells: [], data: {} }; };
export const rockStairCommit = (st, env, edgeOut, moves, lat) => { void st; void env; void edgeOut; void moves; void lat; };
export const rockStairFail = (st, edgeOut, inS) => { void st; void edgeOut; void inS; return false; };
