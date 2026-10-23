// (7a foundation) Route row 10, `catwalk` (docs/CONTRACT.md "Phase 7a foundation" §3.2): slice CW owns this file. The foundation ships its
// hooks as inert stubs with their final names: init returns null always, so the row is off and the pass is byte for byte as before.
// An edge opts in with spans ['catwalk'] and once 'catwalk'; its options ride in edge.t7.catwalk, the pass-level input in the intent's key.
// The hooks are route.mjs SPECIAL_MOVES' (init, active, needsFlag, blocks, expand, cells, commit; optional prune, fail).

export const catwalkInit = (env, intent) => { void env; void intent; return null; };
export const catwalkActive = (st, edge) => { void st; void edge; return false; };
export const catwalkNeedsFlag = (st, edge) => { void st; void edge; return false; };
export const catwalkBlocks = (st) => { void st; return null; };
export const catwalkExpand = (st, S) => { void st; void S; };
export const catwalkCells = (st, m) => { void st; void m; return { cells: [], data: {} }; };
export const catwalkCommit = (st, env, edgeOut, moves, lat) => { void st; void env; void edgeOut; void moves; void lat; };
export const catwalkFail = (st, edgeOut, inS) => { void st; void edgeOut; void inS; return false; };
