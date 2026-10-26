// (7a RK) What slice RK moves for the byte-identity checks (tools/gate7ark.mjs unchanged, the earlier drivers' unchanged()), by name
// (docs/CONTRACT.md "Phase 7a slice RK" §7, §8 item 2): route row 11 is off unless an edge lists it and only a plan with a rock stair
// part asks volumes, so no committed fixture without one moves. extension/e15_every_reserved_a.json dropped its c_rock_stair part
// (connector.rock_stair supported): the fixture itself changed, planned the same way on both trees.
export const RK_MOVED = Object.freeze({});

/**
 * (Noah's look, 2026-10-26: the parapet copings) RK's own fixtures that the copings move against 809ef1fa (the head before them), by
 * name: only the plans whose flight has a rising stepped parapet run. They are new on this branch (main has none), so unchanged() notes
 * them rather than compares them; recorded here and in CONTRACT "RK as built".
 */
export const RK_COPING_MOVED = Object.freeze({
  'valid/v7a_rk_ridge.json': 'the cut near the foot steps its parapets 1 a cell: coped with the lining\'s slab (the run\'s top post uncapped)',
});
