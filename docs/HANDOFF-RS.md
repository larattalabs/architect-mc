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

## Status (2026-10-20 evening)

- [x] RS-a kit: survival IR, evaluator v2, check answers, FREE_EXCEPT; kit/test/rs.test.mjs (9 pass)
- [x] fixtures kit/test/fixtures/plan/rs/: rs01_land, rs02_walled, rs03_water, rs04_tunnel, rs05_offer (game: the region id), rs06_over_held
  (a 4e road over a held terrace), rs07_big_tile (a zigzag wall 12 high in one world tile), survival_village, u_spawner
- [x] RS-a mod: mode, flags fix, decode v2, targets (InfraJob extras), runs, feed reservation, stage waits (SITE_BUSY), fluids barrier
  and charge, scoop, RegionView.build, free-drop hook, rescan at start, dev hooks dev.rs.*; RegionTargetsTest (6 pass); mod unit suite green
- [x] latent bug: reproduced on the base (artifacts/gate6c-rs/latent-base.json: every item FAILED "survival was switched on after this
  was queued"), fixed (PLACED on this head)
- [x] in-game smoke (scratchpad/rs-build/smoke-game.mjs, headless on 8930/8931, run worktree ../architect-mc-RS-run): rs01 in survival
  built from the stockpile, equal to its INSTANT twin cell for cell (bar the crates), removed: E-flat 0, the refund exactly the bill
- [ ] the gate driver tools/gate6crs.mjs (rs-unit, rs-ingame, rs-survival, rs-crash), chains, impact rule
- [ ] RS-b specifics: tunnels ring order (today: courses bottom up, a carve after its lining), bodies, courses, irrigation in game
- [ ] gate runs, verifier, "RS as built", HANDOFF retired

## Notes for the as-built

- Rock spires' default material rule ages their surface to cobblestone (no voxel class): a spire is a held part (its stone cells build
  with its cobblestone). The relief and the pads are the free pass; the terrace is held whole.
- A shared route part (routes:a,b) builds with its first connector (rs02: the rope's group holds the road's cells).
- A region's construction road writes with CELL_FLAGS (as its tiles), else a dirt path under a lantern post turned to dirt (C16's builder).
- Ad-hoc servers claim a gate slot (scratchpad/rs-build/slot.mjs) by the host's pid.

## Next step

The gate driver: per item steps (item5, item8, item9, item10, item11 alone for the verifier).
