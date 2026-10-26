// (7a RK) What slice RK moves for the byte-identity checks (tools/gate7ark.mjs unchanged, the earlier drivers' unchanged()), by name
// (docs/CONTRACT.md "Phase 7a slice RK" §7, §8 item 2): route row 11 is off unless an edge lists it and only a plan with a rock stair
// part asks volumes, so no committed fixture without one moves. extension/e15_every_reserved_a.json dropped its c_rock_stair part
// (connector.rock_stair supported): the fixture itself changed, planned the same way on both trees.
export const RK_MOVED = Object.freeze({});
