# Speed cuts: what was dropped or weakened for gate speed

Noah, 2026-11-21 (relayed by the coordinator): speed may now win over coverage. This file lists every test, row or step that was
dropped or weakened for speed, one line each: what was cut, the minutes saved per gate run, what is no longer covered, and how to
restore it. Changes that only remove repeated work (the same suite run twice in one gate, a single-threaded loop split over
threads) are not cuts: they are listed under "Not cuts" so the next sweep doesn't look for them again.

## Dropped or weakened

None yet. Chore SPD (2026-11-21) applied only the waste removals below. The weakening cuts it measured are listed under "Proposed".
The permission check refused them: a relayed message didn't count as Noah's approval for weakening assertions. They wait for Noah to
confirm them directly.

| cut | min saved per gate run | no longer covered | restore |
|---|---|---|---|

## Not cuts (chore SPD): the same coverage, less repeated work

- **unit-scope skips the suites the run already runs in full** (`GATE_FULL_UNITS`: unit-kit, unit-sidecar, unit-mod in the run or
  CACHED). Same head, same worktree, a superset of its picks. Saves the kit suite (~11-18 min) in change runs that had unit-kit too.
- **districts-d3 item 1** (300 seeded towns) runs on up to 6 worker threads: the same towns, assertions and counts. It was the kit
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

## Proposed (measured, not applied)

| proposal | est. min saved | what it weakens |
|---|---|---|
| Determinism "three checks" -> two, in ~24 kit files (plan-p0-det-1/2/3, plan-t3b, h-wet, k3, ...) and fl-unit item 10 | ~1.5 kit wall, ~8 CPU-min | a nondeterminism that shows only on the 3rd run |
| txn-crash-adopt kill matrix: the `+save` twin only where it differs from the bare point (17 points x 2 x ~25 s) | ~5-7 | the saved-then-killed variant at those points |
| districts-d3 item 1: 300 -> 100 towns | ~0.5 (now that it is threaded) | 200 of the seeded towns |
| t4-crash (slice/T4R, not on main) T4-2nd-b: `L.openWorld(name).catch(() => null)` waits out `run6b.openWorld`'s 1800 x 500 ms ready-poll after the server already exited at the start's kill point (905 s in T4RN's run); race it with `haltWait`, or make `openWorld` fail once the host's `dev.state` shows no server (`host` set, `loading: false`, `phase: 'title'`) | ~15 | nothing (waste) |
| t4-crash T4-2nd: the fixed `L.sleep(200_000)` race against the open that never completes; race with `haltWait` instead | ~3 | nothing (waste) |
| txn-crash-adopt: the T3 fixture (builds b1, b2, part-built house_4, ~50 s) rebuilt for each of 5 cases; copy one prepared world snapshot | ~3 | nothing (waste) |
| txn-crash-adopt: the 34 kill-matrix restarts (~16 min) split over 2 headless servers | ~8 wall | nothing; one more server |
| unit-sidecar `cpuShares` 3-4: **applied as 3 in SPD2** (median 806 -> 689 s next to unit-kit; "Not cuts") | ~2 measured | nothing |
| fl-unit `cpuShares` 3: **measured in SPD2, not applied** (no median gain under shifting load; "Not cuts") | 0-5 | nothing |
| plan-k1a item 7 and plan-p0-asks item 11 both plan Steward's 59 recorded plans (~250-400 s each under load): share one planning | ~4 CPU-min | nothing (waste) |
