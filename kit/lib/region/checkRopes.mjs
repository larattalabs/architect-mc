// (7a K1b) The rope bridge rules of the checker (docs/CONTRACT.md "Phase 7a slice K1" §5): `M10:rope` (each deck cell's half-block
// y equals §3's profile, adjacent cells within one half block, span 8-40, both ends' posts and landing 2 deep in site-solid), with
// M8 (rails), M6 (headroom), M5 and M3 over the deck, from the plan meta's `ropes`. Called by checkRegion (check.mjs), which
// passes `finding`; leaves `vw` as it found it.
//
// STUB (the K1 foundation): K1b fills it in.

/** The rope rules: findings and `metrics.ropes`. */
export function ropeRules({ ir, vw, ropes, meta, want, findings, metrics, partStage, finding }) {
  void ir; void vw; void meta; void want; void findings; void partStage; void finding;
  metrics.ropes = { bridges: ropes.length };
}
