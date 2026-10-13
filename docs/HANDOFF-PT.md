# HANDOFF: slice PT (player-placed tracking and builds, C32)

Branch `slice/PT`, worktree `../architect-mc-PT`. Placeholders: API 1.24.0, mod 0.27.0, kit 0.26.0. Ports 8912-8917 (ad-hoc headless:
sidecar 8912, DevBridge 8913). $0.

## Done (committed and pushed)
- v0.25.0 archived from its tag (jars, tools/, HEAD.txt) in the main checkout's `artifacts/gate6c-pt/v0250`; `api-compat --gate6cpt`
  (0.25.0/0.24.0/0.23.0 jars, the 0.25.0 surface) clean; `gate6a apijars` points at the same three jars.
- `placed/`: PlacedChunk (attachment data + NBT), PlacedRules (pure record rules), TrackingRule (the world rule flag), Placed (hooks,
  scopes, the predicate `Placed.build`, consent scope, journal annotate, undo restore maps), Builds (classifier, index builds.json,
  claim/release), BuildViews (API views, scan/hits, consent, keep-outs, planJson for P0), BuildCommands (`/architect build ...`).
- Mixins: LevelChunk (record/clear), ServerPlayerGameMode useItemOn/useItem, PistonBaseBlock.moveBlocks,
  MovingPistonBlock.newMovingBlockEntity, PistonMovingBlockEntity (carry, NBT, settle), FallingBlockEntity (carry, NBT, land).
- Journal: Pt; Cell/Write/HandDown carry pt; SectionCells.pt; JournalNbt `pt` + v3 only for files with pt; JournalStore.ptSource
  annotates at create; retake annotates; SiteJournal.Restore carries pts and every undo writer runs under it.
- Architect writes through `Placed.set` / `Placed.beginWrites` (PredicatePathsTest guards it).
- Enforcement: Sites check (snapshot box), approaches (TerrainFit.BUILD), roads (segment PLAYER_BUILD, PATH joined via BUILT),
  cells (InfraPlace, CellsCheck), TileCheck (stage 0, felling, leaves, dependents, supports), strokes (consent; N-PT-5), deltas
  (server-thread check incl. DeltaJob), fitToLot (recommended rect moved off builds), region keep-outs and findings (buildHits).
- API: records, enums, Reason.PLAYER_BUILD, Refusal/ArchitectRefused builds, consent on 7 requests, RegionView.buildHits,
  SiteEvents.BUILD_CHANGED, Sites methods (SitesImpl), features builds/playerPlaced (+ helper plan.feature.build).
- Kit: plan.json feature.build/target build/endpoint.build + catalogue; kit/lib/region/builds.mjs + kit/test/builds-pt.test.mjs.
- Tests: PlacedChunkTest, JournalPtTest, RecordRulesTest, PredicatePathsTest, ApiPTTest; whole mod/kit/sidecar suites green.
- Dev hooks: SlicePTDev (dev.pt.*), dev.brush consent; apitest ApiTestPT (/apitest apipt, ptat, ptbox, ptbuilds, ...).

## Verified by hand (headless, PT Flat world)
- recording (blocks, both door halves), breaking clears; an all-log cabin with a door classifies HOUSE (entrance found);
- a consented PLAYER_BLOCKS stroke over a cobble hut cleared 90 build cells; its undo restored every record (tracked-set hash equal).

## Next
- Slice tier run (ports 8912-8917, run dir ../architect-mc-PT-run, out artifacts/gate-runs-PT) on the head after the item 4/12
  additions; then the gate-verifier (items 7, 8, 10 re-run) on one port pair once the tier is done.
- CONTRACT "Phase 6c slice PT as built"; retire this file; push; report.

## Findings so far
- Item 12 (no-mod half), measured: a chunk LOADED by a server without the mod loses `fabric:attachments/architect_mc:placed`
  (Fabric logs "Skipping invalid attachments"; the chunk is re-saved without it); a never-loaded chunk keeps it. pt-nomod
  reports FAIL honestly. Blocker for the coordinator: accept as a documented limitation, or a side-file mirror (a §1 change).
- Item 7 runs on S7's flat_village (lots >= 8): route_demo on a flat copy with builds present planned 5,668 cells and wrote 0.
- Items 5/6 vs N-PT-2's grace: item 5 runs with the grace (walls PROVISIONAL), item 6 with graceMs 0 (rules are world-tunable).
- Item 4 proves the unload (0 tracked readable 600 blocks away); item 12 also covers a building's removal (template restore).
