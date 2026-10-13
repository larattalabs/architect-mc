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
- gate-chains: pt-unit, pt-ingame, impact rule, apijars link; `gate-run.mjs slice --plan`.
- Fix: provisional expiry after a restart (lastPlayerChange floor, reschedule in load()); off-thread annotate warning / touched.
- tools/gate6cpt.mjs items 1-16; item 12 no-mod start (load-only and modified chunk, both measured).
- docs: CONTRACT as-built, DEVBRIDGE hooks, GATES chain notes; retire this file.

## Findings so far
- Item 12: Fabric's attachment deserializer drops unknown ids ("Skipping invalid attachments"): expected to survive a load-only start
  and be lost when the chunk is re-saved without the mod. To be measured.
- Items 5/6 vs N-PT-2's grace: item 5 runs with the grace (walls PROVISIONAL), item 6 with graceMs 0 (rules are world-tunable).
