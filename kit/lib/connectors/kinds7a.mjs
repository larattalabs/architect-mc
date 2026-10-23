// (7a foundation) The connector kinds batch 7a compiles (docs/CONTRACT.md "Phase 7a foundation: the shared interface" §1). A leaf
// module (no imports), as T3's t3kinds.mjs: the compiler, the hook modules and the region program read these constants without an
// import cycle (K1's integration lesson: a cycle left ROPE_KINDS uninitialised).

/** CL: stairs, switchbacks and ladders, T2's own moves under an edge profile. */
export const CLIMB_KINDS = Object.freeze(['stair', 'switchback', 'ladder']);
/** RK: rock stairs, route row 11. */
export const ROCK_KINDS = Object.freeze(['rock_stair']);
/** LF: lifts, route row 9. */
export const LIFT_KINDS = Object.freeze(['lift']);
/** CW: catwalks, route row 10. */
export const CATWALK_KINDS = Object.freeze(['catwalk']);
/** SA: spiral stairs round a form part (a hosted generator plus an ordinary leg to its foot). */
export const SPIRAL_KINDS = Object.freeze(['stairs_around']);
/** Supported aliases (R25, S-7a-3): rewritten to their target kind before dispatch (schema.mjs). */
export const ALIAS_KINDS = Object.freeze({ span_bridge: 'bridge' });
/** Every 7a kind (each gets the links stage: compile.mjs LINK_KINDS). */
export const KINDS_7A = Object.freeze([...CLIMB_KINDS, ...ROCK_KINDS, ...LIFT_KINDS, ...CATWALK_KINDS, ...SPIRAL_KINDS]);
/** The routed 7a kinds (R26: from, to; via read leniently, the first leg). */
export const ROUTED_7A = Object.freeze([...CLIMB_KINDS, ...ROCK_KINDS, ...LIFT_KINDS, ...CATWALK_KINDS]);
/** A connector's test-only switches (its `ext`), as K1's and T3's. */
export const UNSAFE_EXT_7A = 'architect_mc:unsafe';
/** The route pass's 7a intent keys (rows 11, 9, 10's pass-level inputs: intent.rockStair, intent.lift, intent.catwalk), passed through by
 * the region program as T3's intent.bridge and intent.tunnel. */
export const INTENT_KEYS_7A = Object.freeze(['rockStair', 'lift', 'catwalk']);
