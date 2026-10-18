// (6c T3) The tunnel rules of the checker (docs/CONTRACT.md "Phase 6c slice T3" §5): `M3:tunnel` (cover, a sealed shell, no gravity
// block over the void), `M4:tunnel` (no water, lava or ice within 2 of the void or a cut; a 2.5D-only world is the finding "no
// volume") and the tunnels' metrics, for every tunnel the plan meta records (`meta.tunnels`). Slice T3b owns this file. Called by
// checkRegion (check.mjs) with the same arguments as K1's rules; leaves `vw` as it found it. The foundation's stub checks nothing.

/** The tunnel rules: findings and `metrics.tunnels`. The foundation: none. */
export function tunnelRules({ tunnels, metrics }) {
  void tunnels; void metrics;
}
