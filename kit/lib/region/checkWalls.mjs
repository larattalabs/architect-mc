// (7a K1a) The wall rules of the checker (docs/CONTRACT.md "Phase 7a slice K1" §5): `M2:wall` (closure of a closed wall, no walk
// cell under a wall cell, every crossing a gate) and `M8:wall` (the wall's height at its foot and over the ground beside it), over
// the plan meta's `walls`. Called by checkRegion (check.mjs), which passes `finding`; leaves `vw` as it found it.
//
// STUB (the K1 foundation): K1a fills it in.

/** The wall rules: findings and `metrics.walls`. */
export function wallRules({ ir, vw, walls, meta, want, findings, metrics, partStage, finding }) {
  void ir; void vw; void meta; void want; void findings; void partStage; void finding;
  metrics.walls = { walls: walls.length };
}
