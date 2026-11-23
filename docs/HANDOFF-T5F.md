# T5F resume note (slice/T5F, worktree _work/architect-mc-T5F)

Contract: the coordinator's T5F draft (side-session notes, architect-T5F-contract-draft.md) with N1-N6, S1-S4, Q1-Q3. As-built: docs/CONTRACT.md
"Slice T5F". Build: `export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home; cd mod && nice -n 10 ./gradlew test --offline`.

## Done
- T5Fa (merged with T4R), T5Fb (+ two fix rounds, in-game green at 7c05870c; record in CONTRACT).
- T5Fc must-fixes (a)-(c) from T5Fb's last GPT pass: 8ffeecc6.
- T5Fc part 1 (eb9a8b7c): drain per (body, chunk) with counted receipts and mark deletion; region.scoop txn (scoopStep in gateOne and
  gateFlowing, after the drain); deadline from receipts (settleDeadline; until never read/saved); legacy 8cT drain adapters kept.
  Units FluidsT5FcTest. Still to unguard in FluidsT5FRedTest/FluidCrashModelT5FTest: i4, i5 x2, f_, runtime SEEN_AHEAD, AGGREGATE_W,
  L_BEFORE_BARRIER, STORED_UNTIL (green now).

- T5Fc parts 2-3 (ff74d14a, head): RemoveResult fluids plumbing, Q1 freezeRows, fluid.stray txns, escape/held/lot per-chunk Ws.
  As-built in CONTRACT "Slice T5Fc as built".

## T5Fc, next: hooks and rows (dev.api.removalEvents; coverage rows; matrix steps), red run on ffea3bd5 (T5Fb head = the revert
## check), green run, then flowingWater advertised in its own last commit. (Earlier plan: part 2: RemoveResult plumbing via Groups.Removed + ApiEvents + RemovalTxn payload + undoResult, reading fluids.json
## scoopCredited/taken (fluids.json survives REMOVED: only region.json is deleted); Q1 freezeRows; fluid.stray; escape/held/lot per chunk)
1. Units red, no runtime change: drain W per (body, chunk) counting l/u/h at its apply; only a lost chunk replayed; region.scoop from receipts
   (an UNKNOWN chunk holds); deadline from receipt t; stray txn; escape/lot per chunk; freezeRows (Q1); fluidsTaken/Cells; no R mark left.
2. Row drivers and hooks (no runtime change): dev.api.removalEvents (t5-s3b); coverage rows t5-escape-closure, t5-held-future, t5-lot-multi,
   t5-lot-barrier-crash, t5-rc-strict; drain/stray/scoop/charge matrix steps. Red run once (load <= 25, no other in-game gate).
3. Runtime: drain per (body, chunk) + @seen gone; region.scoop + RemoveResult plumbing (credited, not planned; one merge for every path:
   group future, removalFinished, the RemovalTxn payload, undoResult, the region's future); deadline from receipts (no stored until read);
   escape/unsettled/upstream/held/lot on per-chunk Ws; fluid.stray txns; Q1 tombstone rows. Then the green run.
4. Last commit: advertise flowingWater.

## Runs (ports 9050:9051,9052:9053; --lock .../_work/architect-mc/artifacts/gate-runs/gate-run-T5F.lock; out _work/architect-mc-T5F-runs/)
`GITHUB_TOKEN=$(gh auth token) node tools/gate-run.mjs change --since origin/main --no-turbo --only <steps> --shards 2 --ports ... --run-dir
<_work>/architect-mc-T5F-run --run-dirs <_work>/architect-mc-T5F-run,<_work>/architect-mc-T5F-run-s2 --out <_work>/architect-mc-T5F-runs/<name>
--lock <lock>`. Never the 135-step harness or 8c-ingame/-crash/-survival (the coordinator schedules them).

## T5Fc fix round: BUILT (aae02fde seams + red tests, 580f989c fixes; as-built in CONTRACT "Slice T5Fc fix round as built")

- Units: FluidsT5FcFixTest 17/17 red on aae02fde, green on 580f989c; per-finding revert check 16/16 red (mutation script kept outside the
  repo); mod suite 2005 tests, 0 failed, 1 skipped.
- In-game (3 runs used): red3 on ffea3bd5 8/8 FAIL; green3 on 77611839 6 PASS (incl. t5-drain-tx, t5-scoop-tx); green4 on 03fe3489 t5-s3a and
  t5-drain-hold PASS after two driver fixes (hold: conservation only). t5-drain-fl5 and t5-drain-mixed stay FAIL on their preconditions (red
  and green alike; mixed's 11 == 10 unexplained, the scoop credited 10); both need a driver rework. Record: CONTRACT "fix round as built".
- Not done here: the coverage rows (t5-escape-closure, t5-held-future, t5-lot-multi, t5-lot-barrier-crash, t5-rc-strict); flowingWater
  stays unadvertised; the GPT fix-check (the coordinator's).

## T5Fc round 2: state at stop (2026-11-22, stopped on Noah's word before any code change)

Scope: the fix-check of 829658b8 (coord-tools/reviews/T5Fc-fixcheck-829658b8.findings.md), findings 2-5, the test gaps and the fl5/mixed drivers.
Done so far: reading and the design only. No code, test or in-game run yet, so there is no red or green evidence. Head is still 829658b8.
- **Finding 2 (legacy selection): not started.** Design: `record()` stamps every W it plans with a schema marker (for example `"pc":1`).
  `FluidTxns.w()` takes the DrainCtx/chunkFilter/tickBodyIn path only when the marker is present (not `cs.size()==1`). An unmarked entry
  runs as 8cT did. Drop the old path's `level == null` guard and let each run check it: escape and lotdrain already do; add the check to
  `LegacyV1.PLACE`. Red test: a pool record with `prov=false` and no marks, and a hand-planned legacy `fluid.hold` W (one chunk [0,0], no
  marker, no closure) recovered and driven: POOL must be air. Revert check: restore the chunk-count condition in `w()`. As-built note:
  unmarked fix-round dev intents take the legacy path (P3 class).
- **Findings 3 and 4 (escape `at`, destination chunks): not started.** Design: `record()` takes the chunk footprint from its caller instead
  of `drainChunks(st)`. Footprint = drainChunks(st) ∪ drainChunksOf over the W's bodies (escape: closure + body; hold: body + upstreamOf,
  as in wBodies; lot: its bodies) ∪, for an escape with why=="escaped", the `at` cells and their face neighbours (plus the abort work
  cells' chunks). Freeze the `at` cells into each W's data (`esc`). In FLUID_ESCAPE's new branch, feed them as extra stray candidates for
  the body (a static set scoped with try/finally, like chunkFilter; never mutate bs.escapedCells in the W). Also feed them as extra
  tickBodyIn sources in `w()`. Tests: the pit with at cells (20,60,5) (a planned chunk) and (48,60,5) (chunk 3, unplanned), both holding
  flowing lava, must end as air, and chunk 2's W must tick flow at (47,60,5). A pool-only IR (x 15) held with flow at POOL_EAST must have
  w.ticksIn(1,0) contain POOL_EAST. Revert checks: drop the esc feed; restore drainChunks(st) in record().
- **Finding 5 (revision rows): not started.** Design: `freezeRows` returns the confirmed region-record save. `report()` returns
  RegionsImpl.save's result, which fixes the REMOVING branch too. Extract `saveDone(l, st, back)`: removal=done, then freezeRows, else roll
  back and return false; barrierDone; save(l,st). gateOne (~3727) and gateFlowing (~4652) both call it. Test: refuse region.json with a
  non-empty directory at its path (or RegionStore.failNext with sticky). saveDone(rev live rid 2) must be false and done must not be on
  disk. Clear the refusal; it must then be true, and after a restart region.json on disk must have architect_mc:fluidsUndone."2". Call
  saveDone by reflection so the test compiles red. Revert: ignore freezeRows' return.
- **Test gaps: not started.** Plan:
  - P1-6: either route drainSourcesAll and strayChunk through FluidWorld and call gateFlowing(null, null, ..) in the restoring phase, or
    use a seam plus a source pin (StockpileSaveHFTest.body pattern).
  - mergeAwaitedWith: a source pin on Revisions' driver call (it needs a server), plus a behaviour test of the Groups.withFluids lambda.
  - The abort test needs a flowing (flow:"current", testFlowing=true) escape intent with work frozen in two chunks.
  - Write units for the stray completion guard and FL9-after-receipt.
  - The integration test needs a ledger rebuilt from its saved snapshot at each restart and a second crash armed during the replay.
  - Held-on-top cell: show refund 0, taken 0, mark deleted, handed-down before = lava (conserved), and record it in the as-built.
- **Drivers: not started.**
  - mixed: add a dev-gated kill point keyed by chunk (after that chunk's receipt) so the halt is at the pit's W. Check the cell is air
    before the dispense. Record the dispenser slots before and after and any lava bucket reaching the pile as cargo; the 11th bucket was
    the injected bucket, which the dispenser could not place because the pit stood.
  - fl5: confirm the boxHeld seal in green3's server log first. If it is confirmed, assert the refusal (dispenser unchanged) plus
    conservation.
- **Next steps, in order:** red tests for 2-5 (commit, red run); the fixes; per-fix revert script in the scratchpad; push; test gaps;
  drivers; at most 3 in-game runs (green on the 10 listed steps, then failures only); "Slice T5Fc round 2 as built" in CONTRACT.
  829658b8 is not a red baseline for mixed or fl5 (their red is pre-T5Fc).
