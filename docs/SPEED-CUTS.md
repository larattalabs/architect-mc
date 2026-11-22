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
- **unit-scope runs kit, sidecar and Gradle side by side**, not one after another.
- **districts-d3 item 1** (300 seeded towns) runs on up to 6 worker threads: the same towns, assertions and counts. It was the kit
  suite's critical path, a single test of ~770 s under load.
- **fl-unit reads its four kit files from unit-kit's report** when it is exact (`kit-reuse.mjs`), instead of running them again.
- **unit-sidecar gets 4 CPU shares** (12 vitest forks, was 3) and **fl-unit 3** (9 plan workers, was 4).

## Proposed (measured, not applied)

| proposal | est. min saved | what it weakens |
|---|---|---|
| Determinism "three checks" -> two, in ~24 kit files (plan-p0-det-1/2/3, plan-t3b, h-wet, k3, ...) and fl-unit item 10 | ~1.5 kit wall, ~8 CPU-min | a nondeterminism that shows only on the 3rd run |
| txn-crash-adopt kill matrix: the `+save` twin only where it differs from the bare point (17 points x 2 x ~25 s) | ~5-7 | the saved-then-killed variant at those points |
| districts-d3 item 1: 300 -> 100 towns | ~0.5 (now that it is threaded) | 200 of the seeded towns |
