# HANDOFF: slice RS (regions in survival, the terrain half)

Branch `slice/RS`, worktree `../architect-mc-RS` (from main e755d663, v0.40.0). Placeholders: API 1.41.0, mod 0.44.0, kit 0.42.0,
catalogue unchanged. Ports 8930-8935 (gate runs: `--ports 8930:8931`, run worktree `../architect-mc-RS-run`). Scratch:
`scratchpad/rs-build/`. Contract: docs/CONTRACT.md "Phase 6c slice RS ... (FROZEN 2026-10-20)" plus its Steward's review and coordinator
decisions.

## Findings (orientation)

- **Cells don't carry their part.** `Packed.Tile` (ARTL v1) is pos, state, cond, walk per cell; bit 15 of the u16 is unused. The
  evaluator knows each cell's winning op (so its IR part) at scan time. Decision: a **survival IR** (only) is evaluated to **ARTL
  version 2**: after each section's palette indexes, `n` class bytes (0 free pass, 1 held, 2 paid) and `n` u16 group indexes (into
  `ir.survival.groups`). A creative IR stays ARTL v1, byte-identical.
- **Survival groups.** `ir.survival.groups` lists the target groups; `ir.survival.groupOf[irPart]` names each IR part's group: the plan
  part (plan compile's `partOf`), a shared route part (`routes:a,b`) the first connector of it (its cells are that connector's in survival;
  the creative cost split by legs is unchanged), `__lamps__` its own group, a bundled program's IR part itself. A group **holds** its free
  cells (§4.3) when any of its IR parts can write a paid cell (static, from the ops' candidate materials), except a lot's pad part (its cut
  and fill are always the free pass: §7.1 and §11's "pads free").
- **The target unit is (tile x group)**, not the tile: gate item 7 pauses one part, S-RS-1 names one part per wait, `PartBuild` maps parts
  to targets. One tile item writes one free-pass CELL entry (as today, only class-0 cells) plus one target entry per group with held or
  paid cells: a fed Infra (`cells:architect:terrain|path`, Construction BUILDING, no crate) whose journal entry holds the queued cells'
  before and planned after, written nothing at put-down. Its ext carries `architect_mc:region` and `architect_mc:part`.
- **InfraJob crash trap** (advisor): a resumed WRITE re-reads the committed entry and writes every cell. The free-pass entry never holds a
  queued cell, and a job whose main entry is a target writes nothing (`writeMain` persisted in the job JSON); the target entries are extra
  entries of the same P3 transaction, completed at P7 (persisted in the job JSON).
- **Latent bug:** region items are queued `construction=false, survivalAtQueue=false`; `Batches.tick` fails them under the toggle in a
  creative-game-type world. Fix: `survivalAtQueue = SurvivalWorld.on()` at queue, `construction` = the region's survival mode.
- **Hardcore:** gate3's hardcore step doesn't touch regions. A Hardcore world (toggle on, game type survival) now realises regions in
  survival (mode by world); "Hardcore unchanged" = gate3 hardcore green.
- **Steward's handlers:** SITE_WAITING reads `site.owner()` and `wait.nextNeeded()`; ITEM_WAITING switches on PLAYER_IN_BOX, OCCUPIED,
  NOT_LOADED (others silent). A region item waiting for an earlier target to be built waits **SITE_BUSY** (no new Reason; Steward says
  nothing for it), its item ext gains `architect_mc:waitsFor {target, part}`.

## Design (as being built)

Kit:
- `planRegion({survival: true})` (CLI `--survival`; sidecar cap `survival`; the mod sends it when the world is survival): ops written by
  terrain kinds get `free: true` (relief, pads' and terraces' cut and fill, 6a fills, forms, scatter, stamps, brush strokes), the IR gets
  member `survival` and `requires` gains `survival` (format 2). `KINDS_FORMAT2` and `MEMBERS_FORMAT2` gain it (realise.mjs, IrStale).
- `evalTile` on a survival IR: the class per cell (§4.1: cut, free natural op write not in `FREE_EXCEPT`, a dirt path on the column's
  surface, a water source or ice cap, a lava source (charged at the fluids gate); else paid; held when free in a holding group), ARTL v2,
  `notes.survival[group] = {free, held, paid, bom, creativeOnly}`.
- `FREE_EXCEPT` generated into `kit/lib/vocab/survival.mjs` from survival.json's `free` rule (ores, amethyst, obsidian, crying obsidian,
  ancient debris, natural blocks of tier precious).
- Plan check in survival: `survival: true`, per part `cost.survival {free, held, bom, creativeOnly?}`, plan `cost.bom` = the parts'
  survival bills (the mod adds the bound lots' `bomFull` and the 4e roads' `checkRoad` bills), a part writing a creative-only block
  refused `SURVIVAL {kind: creativeOnly, blocks}` (re-planned without it), the artifact `survival: true`.

Mod:
- Mode: `SurvivalWorld.on() && defaultGameType != CREATIVE`. checkPlan, plan and brush strokes plan in that mode; realiseApproved refuses
  an artifact of the other mode ARTIFACT_STALE; realise refuses NOT_ALLOWED with no stockpile (with the bill), CREATIVE_ONLY_BLOCK.
- Tiles: decode v2, partition after TileCheck: free-pass cells written, targets put down. `RegionTargets` (a Builder.Run per target: held
  cells cost nothing; the queue order = BuildOrder bottom up with a carve or cut after every paid cell above and beside it within 1; runs
  cut at put-down at most a quarter of the stockpile's capacity in stacks; a run starts only with its whole bill; reservation = the
  current run's bill; written with CELL_FLAGS and the entry's NBT).
- Stage waits: a survival region item waits SITE_BUSY while an earlier-stage target (tile targets, construction roads; lots for the
  fluids stage) within one tile (lots: box + 8) is not BUILT.
- Fluids: the fluids gate in survival waits for and consumes one lava_bucket per lava source (a bucket back) and one iron_bars per grate
  cell; removal scoops lava (a bucket from stock -> a lava bucket credited, keyed) and refunds standing grates.
- Removal: targets leave the feed (C29), refunds via Groups' decCredit (`RoadBuilder.refundOf` dispatches), lava scoop.
- `RegionView.build` (`RegionBuild(built, done, percent, outstanding, parts)`), SITE_WAITING with region and part in the target's ext.
- N-RS-2: a block-break hook: a survival region's free cell (a free-pass cell or a held cell) still holding its write drops nothing.
- Crash: targets rescan from the world (Builder.Run.rescan); a survival region's free-pass entries re-checked at load (a cell back at its
  before is written again).

## The split (Noah, via the coordinator, 2026-10-20 night)

RS is split so no builder runs out of context. **RS-a (this branch, `slice/RS`; its interface pushed as `rs/core`)** finishes the core
and gates its own items. **RS-b** is a separate builder on `rs/core`'s interface.

### The shared interface (frozen on `rs/core`)

- Kit: `planRegion({survival})`, `ir.survival {format 1, groups, parts, pads, cells, creativeOnly?}`, ARTL v2 (class byte 0 free /
  1 held / 2 paid, u16 group per cell), `kit/lib/region/survival.mjs` (freeCell, canPay, chargedOf, itemsOf), `cost.survival`,
  plan `cost.bom` + mod-added `bomParts`. A fluid op's cells are always class 0 (never held: the fluids gate writes them in waves).
- Mod: `RegionSurvival` (mode by world, creativeOnly, buildsFromStock), `Packed.Tile.cls()/group()`, `site/RegionTargets` (targets =
  tile x group Infra `cells:architect:terrain|path` with spec `regionTarget {region, part, group, tile, held, heldCells, runs, capStacks}`,
  ext `architect_mc:region` / `architect_mc:part`; `stepFed`, `stageWait`, `building(group)`, `buildingMember(group)`, runs from
  `BuildOrder` + `firstUnsafeCut`), `RegionFluids.survivalBarrier/charge/scoop/survivalStanding/pendingCharges`, `Stockpiles.charge /
  chargeShort / scoop / scoopInto`, `RegionFreeDrops`, API `RegionView.build` (`RegionBuild`, `PartBuild`), `PlanCheck.survival`,
  feature `regionSurvival`, DevBridge `dev.rs.state | target | cells | freeWrite | break`.
- Gate driver: `tools/gate6crs.mjs` + `tools/lib/gate6crs-game.mjs` (`buildOne`, `feed`, `Conservation`, `twinDiff`, `billsOf`).

### What RS-b must build (and gate)

Already on `rs/core` (RS-b verifies and extends, doesn't rebuild): the bodies' barrier (the fluids stage waits for every target, road and
lot of the region BUILT), lava buckets charged at the gate (a bucket back) and scooped at removal, grates' iron bars charged and refunded,
courses written in `after` order (rs03's brook: both reaches settled, world equal to its INSTANT twin, 0 differ), irrigation after its lot
(a construction lot never queues its LotMask cells: fixed in `Builder.planConvert`; rs03's f1 bodies settled).

RS-b builds:
1. **Tunnels ring by ring** (§6.4, rs04): today a bore's target orders bottom up with every carve after its paid neighbours above and
   beside within 1 (`RegionTargets` queue order + `firstUnsafeCut`, the unit test's carveFirst caught). RS-b: rings (a ring's lining, then
   its carve) along the bore's axis, runs cut per ring within the quarter cap; prove no bore cell open without its lining half fed.
   **Found (RS-a's run, 22:15):** rs04 in survival stops at 95.3%: target c3 (the bore's lining, 520/662) deadlocks at run 9, a
   hanging lantern (9645,68,9079) under a roof cell (9645,69,9079): the roof waits for the cell below it (the lantern, bottom up), the
   lantern waits for its support (the roof), the held cut under them waits for its paid neighbours above. Ring order must place a
   hanging block after its support (support before bottom-up), and a cut's deps must not include cells that wait on it.
2. **Item 5's rs04 row** (build, twin 0, E-flat 0) and **item 6's rs04 row** (half fed: runs whole, M3/M4/M8/gravity 0, no open cut).
3. **Ice caps in game** (N-RS-4: free; a cold-biome body, not in any RS fixture yet).
4. **Item 8 on rs03** (conservation through bodies: lava charged, bucket back, at 10+ checkpoints; RS-a's item 8 is on rs02, and its
   item 9 rs03 row already holds the sum through the bodies) and **item 9's "drained without a bucket" row** (keep fewer buckets than
   lava sources in stock before the removal: the rest drained, nothing credited for them).
5. **Brushes in survival in game** (item 13's last row: a concrete-pattern stroke refused NOT_ALLOWED, a natural stroke free via
   `dev.brush`).
6. Item 16's body steps again after its changes: `hy-ingame`, `irr-ingame`, `h-ingame`, `ha-ingame`, `kc-ingame` (RS-a ran them on its
   head: see "RS-a as built").
7. Item 11's "clean stop mid body wait" row (a stop while the fluids stage waits for its barriers: resumes, the bodies settle).

## RS-a: done (2026-10-21)

RS-a is gated on `slice/RS` and its as-built is in docs/CONTRACT.md "RS-a as built". **`rs/core` (4ad93e64) is older than `slice/RS`:**
RS-b merges `slice/RS` (or main, once RS-a has merged) before it starts. RS-a changed after `rs/core`: stage waits honour `after` deps
(a road waits for the targets it is queued after), a paid cell never waits on a cut below, a region target's player block drops at its
removal (`RegionTargets.dropPlayerBlocks`, the refund skips it), a BUILT target's soil cells stand as built (`Builder.Run.soilSame`,
off once it leaves), mined free cells are remembered and put back before the removal (`RegionFreeDrops.restoreMined`), item 3 compares
the region's whole bill, items 6b-15 in the driver, the asks tables.

RS-a's own runs showed, for RS-b: rs03's lava pit charged 10 lava buckets and 8 iron bars at the gate and scooped them back at the
removal with buckets in stock (item 9's rs03 row, conservation exact at 29 points); the "drained without a bucket" row is not run.

Ports: RS-a used 8930-8935 (ad-hoc server 8930/8931, runner shards 8932-8935). Gate evidence: `../architect-mc/artifacts/gate6c-rs/`.
