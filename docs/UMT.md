# UMT: the undo model tester

UMT fuzzes exact undo in seconds, without a Minecraft server. It drives Architect's **real** journal, undo and settle code against an
in-memory world. The world models how vanilla changes cells around those writes (the vanilla-updates table). Every scenario is seeded
and reproducible, and a failing one shrinks to a minimal list of operations.

It builds on `JournalPropertyTest`, which already fuzzes the pure layering rules (`Journal.planUndo`) over every order of up to 4
entries. UMT doesn't repeat that. It tests what sits above those rules: the store on disk, sectioned planning, the restore's template
and cells, crash recovery and the world-start settle, and above all vanilla changing cells between a write and its undo. Every recent
undo bug was of that last kind: relief re-tick, copper weathering, lamp on dirt path, sand vanish, and the 4d decor noise.

## Running it

| what | command | time |
|---|---|---|
| CI set (in `build`, and the gate step `umt`) | `./gradlew test --tests 'dev.larattalabs.architect.site.Umt*'` | about 50 s (2000 scenarios in 41 s); `build` grows from 1:17 to 1:54 |
| long fuzz (gate step `umt-long`, release tier) | `./gradlew umtLong -Dumt.seeds=5000 [-Dumt.from=<seed>]` | about 5 min |
| the findings' repros (expected to fail until fixed) | `./gradlew umtFindings` | 5 s |
| explore a generator or one seed | `./gradlew umtExplore -Dumt.explore=<PLAIN\|CRASH\|DRIFT\|ALL\|FINDINGS>:<from>:<count>[:one] [-Dumt.unknown=1]` | |
| fail on findings too | add `-Dumt.strict=true` | |

A violation tagged with a finding id (`[F1]`, `[LP]`, ...) is counted and printed in the summary line. It doesn't fail CI unless
`umt.strict` is set, because the coordinator decides which findings are bugs. Any untagged violation fails, shrunk, with its seed.

The CI set's findings are also **pinned** (provisional, until the coordinator decides). Every failing seed's tags and a digest of its
sorted violations must equal `mod/src/test/resources/umt/ci-baseline.txt`. So a change inside a known finding's bucket fails CI: more
cells, fewer cells or other cells. Rewriting the pin is a deliberate, reviewed act (`-Dumt.rebaseline=true`). The run is
deterministic: two runs give byte-identical pins.

The summary line also prints how often each vanilla rule fired. A rule stuck at 0 is a generator gap.

Gate steps (`tools/gate-chains.json`): `umt` runs when a change touches the journal, undo, settle or evidence code (impact rule
"UMT"). It is offline and needs no slot. `umt-long` is in `tiers.release.always`, a tier change for the coordinator to accept.

## Real code and modelled code

**Real (production code, called as the mod calls it):**
- `JournalStore` on a temp folder: commits, region files, the index, `faultHook` for faults at every I/O step, and reopening from disk.
- `WorldJournal.UndoPlanner` (sectioned R1), `WorldJournal.undoTxn` (R2), `WorldJournal.holdsOurs`/`holds`/`same` (StillOurs, CU,
  PT's player-record rule), `Copper`, `StillOurs`.
- `SiteJournal.begin` (P3, with `LotMask`) and `complete` (P7), `restore` (R4's template, mask, cells, halves, PT expectations),
  `writeCells` and `fixHalves` (the R4 cell writes, including the `FluidRearm.wrote` call), `reactivate`, `releaseGroup`,
  `active`/`undone`/`lastGroup`.
- `Sites.evidence`, and the settle's decisions on it: `Sites.settleSite` (sites and lots: `covered` releases, else
  `Reconcile.decide`) and `Sites.settleInfra` (roads, tiles and cell sites). Both are the helpers `Sites.reconcile` calls. UMT
  passes the removal's arguments only: not moved, no current record, `Overlap.NONE` (as production does for every pending site).
- `TileCheck.dependent` and `keepsGravity`, `FluidRearm`'s queue, `StockLedger`.
- `RegionFluids.drain`'s body loops (ice and cells, spill and watch, strays) through `DrainTarget`. Its irrigation breach path
  (`breachFlow`, `sweepBreach`) reads and writes the level directly: UMT passes no level and no other bodies, so it isn't run
  (irr-ingame covers it).
- `JournalStore.ptSource`, the hook where production annotates PT records.

**Seams (production changes, behaviour unchanged).** Each one only widens a parameter or adds an overload that the level version
delegates to:
- `WorldJournal.install(store, dir)` and `WorldJournal.clock`. Test-only entry points; the mod never calls them.
- `WorldJournal.holds/holdsOurs(BlockState, Supplier<nbt>, ...)`. The level versions read the cell, then call these.
- `WorldJournal.UndoPlanner(String dim, Journal.World, ids, group)`. The level constructor passes `holdsOurs(level, ...)`.
- `SiteJournal.begin(level, dim, ...)`. Takes a ready capture; the level is read only for held leaves and cut halves.
- `SiteJournal.CellTarget`, with `writeCells`/`fixHalves(CellTarget, ...)`. The level versions wrap the level (`levelTarget`).
- `Sites.evidence(BlockGetter, ...)`. Was `ServerLevel`; it only reads block states.
- `FluidRearm.wrote(ResourceKey, ...)` and `pending(dim, pos)`. `RegionFluids.DrainTarget` with `drain(DrainTarget, level, ...)`.
- `Sites.settleSite` and `Sites.settleInfra`: the settle's two decisions, moved out of `Sites.reconcile` unchanged so UMT calls them
  instead of copies.

**Modelled (test code, each with a calibration pointer):**
- The P3/P7 commits of roads, tiles and deltas: their headers, cells and status are built in `UmtSim` (sites and lots go through
  `SiteJournal.begin` and `complete`). The store's commit itself is real.
- The sequencing of PlaceJob/InfraJob (P1-P8) and RestoreJob/Groups (R1-R5), and what each saves when:
  - records are saved at each change;
  - a RestoreJob is in the queue from the start;
  - `Groups.committed` saves the removal's undo group when R2 is submitted.

  Calibration: 4e-crash K1-K8, 6a-crash, x-resume.
- The world-start settle loop (`Sites.reconcile`):
  - K2 releases;
  - K6 makes a record pending;
  - a site that has a job is left to its job;
  - pending sites settle on evidence, sites first, then roads and cells;
  - a placing record rolls back as a RestoreJob ROLLBACK.

  The loop is modelled; the evidence and each decision are production (see above).

  Calibration: 4e-crash, 6a-crash.
- A rolled-back placement's evidence. A PLACING entry has no afters, and production reads the blueprint grid (`ownGrid`), which UMT
  doesn't have. UMT counts it restored when the world holds every value the rollback wrote.
- A structure template's placement (TemplateWriter): the restore template's blocks in list order, with `Sites.FLAGS`.
  `Restore.writing`'s record restore is modelled in `UmtWorld.restoring`, because `Placed` can't load without the game.
  Calibration: 4d-all, 4e-orders.
- The world's durability: a crash puts the world back to its last autosave, and the journal stays as committed.
- Site deltas (`SiteDeltas` D1-D7) are modelled as a BOX entry of kind `delta` under the site's id, inside or growing its box.
  Its store calls and `SiteJournal.restore`'s union of the site's and its deltas' boxes are real. Delta planning, folding at 7 and
  growth rings are not run; `DeltaPropertyTest` covers them.
- Roads, region tiles and lots are abstract designs:
  - a road is a path with posts beside it;
  - a tile lowers, raises, paves, fills or seeds a rectangle;
  - a tile skips cells others own (TileCheck.owners, modelled from the store);
  - a lot masks one irrigation cell.

  RoadPlan, the kit and IRR are not run.
- Block entities are opaque NBT. There are no entities.

- The F6 guard: `UmtSim` checks each member a RECOVER takes back (production `Sites.recoverScope`) against that member's own
  evidence, to name the residual F6. The scope and the reactivation are real.
- The order of the settle loop: sites and lots first, then roads, tiles and cell sites, each in the order they went pending (by
  their undo's time), as `Sites.reconcile` and `Infras.pendingAll` run them.

## The vanilla table

The source of truth is `mod/src/test/java/dev/larattalabs/architect/site/UmtVanilla.java`. Each row lists:
- the vanilla behaviour;
- the bug or noise it covers;
- how UMT applies it;
- the in-game probe that calibrates it.

Probes marked "to build" don't exist yet. One small DevBridge probe step could write each row's cell and read it back. That is the
first follow-up (see "Calibration").

| id | class | vanilla | covers |
|---|---|---|---|
| V1 | update | a write without `UPDATE_KNOWN_SHAPE` sends shape updates to its six neighbours. `Sites.FLAGS` does; `CELL_FLAGS` doesn't. `UpdateMask` drops them at a restore's covered cells | all update rows |
| V2 | update | a falling block over a free cell falls (`onPlace`, `updateShape`, the tick; TickDeferral releases the tick) | sand vanish, 4d gravel column, F2, F3 |
| V3 | update | a dirt path or farmland under a solid block (not a fence gate) turns to dirt | lamp on dirt path (LP) |
| V4 | update | a fence, wall or pane whose connection changes passes the update on | LP's chain: a write beside a post |
| V5 | update | plants, carpets, leaf litter and snow break when their support goes | 4d leaf_litter after the undo |
| V6 | equiv | copper weathers; wax and scrape change it in place | CU |
| V7 | equiv | farmland dries; grass spreads and dies | CU S-CU-3, 6a |
| V8 | equiv | water flows into cleared air; a source freezes | 6a, H §4.3 |
| V9 | update | restored flowing water has no tick until FluidRearm wakes it | relief re-tick |
| V10 | equiv | a volatile property changes by use or neighbours: open, lit, powered, connections, stair shape, leaves' distance, waterlogged | StillOurs.VOLATILE (4e S2) |
| N1 | noise | mushrooms pop off, leaf litter is trampled | 4d intermittent "back exactly" |
| N2 | noise | an entity in a box makes removal wait | 4d bee |

**Noise rule (N1), the in-game hash's ignore list.** A difference is the world's own when all three hold:
- the cell is a decor kind (`TileCheck.dependent`, gravity aside);
- no plan ever wrote the cell;
- no written cell is within 1 of it.

UMT injects noise that obeys the rule. It then measures the rule:
- how much injected noise the rule names (220 of 253 in the CI set);
- how much it misses, because a plan came near the noise later (33 of 253);
- how many real differences it would have hidden (0).

So in game, the rule leaves some noise to fail the hash, but never hides a miss.

## Properties

- **P1, any order of removal is exact** (`UmtFuzzTest.p1`). Sites, lots, roads and region tiles over overlapping footprints, stacked,
  removed one by one and as groups, in random orders, with restarts. At the end:
  - the world equals the world before everything (states, block entity data, PT records);
  - the journal is empty and no record is left.

  On the way: a removal never changes a cell that a standing site still owns on top.
- **P2, a crash at any point** (`p2`, and `p2_everyKillPointOfOneScenario`). A kill can come:
  - at each I/O step of P3, P7 and R2;
  - at K2;
  - mid-writes, at P5 or K7;
  - after the writes, at P6 or P8;
  - at K6 or R5;
  - with or without an autosave just before.

  Then the restart and recovery, and the same final result.
- **P3, StillOurs equivalences** (`p3`, and the targeted `p3_*`):
  - a volatile property changed (V10) is still ours, and a turned stair (facing, not volatile) is the player's;
  - weathered and waxed copper is still ours;
  - a player's own oxidized copper (with a record) wins;
  - farmland and dirt are interchangeable;
  - water in cleared air and ice are still ours;
  - a weathered cell hands down under a stacked site;
  - a box gives PT records back.
- **P4, neighbour effects:**
  - restored flowing water is queued for one tick (FluidRearm);
  - supported sand stays over a tile;
  - a path inside a box comes back.

  Gravity and path conversion outside the journal are findings.
- **P5, accounting:** a refund is credited once per key across crashes (StockLedger). Standing-block refunds (CU) need
  `Builder.prepareDeconstruct` on a level. They are not reached; cu-survival covers them.
- **P6, history:**

  | case | covered by |
  |---|---|
  | relief re-tick | `p4_restoredFlowingWaterIsQueuedForATick` |
  | sand vanish | `p4_supportedSandStaysOverATile` |
  | copper weathering | `p3_weatheredAndWaxedCopperIsStillOurs`, `p3_aCoveredWeatheredCellHandsDown` |
  | the drain sparing water that isn't the body's | `p6_aDrainKeepsForeignWater` (the breach sweep itself reads the level: irr-ingame) |
  | lamp on path | `UmtFindingsTest.lp_*`, a finding until fix/lamp-path merges |
  | the wall through the fountain | not undo-relevant: a writer keep-clear rule (structure lint) |

  Each of the first three was checked to go red with its fix reverted:

  | mutation | goes red |
  |---|---|
  | `writeCells` without its `FluidRearm.wrote` call | `p4_restoredFlowingWaterIsQueuedForATick` |
  | `StillOurs`/`WorldJournal.holds` without the copper chain (pre-CU) | `p3_weatheredAndWaxedCopperIsStillOurs`, `p3_aCoveredWeatheredCellHandsDown`, fuzz `p3` |
  | `TileCheck.keepsGravity` returning false (pre-70fc0dd0) | `p4_supportedSandStaysOverATile` |
  | farmland out of `StillOurs.spread` (pre-S-CU-3) | `p3_farmlandAndDirtAreInterchangeable`, fuzz `p3` and `all` |
  | `lit` out of `StillOurs.VOLATILE` | `p3_volatilePropertiesStayOursAndAFacingIsThePlayers` |
  | fix/lamp-path's `pathTurned` applied | `UmtFindingsTest.lp_*` turns green, and the fuzz's [LP] count drops to 0 |
- **The R2-R4 crash window:**
  - after a durable R2 (K6), mid-R4 (K7) and after R4 (R5), single and group, a region among them: exact
    (`r2r4_killAfterTheDurableUndoAndMidWritesRecovers`);
  - inside R2 (the K8 window, group removal): planned again, exact (`f4_aGroupRemovalKilledInsideR2IsPlannedAgain`; F4, fixed).

## Findings

Each open finding has a repro in `UmtFindingsTest` (`./gradlew umtFindings`, failing until fixed) and a tag in the fuzz. A fixed
finding's repro moves to `UmtPropertiesTest` (F1, F4 and F6 in undo hardening A, patch 0.40.1).

| id | what | where | reach |
|---|---|---|---|
| F1 | **fixed (undo hardening A).** Two stacked sites, removed upper first, then lower, then a start: the upper's evidence compared the world with its own undo's written values, which the lower's removal had since rewritten: neither restored nor standing, KEEP at every start. Now `Sites.evidence` reads, per cell, the latest later undo of another group by an entry under the cell (the cell's holder below) and expects what it wrote (`f1_aStackedPairRemovedTopDownSettles`; 4e-orders settles after every order). It relies on the settle order (the upper, undone first, settles first); one CI seed (ALL 207) still shows the mark, where a crash lost a resumed restore's writes (F5's mechanism, untagged there because the site is stacked) | `Sites.evidence` | was common |
| F2 | worldgen sand hanging over air inside a box falls when the removal writes it back (its tick is held, then released) | `Sites.restoreQuietly`/RestoreJob with `TickDeferral.release` | needs hanging sand in a box |
| F3 | a gravity block resting on a site box's top or side cell falls into the box when the site writes under it; the undo can't bring it back (it was no entry's cell) | sites have no dependents stage (tiles do, TileCheck) | gravel or sand ledges at a box edge; the 4d noise |
| F4 | **fixed (undo hardening A).** `Groups.committed` saves the removal's undo group before R2 is durable; a kill inside R2 (K8) left a saved removal naming a group the journal never got, and the resumed removal ended as done with nothing written. Now `Groups.Removal.fromJson` drops an undo group no journal entry has, as `RestoreJob.fromJson` does, and the removal is planned again (`f4_*`; 4e-crash K8 group) | `Groups.Removal.fromJson` | was a kill during a group removal's R2 commit |
| F5 | a restore (or a rollback) whose job ended, then a crash before the world saved: the world is half-restored, the settle finds it neither restored nor standing, KEEP forever, the half-written blocks stay | settle on evidence | two events inside one autosave interval |
| F6 | **fixed for side-by-side members (undo hardening A); open for stacked ones.** Settling one pending site RECOVER reactivated the whole undo group: a member whose own evidence says removed came back as standing, and (crash-safety review) after an unclean stop mid group removal, members the resumed removal was still writing went ACTIVE under it. Now `Sites.recoverScope`: no RECOVER while the group's removal is queued (KEEP until it ends), and a RECOVER takes back the site, the members whose evidence stands, every member sharing a cell with those (stacked members must come back together: reactivating one of a stacked pair alone leaves befores naming the other's blocks) and the crate (`f6_*`; 4e-crash GW). Residual: a removed member stacked with a recovered one still comes back (2 CI seeds); undo-c's roll-forward removes reactivation of removals | `Sites.recoverScope`, `SiteJournal.reactivate(group, sites)` | a crash that loses part of a group removal |
| F7 | two pending sites recovered at one start, the lower first: its hand-downs to the upper are skipped (the upper is still UNDONE, `Journal.reactivate`), so after the upper is recovered too its before is the ground. Removing the upper then cuts the lower | `Journal.reactivate`'s "receiver not active" skip; sites settle before roads | a crash that loses two stacked removals |
| LP | (fix/lamp-path) a journaled dirt path under a later solid write turns to dirt; the path's entry no longer counts it as its own | `StillOurs`/`WorldJournal.holds` (the fix adds `pathTurned`) | known, fix pending |
| DRAIN | (the coordinator's item 2) the region drain overwrites a later separate site's waterlogged block at a body source cell, before any journal hand-down | `RegionFluids.drain`'s first loop: no holder check | a waterlogged block placed by a later site on a body cell |
| F8 | a plant, carpet or leaf litter standing on a cell a site or delta changes, but outside its box, breaks (V5); no entry has its cell, so the removal can't bring it back | sites and deltas have no dependents stage (tiles do) | a box edge under decor; the 4d leaf_litter noise when the litter sat next to the plan |
| UC | (open: unsaved chunks) a crash loses world writes the journal recorded; for example a recovered site whose delta's writes were lost (repro `uc_aRecoveredSiteLostItsDeltasWrites`, re-minimised from CI seed 130 after the old seed-2115 repro went stale), or a covered release of a site whose blocks the world still shows | journal durable ahead of the world | crashes within an autosave interval |

F1, F4 and DRAIN reproduced against production code with only glue modelled. F5, F6, F7 and UC need a crash that loses world writes,
which is the unsaved-chunks question; their mechanisms are in production code, and their reach depends on the autosave interval.
F2, F3 and F8 rest on modelled vanilla rules (V2, V5); confirm them in game.

UMT settles region tiles through the roads-and-cell-sites loop of `Sites.reconcile`. Region records may settle elsewhere
(`RegionsImpl`), which could change F5, F6 and F7 for tiles. 4e-orders now restarts after every removal order and checks that the
start settles everything (no pending record, no journal entry): F1's in-game check.

## Calibration

These are the modelled parts and the in-game checks that keep them honest. Run them at release and on every Minecraft update:
- **Glue: P1-P8, R1-R5, saves, settle.** 4e-crash (K1-K8), 6a-crash (RG2-RG6), x-resume, 4e-orders, 4d-all. Plus 3 UMT seeds
  replayed in game on `G6A Flat Base`, comparing the world hash with UMT's expected cells. To build: a DevBridge driver that plays a
  `UmtOps.Scenario`.
- **Vanilla table:** the probes in `UmtVanilla.TABLE`. tile-gravity, dev.copper.use, h-ingame, irr-ingame (lp) and relief-probe
  exist. To build: one "vanilla-table" probe step that writes each row's cell with the listed flags and records the result. No
  judging is needed: it regenerates the table.
- **Noise rule:** the in-game hash ignores N1 cells by the same rule. Measure its miss rate on 4d-all's logs.

## Adding a property

- A **targeted property**: write a test in `UmtPropertiesTest`.
  - Build a `UmtCase` (a flat 8x8 area at x/z 30..37).
  - Place with `c.site(...)` or `c.sim.cells(kind, group, cells(...))`.
  - Change the world with `c.sim.world.natural` (the world's own change), `c.sim.world.player` (a player's, with or without a
    record; add the cell to `c.sim.tainted`) or `c.sim.restart(crash)`.
  - Remove with `c.sim.remove` or `c.sim.removeGroup`, optionally with a `UmtOps.Crash`.
  - End with `exact(c.sim.end())`.
- A **fuzzed behaviour**:
  - add an operation to `UmtOps` (sealed `Op`, its generator branch, its shrink simplification);
  - apply it in `UmtSim.apply`;
  - if it's a new world rule, add a row to `UmtVanilla.TABLE`, call `UmtVanilla.fired(id)` where it applies, and name a probe.
- A **finding**: tag its violations in `UmtSim.tag` (or where the violation is raised) with a new id. Add its minimal repro to
  `UmtFindingsTest` asserting the right behaviour, and a row to the table above. CI counts it without failing until the coordinator
  decides.
