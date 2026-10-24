// (7a foundation) The compile hooks of connector stair, switchback and ladder (CLIMB_KINDS): slice CL owns this module (docs/CONTRACT.md "Phase 7a foundation" §2). The
// foundation ships it as an inert stub with its final name (T3's lesson: no throwing placeholder): every hook answers nothing, so a
// plan without such a part (every plan, while the kind is reserved) compiles as before. This module never imports compile.mjs,
// program.mjs or connectors/rope.mjs (K1's integration lesson: an import cycle left a kind list uninitialised).
//   resolve(K, p) -> stop | null            before routing (R18-style self-loops, movers, NO_CLIMB, params); null routes it
//   leg(K, p) -> legOptions | null          the edge's profile, spans, once and per-row options in edge.t7
//   passInput(K) -> object | null           the pass-level input of its row; null without such parts
//   failAnswer(K, leg, meta) -> answer|null its typed refusal for a leg the pass could not route; null: not this module's
//   answer(K, p, legs) -> extra | null      merged by mergeExtras, as T3's
//   emit(K)                                 the links stage, under a checkpoint per part
//   bom(K, p) -> cost.bom | null            C26's bomFull over the emitted cells
//   survival(K, p) -> RS target spec | null the slice's §Survival row

export function resolve(K, p) { void K; void p; return null; }
export function leg(K, p) { void K; void p; return null; }
export function passInput(K) { void K; return null; }
export function failAnswer(K, leg, meta) { void K; void leg; void meta; return null; }
export function answer(K, p, legs) { void K; void p; void legs; return null; }
export function emit(K) { void K; }
export function bom(K, p) { void K; void p; return null; }
export function survival(K, p) { void K; void p; return null; }
