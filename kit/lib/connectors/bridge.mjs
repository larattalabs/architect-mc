// (6c T3) Bridges in the plan compiler (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §8): the hooks kit/lib/plan/compile.mjs calls
// for connector.bridge, for auto connectors' bridge move and for the street fallback (K = the compiler's context). Slice T3a owns this
// file; it must not import compile.mjs or program.mjs.
//   bridgeResolve(K, p) -> answer | null   before routing: params, movers, R18's self-loop and drawbridge, the width; null routes it
//   bridgeLeg(K, p) -> {}                  a bridge leg's route options (spans ['bridge'], once 'bridge', approach, width, movers,
//                                          t3: {bridge: {...}})
//   bridgeAutoLeg(K, p) -> {}              an auto connector's bridge options ({spans: ['bridge'], t3: {bridge}}; {} for none)
//   bridgeFallback(K, l) -> {} | null      a street, road or path leg that failed ROUTE_WATER: the options to search it once more with
//                                          (spans ['bridge'], no once), or null (it keeps its WATER refusal)
//   bridgePassInput(K) -> object | null    the route pass's pass-level `bridge` input
//   bridgeFailAnswer(K, l, m) -> answer    a bridge leg the pass could not span (m.failed === 'BRIDGE'): its typed answer
//   bridgeAnswer(K, p, legs) -> extra|null a routed connector's bridge fields ({geometry: {bridges}, notes, deviations}) to merge
//   emitBridges(K)                         the links stage, after K1's walls, gates and ropes
//
// The foundation's stub: a bridge part is refused before routing (the span arrives with T3a), auto edges get no bridge move, the
// street fallback is off (a street that only crosses water keeps its WATER refusal), and the links stage writes nothing.

/** Before routing: the foundation refuses every bridge part (T3a replaces this). */
export function bridgeResolve(K, p) {
  void K; void p;
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: 'bridges are built by slice T3a (this build has its foundation only)', until: 'T3a' }] };
}

/** A bridge leg's route options: none in the foundation. */
export function bridgeLeg(K, p) {
  void K; void p;
  return {};
}

/** An auto connector's bridge options: none in the foundation. */
export function bridgeAutoLeg(K, p) {
  void K; void p;
  return {};
}

/** The street fallback: off in the foundation. */
export function bridgeFallback(K, l) {
  void K; void l;
  return null;
}

/** The route pass's pass-level bridge input: none in the foundation. */
export function bridgePassInput(K) {
  void K;
  return null;
}

/** A bridge leg that found no route: its answer. */
export function bridgeFailAnswer(K, l, m) {
  void K; void m;
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `leg ${l.k + 1}: no bridge`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at } }] };
}

/** A routed connector's bridge fields: none in the foundation. */
export function bridgeAnswer(K, p, legs) {
  void K; void p; void legs;
  return null;
}

/** The links stage's bridges: none in the foundation. */
export function emitBridges(K) {
  void K;
}
