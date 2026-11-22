# Speed cuts: what was dropped or weakened for gate speed

Noah, 2026-11-21 (relayed by the coordinator): speed may now win over coverage. This file lists every test, row or step that was
dropped or weakened for speed, one line each: what was cut, the minutes saved per gate run, what is no longer covered, and how to
restore it. Changes that only remove repeated work (the same suite run twice in one gate, a single-threaded loop split over
threads) are not cuts: they are listed under "Not cuts" so the next sweep doesn't look for them again.

## Dropped or weakened

Noah approved the weakening cuts directly, typed in the coordinator session on 2026-11-22: "I approve the weakening cuts in
docs/SPEED-CUTS.md (determinism 3→2, txn-crash-adopt +save twin only where it differs, d3 towns 300→100) and any similar
speed-over-coverage cuts SPD finds." Chore SPD3 applied the first and the third; the txn-crash-adopt cut waits for slice/T4R to merge.

| cut | min saved per gate run | no longer covered | restore |
|---|---|---|---|
| **Determinism "three checks" -> two** (SPD3): 35 kit tests and fl-unit item 10 plan or check the same input twice, not three times, and compare the two. Files: kit/test/ catwalk-cw, cl, districts-d3 (item 17), forms-f1, forms-f3-coral, forms-island, gj, gm-a, gm-b, gm-c, gr-a, h-a, h-wet, hy-a, k2, k3, lf, mp, plan-gc, plan-k1a, plan-k1b, plan-p0-det-1/2/3 (through plan-p0-shared.mjs `determinism`), plan-t3a, plan-t3b, region-6b, region-plan (mega_bench), rk, rv-a, sa, scatter-f2, vocc, wl, ws; tools/gate6cfl.mjs item 10. h-wet and plan-t3a checked the IR sha only on run 3: that check moved to run 2. gm-a and gm-c keep a cached first run beside one fresh run. No test removed or merged | ~7 test-min in unit-kit (these tests summed 1615-1624 s in main's runs 20261122-033242 and -010913, 1199 s in SPD3's gate 20261122-091030; spread over unit-kit's workers, so its wall share isn't separable) + ~0.3 in fl-unit (item 10: 30-44 s -> 20 s). Locally at load 55-80: 6297 -> 5215 test-s | a nondeterminism that shows only on a 3rd run (state that leaks across two earlier runs, a cache that warms on the 2nd); 2 runs still catch any run-to-run difference | in each file listed, add the third run back: `[await run(f), await run(f)]` -> three calls, loop bounds `i < 2` / `k < 2` -> `< 3`, `[0, 1].map` -> `[0, 1, 2].map`, `['a', 'b']` -> `['a', 'b', 'c']` (region-plan), `for (const k of [1])` -> `[1, 2]` (gm-c), and the `[2]` / `c` equality asserts beside the `[1]` / `b` ones; the test titles' "two"/"2"/"twice" back to "three"/"3"; tools/gate6cfl.mjs item 10: a third `await h.run(f)` and `&& j[2] === j[0]`. `git show 8e73e4f7` (SPD3) is the exact code diff to revert |
| **districts-d3 item 1: 300 -> 100 seeded towns** (SPD3): the first 100 towns of the same sequence (`TOWN_SEED` 20261023), still on up to 6 worker threads, so a failing town n < 100 reproduces as before. Count-dependent expectations: the joined bound `>= 200` (two thirds of 300) is now `>= Math.ceil(TOWNS * 2 / 3)` = 67 (measured: 100 of 100 joined, 51 at a side, 189 hold cells; 300 of 300, 143, 648 before); the title, the summary line and gate6cd3's d3 message say 100. The per-town re-check (`n % 25 === 0`) now covers 4 towns, not 12 | ~8 of item 1's own wall (537-578 s -> 64 s in unit-kit; it was the suite's critical path). Together with the row above, unit-kit went from 9m22-10m02 (load 6-11) to 7m07 (load 20-24): ~2.5 min of gate wall at more than twice the load. Locally at load 55-80: 823 -> 325 s | towns 100-299 of the sequence (200 synthetic layouts: axis, street, lots, held rects, bodies, terrain, district side) | kit/test/d3-towns.mjs `export const TOWNS = 100` -> `300` (the joined bound follows it); "100" -> "300" in the item 1 title in kit/test/districts-d3.test.mjs and in tools/gate6cd3.mjs's items 1, 2, 17 message |

## Not cuts (chore SPD): the same coverage, less repeated work

- **unit-scope skips the suites the run already runs in full** (`GATE_FULL_UNITS`: unit-kit, unit-sidecar, unit-mod in the run or
  CACHED). Same head, same worktree, a superset of its picks. Saves the kit suite (~11-18 min) in change runs that had unit-kit too.
- **districts-d3 item 1** (300 seeded towns then; 100 since SPD3's cut above) runs on up to 6 worker threads: the same towns, assertions and counts. It was the kit
  suite's critical path, a single test of ~770 s under load.
- **fl-unit reads its four kit files from unit-kit's report** when it is exact (`kit-reuse.mjs`), instead of running them again.
  It has no `waitFor`, so this helps only when unit-kit is CACHED or already finished.

## Proposed (measured, not applied)

| proposal | est. min saved | what it weakens |
|---|---|---|
| txn-crash-adopt kill matrix: the `+save` twin only where it differs from the bare point (17 points x 2 x ~25 s) | ~5-7 | the saved-then-killed variant at those points |
| t4-crash (slice/T4R, not on main) T4-2nd-b: `L.openWorld(name).catch(() => null)` waits out `run6b.openWorld`'s 1800 x 500 ms ready-poll after the server already exited at the start's kill point (905 s in T4RN's run); race it with `haltWait`, or make `openWorld` fail once the host's `dev.state` shows no server (`host` set, `loading: false`, `phase: 'title'`) | ~15 | nothing (waste) |
| t4-crash T4-2nd: the fixed `L.sleep(200_000)` race against the open that never completes; race with `haltWait` instead | ~3 | nothing (waste) |
| txn-crash-adopt: the T3 fixture (builds b1, b2, part-built house_4, ~50 s) rebuilt for each of 5 cases; copy one prepared world snapshot | ~3 | nothing (waste) |
| txn-crash-adopt: the 34 kill-matrix restarts (~16 min) split over 2 headless servers | ~8 wall | nothing; one more server |
| unit-sidecar `cpuShares` 3-4 (3 vitest forks now: 841 s of tests in 5-10 min) | ~3-6 | nothing; needs a measurement next to unit-kit x6 (SPD's oversubscribed run failed eval.e2e) |
| fl-unit `cpuShares` 3 (item 4's 926 corpus plans took 1013 s on 4 workers under load) | ~5 at load | nothing; unmeasured |
| plan-k1a item 7 and plan-p0-asks item 11 both plan Steward's 59 recorded plans (~250-400 s each under load): share one planning | ~4 CPU-min | nothing (waste) |
