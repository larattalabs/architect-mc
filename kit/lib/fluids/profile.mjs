// (6c HY) A course's profile (docs/CONTRACT.md "Phase 6c slice HY" §7.2, §15): along a routed path, the level as the running minimum of
// (ground - 1), cut into reaches of at least minReach cells, each drop a step (a fall, a spillway or a riffle). Slice HY-b owns this
// file (with the router). Pure, integer, deterministic.
//   profileOf(path, opts) -> {reaches: [{cells: [[x, z]], level}], steps: [{kind, from, to, drop}]} | null
//
// The foundation's stub (HY-core): no profile (HY-b builds it).

/** The profile of a path: none in the foundation. */
export function profileOf(path, opts = {}) {
  void path; void opts;
  return null;
}
