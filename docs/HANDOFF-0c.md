# Handoff: 6c slice 0c (placement polish and protected areas)

Branch `slice/0c`, worktree `../architect-mc-0c` (the contract names `phase/6c-0c` / `../architect-mc-6c-0c`; the coordinator's
names win). API 1.12.0, mod 0.15.0 (after 0a = 1.10.0 and 0b = 1.11.0). Ports 8912-8917. $0: no Claude calls.

## Status per item (contract §§)

| Item | State | Notes |
|---|---|---|
| §8 C17 protected areas | in progress | `site/Protected.java`; hooks: verdict (place, check, fitToLot, batch building, move), SiteDeltas.check (delta, checkDelta, batch delta, forward revert), revert (undo path: restore box), cells (API + batch), region plan start/accept + realise start. Roads: span-local via §3 |
| §9 C18 owner-tagged entities | built | `Occupancy.ownedBy`; checkSite scan (place, check, batch), both discard loops, delta check + DeltaJob, removalBlockers (remove: requester; group undo: site owner) |
| §2 minLotSize / recommendedLot | built (String); MassingRef overload waits for 0a's fitMassingToLot | `LotFitting.minSize/recommended`, `MinLotSizeTest` |
| §3 partial roads | built | `RoadPlan.plan(..., protect, partial)`: per-segment failures, per-run smoothing rounds, spans merged; `RoadSpansTest`. Roads' C17 check is span-local (centre and side columns, lantern posts skipped) |
| §4 groundHeight | built | `Volume.ground` derived in `VolumeSurvey.encode` (ARVX sha pinned by `GroundHeightTest` from the pre-§4 encoder); `Sample.ground` in `SurveyImpl.ground` (scan down from WORLD_SURFACE with the volume's classOf; a journal-owned LOG/LEAVES/PLANT counts) |
| §6 extend warning | built | `Extension.of/minBudgetUsd`, `Designs.extend`; sidecar ack gains spentUsd + softBudgetFraction, feature `extendInfo`; `ExtensionTest`, groups.test.ts |
| §5 FIELD_LIMIT | built (0a's `ArchitectRefused` copied verbatim; take 0a's at merge) | `api/Limits`, `apiimpl/FieldLimits` (request, requestGroup, critique, polish, redirectMassing, bibles.request); `FieldLimitsTest`; `sidecar/test/limits.test.ts` (zod walker); gate step `fields`. Re-run the drift test after merging 0b: its new bounded fields need constants |
| §10 off-thread undo planning | after 0a (own-time percentiles), 2 h box | no journal/** change left on the branch if no-go |
| §7 C16 survival roads | built (merged from `slice/0c-c16`) | `site/RoadBuilder.java` reuses `Builder.Run` through a probe Site; hooks in Builder (crate acceptance, stock, keep-crate), InfraJob (convert at DONE), InfraPlace (remove: refunds + crate; mode rules), Batches (construction road item), Views/ApiEvents; gate step `survroad` passes. Downgrade check pending the 0.14.0 jar |

## Steward's review (CONTRACT "Changes from Steward's review of 0b, 0c and V")

Confirms the drafted choices, all as built: remove and undo never refused; tagged entities ignored, not moved; a region
claim touching an area is refused (no carving); a partial road is one site with gaps plus the skipped spans; survival roads
need a shared crate.

## Deviations so far

- `LotFit`'s 1.4.0 constructor sets `recommendedLot` to the template box (the contract's "the lot passed in" isn't known to
  that constructor).
- Revert's undo path (no forward delta) is checked against the site's restore box, not per cell.

- A step or wall can't fail TOO_STEEP (the ground search stops 8 above the hint, so the smoothed profile needs at most 4):
  the §3 unit test and the in-game check use a trench (no ground within 8) instead of the "6-high step / wall".
- With a pre-smoothing failure, the cut/fill check runs per run (the failing segments left out), so a non-partial road's
  first span can differ from 4e's single refusal when a cut/fill failure sits before a water/lava/no-ground one.
- A run shorter than 2 centre cells between skipped spans is left out and noted ("short"), not reported as a span.
- A partial road's `PlaceResult.skipped` isn't saved with the job; after a restart its notes (and the batch item's message)
  still name the skipped segments.

- `Volume` counts a journal-owned air cell as ground (OWNED, per the contract); `Sample.ground` only sees blocks, so inside a
  site's box the two can differ (the bar is on a forest box without sites). A snow layer (SNOW class) on a dry column makes
  `ground` one above `height` (not motion-blocking).
- `Volume`'s over-16M-columns note is a log line (the record has no notes field).

- C16: free = a `dirt_path` laid on `grass_block` only (the coordinator said "on grass"; vanilla shovels also path dirt,
  podzol, mycelium, coarse and rooted dirt: open question). A road cell whose block already is the target isn't queued (nor
  billed). `checkRoad` in construction mode answers for the batch case (construction, BOM, a note); a standalone placeRoad in
  CONSTRUCTION (or AUTO in survival) is refused NOT_ALLOWED. A road's `/architect site finish` cells aren't marked free (its
  removal refunds them as paid). The group crate is put down by the road when no house of the group made one yet.

- §5 covers string lengths, list sizes, ext (keys, 64 KB as JSON), context and the zod patterns of those fields; numeric
  ranges (budgetUsd, wave, concurrency...) aren't in `Limits` (the drift test walks max lengths and patterns only).
- §10 spike is on `slice/0c-undo` (not merged): `WorldJournal.UndoPlanner` copies sections on the server thread, plans off it,
  compares, falls back on any change. Go/no-go needs 0a's ownCpu on megaA undo-only.

## Resume

- Build: `export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home; cd mod && ./gradlew build --offline`.
- Merge policy (coordinator, 2026-10-10): agents can't push to main. After the slice tier and the gate-verifier pass, push `slice/0c` and report "ready to merge"; the coordinator merges, tags and publishes.
- The 0.14.0 baseline jars (apitest + mod) don't exist until 0b merges; archive them into `artifacts/gate6c0c/v0140/` then.
