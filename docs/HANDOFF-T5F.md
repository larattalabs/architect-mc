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
