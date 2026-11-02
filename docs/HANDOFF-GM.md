# GM handoff

Item 0 (`gm-probe`) has a result: **the lifting extender as the contract states it cannot be built. The slice is stopped under §1's stop rule.** Nothing else in GM is started. `kit/lib/connectors/gmCircuit.mjs` is not written, because no extender circuit is proven.

## What the probe shows (running 26.3, headless, `node tools/gate7agm.mjs probe`)

- Every §1 rule holds: stroke 1, push 12 (13 refused), sticky pull 1, a retracted base moves and an extended one does not, obsidian and chest immovable, a door destroyed (it drops), iron door and trapdoor redstone-only, fence 1.5, wire on a piston, quasi-connectivity.
- **Sticky pull 1 is what stops it.** Three separate bars under downward sticky pistons: lowering by pushes works; raising takes only the top bar. The full three-piston inchworm ends with bars in rows 0, 1, 2(two outer columns untouched) and the middle column's top bar in row 5. Rows 0 and 1 cannot be reached: the first bar stands in the only way in.
- Getting past it needs an arm that passes the lifted bars and reaches floorY+1, a reach of 5 cells from the top of a 4-cell winch room, plus somewhere to park each bar outside the column. There is no such arm in the envelope. Pistons below the floor can raise but are outside the envelope, and then lowering needs a second extender above.

## Outside the contract (recorded, not a claim on the bar)

A slime column down the grid's middle (3 slime, 6 bars) makes one body. One chain of 3 sticky pistons (A, B, C in the middle column) raised and lowered it **20 cycles, 0 faults** (checks: 9 grid blocks in rows 3-5 and 0-2, box identical each cycle, no `moving_piston`, 0 items).
- Raise 27 ticks, lower 17 ticks (lowering relies on the sticky spit: a 1-tick pulse).
- It breaks the contract three ways: slime in the grid (§3 "not added", and visible at the centre of the gate), **5** clear cells above the lintel (C's base at floorY+8; the contract has 4), and the cell under the slime must be immovable (first try: slime lifted the floor block; obsidian fixed it).
- The piston power was commanded redstone blocks in the plane behind, stepped under `/tick freeze`. **No wired circuit exists yet**, and those pistons move through three power rows, so the wiring is not shown.
- A slime row across the middle does not glue: slime only grabs when it is itself the moved block, so the head must touch slime.

## Not run (stopped by the stop rule)

§2a's day-cycle logic, `slide` and `swing` 20 cycles, the drawbridge ripple. The coordinator decides whether they run.

## Decisions needed (Noah, through the coordinator)

1. Accept slime in the grid, 5 cells above the lintel and an immovable floor cell, or
2. Under-floor drivers (a new envelope below floorY, about 9 pistons per column by count, not built), or
3. The split sliding grate (§1's fallback, only with his approval).

## Running it

`node tools/gate-run.mjs 7agm --host server --ports 8896:8897 --run-dir ../architect-mc-GM-run --lock ../architect-mc-GM-run.lock`. The step exits 1 on the extender row until the contract changes.
