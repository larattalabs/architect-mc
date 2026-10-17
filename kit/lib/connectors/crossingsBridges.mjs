// (6c T3) crossings_demo's bridge half (docs/CONTRACT.md "Phase 6c slice T3" §10): slice T3a owns this file and kit/regions/crossings_demo.mjs
// (the tunnel half is lib/connectors/crossingsTunnels.mjs, T3b's).
//   bridgeSection(ctx, r, {rect, variant, base, P}) -> {nodes, edges, input, note}   (as crossingsTunnels.mjs's tunnelSection)
//   emitDemoBridges(r, {stage}) -> [records]                                           in the links stage, before the tunnels
// The foundation's stub: no section, nothing emitted (T3a replaces the bodies).

/** The bridge section: none in the foundation. */
export function bridgeSection(ctx, r, opts) {
  void ctx; void r; void opts;
  return { nodes: {}, edges: [], input: null, note: null };
}

/** The bridges the route pass found, emitted: none in the foundation. */
export function emitDemoBridges(r, opts) {
  void r; void opts;
  return [];
}
