// (7a foundation) The compile hook table (docs/CONTRACT.md "Phase 7a foundation: the shared interface" §2): one table and one loop at
// each of compile.mjs's call sites, so that five slices don't each add an `if` to the same six sites. Each slice owns exactly its
// module (and its route row file); the foundation ships each as an inert stub with its final name. The modules are imported
// statically (the step-inputs closure and the plan-path lint follow static imports only).
//
// Order at each call site: K1's, then T3's (as before), then HOOKS_7A in table order. The links emission order is frozen separately
// (EMIT_ORDER_7A): walls and gates (K1, K2's walks, K3's wall lots), ropes, bridges, tunnels (T3), then climbs' fittings (CL), rock
// stairs (RK), catwalks (CW), spirals (SA), lifts (LF). Each part emits under its own checkpoint (the module's own).
import { CATWALK_KINDS, CLIMB_KINDS, LIFT_KINDS, ROCK_KINDS, SPIRAL_KINDS } from './kinds7a.mjs';
import * as climb from './climb.mjs';
import * as rockStair from './rockStair.mjs';
import * as lift from './lift.mjs';
import * as catwalk from './catwalk.mjs';
import * as spiral from './spiral.mjs';

/**
 * Each row: `kinds` (the connector kinds it compiles), `mod` (its hook module: resolve, leg, passInput, failAnswer, answer, emit,
 * bom, survival), `file` (the module's name), `intent` (the route pass's intent key its passInput rides in, null for none).
 */
export const HOOKS_7A = Object.freeze([
  Object.freeze({ name: 'climb', kinds: CLIMB_KINDS, mod: climb, file: './climb.mjs', intent: null }), // CL
  Object.freeze({ name: 'rockStair', kinds: ROCK_KINDS, mod: rockStair, file: './rockStair.mjs', intent: 'rockStair' }), // RK
  Object.freeze({ name: 'lift', kinds: LIFT_KINDS, mod: lift, file: './lift.mjs', intent: 'lift' }), // LF
  Object.freeze({ name: 'catwalk', kinds: CATWALK_KINDS, mod: catwalk, file: './catwalk.mjs', intent: 'catwalk' }), // CW
  Object.freeze({ name: 'spiral', kinds: SPIRAL_KINDS, mod: spiral, file: './spiral.mjs', intent: null }), // SA
]);

/** The links stage's 7a emission order (frozen): climbs, rock stairs, catwalks, spirals, lifts. */
export const EMIT_ORDER_7A = Object.freeze(['climb', 'rockStair', 'catwalk', 'spiral', 'lift'].map((n) => HOOKS_7A.find((h) => h.name === n)));

/** The hook row that compiles a connector kind, or null. */
export const hookOf = (kind) => HOOKS_7A.find((h) => h.kinds.includes(kind)) ?? null;
