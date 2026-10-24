// (7a foundation) Edge profiles over T2's built-in moves (docs/CONTRACT.md "Phase 7a foundation" §3.1): an explicit stair, switchback
// or ladder connector routes with T2's own moves (1 stair, 2 hairpin, 3 ladder) under a per-edge cost profile, not new rows. Slice CL
// owns the values; the foundation freezes the names and the shape with every value equal to the pass's own (so it changes nothing).
//   edge.profile: 'stair' | 'switchback' | 'ladder'   (absent: COST and the pass's flags, byte for byte)
//   PROFILES[name] = { stairs: bool, ladders: bool, ladderMax: int, cost: {...} }
// For that edge's search only: `cost` is merged over route.mjs COST (any of its members: step, diag, turn, grade, cutFill, flight,
// stair, hairpin, landing, ladder, ladderPer); `stairs` and `ladders` are ANDed with the pass's (a ladder still never on a villager
// edge, S-T2-2, nor at a coarse resolution); `ladderMax` replaces LADDER_MAX. No new flag semantics: "the connector really climbed"
// is CL's post-check on the routed segments, not an A* constraint. A leaf module (no imports).

// (7a CL, §2) the values: a stair climbs in flights rather than winding at the grade (flights cheap, a graded walk dear); a switchback
// zigzags on hairpins rather than detouring round the slope (no flights, hairpins and their landings cheap); a ladder climbs a face to
// 48 rather than walking round (the rest landings are the emitter's: lib/connectors/climbGeom.mjs)
export const PROFILES = Object.freeze({
  stair: Object.freeze({ stairs: true, ladders: false, ladderMax: 24, cost: Object.freeze({ flight: 20, stair: 12, grade: 18 }) }),
  switchback: Object.freeze({ stairs: false, ladders: false, ladderMax: 24, cost: Object.freeze({ hairpin: 16, landing: 1, grade: 6 }) }),
  ladder: Object.freeze({ stairs: true, ladders: true, ladderMax: 48, cost: Object.freeze({ ladder: 30, ladderPer: 10 }) }),
});

/** The profile names an edge may carry. */
export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));
