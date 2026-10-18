// (6c T3) Tunnels in the plan compiler (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §6, §8): the hooks kit/lib/plan/compile.mjs
// calls for connector.tunnel (K = the compiler's context). Slice T3b owns this file; it must not import compile.mjs or program.mjs.
//   tunnelResolve(K, p) -> answer | null   before routing: params, movers, R18's self-loop, the width and height; null routes it
//   tunnelLeg(K, p) -> {}                  a tunnel leg's route options (spans ['tunnel'], once 'tunnel', approach, width, movers,
//                                          t3: {tunnel: {...}})
//   tunnelAutoLeg(K, p) -> {}              an auto connector's tunnel options ({spans: ['tunnel'], t3: {tunnel}}; {} for none)
//   tunnelPassInput(K) -> object | null    the route pass's pass-level `tunnel` input
//   tunnelFailAnswer(K, l, m) -> answer    a tunnel leg the pass could not bore (m.failed === 'TUNNEL'): its typed answer
//   tunnelAnswer(K, p, legs) -> extra|null a routed connector's tunnel fields ({geometry: {tunnels}, notes, ...}) to merge
//   emitTunnels(K)                         the links stage, after the bridges
//
// The foundation's stub: a tunnel part is refused before routing (the bore arrives with T3b), auto edges get no tunnel move, and the
// links stage writes nothing.

/** Before routing: the foundation refuses every tunnel part (T3b replaces this). */
export function tunnelResolve(K, p) {
  void K; void p;
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: 'tunnels are built by slice T3b (this build has its foundation only)', until: 'T3b' }] };
}

/** A tunnel leg's route options: none in the foundation. */
export function tunnelLeg(K, p) {
  void K; void p;
  return {};
}

/** An auto connector's tunnel options: none in the foundation. */
export function tunnelAutoLeg(K, p) {
  void K; void p;
  return {};
}

/** The route pass's pass-level tunnel input: none in the foundation. */
export function tunnelPassInput(K) {
  void K;
  return null;
}

/** A tunnel leg that found no route: its answer. */
export function tunnelFailAnswer(K, l, m) {
  void K; void m;
  return { class: 'refused', reasons: [{ code: 'UNREACHABLE', message: `leg ${l.k + 1}: no tunnel`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at } }] };
}

/** A routed connector's tunnel fields: none in the foundation. */
export function tunnelAnswer(K, p, legs) {
  void K; void p; void legs;
  return null;
}

/** The links stage's tunnels: none in the foundation. */
export function emitTunnels(K) {
  void K;
}
