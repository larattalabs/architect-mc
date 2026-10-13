# HANDOFF: slice PT (player-placed tracking and builds, C32)

Branch `slice/PT`, worktree `../architect-mc-PT`. Placeholders: API 1.24.0, mod 0.27.0, kit 0.26.0. Ports 8912-8917. $0.

## Done
- v0.25.0 archived from its tag (jars, tools/, HEAD.txt) in the main checkout's `artifacts/gate6c-pt/v0250`.
- Versions bumped to the placeholders (gradle.properties, ArchitectApi.VERSION, IrStale/realise/plan KIT_VERSION).
- `placed/`: PlacedChunk (the attachment data + NBT), Placed (hooks, scopes, predicate, journal annotate/restore), Builds
  (classifier, index builds.json, claim/release), BuildViews (API views, consent, hits), BuildCommands.
- Mixins: LevelChunk (record/clear), ServerPlayerGameMode useItemOn/useItem, PistonBaseBlock.moveBlocks,
  MovingPistonBlock.newMovingBlockEntity, PistonMovingBlockEntity (carry/settle), FallingBlockEntity (carry/land).
- Journal: Pt record; Cell/Write/HandDown carry pt; SectionCells.pt; JournalNbt `pt` member, v3 only for files with pt;
  JournalStore.ptSource annotates new entries at create; retake annotates; Restore carries pts; undo writers scoped.
- Architect writes go through `Placed.set` (per cell) or `Placed.beginWrites` (template placements).
- API records/enums/methods added (defaults throw).

## Next
- SitesImpl overrides, features, enforcement paths (TileCheck, Sites place/check, roads, cells, fit, approaches, delta, brushes),
  kit plan/0 additions and keep-outs, dev hooks (fake player useItemOn), tools/gate6cpt.mjs, gate-chains, api-compat --gate6cpt.

## Findings so far
- Item 12: Fabric's attachment deserializer drops unknown attachment ids ("Skipping invalid attachments") and a chunk re-saved
  without the mod loses `architect_mc:placed`; to be measured by the gate (load-only vs modified chunk).
