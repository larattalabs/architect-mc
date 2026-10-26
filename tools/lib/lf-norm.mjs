// (7a LF) What slice LF moves for the byte-identity checks (tools/gate7alf.mjs unchanged, the earlier drivers' unchanged()), by name
// (docs/CONTRACT.md "Phase 7a slice LF" §7, §9 item 3): route row 9 is off unless an edge lists it, the fluids stage is asked only by a plan
// with a lift part, and every new op member, IR kind and checker row is absent without one, so no committed fixture without a lift moves.
// Steward's two recorded lifts (the first recordings, asks-8703dbd/) answer refused NO_CLIMB with a path wouldFit instead of unsupported.
// extension/e15_every_reserved_a.json dropped its c_lift part (connector.lift supported): the fixture itself changed, planned the same way
// on both trees.
export const LF_MOVED = Object.freeze({
  'asks-8703dbd/treetop_village.json': 'storehouse_lift: unsupported {connector.lift, until 7a} -> refused NO_CLIMB with a path wouldFit (the asks claim is flat)',
  'asks-8703dbd/upside_down.json': 'winch_lift: unsupported {connector.lift, until 7a} -> refused NO_CLIMB with a path wouldFit (the asks claim is flat)',
});
