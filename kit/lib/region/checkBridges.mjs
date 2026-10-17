// (6c T3) The bridge rules of the checker (docs/CONTRACT.md "Phase 6c slice T3" §5): `M10:bridge` (the deck's profile, the supports,
// no cell in water or ice, the clearance over water) and the bridges' metrics (rails, head room), for every bridge the plan meta
// records (`meta.bridges`). Slice T3a owns this file. Called by checkRegion (check.mjs) with the same arguments as K1's rules; leaves
// `vw` as it found it. The foundation's stub checks nothing.

/** The bridge rules: findings and `metrics.bridges`. The foundation: none. */
export function bridgeRules({ bridges, metrics }) {
  void bridges; void metrics;
}
