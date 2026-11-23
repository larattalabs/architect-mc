# Speed cuts: what was dropped or weakened for gate speed

Noah, 2026-11-21 (relayed by the coordinator): speed may now win over coverage. This file lists every test, row or step that was
dropped or weakened for speed, one line each: what was cut, the minutes saved per gate run, what is no longer covered, and how to
restore it. Changes that only remove repeated work (the same suite run twice in one gate, a single-threaded loop split over
threads) are not cuts: they are listed under "Not cuts" so the next sweep doesn't look for them again.

## Dropped or weakened

Noah approved the weakening cuts directly, typed in the coordinator session on 2026-11-22: "I approve the weakening cuts in
docs/SPEED-CUTS.md (determinism 3→2, txn-crash-adopt +save twin only where it differs, d3 towns 300→100) and any similar
speed-over-coverage cuts SPD finds." Chore SPD3 applied the first and the third; chore TXA applied the txn-crash-adopt cut.

| cut | min saved per gate run | no longer covered | restore |
|---|---|---|---|
| **Determinism "three checks" -> two** (SPD3): 35 kit tests and fl-unit item 10 plan or check the same input twice, not three times, and compare the two. Files: kit/test/ catwalk-cw, cl, districts-d3 (item 17), forms-f1, forms-f3-coral, forms-island, gj, gm-a, gm-b, gm-c, gr-a, h-a, h-wet, hy-a, k2, k3, lf, mp, plan-gc, plan-k1a, plan-k1b, plan-p0-det-1/2/3 (through plan-p0-shared.mjs `determinism`), plan-t3a, plan-t3b, region-6b, region-plan (mega_bench), rk, rv-a, sa, scatter-f2, vocc, wl, ws; tools/gate6cfl.mjs item 10 (and the step messages describing those kit tests in gate6cd3, gate6cmp, gate7agj, gate6drv, gate6cf2, gate7acl). h-wet and plan-t3a checked the IR sha only on run 3: that check moved to run 2. gm-a and gm-c keep a cached first run beside one fresh run. No test removed or merged. Not cut (the gate drivers' own 3-run loops, in game or in process): gate6cf3 item 11, gate6cd items 8-9, gate6ct1/gate6ct2, gate6cp0, gate7ak1/2/3, tools/scenarios.mjs's determinism row | ~2.5 of unit-kit wall together with the d3 row below (unit-kit 9m22-10m02 at load 6-11 in main's runs 20261122-010913 and -033242, 7m07 at load 20-24 in SPD3's gate 20261122-091030), + ~0.3 in fl-unit (item 10: 30-44 s -> 20 s). Detail: the 35 tests summed 1230-1243 s -> 826 s in unit-kit (~7 test-min, spread over its workers, so its own wall share isn't separable); locally at load 55-80, 6182 -> 5078 test-s | a nondeterminism that shows only on a 3rd run (state that leaks across two earlier runs, a cache that warms on the 2nd); 2 runs still catch any run-to-run difference | in each file listed, add the third run back: `[await run(f), await run(f)]` -> three calls, loop bounds `i < 2` / `k < 2` -> `< 3`, `[0, 1].map` -> `[0, 1, 2].map`, `['a', 'b']` -> `['a', 'b', 'c']` (region-plan), `for (const k of [1])` -> `[1, 2]` (gm-c), and the `[2]` / `c` equality asserts beside the `[1]` / `b` ones; the test titles' "two"/"2"/"twice" back to "three"/"3"; tools/gate6cfl.mjs item 10: a third `await h.run(f)` and `&& j[2] === j[0]`; the driver messages' "2" back to "3". `git show 8e73e4f7` plus the driver-message commit after it (SPD3) are the exact diffs to revert |
| **districts-d3 item 1: 300 -> 100 seeded towns** (SPD3): the first 100 towns of the same sequence (`TOWN_SEED` 20261023), still on up to 6 worker threads, so a failing town n < 100 reproduces as before. Count-dependent expectations: the joined bound `>= 200` (two thirds of 300) is now `>= Math.ceil(TOWNS * 2 / 3)` = 67 (measured: 100 of 100 joined, 51 at a side, 189 hold cells; 300 of 300, 143, 648 before); the title, the summary line and gate6cd3's d3 message say 100. The per-town re-check (`n % 25 === 0`) now covers 4 towns, not 12 | part of the ~2.5 min of unit-kit wall above (it was unit-kit's critical path). Detail: item 1's own wall 537-578 s -> 64 s in unit-kit; locally at load 55-80, 823 -> 325 s | towns 100-299 of the sequence (200 synthetic layouts: axis, street, lots, held rects, bodies, terrain, district side) | kit/test/d3-towns.mjs `export const TOWNS = 100` -> `300` (the joined bound follows it); "100" -> "300" in the item 1 title in kit/test/districts-d3.test.mjs and in tools/gate6cd3.mjs's items 1, 2, 17 message |
| **txn-crash-adopt kill matrix: the `+save` twin only where it differs** (TXA; rule accepted by the coordinator, 2026-11-23): the rule, from TxnCore: `+save` (WorldJournal.kill) saves every chunk and the ledger before the halt, which changes what is on disk only while an applied effect is not yet durable, from an `apply:N`/`comp:N` point to the next `barrier:*` point (TxnCore kills there after `env.barrier()` made players, chunks and the ledger durable; `journal.release` and `record.clear` confirm their own writes). So the twin runs at `apply:0`..`apply:7` (8 of 17 points) and is skipped at `intent`, `barrier:prepare`, `prepared`, `decided`, `barrier:effects`, `effects`, `emit:stockpile_changed`, `retiring`, `done`: 34 -> 25 halts. The rule is computed over the traced points, so a new point is classed by its name | ~4.0 of step time (~2 wall per part): 9 halts x 26.8 s, the mean halt measured in the after run below | a saved-then-killed halt at the 9 points where the save should be a no-op: a bug where a barrier fails to cover something a full save would write (or a save hook that changes state) is no longer caught at those points | `GATE_T3B_ALL_TWINS=1` in the step's env (or the driver's `allTwins` default) runs every twin |

## Not cuts (chore SPD): the same coverage, less repeated work

- **unit-scope skips the suites the run already runs in full** (`GATE_FULL_UNITS`: unit-kit, unit-sidecar, unit-mod in the run or
  CACHED). Same head, same worktree, a superset of its picks. Saves the kit suite (~11-18 min) in change runs that had unit-kit too.
- **districts-d3 item 1** (300 seeded towns then; 100 since SPD3's cut above) runs on up to 6 worker threads: the same towns, assertions and counts. It was the kit
  suite's critical path, a single test of ~770 s under load.
- **fl-unit reads its four kit files from unit-kit's report** when it is exact (`kit-reuse.mjs`), instead of running them again.
  It has no `waitFor`, so this helps only when unit-kit is CACHED or already finished.
- **unit-sidecar takes 3 CPU shares** (chore SPD2; `cpuShares` 3 in `tools/gate-chains.json`: 9 vitest forks at the usual share of 3,
  was 3). The same 953 tests. Measured with `budgetEnv`'s env under `nice -n 10`, next to the whole kit suite at unit-kit's 6 shares
  (17 workers), the worst case: in a gate run unit-sidecar normally follows unit-kit on the same shard. Two pairs, A B A B:

  | sample | sidecar 3 forks | sidecar 9 forks | unit-kit next to it (3 / 9) | 1-min load start -> end |
  |---|---|---|---|---|
  | pair 1 | 756 s | 634 s | 827 s / 624 s | 5.6 -> 35 / 17.6 -> 17 |
  | pair 2 | 856 s | 743 s | 909 s / 704 s | 17 -> 41 / 23.9 -> 24.5 |
  | median | 806 s | 689 s (-2 min) | 868 s / 664 s (not slower) | |

  953/953 and kit 1683/0 in all four; no "connection closed" and no eval.e2e failure at 9 forks. The ceiling is the slowest file,
  polish.test.ts (~100 s of 806 s of tests). Restore: drop the `cpuShares` key.
- **fl-unit's `cpuShares` 3 was measured and not applied** (SPD2). Item 4's cold loop (926 plans, a fresh plan store, a base dir
  whose trees force the full loop), next to unit-kit: 4 workers 1389 s and 1164 s (median 1276 s); 9 workers 1739 s (load 80-90
  from other gates) and 853 s (median 1296 s). unit-kit beside it: 1241/945 s before, 1945/1067 s after. No median gain, and pair 1's
  after-run slowed unit-kit, so the default stays. Pair 2 alone (similar load) suggests -5 min; re-measure on a quiet box before
  retrying. A warm gate run reads the shared plan store and does not plan at all.

- **txn-crash-adopt builds the T3 fixture once** (chore TXA): b1, b2, the part-built house_4 and the stockpile were built in a fresh
  world by each of 6 cases (overflow, retagged, held, the matrix, legacy-finish, gone-save); now each process builds it once in
  `G6B T3 Fixture`, leaves it cleanly, and every case opens an APFS clone (`L.copyWorld`); the kill matrix restores from it too
  (and from a clone, not `fs.cpSync`), and traces in the clone it opened instead of saving, copying and reopening. Each case still
  reads its crate, tag, stock and conservation baseline from its own copy. Measured (chore TXA, load p50 9.5): the fixture build 60-61 s, a clone and open 5 s, so ~55 s per build avoided: ~4.6 min of step time whole (6 builds -> 1), ~3.7 min split (6 -> 2, one per part). The cases now start from a cleanly reopened
  world, not the live one they built (the matrix always did). Restore: build per case in `t3Town` (drop the `fixture` cache).
- **txn-crash-adopt is a split step** (chore TXA): two parts on two shards' headless servers (`split` in `gate-chains.json`,
  `tools/lib/gate-part.mjs` sections): p1 the matrix's odd halts, overflow, road, retagged; p2 the even halts, held, legacy-finish,
  gone-save. Each part builds its own fixture and traces its own adoption. It splits in a run that splits (turbo, `--split`,
  `--only txn-crash-adopt/p1`, or since chore TXS a fixed `--shards N` >= 2, so the release verifiers' `--no-turbo --shards 2`
  runs split too); one shard (or `--no-split`) runs the step whole. Measured: the two parts took 8m35s and 8m08s (16m43s of step time) in 8m35s of wall: -8.1 min wall, at the cost of the second part's fixture build (~1 min) and a second server. Restore: drop the
  `split` key.

- **txn-crash-adopt before and after, all three cuts** (chore TXA): before, 604e109d whole on one server: 24m45s, 205/0, load p50 12.6,
  p90 20.4, max 26.4 (run 20261123-003524-change); after, e9ff093f split on two servers: 8m35s wall (parts 8m35s and 8m08s), 153/0,
  load p50 9.5, max 12.3 (run 20261123-044047-change): -16.2 min wall. `split-proof.mjs` (whole vs parts): the only checks missing
  are the 9 skipped `+save` twins' (29 check lines) and the 4 fixture builds no longer repeated (24: the T3 town, its builds and its
  stockpile); added: one crate check and one traced adoption per extra part.

## Proposed (measured, not applied)

| proposal | est. min saved | what it weakens |
|---|---|---|
| t4-crash (slice/T4R, not on main) T4-2nd-b: `L.openWorld(name).catch(() => null)` waits out `run6b.openWorld`'s 1800 x 500 ms ready-poll after the server already exited at the start's kill point (905 s in T4RN's run); race it with `haltWait`, or make `openWorld` fail once the host's `dev.state` shows no server (`host` set, `loading: false`, `phase: 'title'`) | ~15 | nothing (waste) |
| t4-crash T4-2nd: the fixed `L.sleep(200_000)` race against the open that never completes; race with `haltWait` instead | ~3 | nothing (waste) |
| unit-sidecar `cpuShares` 3-4: **applied as 3 in SPD2** (median 806 -> 689 s next to unit-kit; "Not cuts") | ~2 measured | nothing |
| fl-unit `cpuShares` 3: **measured in SPD2, not applied** (no median gain under shifting load; "Not cuts") | 0-5 | nothing |
| plan-k1a item 7 and plan-p0-asks item 11 both plan Steward's 59 recorded plans (~250-400 s each under load): share one planning | ~4 CPU-min | nothing (waste) |
