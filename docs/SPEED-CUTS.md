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
| unit-sidecar `cpuShares` 3-4 (3 vitest forks now: 841 s of tests in 5-10 min) | ~3-6 | nothing; needs a measurement next to unit-kit x6 (SPD's oversubscribed run failed eval.e2e) |
| fl-unit `cpuShares` 3 (item 4's 926 corpus plans took 1013 s on 4 workers under load) | ~5 at load | nothing; unmeasured |
| plan-k1a item 7 and plan-p0-asks item 11 both plan Steward's 59 recorded plans (~250-400 s each under load): share one planning | ~4 CPU-min | nothing (waste) |
