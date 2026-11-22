# Recurring review findings

The failure classes that came up again and again in about 60 GPT reviews between 2026-11-15 and 2026-11-21, across
TXN, T2, T4, T4R, 8cT, DF, SOFF, PLR, RTE and E2E-DISK. Each has an Architect example. AGENTS.md "Recurring review findings" says
when to use this list. The section headed "For review prompts" at the end is pasted into every GPT review prompt.

## A. Crash safety (strict slices: the design answers each one before the GPT design review)

1. **One durable record per fact.** Name the single record that decides "did this happen?". Everything else derives from it.
   - *Example:* T4R-N. A player-block item entity and its chunk receipt were two stores, so a second crash paid out 0 or 2.
   - *Example:* PLR. `architect-sites.json` said `placing:true` while the async `architect-queue.json` didn't know the job existed.
2. **Persist before mutate, and acknowledge the right save.** Write the record durably first, including its parent directory's
   fsync, before touching the world, a stockpile or a credit. A queued save, an executor completion or an off-thread write is not
   persistence. Minecraft saves chunks before entities, saves eagerly and at unload, and swallows errors in player saves.
   - *Example:* PLR2. The refused tile was committed ACTIVE before its FAILED state was saved, so a crash brought the item back
     QUEUED.
3. **The second crash.** Every recovery path (replay, rollback, settle, sweep) must itself survive a crash and run exactly once.
   Walk "crash, recover, crash again" for each recovery step.
   - *Example:* T4R-N's paid cascade hold cycle after a crash between R3 and R4.
4. **Key per operation, not per target.** Idempotency keys identify each attempt or extraction, never just a site, tile or cell.
   Reused keys caused double pays and lost aborts.
5. **Holds and admission see everything, including after a restart.** Use one admission rule over the full footprint (crates,
   piles, margins), plus holds loaded from disk, in a simple order such as FIFO per dimension. Deadlocks came from partial views.
   - *Example:* PLR. `RegionTargets.building()` counted a placing record that the load sweep ignored, so the region hung forever.
6. **Refunds track what was actually removed.** Price each cell at its real item cost (a double slab is 2), from what the removal
   took out, not from a plan or journal guess. A rollback that restores a block must also undo any refund paid for it.
   - *Example:* PLR's P1 3. `retakeToPile` refunded a block that the crash rollback then put back.

## B. Scope and design

7. **Don't convert old in-flight state.** Let half-finished work from older worlds finish on the old path; only new work uses the
   new design.
   - *Example:* T4R-L. Converting legacy work found new P1s in every round.
8. **Listing cases never closes a hole.** "These N ways a block can change" always misses one. Find one structural rule you can
   prove, or narrow the promise and document the rest as a known risk in CONTRACT.md.
   - *Example:* T4R-D. Revs 1 to 3 each missed a case: falling blocks, then dragon eggs and leaves, then campfires and buckets.
     Option (b) narrowed the promise to the direct-write core.
9. **When every round finds new edges in the same area, stop patching.** Redesign or narrow the scope. The review guard (speed
   rule 4) exists for this. Design-review strict work before building it.
10. **Old saved data is a test input.** Check every reader against real plans and worlds saved by earlier versions.
    - *Example:* RTE regressed on older saved plans four times before such a corpus existed.

## C. Tests that prove something (the builder's self-check before the early review)

11. **A test must fail when its fix is reverted.** For every failing-first row, revert only the fix and rerun it: the row must go
    red again. Record the red run's commit and run dir in the changes file. A row that stays green is not evidence.
12. **Assert state, not log lines.** A missing log line doesn't prove nothing happened. Read the saved record, the stockpile or the
    world, or add a dev-only probe.
13. **Make the bad window reachable.** If a race can't happen without a hook, add a dev-only fault point (docs/DEVBRIDGE.md). Gate
    it to dev or headless starts, and disarm it when the server stops. Otherwise the in-game row never fires.
    - *Example:* PLR2's XR1 row was never reached.
14. **Every wait has a bound.** A timeout is a FAIL, never a pass, and so are zero results. Log progress at least once a minute.
    - *Example:* PLR2's xr-crash halt wait sat silent for 40 minutes.

## D. Tooling and the disk

15. **Paths are hostile.** Use realpath, refuse symlinked or nested roots, compare case-insensitively (APFS) and claim files
    exclusively. Cleanup code must prove it owns a path before it deletes it.
    - *Example:* chore/DISK's lstat check on the root.
16. **Runs clean up after themselves** and refuse to start below the 150 GiB free-space floor (gate-run's space guard).
17. **Verifiers run `--no-turbo` with fixed shards**, so they never reserve the whole machine.

## For review prompts

Paste this block into every GPT design review and code review prompt, after the goal and before the questions:

```
Known failure classes in this codebase (check these first, then look beyond them):
- Two durable stores that can disagree after a crash (item vs receipt, queue file vs site record, credit vs block).
- A world, stockpile or credit change before its record is durably saved; a queued or async save treated as persisted.
- A recovery path (replay, rollback, sweep) that is not itself crash-safe and exactly-once: crash, recover, crash again.
- Idempotency keyed per target instead of per operation.
- Holds or admission that miss part of a footprint, or holds loaded from disk after a restart.
- Refunds priced from a plan rather than what was removed; a rollback that restores a block but keeps its refund.
- Old in-flight state converted to a new design; older saved worlds and plans not handled.
- A case list where a structural rule is needed.
- Tests that stay green with the fix reverted, assert log lines rather than state, never reach their window, or wait unbounded.
- Test hooks that can arm outside dev or headless starts, or outlive the server.
- Paths and cleanup that trust symlinks, case or ownership.
```
