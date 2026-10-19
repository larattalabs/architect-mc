// (6c H) The wet fallback (docs/CONTRACT.md "Phase 6c slice H" §8, Steward's S-H-4: a fallback only). Slice H-b owns this file; it must
// not import compile.mjs or program.mjs.
//
// Only a leg or a wall that fails because of water is searched once more with wet writes allowed; only surveyed (natural) water is ever
// made passable (plan-made water stays an obstacle); a plan with no such failure plans and checks byte for byte as before.
//
//   wetBridgeFallback(K, l, m, why) -> options | null
//       compile.mjs's route rounds, after T3's street fallback (S-T3-2) and before the leg's answer: a street, road, path or bridge leg
//       whose route still fails on water (`why`: 'ROUTE_WATER' or 'BRIDGE'; `m` the leg's route meta, with the bridge row's diagnosis)
//       gets leg options to route it again with wet piers (merged into l.k1, e.g. {t3: {bridge: {wet: {waterDepth}}}}): one more round,
//       never twice (l.wet). null: no wet fallback (the leg answers as on v0.36.0, its WATER without `until`).
//       Costs (§8.1): the bridge row's 320 + 30 n + 40 per pier, plus 10 per wet pier cell, so a dry crossing wins where it fits.
//   wetWallFallback(K, wall, failure) -> options | null
//       wall.mjs's ring and line search (K1a's planWalls), where a ring or line fails on OB.WATER: options to search it again with
//       natural water columns up to waterDepth (default 6) as clear at cost 3 a cell (dry 1). null: no wet fallback (WATER as before).
//       H-b calls it from wall.mjs (the call site is H-b's: wall.mjs is H-b's file in H).
//
// The foundation's stubs (H-core) answer null: no wet fallback anywhere.

/** A leg that still fails on water: the foundation offers no wet fallback. */
export function wetBridgeFallback(K, l, m, why) {
  void K; void l; void m; void why;
  return null;
}

/** A wall that fails on water: the foundation offers no wet fallback. */
export function wetWallFallback(K, wall, failure) {
  void K; void wall; void failure;
  return null;
}
