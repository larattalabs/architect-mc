# GM handoff

Item 0 (`gm-probe`) has a result: **the lifting extender as the contract states it cannot be built. The slice is stopped under §1's stop rule.** Nothing else in GM is started. `kit/lib/connectors/gmCircuit.mjs` is not written, because no extender circuit is proven.

## What the probe shows (running 26.3, headless, `node tools/gate7agm.mjs probe`)

- Every §1 rule holds: stroke 1, push 12 (13 refused), sticky pull 1, a retracted base moves and an extended one does not, obsidian and chest immovable, a door destroyed (it drops), iron door and trapdoor redstone-only, fence 1.5, wire on a piston, quasi-connectivity.
- **Sticky pull 1 is what stops it.** A column of separate bars under downward sticky pistons: pushes lower it, but raising takes only the top bar. The full three-piston inchworm (`extender`) ends with that column's bars at rows 0, 1 and 5 (the bar: 3, 4, 5), and it already needed row 8.
- **Why this is not one failed rig.** Raising separate bars one at a time needs a puller between the raised top bar and the next one down. It can only get there from the side, and a full 3-wide plane d=1 under a lintel has no side: the lanes must stay clear and the middle column has no jamb. Pullers below the floor have the same problem in reverse when lowering, and they sit outside the envelope.

## Outside the contract (recorded, never a claim on the bar)

The only design measured to move a whole grid: a slime column down the grid's middle (3 slime, 6 bars) makes one body, reeled by one chain of 3 sticky pistons in the middle column.

| Run | Result |
|---|---|
| Open air, obsidian under the slime | 20 cycles, 0 faults: 9 grid blocks in rows 3-5 and 0-2, box identical each cycle, no `moving_piston`, 0 items |
| Stone on the faces (lintel row both faces, wall rows 3-8 on the front) | **fails on cycle 1**: the grid jams 1 cell up, and lowering drags the two lintel cells beside the slime down into the lanes |

So 20 cycles says nothing about a real gatehouse. To be a candidate it needs, all outside the contract:
- slime visible in the grid (§3 "not added");
- non-stickable faces (obsidian-class, not themed) wherever the slime column passes, and under it (the first try lifted the floor cell);
- **5** clear cells above the lintel (C's base at floorY+8; contract 4), and a power plane outside d=1;
- a wired circuit. Power here was commanded redstone blocks stepped under `/tick freeze`.

Numbers: 3 sticky pistons for the whole grid (contract: about 9-12). Raise 27 / lower 17 ticks are the **commanded schedule** (3 ticks a stroke, 1-tick spit pulses), not a free-running circuit's time; shorter spacing was not tried.

A slime row across the middle does not glue: slime only grabs when it is itself the moved block, so the head must touch slime.

## Not run (stopped by the stop rule)

§2a's day-cycle logic, `slide` and `swing` 20 cycles, the drawbridge ripple. The coordinator decides whether they run.

## Decisions needed (Noah, through the coordinator)

1. The split sliding grate (§1's fallback, only with his approval): the shortest way on, and not probed yet.
2. A slime-glued grid, with everything listed above and a new probe, or
3. Under-floor drivers (a new envelope below floorY, an estimated 9 pistons or so per column, never built or tested).

## Running it

`node tools/gate-run.mjs 7agm --host server --ports 8896:8897 --run-dir ../architect-mc-GM-run --lock ../architect-mc-GM-run.lock`. The step exits 1 on the extender row until the contract changes.

Evidence (uncommitted, main checkout): `artifacts/gate7a-gm/` (`probe.json`, `SUMMARY.md`, `gm-probe.log`).
