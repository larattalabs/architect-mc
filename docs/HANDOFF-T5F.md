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

## T5Fc fix round (the ONLY round; GPT review of 081d5c53..25748ae8 NOT SAFE: 6 P1, 8 P2; findings in
## _work/coord-tools/reviews/T5Fc-25748ae8.findings.md). Not started at 25748ae8+ (the builder's context ran out); plan for a fresh builder:

Redesign, not patches (the coordinator's brief): entitlements live in the chunk with the removal that creates them, survive retries, and
the scoop consumes them once and keeps what the ledger actually credited.
- **P1-1, P1-2, P1-4 (one structure).** Add a third provenance mark, `DRAINED(R)`, set in the same accepted write that removes an R-owned
  delivered cell (WROTE, `ownDelivered`, holder and player-placement rules applied by the same predicate the drain uses), by every
  Architect removal of R's fluid: the removal drain, the escape/unsettled/upstream/held and recheck drains, `abortFlowing`, the stray
  pass. A refused write leaves WROTE (no mark change), so a partly refused W keeps every accepted cell's entitlement durably with its
  block, and a retry continues. `l` is the count of DRAINED marks of paid bodies (never a pre-write count). The scoop sums DRAINED marks
  (and the frozen `u`, below) over the record's chunks; a later "taken" is only WROTE-not-delivered.
- **P1-3.** Freeze the legacy never-delivered allocation once, in the removal drain's intent (the entitled cells per chunk, computed before
  any mark changes); each W's `u` is that list's cells in its chunk. Never recompute from a world the drain is changing.
- **Consumption.** After the scoop txn's EFFECTS_DONE, a cleanup W txn per chunk deletes R's DRAINED/WROTE marks (receipted), so a
  scoop never counts them twice and no mark outlives the record.
- **P2-10.** Make the credited amount atomic with the ledger key: StockLedger keeps per-key credited items (persisted with the ledger;
  an older ledger lacks them: the scoop of an old key reports nothing extra). `region.scooped` reads them; drop the "planned" fallback.
- **P2-11.** `taken` (Σh) computed by the scoop's plan from the final receipts (after the drain's EFFECTS_DONE), not by the drained R.
- **P1-5.** One chunk-key convention: `RegionFluids.chunkKey` (cx high, cz low). Convert `watchChunks`/`strayChunks` (ChunkPos.pack: x low)
  at the boundary or switch them; units with asymmetric and negative coordinates (e.g. (100,7), (-3,5)).
- **P1-6.** The restoring-restart fallback (`drainSourcesAll` when `!redrained`) only for legacy records (`drainReceipts == null`).
- **P2-7.** `abortFlowing` (and every other writer reached from a W) honours `chunkFilter`; the escape's closure goes into the intent.
- **P2-8.** Ticks from body geometry, not from local success: each W schedules every tick position that lies in its chunk (the drained or
  forced cells' face neighbours), as `forceBodyIn` does.
- **P2-9.** `scoopStep` and the stray loop wait for the txn's EFFECTS_DONE (FluidTxns.after on the open entry, or REPLAYED), never an R
  marker (`scooped`, empty `strayChunks`); after a restart, find the open txn by its key first.
- **P2-12.** `Revisions.mergeAwaited` applies the same fluids merge (or the stage snapshot stores the fluids additions).
- **P2-13.** Freeze rows for revision removals too (the revision's rows into the region record's ext, kept with the UNDONE revision).
- **P2-14.** FL5/FL9 aliases and `w()`'s step after the receipt is installed; a unit asserts the saved chunk holds receipt and counts.
- **Tests.** Each fix red first through the real adapters on MemFluidWorld (extend it with holders, player-placed cells and tick
  destinations), plus a revert check per finding; at least one test drives drain then scoop through a real TxnCore (TxnCoreTest's env).
- Trailing whitespace: fixed (9 lines).
