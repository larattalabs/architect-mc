// (6c T3) crossings_demo's tunnel half (docs/CONTRACT.md "Phase 6c slice T3" §10): slice T3b owns this file (kit/regions/crossings_demo.mjs
// calls it; T3a owns the program and its bridge half, lib/connectors/crossingsBridges.mjs).
//   tunnelSection(ctx, r, {rect, variant, base, P}) -> {nodes, edges, input, note}
//       in stage `ground`: the section's own land (the flat variant's ridge raised in `ground`, written into `base.values` so the route
//       pass meets it, T1's lesson), its route nodes and edges (spans ['tunnel'], once 'tunnel', t3.tunnel), and the pass-level `tunnel`
//       input (null: none). `rect` [x0, z0, x1, z1]: the claim's part this section may use (the flat claim's east half; the whole
//       claim on the `hill` variant); `variant`: flat | hill (river and frozen are the bridges'); `base`: {minX, minZ, width, depth,
//       values: Int16Array} the shared base; `P`: the program's params.
//   emitDemoTunnels(r, {stage}) -> [records]   in the links stage, after the bridges
// The foundation's stub: no section (no nodes, no edges), nothing emitted.

/** The tunnel section: none in the foundation. */
export function tunnelSection(ctx, r, opts) {
  void ctx; void r; void opts;
  return { nodes: {}, edges: [], input: null, note: null };
}

/** The tunnels the route pass found, emitted: none in the foundation. */
export function emitDemoTunnels(r, opts) {
  void r; void opts;
  return [];
}
