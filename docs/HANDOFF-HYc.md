# HANDOFF: Phase 6c slice HY-c (water gates, `wall.water_gate`)

Branch `slice/HY-c`, worktree `../architect-mc-HYc`, run worktree `../architect-mc-HYc-run` (ports 8942/8943; 8944-8947 spare). Base
`origin/hy/core` (8525a046 merged). Contract: docs/CONTRACT.md "Phase 6c slice HY" §8.3, §14 item 14 and item 9's water-gate row.
Placeholders as HY-core's (API 1.36.0, mod 0.39.0, kit 0.37.0, catalogue 8). $0.

## Interface asks (for the coordinator; HY-core's files)

1. **The grate must be joined bars (defect in the frozen interface, fixed on this branch).** Probe (headless, flat world, a 3 x 2 x 2
   grate across a 2-deep channel under a 2-thick wall, mobs pushed at it for 20 s): `iron_bars[waterlogged=true]` as written (no
   neighbour update: every connection false, posts 2/16 wide, gaps 14/16) let 2 of 6 mobs (zombies, 0.6 wide) through; open water let
   every mob through (the control); bars joined north/south stopped all. Fix: `RegionFluids.writeBody` re-reads each grate cell after
   the body is written and sets `Block.updateFromNeighbourShapes` (vanilla's own joins to the next bars and the shell), still without
   an update. No op, IR or kit change: the kit's evaluator and `GRATE_STATE` stay `iron_bars[waterlogged=true]` (the kit's movers don't
   dive), HY-core's census regex and "still ours" (`is(IRON_BARS)`) already accept any connection state.

## State

- Grate probe done (above). Next: gate.mjs crossing API, wall.mjs lintel, closure, hand course fixture, tests, in-game items.
