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

## T5Fc round 2: BUILT (54e5bd92..head; as-built in CONTRACT "Slice T5Fc round 2 as built")

- Code and units done: findings 2-5, the test gaps, the fl5/mixed drivers (all pushed). Revert checks: mutation script and mutations.json
  kept outside the repo (the builder's scratchpad); every row red again on its production-call-site revert.
- Red baseline for fl5/mixed: a detached worktree `_work/architect-mc-T5F-red2` at ffea3bd + the driver commit 961f456a cherry-picked
  (d7aa4f64, local only). 829658b8 is no red baseline for them (their red predates T5Fc).
- In-game: see CONTRACT round 2 record. Next after this: the one GPT check (coordinator's); a P1 parks T5F.

## T5Fc round 2: state at stop (2) (2026-11-24, stopped on Noah's word via the coordinator)

- Done (code, units, revert checks, pushed): finding 2 (54e5bd92), findings 3+4 (049123888), finding 5 (0fe6b4e7), test gaps (e2628288),
  drivers + hooks (961f456a, 99c174c8, f8ba1e03). Each row red first; every production-call-site revert red again (mutation script and
  mutations.json in the builder's scratchpad, not kept). Mod suite 2018 / 0 failed / 1 skipped.
- In-game (2 complete runs + 1 stopped): red4 (ffea3bd + d7aa4f64), green5 (f8ba1e03): 10/10 named PASS; irr-ingame-smoke FAIL item 4
  (E-flat 25 after removing the bare-pad breach region). base-irr (829658b8, irr-ingame-smoke only) stopped mid-run: no result.
- Partial: whether irr-ingame-smoke item 4 is a round-2 regression. Suspects if it is: footprint()/esc in an escape of the irrigation body
  (an escape's Ws now span drainChunksOf incl. the breach box), or saveDone's ordering. Not suspected: the removal drain W (unchanged).
- Next steps: (1) rerun irr-ingame-smoke on 829658b8 (worktree `_work/architect-mc-T5F-red2`, detached there) as the baseline; (2) if it
  passes there, bisect 54e5bd92..f8ba1e03 for item 4 (read the server log of green5 s1 for an escape/hold txn on the pad's bodies), fix, unit,
  rerun only that step; (3) then the coordinator's GPT check. Worktrees to remove after: `_work/architect-mc-T5F-red2`, the run dirs
  `_work/architect-mc-T5F-run`, `-run-s2`, `-run-src` (gate-run kept them after FAIL).
