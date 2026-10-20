# Fast checks: what moves out of the game, and what it buys

Status: analysis for a decision (2026-10-20, main at b4ff2bd4). Nothing here has been dropped yet. No code, gate step or tier has
changed. This doc maps every in-game assertion in `tools/gate-chains.json` to its fastest trustworthy home. Those homes are the six
fast checkers Noah approved, a smoke instance kept in game, or "stays in game". The doc then projects what each checker saves at the
slice tier.

## Headline

| | now | after the 0-checker moves (P0) | + undo model (P1) | + structure and look lints (P2) | + water and survival lints (P3) |
|---|---|---|---|---|---|
| **slice wall time, median of the last 12 full slices (3 shards)** | **131 min** (83-174) | 109 min | 97 min | 92 min | **86 min** (48-107) |
| slice step-minutes (all steps) | 392 | 326 | 292 | 276 | 259 |
| in-game step-minutes | 306 | 232 | 193 | 178 | 162 |

- **Share of in-game slice time that can leave the game: 48%** (141 of 294 step-minutes per slice, weighted by how often each
  step runs).
  - 25% of that needs no checker (P0). It is the look steps moving to release, three pure duplicate steps, and assertions the kit
    or the Java unit tests already prove.
  - 23% needs the new checkers: undo model 11%, structure and look lints 6%, water and survival lints 6%.
- **The checkers alone save about 67 step-minutes, or about 22 min of wall time per slice.** P0 saves more than all three
  checker phases together. So does fixing the fixed waits described in "Fixed waits", which is outside this brief.
- **The headline numbers can't reach the 80 min target on their own.** The 81.5 min figure in docs/GATES.md "Measured" came from
  a 53-step slice. Recent full slices run 45-95 steps (median about 63) because each batch's impact map is wider. Against that
  workload, all three checkers plus P0 land at a median of 86 min.
- **The release tier grows.** Today it runs only the regression set (about 128 min wall). The slice's own steps never run again
  after their slice. "Full set at release" for every SMOKE row therefore means adding them: every in-game step once is about 5.6 h
  wall on 3 shards, about 5.3 h once the look-step remove stalls are fixed, plus about 30 min of calibration probes.
- **The offline unit steps become the floor.** They take 93 step-minutes per slice today (h-unit alone 26 min at p50, up to 47 min).
  After P3 they are 36% of the slice. They will set the critical path below about 60 min of wall time.

### Top 10 by time saved per slice (all phases)

| # | step | saves (step-min/slice) | how |
|---|---|---|---|
| 1 | `k1a-look` | 31.7 | LOOK → release (88% of it is a 10-minute idle after `dev.region.remove` per bible, see "Fixed waits") |
| 2 | `t3a-look` | 12.4 | LOOK → release (same 600 s stall, twice) |
| 3 | `5b-chains` | 7.3 | ALREADY-OFFLINE (DeltaPropertyTest E1-E7) + undo model; keep the fixed script and 2 seeds as SMOKE |
| 4 | `6cw-scenario-s7` | 7.1 | DUPLICATE of `6cv-scenario-s7` (same S7 flat+natural pair; `--phase` only renames the dir) |
| 5 | `hy-ingame` | 5.8 | water-lint over 12 design kinds (keep one per writer kind + the riffle calibration table) |
| 6 | `h-ingame` | 5.2 | water-lint for the breach sweep and the per-body census; drop the ha-* halves it repeats |
| 7 | `4d-all` | 4.5 | undo model for group/stage undo and queued==atomic; keep the hopper survival build |
| 8 | `4e-orders` | 4.5 | undo model (JournalPropertyTest already covers every order of ≤ 4 entries); keep 2 seam orders |
| 9 | `6b-scenario-s1-flat` | 3.6 | DUPLICATE: the first half of `6b-scenario-s1` |
| 10 | `w-ingame` | 3.5 | structure lint: `pathbibles` is four S7-flat realises asserting M5 = 0 and equal lantern counts |

### Top 10 by time saved by the new checkers only (P1-P3)

`hy-ingame` 5.7 (water), `5b-chains` 5.1 (undo), `h-ingame` 4.7 (water), `4e-orders` 4.5 (undo), `w-ingame` 3.5 (structure),
`4d-all` 3.4 (undo), `6a-staged` 3.2 (undo), `4e-crash` 2.8 (undo crash harness), `pt-ingame` 2.7 (ledger + undo), `6a-eflat` 2.2
(undo). Units: step-minutes per slice.

## Method

- **Baseline.** These are the 12 most recent full slice runs, each with 40 or more steps and at least 60 min of wall time:
  `artifacts/gate-runs-{hk2,Hcore,Hb,hk3,VOCa,VOCb,HYcore,HYb,CU,VOCc,KC,IRR}/*-slice/summary.json`, 2026-10-18 to 2026-10-20.
  - They ran 45-95 steps: 247-521 step-minutes, 84-175 min wall.
  - A step's "step-minutes per slice" is its mean measured seconds multiplied by the share of those 12 slices it ran in.
  - The denominator for "share of in-game time" is the sum over in-game steps, 294 step-minutes. An in-game step is one with a
    client, server or `self` host, including `apijars`.
- **Wall-time model.** `scratchpad/fast/pack.py` packs each run's real step durations longest-first onto 3 shards, with `after`
  chains kept on their dependency's shard. Replayed on the 12 runs, it reproduces the measured wall within 1% (median
  actual/packed 1.01). Each projection applies the per-step reductions below to those same 12 runs and re-packs them.
- **Assertion groups.** Eight read-only passes over the drivers (`tools/gate*.mjs`, `tools/lib/gate6c*.mjs`, `tools/scenarios.mjs`,
  `tools/apitest.mjs`) split each in-game step into groups. They timed each group from the `[HH:MM:SS]` lines of real PASS logs
  where the logs have them; otherwise the share is marked `~est`.
  - The 4d, 4e, 5b and apitest logs have no per-line times. Those shares come from per-subcommand seconds and are estimated
    inside a subcommand.
  - The full table is in "Every step, every assertion group" at the end: 125 steps, 783 groups.
- **Dispositions.**
  - **KEEP-INGAME:** needs vanilla or the real system. Each row says which.
  - **SMOKE:** one representative per kind at the slice tier, the full set at release.
  - **REPLACE · checker:** names the checker and what it must model.
  - **ALREADY-OFFLINE:** the kit or the Java units already prove it.
  - **LOOK → release:** recorded cameras, not judged.
  - **DUPLICATE:** another step runs the same thing.
  - **BAR:** timing. It is already recorded-not-judged at the slice tier and stays.
  - **WAIT:** a fixed sleep or idle, not an assertion.
  - **setup:** world restore, client start, settle.
- **Projection rules.**
  - A REPLACE row's time leaves the slice when its checker lands.
  - A SMOKE row keeps 1/3 of its time, since a typical row is 3 or more copies of one proof.
  - A step's setup scales with the assertion time left, but never below 30% of it.
  - A step with nothing left loses its setup too.
  - LOOK and DUPLICATE steps leave whole.
  - WAIT rows are not counted as savings in the headline. The look steps carry most of them and leave anyway.
- **What the numbers are not.**
  - The model is per-step and proportional. It doesn't merge steps, so it doesn't capture the larger saving from running the
    remaining smokes on one shared world.
  - The p50s in `artifacts/gate-step-history.json` are polluted by fast-failing samples for some steps: h-cold 23 s against 334 s
    for a pass, irr-ingame 249 s against 1,740-2,105 s, h-natural, irr-look and 6b-versionc. The baseline uses the slices'
    measured seconds, so it is not affected. The release projection takes the larger of p50 and the slice mean.
- **Steps missing from the table.** `fl-*`, `f3-*`, `relief-probe` and `vocnat-probe` appear in the step history but not in main's
  `gate-chains.json`, because they belong to unmerged branches. They are left out.

## The phases

| phase | what lands | slice step-min saved | slice wall after |
|---|---|---|---|
| P0 (no checker) | look steps → release (`k1a-look`, `t3a-look`, `t3b-look`, `6ch-look`, `ha-look`, `6chy-look`, `irr-look`, `6cvoc-look`); duplicates out (`6cw-scenario-s7`, `6b-scenario-s1-flat`, the ha-* steps that h-* already run); ALREADY-OFFLINE rows out (api-compat inside x/mp/sch/y2/c29, 0a-* sidecar duplicates, 6a-inv3's order invariance, kit re-reads) | 75 | 109 min |
| P1 undo model | the E-flat/E-normal copies, removal orders (4e-orders), group/stage undo (4d, c30, 6a-staged, 6a-eflat), the crash kill points K1, K2, K4, K5, K6, K8 and RG2-RG6 (fault injection), x-resume's state machine, 5b's delta chains | 32 | 97 min |
| P2 structure + look lints | the realised re-reads of M2/M3/M4/M5/M10 (bridges, tunnels, walls, ropes), keep-clear and protected areas, OVERLAP/PROTECTED/PALETTE refusals, w-ingame's path bibles, d/d2 geometry, voc M20/M26/M27 re-runs | 17 | 92 min |
| P3 water + survival lints | per-body census copies, breach sweeps, the 12 HY design kinds, ledger rows in y/c29/pt/pt2/cu/voc-survival | 17 | 86 min |

The order Noah suggested holds up. The undo model saves the most and guards the riskiest code: journal, removal and crash. It also
already has a base: `JournalPropertyTest`, `RegionJournalTest`, `DeltaPropertyTest`/`DeltaModel` and `JournalStoreTest`. Do P0 first
regardless. It needs only a tier edit and Noah's sign-off on each look and duplicate step.

**Precondition for every REPLACE row (the realised == virtual guard).** Today the in-game re-runs of the M-rules on the realised
ARWD dump are the only generic proof that the real writer produced the virtual world. Scenarios have no direct realised == virtual
row; it exists only in `gate6cp0.mjs:122` and `gate7ak1.mjs:170`.
- So a lint on the virtual world is trustworthy only while one in-game `realisedVsVirtual` cell diff per writer kind survives at
  the slice tier. The writer kinds are: ground/relief, street/route, forms, lots, props, scatter, walls, bridges (beam/arch/slab),
  rope, tunnels, fluids (body, course, wet write).
- Add that row to `scenarios.mjs` and to one bridge run and one tunnel run before any P2 row moves. These are the SMOKE rows that
  protect P2.

## The checkers

### 1. Undo model tester (P1)

- **Scope.**
  - Every "the world is back exactly" assertion: E-flat, E-normal minus the world-class diff, removal by owner, group/stage/lot
    undo, cancel mid-item, removal orders, overlap layering, delta apply/revert/remove (5b E1-E3).
  - The crash/resume state machine: x-resume a-f, 4e-crash K1/K2/K4/K5/K6/K8, 6a-crash RG2-RG4/RG6, irr/hy/h FL1-FL3 resume
    bookkeeping.
  - Brush stroke undo orders (b-ingame), pt/pt2 record restore.
- **What it must model.**
  - **The real journal code, not a re-implementation:** `Journal`, `RegionJournal`, `StillOurs`, the index and the record store,
    driven headless the way `JournalPropertyTest` already does.
  - **Fault injection** at every journal and record I/O point: file write, rename, index write, the R2 hand-down commit, the
    region-record commit. Then the real startup recovery from the bytes on disk. `JournalStoreTest` does this for the store only.
  - **A vanilla-update model.** Between the write and the undo, cells may change through vanilla in a known set of ways:
    copper weathering steps, dirt_path to dirt under a solid block, gravity columns falling into a hole, leaf_litter and mushroom
    decay, fluid flowing in. The model checks that the `StillOurs` equivalence rules hold for each. Without this table the model
    proves exactly what `JournalPropertyTest` already proves, and none of the four undo bugs below would have failed it.
  - **Block entities and shape updates as opaque states.** DeltaModel's known gap: fences, panes and walls reshape against
    neighbours at a seam. Keep 2 seam orders in game.
- **Calibration probe** (release tier and every Minecraft update): a fuzz seed replayed in game.
  - Pick 3 seeds the model generated: overlapping regions, a removal order and a kill point. Run them on `G6A Flat Base` and
    compare the world hash to the model's expected cell set.
  - Also run the vanilla-update table's probe: write one cell of each listed block, force its update (`dev.copper.tick`, a
    neighbour change, a gravity trigger), and record the resulting state. It needs no judging; the table is regenerated from it.
  - About 6 min.
- **Blind spots.**
  - Any vanilla update not in the table. The relief re-tick refill and the 4d decor drift were both this kind.
  - Scale: 9M entries, chunk-spanning sections and the heap. Keep `6a-eflat` and `6a-megaA` at release.
  - Real process death: keep RG3, K3, K7 and one `x-resume` stop/reopen per release.
  - The tick scheduler's interleaving with other mods.
- **Bugs from history it would have caught.**
  - **C23** resumed removal stuck REMOVING (e9460937), if the model includes group-removal restart ordering.
  - **Copper undo**, the `StillOurs` equivalence (a3478515), with the weathering table.
  - **Lamp on dirt path**, the path-turned equivalence half (52cc9606).
  - **Relief re-tick**, the journal half only: "a restore writes flowing fluid and schedules no tick" as an invariant (7bd8c817).
  - **4d's intermittent "group undo ... back exactly"** (failed 18 of 84 logs). The 4d pass found three vanilla causes: leaf_litter
    and brown mushroom missing after the undo, a gravel column falling into the restored hole, and a bee in a site box making
    `removeGroup` refuse.
    - The model would not catch these. It would stop the gate failing on them, because the in-game smoke hash would ignore listed
      decor.

### 2. Structure lint (P2)

- **Scope:** closure, walkability (the `player` and `villager` movers of `walkGraph`), headroom, clearance, block light (M5),
  keep-clear (M25:clear, wall.around a region, protected areas, a tracked player build), lots off streets, OVERLAP / PROTECTED /
  NO_ROOM / NO_EDGE / PALETTE refusals, support (M3), bridge/tunnel/rope/wall re-reads (M10:bridge, M10:rope, M3/M4:tunnel, K1a wall
  height and gates), vocabulary (M20/M26/M27).
- **What it must model.**
  - The virtual world (`vworld.mjs`) built from the committed pinned surveys. It must not use a live seed: `gate7ak1.mjs:408-411`
    notes the live seed drifts, so the natural surveys of S1, S2, S3 and S7 and `tunnel_hill` must be committed fixtures.
  - A block-light model calibrated to vanilla (`light.mjs`), because M5 on a dump today reads the game's own light.
  - Fuzz of even widths on both axes for every writer that offsets by `rightOf`.
  - A rule that a writer's dependents stage never clears a gravity block that stays supported.
  - Most of this already exists. The lint is mostly `check.mjs` run in the unit tier on every scenario's fixtures, with the
    realised re-read replaced by the realised == virtual SMOKE row.
- **Calibration probe** (release and every Minecraft update).
  - `t3a-probe` and `k1b-ingame`'s villager probe: vanilla `dev.nav.villager` across command-built beam, arch and slab decks both
    ways, with a holed deck refused. Compare against M2:villager on the same cells.
  - `voc-registry` (blocks.mjs against the live registry: ids, property domains, light per state, random ticking).
  - A light probe: place each lamp kind over grass, dump block light, and compare against `light.mjs`.
  - About 8 min. On a mismatch, the lint's mover or light table is wrong for that version, and every P2 row goes back in game
    until it is fixed.
- **Blind spots.**
  - Real villager AI beyond the graph: doors, mobs in the way, POI claiming. Keep one villager nav per scenario at the slice tier;
    it costs 0.04-0.2 s.
  - Light from sky and snow melt (b091b539: lamps melted S3 snow into a protected area).
  - Anything the survey fixture doesn't hold, such as entities and block entities.
  - Writer bugs where virtual is right but realised is wrong. The realised == virtual SMOKE row is the guard for these.
- **Bugs from history it would have caught.**
  - **Wall through the fountain** (v51; KC's keep-clear f88ec297): any writer cell in a body's cells.
  - The other KC keep-clear finds (e8bc2e57).
  - **Even-width bridges**: T3a c4f1c8f9, then the rope and tunnel relatives 9ba60b79, which passed every checker until an
    even-width fuzz existed.
  - **C31 felling** into protected areas (5cc0d7f1).
  - The **C34/C34b claim-box door** (f5204066, a0530bc3).
  - **Lamp on dirt path**, root cause: a post's foot is never a dirt_path (52cc9606).
  - **Sand vanish** (70fc0dd0). It was a tile-writer rule, not gravity: the dependents stage cleared every gravity block on a
    changed cell. The "never clear a supported gravity block" rule catches it offline.
  - The **farm typed lot** (65d61b0b): "a farm zone or farm-typed lot that asks for a pond yields a body", but only over a corpus
    of Steward-shaped plans. Our fixtures had none, which is why Steward's RC found it.

### 3. Look lint (P2)

- **Scope:** gaps between a road and its verge, dead-ends, path width, lamp spacing settlement-wide, then taste warnings (organic
  read, palette share, slope pad batter).
  - Today only `6cw-scenario-s7 lampsoff` and parts of the scenario realised bars judge any of this.
  - The look steps record cameras and judge nothing beyond READY and PLACED.
- **What it must model:** the virtual world plus the bible's style choices. It needs the same light model as the structure lint,
  so it shares that calibration probe.
- **Calibration probe:** none against vanilla. This is taste. Calibrate against Noah's verdicts on the release-tier cameras, which
  keep running: each look-lint warning should match a camera Noah flagged.
- **Blind spots:** everything a camera shows that has no rule. The look steps move to release, not away.
- **Bugs from history:** the slope-pad batter undercutting verges (a floating cell) and the stranded apron lamp
  (5df8eeb8, 18ea5833), plus the lamp-on-path rule above.
- **Time it saves at the slice tier:** almost none, because LOOK → release does the saving. Its value is catching at the slice what
  the cameras now only show overnight.

### 4. Water lint (P3)

- **Scope.**
  - Containment: M25 leak, convert, mix, shell, keep, wet, trap and exit.
  - Census equal to the prediction for every body after the first per kind.
  - The single-breach sweep per shell cell.
  - The HY design kinds beyond one per writer kind (stream, canal/weir, race, ditch, fountain-fed).
  - IRR's broken-side breach.
  - Fire reach (M20).
- **What it must model.**
  - `sim.mjs`'s `reach` as a superset of vanilla, and `predicted` as vanilla's steady state, which it already does.
  - The water lint must also model the source/flowing distinction and foreign sources: "what this source fed", not connectivity.
  - Calibrated settle bounds.
- **Calibration probe** (release, and on any change to `kit/lib/fluids/sim.mjs` or the course writers, plus every Minecraft
  update).
  - h_core_demo's census against `predicted` and one course.
  - hy-ingame's riffle table, p01/p01b/p02: riffles 2, 4 and 6 per drop, at 1-3 slopes.
  - One breach in game.
  - h-probe's fire-reach posts and the sand-under-water anomaly.
  - About 12 min. A recorded per-body diff of zero is the pass.
- **Blind spots.**
  - Random ticks: freezing, ice and snow, hydration and crop growth (irr-ingame's 2-minute hydration waits, about 850 s).
  - Drowning and villager swimming.
  - The runtime guards: the escape guard, settle-at-start after a crash, the removal drain and its 2x-bound cap. These stay
    KEEP-INGAME.
  - Worldgen fluids meeting the plan: voc-natural's cave stream and lava spring, and the relief refill over a worldgen stream.
- **Bugs from history.**
  - **IRR breach sweep** (c170b161), only partly. The verifier found it in review; the pure selection is unit-testable, but a
    foreign flow meeting the breach is still in game only.
  - **H review defects** (bcdc7097): the drain took a player's water.
  - It would **not** have caught the relief refill (7bd8c817), which needed vanilla ticks over a worldgen stream.

### 5. Survival ledger lint (P3)

- **Scope.**
  - Conservation at every checkpoint and credit once.
  - Refund = tally of standing blocks, on deconstruct, delta, revert and undo.
  - Bill = BOM (C26 bomFull), adopt costs 0, and an update pays only the added cells.
  - Reservation release on wait and stage removal (C29).
  - Weathering while waiting charges nothing and doesn't re-queue (cu-survival).
  - Capacity and overflow.
- **What it must model.**
  - The real Java ledger: `Stockpile`, `Refunds`, `FeedOrder`, `FullBom`. The units already prove each rule alone
    (`StockpileTest`, `LedgerTest`, `RefundsAndBitsTest`, `FeedOrderTest`, `FullBomTest`, `C29CreditTest`).
  - On top, a simulated interleaving of place, remove, delta, weather and adopt events across several targets and one stockpile.
  - The "free conversion" set (dirt-family to dirt_path) and the vanilla-update table shared with the undo model.
- **Calibration probe** (release and every Minecraft update).
  - One `y-ingame store` run: a storehouse feeds a house, a road and a delta, with the ledger delta measured per event.
  - One `cu-survival` run with real weathering (`dev.copper.tick`).
  - The model's predicted ledger after the same event list must equal the game's.
  - About 6 min.
- **Blind spots.**
  - Real item flow: hoppers, container ticks, players dropping items. Keep 4d's survival build of 3 construction sites from one
    hopper chain.
  - The OCCUPIED wait with a real player in a cell.
  - Chunk unload: the unloaded frontier, NOT_LOADED.
  - Restart. Keep the y `once/restart` and `c29restart` steps.
- **Bugs from history:** the Steward repros S-Y-1, dissolve, C29, C34 and C35 were all ledger-arithmetic shaped. The copper refund
  "by standing block, not planned block" is also covered.

### 6. Determinism and byte identity (exists)

- **Scope:** IR sha ×3 under `/tick freeze`, 1 vs 4 workers, goldens, plan catalogue, `Library.Entry.cells() == PlanChecks.cells`
  (c37), and tile sha with permuted arrival (0a-tiles).
- These already run in the unit tier (mp-unit, p0-unit, the kit goldens). In game they mostly duplicate it, apart from the prepare
  step's real worldgen, which the scenario surveys need.
- **Calibration:** the pinned-seed survey sha, recorded per Minecraft version. A drift means re-pinning the fixtures. Bug S1 survey
  sha drift was exactly this.
- **Missed historically:** nested guard runs (72d305ba). It was a kit-to-Java schema mismatch that only `realiseApproved` in Java
  saw. Neither determinism nor any lint here catches it. A contract test that round-trips every emitted IR through the Java reader
  does, so add it to the unit tier.

## What stays in game at the slice tier (after P3)

About 162 in-game step-minutes per slice (55% of today). It is dominated by:
- the 2-minute stands and settles: random ticks, melt, E-normal world classes;
- the realise/remove write path, one per writer kind, with the new realised == virtual row;
- vanilla villager nav;
- the fluid runtime guards and crash resume;
- the hopper survival build;
- old-jar API on a live server (`apijars`);
- the sim suites;
- chunk loading;
- the client UI steps (6b-ghost, 6b-nudges, 6b-commands).

## Fixed waits (outside this brief, and larger than any checker)

Several passes found that much of the in-game time is neither an assertion nor vanilla. This brief doesn't cover it, but it changes
the ranking, so here it is. None of it has been verified beyond reading the code and the log times.

- **`k1a-look` and `t3a-look`.** About 600 s idle after `dev.region.remove`, then `leaveWorld`, after each non-default bible: 3
  times in k1a-look and twice in t3a-look, in 10 of 10 logs. That is 88% and 86% of those steps. It matches
  `ApiTimeouts.DESIGN_DEFAULT_MS`, but the cause isn't confirmed. t3a-look swallows the remove result and discards the world, so
  skipping the remove cuts it to about 200 s.
- **Region poll floors.** `tools/lib/run6b.mjs` `waitRegion` sleeps 30 s per poll, and `tools/gate6a.mjs:256-272` sleeps 60 s.
  - Every region realise therefore reads 30 s or 60 s whatever its size; real placement takes 1.7-12 s.
  - It is 76% of p0-ingame, 53% of x-resume, about 42% of x-ingame and about 540 of 939 s in 6a-crash.
  - cu-ingame's three realises are exactly 30 s each.
- **Scenario settles.** The 90 s pre-realise settle per variant (`scenarios.mjs:343`) is 36-40% of each scenario step. The 120 s
  stand is a further 24-32%, but that is vanilla physics and stays.
- **Smaller ones:**
  - b-ingame's `/architect brush undo` loop waits out 120 s (`gate6cb.mjs:450`; about 47% of the step).
  - pt-ingame `hyst` and pt2 `states` sleep on a wall-clock debounce (119 s and 90 s). An injected tick clock would replace it.
  - c30-ingame hashes six lots after each of 12 removals (about 60% of the step). Hashing once at the end would do.
  - 4d-all and c30-ingame regenerate their base world (53 s) where a restore would do.
  - 0a-tiles spends about 216 s in real-time retry backoff.
  - 5b `hash()` settles 3 s on each of about 700 calls.
- **Rough size:** 25-35 step-minutes per slice beyond the checker savings, so a further 8-12 min of wall. It is unmeasured until
  someone tries it. At release, the look stalls alone are about 50 min of step time.

## Risks and what we'd lose

1. **The realised world stops being checked by default.** Most "REPLACE · structure-lint" rows are the M-rules re-run on the realised
   dump. That re-run is also, accidentally, our only generic realised == virtual check. Drop it without the SMOKE row per writer
   kind and a writer bug passes every lint, because the lint reads the plan, not the world. That is the even-width rope bridge
   pattern.
2. **Vanilla behaviour no table lists.** The undo model and the ledger lint are only as good as the vanilla-update table:
   weathering, path to dirt, gravity, decor decay, fluids flowing in. Relief re-tick, copper undo, lamp on path and the 4d decor
   drift were each found because a real world did something the model didn't know. With fewer in-game runs per day, the next one of
   these surfaces at release or in Steward's hands, not at the slice. Rough rate from history: about one per week of slices.
3. **Fewer real-world samples.** Several bugs were caught by the n-th copy of a SMOKE proof, not the first:
   - the farm hamlet found the lamp-on-path E-flat once;
   - 6ct1-scenario-relief failed intermittently for a week before 36 runs were correlated.

   Cutting copies to one per kind lowers the odds of seeing a 1-in-20 intermittent before release. A partial mitigation: rotate
   which instance is the smoke, deterministically by slice, the same way the release rotation works.
4. **Release becomes the safety net, and it is about 3x longer.**
   - Today's release doesn't run the slice-own steps at all, so "full set at release" is new coverage. It is about 5.5-6 h
     overnight on 3 shards.
   - A failure there lands after the merge. That fits policy 4, "release first, Steward checks after", but it means more patch
     releases.
   - It is fine if releases stay batched (2-3 slices). If releases become per-slice again, the saving disappears.
5. **Calibration drift on Minecraft updates.** Every simulator is trusted only while its probe passes on the current version.
   - A Minecraft update must run every probe before any slice relies on a lint. That's about 30 min.
   - A failing probe returns all of that checker's rows to the game until it is recalibrated. Spell that rule out in GATES.md.
6. **Steward-shaped inputs.** The farm typed lot and nested guards were found only because Steward ran shapes our fixtures lacked.
   Neither offline checker sees a shape it isn't given. Keep Steward's hamlet and a growing corpus of Steward plans as fixtures for
   the lints, and keep `realiseApproved` on at least one Steward plan in game.
7. **The offline floor.** The unit steps are already 93 step-minutes per slice, and the new checkers add to them. A fuzzing undo
   model that is "instant" per case but runs thousands of cases can easily cost 5-10 min. Budget each checker at ≤ 2 min in the
   unit tier, with a long nightly seed sweep at release.
8. **Hidden coupling in steps.** Some in-game groups are fixtures for later groups:
   - 4d's survival crate feeds group 18;
   - 0a-fit runs after 0a-flow;
   - t3a-frozen mostly repeats t3a-natural, but it is the only frozen-river write.

   Removing a group can silently remove the setup another needs. Every step edit needs its driver re-run once, in the change tier,
   to prove the remaining groups still pass on their own.

## Bugs from history and who found them

| bug | found by | needed | would a fast checker have caught it? |
|---|---|---|---|
| Farm pond missing for lots typed `farm` (H RC2, 65d61b0b) | Steward RC (no step realised a type-implied farm) | plan geometry | structure lint, only with Steward-shaped fixtures |
| Nested guard runs (H RC3, 72d305ba) | Steward RC (Java parser) | kit-to-Java schema | none of the six; an IR round-trip contract test |
| Wall through a fountain (v51; KC f88ec297) | VOC integration voc-ingame bill comparison | cell-set overlap | structure lint (keep-clear) |
| IRR breach sweep took other water (c170b161) | gate-verifier code review | fluid feeder semantics | water lint, partly; foreign flow stays in game |
| Copper undo (CU a3478515) | CU item 1 measure (VOC-b drift probe misreported it) | random tick + StillOurs rule | undo model with the weathering table, partly |
| Relief re-tick (7bd8c817) | in-game 6ct1-scenario-relief, intermittent for a week | vanilla fluid tick over a worldgen stream | the journal half only (undo model); the refill needs the game |
| Lamp on dirt path (52cc9606) | in-game IRR control on Steward's hamlet, once | vanilla dirt_path → dirt + journal rule | structure lint (post foot rule) + undo model (equivalence) |
| Sand vanish (70fc0dd0) | in-game T3b gate | tile-writer dependents rule (not gravity) | structure lint (supported gravity block kept) |
| Even-width bridges (c4f1c8f9; rope/tunnel 9ba60b79) | H-a/H-b gates; relatives by code reading | geometry | structure lint with an even-width fuzz |
| C23 removal stuck after restart (e9460937) | Steward review | restart ordering | undo model with crash/resume |
| C31 felling into protected areas (5cc0d7f1) | T2 gate on a fresh S3 copy | geometry with trees | structure lint |
| C34/C34b claim-box door (f5204066, a0530bc3) | Steward patch ask | classifier geometry | structure lint |
| 4d group undo intermittent (18/84 logs) | slice flakes | vanilla decor, gravity, a bee | none; the model removes the false failures |
| 6cv horse in a lot (60-min timeout) | slice run | mobs | none (infra; fixed by clearing mobs) |
| Melt water from lamps into a protected area (b091b539) | in-game realised M5 / looks | vanilla light + snow melt | none |
| Compile rollback left fluid records (34ff42b5) | H batch review | plan state | determinism (plan twice / rollback property) |

Source detail and file:line for each row: `scratchpad/fast/bugs.md` in the analysis checkout. This is a local scratch file, not
committed.

## Every step: savings summary

All in-game steps, sorted by step-minutes saved per slice.
- **keep %** includes the 1/3 of each SMOKE row that stays.
- **P0 / undo / struct+look / water+ledger** columns are the share of the step's time each phase removes.
- **saved P0..P3** are step-minutes per slice.
- Steps in no recent slice show 0 saved, but their rows still decide what release runs.

| step | p50 min | slices /12 | step-min /slice | keep % | P0 % | undo % | struct+look % | water+ledger % | wait % | setup % | saved P0 | saved P1 | saved P2 | saved P3 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `k1a-look` | 34.1 | 11 | 31.7 | 4 | 8 | 0 | 0 | 0 | 88 | 0 | 31.7 | 0.0 | 0.0 | 0.0 |
| `t3a-look` | 23.3 | 6 | 12.4 | 6 | 3 | 0 | 0 | 0 | 86 | 5 | 12.4 | 0.0 | 0.0 | 0.0 |
| `5b-chains` | 30.4 | 4 | 10.0 | 21 | 18 | 41 | 0 | 0 | 0 | 20 | 2.2 | 5.1 | 0.0 | 0.0 |
| `6cw-scenario-s7` | 7.6 | 11 | 7.1 | 0 | 9 | 0 | 0 | 0 | 0 | 91 | 7.1 | 0.0 | 0.0 | 0.0 |
| `hy-ingame` | 18.2 | 6 | 14.1 | 59 | 1 | 2 | 0 | 38 | 0 | 1 | 0.1 | 0.3 | 0.0 | 5.4 |
| `h-ingame` | 17.2 | 10 | 14.1 | 64 | 4 | 5 | 1 | 27 | 0 | 0 | 0.5 | 0.7 | 0.1 | 3.8 |
| `4d-all` | 13.6 | 9 | 10.8 | 57 | 10 | 31 | 1 | 0 | 0 | 2 | 1.1 | 3.4 | 0.1 | 0.0 |
| `4e-orders` | 7.1 | 8 | 4.9 | 8 | 0 | 89 | 0 | 0 | 0 | 3 | 0.0 | 4.5 | 0.0 | 0.0 |
| `6b-scenario-s1-flat` | 2.8 | 12 | 3.6 | 19 | 4 | 6 | 0 | 0 | 0 | 70 | 3.6 | 0.0 | 0.0 | 0.0 |
| `w-ingame` | 12.7 | 6 | 4.0 | 10 | 0 | 0 | 84 | 0 | 0 | 5 | 0.0 | 0.0 | 3.5 | 0.0 |
| `6a-staged` | 6.3 | 11 | 6.1 | 46 | 0 | 53 | 0 | 0 | 0 | 1 | 0.0 | 3.2 | 0.0 | 0.0 |
| `4e-crash` | 6.2 | 8 | 4.7 | 38 | 0 | 56 | 0 | 0 | 0 | 7 | 0.0 | 2.8 | 0.0 | 0.0 |
| `pt-ingame` | 8.4 | 7 | 5.1 | 47 | 0 | 8 | 0 | 43 | 0 | 2 | 0.0 | 0.4 | 0.0 | 2.2 |
| `x-ingame` | 7.0 | 8 | 4.5 | 43 | 26 | 27 | 0 | 0 | 0 | 5 | 1.2 | 1.2 | 0.0 | 0.0 |
| `6cvoc-look` | 5.0 | 5 | 2.2 | 23 | 15 | 0 | 47 | 0 | 0 | 15 | 2.2 | 0.0 | 0.0 | 0.0 |
| `6a-eflat` | 8.0 | 11 | 7.8 | 59 | 0 | 24 | 0 | 0 | 0 | 17 | 0.0 | 2.2 | 0.0 | 0.0 |
| `d2-ingame` | 3.9 | 11 | 4.0 | 46 | 0 | 3 | 50 | 0 | 0 | 1 | 0.0 | 0.1 | 2.0 | 0.0 |
| `mp-ingame` | 9.5 | 3 | 2.5 | 11 | 42 | 22 | 0 | 0 | 0 | 25 | 1.4 | 0.6 | 0.0 | 0.0 |
| `6cd-scenario-districts` | 8.8 | 11 | 8.9 | 38 | 1 | 0 | 10 | 0 | 0 | 51 | 0.2 | 0.0 | 1.9 | 0.0 |
| `voc-ingame` | 6.7 | 5 | 2.9 | 29 | 3 | 21 | 41 | 0 | 0 | 6 | 0.1 | 0.6 | 1.3 | 0.0 |
| `t3b-natural` | 9.4 | 8 | 6.7 | 68 | 26 | 0 | 1 | 0 | 0 | 5 | 1.8 | 0.0 | 0.1 | 0.0 |
| `6c-scenario-s2` | 8.4 | 11 | 8.5 | 37 | 3 | 4 | 3 | 0 | 0 | 53 | 0.5 | 0.8 | 0.5 | 0.0 |
| `d-ingame` | 2.2 | 11 | 2.2 | 20 | 0 | 36 | 44 | 0 | 0 | 0 | 0.0 | 0.8 | 1.0 | 0.0 |
| `ha-ingame` | 8.4 | 2 | 1.7 | 0 | 0 | 0 | 0 | 0 | 0 | 100 | 1.7 | 0.0 | 0.0 | 0.0 |
| `x-resume` | 5.8 | 6 | 3.0 | 21 | 13 | 16 | 0 | 0 | 0 | 50 | 0.8 | 0.9 | 0.0 | 0.0 |
| `6b-scenario-s1` | 8.0 | 11 | 7.8 | 39 | 2 | 5 | 4 | 0 | 0 | 50 | 0.3 | 0.7 | 0.6 | 0.0 |
| `6cv-scenario-s7` | 7.6 | 12 | 8.0 | 40 | 3 | 5 | 2 | 0 | 0 | 50 | 0.5 | 0.7 | 0.3 | 0.0 |
| `c29-ingame` | 5.4 | 5 | 2.5 | 46 | 0 | 0 | 0 | 54 | 0 | 0 | 0.0 | 0.0 | 0.0 | 1.4 |
| `pt2-ingame` | 5.7 | 4 | 2.2 | 37 | 0 | 4 | 0 | 59 | 0 | 0 | 0.0 | 0.1 | 0.0 | 1.3 |
| `6ct1-scenario-relief` | 7.6 | 9 | 5.7 | 42 | 3 | 5 | 2 | 0 | 0 | 48 | 0.3 | 0.5 | 0.2 | 0.0 |
| `t3b-look` | 0.9 | 8 | 1.0 | 0 | 16 | 0 | 0 | 0 | 0 | 84 | 1.0 | 0.0 | 0.0 | 0.0 |
| `6cf2-scenario-scatter` | 12.7 | 8 | 9.2 | 47 | 0 | 0 | 6 | 0 | 0 | 47 | 0.0 | 0.0 | 1.0 | 0.0 |
| `p0-ingame` | 2.6 | 10 | 2.3 | 60 | 14 | 3 | 22 | 0 | 0 | 1 | 0.3 | 0.1 | 0.5 | 0.0 |
| `y-ingame` | 5.1 | 4 | 1.9 | 49 | 16 | 0 | 0 | 27 | 0 | 8 | 0.3 | 0.0 | 0.0 | 0.6 |
| `hy-crash` | 4.0 | 6 | 2.1 | 59 | 0 | 0 | 0 | 41 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.9 |
| `b-ingame` | 4.1 | 7 | 2.6 | 22 | 0 | 14 | 16 | 0 | 41 | 8 | 0.0 | 0.4 | 0.5 | 0.0 |
| `c30-ingame` | 5.8 | 2 | 1.0 | 18 | 0 | 76 | 0 | 0 | 0 | 6 | 0.0 | 0.8 | 0.0 | 0.0 |
| `6b-versions` | 2.7 | 10 | 2.3 | 64 | 0 | 0 | 35 | 0 | 0 | 1 | 0.0 | 0.0 | 0.8 | 0.0 |
| `6ct2-scenario-route` | 8.4 | 5 | 3.5 | 38 | 4 | 0 | 7 | 0 | 0 | 51 | 0.3 | 0.0 | 0.5 | 0.0 |
| `apijars` | 4.5 | 12 | 4.1 | 39 | 9 | 0 | 0 | 0 | 0 | 52 | 0.8 | 0.0 | 0.0 | 0.0 |
| `hy-cold` | 6.5 | 6 | 3.2 | 80 | 0 | 0 | 0 | 20 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.6 |
| `6b-ghost` | 1.2 | 12 | 1.9 | 41 | 0 | 0 | 21 | 0 | 0 | 38 | 0.0 | 0.0 | 0.6 | 0.0 |
| `4e-megalite` | 1.6 | 12 | 2.5 | 80 | 0 | 20 | 0 | 0 | 0 | 0 | 0.0 | 0.5 | 0.0 | 0.0 |
| `6cf1-scenario-forms` | 8.0 | 3 | 2.1 | 39 | 4 | 0 | 7 | 0 | 0 | 50 | 0.2 | 0.0 | 0.3 | 0.0 |
| `v-ingame` | 2.9 | 3 | 0.6 | 22 | 6 | 10 | 48 | 9 | 0 | 5 | 0.0 | 0.1 | 0.3 | 0.1 |
| `t3a-ingame` | 2.0 | 6 | 1.1 | 64 | 9 | 0 | 25 | 0 | 0 | 2 | 0.1 | 0.0 | 0.3 | 0.0 |
| `6a-inv3` | 1.4 | 11 | 1.5 | 72 | 24 | 0 | 0 | 0 | 0 | 4 | 0.4 | 0.0 | 0.0 | 0.0 |
| `5b-village` | 2.0 | 4 | 0.7 | 53 | 20 | 27 | 0 | 0 | 0 | 0 | 0.1 | 0.2 | 0.0 | 0.0 |
| `irr-ingame` | 4.2 | 1 | 2.4 | 85 | 0 | 4 | 2 | 8 | 0 | 2 | 0.0 | 0.1 | 0.0 | 0.2 |
| `kc-ingame` | 2.4 | 2 | 0.4 | 29 | 13 | 0 | 0 | 58 | 0 | 0 | 0.1 | 0.0 | 0.0 | 0.3 |
| `voc-survival` | 0.8 | 6 | 0.5 | 27 | 1 | 0 | 0 | 54 | 0 | 18 | 0.0 | 0.0 | 0.0 | 0.3 |
| `t1-ingame` | 0.2 | 8 | 0.4 | 23 | 20 | 0 | 47 | 0 | 0 | 10 | 0.1 | 0.0 | 0.2 | 0.0 |
| `t3b-ingame` | 3.8 | 8 | 2.7 | 91 | 5 | 0 | 4 | 0 | 0 | 0 | 0.1 | 0.0 | 0.1 | 0.0 |
| `cu-ingame` | 2.3 | 2 | 0.4 | 48 | 32 | 0 | 0 | 20 | 0 | 0 | 0.1 | 0.0 | 0.0 | 0.1 |
| `t3a-natural` | 2.2 | 6 | 1.2 | 35 | 11 | 0 | 5 | 0 | 47 | 2 | 0.1 | 0.0 | 0.1 | 0.0 |
| `t3a-frozen` | 2.4 | 6 | 1.2 | 76 | 10 | 0 | 4 | 0 | 0 | 10 | 0.1 | 0.0 | 0.1 | 0.0 |
| `vocc-ingame` | 3.2 | 1 | 0.3 | 22 | 0 | 31 | 17 | 0 | 0 | 30 | 0.0 | 0.1 | 0.1 | 0.0 |
| `h-crash` | 2.0 | 10 | 1.9 | 89 | 9 | 0 | 0 | 0 | 0 | 2 | 0.2 | 0.0 | 0.0 | 0.0 |
| `voc-natural` | 2.5 | 5 | 1.0 | 83 | 0 | 0 | 17 | 0 | 0 | 1 | 0.0 | 0.0 | 0.2 | 0.0 |
| `k1a-ingame` | 0.9 | 11 | 1.0 | 82 | 1 | 15 | 0 | 0 | 0 | 2 | 0.0 | 0.2 | 0.0 | 0.0 |
| `tile-gravity` | 0.3 | 11 | 0.7 | 70 | 0 | 20 | 0 | 0 | 0 | 10 | 0.0 | 0.1 | 0.0 | 0.0 |
| `p0-natural` | 2.1 | 10 | 2.0 | 38 | 1 | 0 | 1 | 0 | 0 | 60 | 0.0 | 0.0 | 0.0 | 0.0 |
| `k1b-ingame` | 1.6 | 4 | 0.5 | 80 | 11 | 0 | 6 | 0 | 0 | 3 | 0.1 | 0.0 | 0.0 | 0.0 |
| `6b-smoke` | 1.4 | 12 | 1.6 | 93 | 0 | 0 | 5 | 0 | 0 | 2 | 0.0 | 0.0 | 0.1 | 0.0 |
| `irr-crash` | 2.7 | 1 | 0.2 | 65 | 0 | 6 | 0 | 29 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.1 |
| `t2-ingame` | 1.2 | 1 | 0.1 | 17 | 0 | 26 | 55 | 0 | 0 | 2 | 0.0 | 0.0 | 0.1 | 0.0 |
| `c37-ingame` | 1.1 | 1 | 0.1 | 15 | 15 | 10 | 30 | 0 | 0 | 30 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6b-pathstyle` | 0.6 | 4 | 0.2 | 61 | 0 | 0 | 31 | 0 | 0 | 8 | 0.0 | 0.0 | 0.1 | 0.0 |
| `cu-survival` | 0.6 | 2 | 0.1 | 51 | 0 | 0 | 0 | 49 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.1 |
| `pt2-survival` | 0.3 | 4 | 0.1 | 73 | 0 | 7 | 0 | 20 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `k1a-natural` | 1.6 | 11 | 1.7 | 51 | 0 | 0 | 1 | 0 | 47 | 1 | 0.0 | 0.0 | 0.0 | 0.0 |
| `k1a-target` | 1.3 | 11 | 1.3 | 85 | 1 | 0 | 0 | 0 | 0 | 14 | 0.0 | 0.0 | 0.0 | 0.0 |
| `h-probe` | 2.7 | 10 | 2.3 | 99 | 1 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `c38-ingame` | 0.2 | 1 | 0.0 | 9 | 55 | 0 | 0 | 0 | 0 | 36 | 0.0 | 0.0 | 0.0 | 0.0 |
| `k1b-natural` | 2.2 | 4 | 0.8 | 42 | 1 | 0 | 0 | 0 | 47 | 11 | 0.0 | 0.0 | 0.0 | 0.0 |
| `c31-felling` | 0.3 | 2 | 0.1 | 95 | 0 | 5 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `f2-harvest` | 0.2 | 8 | 0.1 | 71 | 0 | 0 | 1 | 0 | 0 | 28 | 0.0 | 0.0 | 0.0 | 0.0 |
| `voc-registry` | 0.1 | 6 | 0.0 | 80 | 1 | 0 | 0 | 0 | 0 | 19 | 0.0 | 0.0 | 0.0 | 0.0 |
| `y2-ingame` | 2.7 | 0 | 0.0 | 31 | 47 | 0 | 0 | 13 | 0 | 9 | 0.0 | 0.0 | 0.0 | 0.0 |
| `y2-bom` | 1.0 | 0 | 0.0 | 12 | 0 | 0 | 0 | 37 | 0 | 51 | 0.0 | 0.0 | 0.0 | 0.0 |
| `4e-throughput` | 1.1 | 0 | 0.0 | 64 | 0 | 0 | 0 | 0 | 0 | 36 | 0.0 | 0.0 | 0.0 | 0.0 |
| `4e-throughput-smoke` | 0.3 | 0 | 0.0 | 45 | 0 | 0 | 0 | 0 | 0 | 55 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-megaA` | 9.1 | 5 | 4.3 | 91 | 0 | 0 | 0 | 0 | 0 | 9 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-megaB` | 78.4 | 0 | 0.0 | 93 | 0 | 0 | 0 | 0 | 0 | 7 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-megaB-fast` | 17.8 | 0 | 0.0 | 97 | 0 | 0 | 0 | 0 | 0 | 3 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-crash` | 15.7 | 0 | 0.0 | 44 | 0 | 56 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-forest` | 3.3 | 0 | 0.0 | 95 | 0 | 0 | 0 | 0 | 0 | 5 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6a-heap` | 5.2 | 0 | 0.0 | 77 | 0 | 0 | 0 | 0 | 0 | 23 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sim-jobs` | 0.5 | 12 | 0.6 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sim-sets` | 1.1 | 12 | 1.3 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sim-massing` | 1.1 | 12 | 1.7 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6b-volume` | 1.9 | 5 | 0.9 | 2 | 0 | 0 | 0 | 0 | 0 | 98 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6b-commands` | 2.9 | 0 | 0.0 | 44 | 0 | 0 | 0 | 0 | 0 | 56 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6b-nudges` | 2.9 | 5 | 1.5 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6b-versionc` | 0.3 | 0 | 0.0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-stub` | 0.2 | 0 | 0.0 | 25 | 75 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-flow` | 2.1 | 0 | 0.0 | 41 | 11 | 7 | 9 | 0 | 0 | 31 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-budget` | 1.3 | 0 | 0.0 | 0 | 15 | 0 | 0 | 0 | 0 | 85 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-fit` | 0.5 | 0 | 0.0 | 0 | 13 | 0 | 0 | 0 | 0 | 87 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-batches` | 3.1 | 0 | 0.0 | 64 | 0 | 0 | 0 | 0 | 0 | 36 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-keys` | 2.6 | 0 | 0.0 | 40 | 2 | 0 | 1 | 0 | 0 | 57 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-cancel` | 0.8 | 0 | 0.0 | 3 | 6 | 0 | 7 | 0 | 0 | 84 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-pins` | 1.1 | 0 | 0.0 | 0 | 41 | 0 | 0 | 0 | 0 | 59 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-stopped` | 0.8 | 0 | 0.0 | 22 | 0 | 0 | 0 | 0 | 0 | 78 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0a-tiles` | 6.7 | 0 | 0.0 | 1 | 12 | 54 | 2 | 0 | 0 | 31 | 0.0 | 0.0 | 0.0 | 0.0 |
| `0b-ingame` | 1.0 | 0 | 0.0 | 11 | 13 | 17 | 5 | 0 | 0 | 55 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sch-roundtrip` | 0.3 | 0 | 0.0 | 55 | 25 | 0 | 20 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sch-refusals` | 0.0 | 0 | 0.0 | 8 | 75 | 0 | 17 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sch-placement` | 0.2 | 0 | 0.0 | 33 | 0 | 30 | 37 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `sch-ingame` | 1.6 | 0 | 0.0 | 10 | 85 | 0 | 5 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `d2-findsite` | 3.7 | 0 | 0.0 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `voc-probe` | 5.3 | 6 | 3.9 | 98 | 0 | 0 | 0 | 0 | 0 | 2 | 0.0 | 0.0 | 0.0 | 0.0 |
| `t3a-probe` | 0.7 | 6 | 0.4 | 95 | 0 | 0 | 0 | 0 | 0 | 5 | 0.0 | 0.0 | 0.0 | 0.0 |
| `t3b-pin` | 3.3 | 0 | 0.0 | 80 | 0 | 0 | 20 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `pt-nomod` | 0.9 | 6 | 0.6 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `cu-measure` | 0.7 | 2 | 0.1 | 76 | 0 | 0 | 0 | 0 | 0 | 24 | 0.0 | 0.0 | 0.0 | 0.0 |
| `h-natural` | 2.3 | 0 | 0.0 | 70 | 9 | 0 | 0 | 21 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `h-cold` | 0.4 | 0 | 0.0 | 84 | 7 | 0 | 0 | 9 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6ch-look` | 3.2 | 0 | 0.0 | 0 | 87 | 0 | 0 | 0 | 0 | 13 | 0.0 | 0.0 | 0.0 | 0.0 |
| `ha-natural` | 4.9 | 0 | 0.0 | 0 | 0 | 0 | 0 | 0 | 0 | 100 | 0.0 | 0.0 | 0.0 | 0.0 |
| `ha-cold` | 3.4 | 0 | 0.0 | 0 | 0 | 0 | 0 | 0 | 0 | 100 | 0.0 | 0.0 | 0.0 | 0.0 |
| `ha-look` | 4.2 | 0 | 0.0 | 44 | 54 | 0 | 0 | 0 | 0 | 2 | 0.0 | 0.0 | 0.0 | 0.0 |
| `hy-natural` | 1.7 | 0 | 0.0 | 40 | 13 | 0 | 0 | 29 | 0 | 18 | 0.0 | 0.0 | 0.0 | 0.0 |
| `6chy-look` | 10.9 | 0 | 0.0 | 80 | 16 | 0 | 0 | 0 | 0 | 4 | 0.0 | 0.0 | 0.0 | 0.0 |
| `irr-look` | 1.6 | 0 | 0.0 | 14 | 86 | 0 | 0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 | 0.0 |

## Every step, every assertion group

One table per in-game step in `tools/gate-chains.json`. Group texts are condensed from the driver code and real logs; `~est` marks a share estimated rather than timed. Disposition labels are normalised (see Method). Order: the 4d/4e/5b/6a regression steps first, then the slice-own steps by driver.

#### `4d-all`

p50 13.6 min · in 9/12 recent full slices · 10.8 step-min per slice · after all checkers keeps 58% · saves **4.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base world gen + 12 lot fits | regenerates the normal-preset "G4D Base" world every run (rm + create), fits 12 lots on varied terrain, only BLOCK_ENTITIES refusals allowed | 53 s = 6.8% (measured) | SMOKE · undo-model | Not a proof. The fit check is ALREADY-OFFLINE (`LotFittingTest`, `MassingPredictionTest`). Cheap win: keep the generated base as a restore like the 4e `restore: ["G4E Flat"]` instead of regenerating. |
| 2 | queue places all 12 + BAR tick | 12-lot batch at 4 ms places 12/12; Architect own tick max <= 50 ms | ~15 s = 1.9% (~est) | KEEP-INGAME | Real mod write path through ticks into real chunks. BAR half is recorded-not-judged. |
| 3 | group undo: removeGroup completes + reverse placement order | `sgremove` returns removed=true; SITE_REMOVED events are exactly the reverse of ITEM_PLACED | ~5 s = 0.6% (~est) | REPLACE · undo-model | Pure journal ordering; `RegionJournalTest.groupUndoEqualsTileByTile` + `JournalPropertyTest` cover order/exactness abstractly. Model: removal order = reverse layer order, blockers (entities in box) as an input. |
| 4 | **group undo: every lot region (box+7) and village back exactly** | after removeGroup, 12 lot hashes and the whole-village hash equal the pre-placement hashes | ~75 s = 9.5% (~est; | SMOKE · undo-model | Journal exactness is covered by `JournalPropertyTest` (any order, overlaps, edits). What the in-game copy adds is vanilla neighbour/entity/gravity behaviour on a real world. |
| 5 | queued == atomic equality | same 12 lots placed one-by-one INSTANT in a fresh copy: 12/12 lot regions and the village hash identical (states + BE NBT) | ~77 s = 9.8% (~est; | SMOKE · undo-model | Ticked writer vs atomic writer is the real placement system. 4 design kinds x 3: one lot per kind (cabin, gatehouse, tavern, tower) is a representative; all 12 at release. |
| 6 | relog: MSPT measure sanity | `msptMax >= serverMsptMax` (the full-tick timer includes end-of-tick handlers) | ~0.5 s = 0.1% | BAR | Timing-instrument self-check. |
| 7 | relog: queue file kept the job | after a clean leave mid-item, `architect-queue.json` is clean=true and holds a place job with a writer cursor | ~12 s = 1.5% (~est) | KEEP-INGAME | Save/reload of the queue file. Format is `QueueJsonTest` (offline), but the clean-stop hook needs the real server. |
| 8 | relog: batch resumed, placed 12, actor stored as UUID only | reopen world, batch finishes 12/12 | ~20 s = 2.5% (~est) | KEEP-INGAME | Resume after save/reload. Duplicated by megalite relog and crash K3-clean: three copies of "resume after stop". Keep one per tier. |
| 9 | relog: 12/12 lot regions identical to uninterrupted batch | 12 lot hashes equal `queuePost` | ~39 s = 4.9% (~est; | SMOKE · undo-model | Same proof as group 4 over a resumed batch. One kind at slice tier. |
| 10 | waiting: player in lot | PLAYER_IN_BOX wait; not placed while the player stands in it; placed once the player left | ~8 s = 1.0% (~est) | KEEP-INGAME | Needs the real player entity/box check (`PlayerBlocksTest` covers the predicate only). |
| 11 | waiting: unloaded chunks + LOAD_BOUNDED | NOT_LOADED wait; far lot places when player walks near; LOAD_BOUNDED(64) places a far lot with no player | ~12 s = 1.5% (~est) | KEEP-INGAME | Real chunk load/unload and tickets (`ChunkTicketsTest` is the logic only). |
| 12 | stages: state machine | queued PLANNED, nothing before approval, undo of s1 refused while s3 placed, state sequence in order | ~13 s = 1.6% (~est) | ALREADY-OFFLINE | `StageRulesTest` (4) + `BatchRulesTest` (12) model the rules; in-game copy is a duplicate of the rule table. Also exercised by c30 group 1. |
| 13 | stages: undo 3 then undo 1 restore lots exactly | hash of 3 lots after staged undos equals pre; skipped s2 never placed | ~14 s = 1.7% (~est) | REPLACE · undo-model | Same journal exactness as group 3. Failed in 7 of 84 historical runs on the same decor drift (see notes). |
| 14 | lotfit: 4 lots x 4 street sides geometry | entrance faces street, predicted restore box inside lot, approachIntoStreet, LOT_TOO_SMALL, overlapMargin = front 12 | ~4 s = 0.5% (~est) | ALREADY-OFFLINE | `LotFittingTest`, `MinLotSizeTest`, `MirrorFitTest` (flat-world geometry, no vanilla). |
| 15 | lotfit: 16 placed from their fits | each placed restore box is inside its lot and equals `predictedRestoreBox` | ~5.5 s = 0.7% (~est) | SMOKE · undo-model | Prediction == placement on flat terrain is unit-tested; real terrain slope extension (`extendMax`) is the only in-game residue. |
| 16 | gap0: touching lots place; approach crossing a neighbour refuses OVERL… | A,B 0-gap both place; C refuses `FAILED:OVERLAP` | 5.5 s = 0.7% (measured… | REPLACE · structure-lint | Pure box/approach-strip geometry. `BatchRulesTest` is the likely home (it has no OVERLAP assertion today: grep found none, so add one). Needs: restore boxes and approach strips as AABBs. |
| 17 | survival: rule + crate + stock | actorless INSTANT in survival fails NOT_ALLOWED at queue; one shared crate outside every restore box; | ~40 s = 5.1% (~est) | ALREADY-OFFLINE | The NOT_ALLOWED, crate placement and BOM equality are unit-proven; the hopper-chain build is fixture for group 17. |
| 18 | **survival: 3 construction sites finished from one hopper chain** + BA… | real hoppers move items from chests to the crate; sites build to completion in ticks | ~220 s = 27.9% (~est) | KEEP-INGAME | Vanilla hopper item flow, container ticks and the construction site state machine are the real system. The ledger half (delivered == bill) is `ledger-lint` material but only meaningful over real item flow. |
| 19 | survival: 3/3 built sites identical to instant placement | restore box + BE NBT hashes of the construction-built sites equal INSTANT placement | ~37 s = 4.7% (~est) | SMOKE · undo-model | Construction path final state == instant. One site at slice tier. |
| 20 | patron: actorless INSTANT batch places in creative with toggle on; | places; box+7 identical to atomic | ~22 s = 2.8% (measured… | SMOKE · undo-model | Same equality proof as group 4 for a different permission mode; the toggle is Java config (`BatchRulesTest`). Candidate to fold into group 4. |
| 21 | toggle: survival toggled mid-batch | placing item finishes; 3 queued INSTANT items fail NOT_ALLOWED; failed lots unchanged, nothing half-placed | ~35 s = 4.4% (~est; | KEEP-INGAME | Needs a real item mid-placement (`dev.placement.slow`) to prove nothing is half-written. |
| 22 | toggle: cancelBatch mid-item | placed stays, placing + rest fail CANCELLED; the in-flight lot (at 48/1775) is exactly as before | ~25 s = 3.2% (~est) | SMOKE · undo-model | Cancel-rollback exactness = journal rollback of a half-written PLACING entry; same machinery as crash K3. Model: abort at an arbitrary writer cursor then `undo`. |
| 23 | toggle: append | second batch appends a stage; duplicate stage name refuses; another owner refuses; removeGroup takes both batches' sites down exactly | ~21 s = 2.7% (~est) | ALREADY-OFFLINE | Refusal rules are unit-level; exactness is the same journal property. |
| 24 | throughput: BAR 1 / 4 / 10 ms | cells/s and own tick per budget (4 ms row reused from equality) | 17.4 s = 2.2% (measure… | BAR | Already recorded-not-judged in slices. |

#### `c30-ingame`

p50 5.8 min · in 2/12 recent full slices · 1.0 step-min per slice · after all checkers keeps 20% · saves **0.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base world gen + 12 fits | same as 4d group 0 | 53 s = 14.8% (measured… | SMOKE · undo-model | Restore a saved base instead of regenerating. |
| 2 | C30 1: 12 staged batches reach placed in order | 12 runs at budgets 2/4/20 ms, autoApprove vs per-stage approve, 4 stages / 6 sites; every stage PLACING->PLACED in order, batch finishes | ~20 s = 5.6% (the batc… | SMOKE · undo-model | Stage ordering is `StageRulesTest` (unit). In-game adds tick-scheduler timing. Keep one autoApprove and one manual run at slice, all 12 at release. |
| 3 | C30 1: after each run's group removal the lots are exactly as before | `hashLots(6 lots)` after EVERY of the 12 removals (until a drift is seen) | **~215 s = 60%** (12 x… | REPLACE · undo-model | The expensive part of the step, and it is the same journal-exactness proof as 4d groups 3/12. Immediate cheap fix: hash once after run 0 and once after run 11. |
| 4 | C30 2: chicken holds the last stage PLACING | chicken (NoAI) in a district_2 lot: stage stays PLACING, sibling placed, L5 waiting OCCUPIED with message; | ~15 s = 4.2% (~est; | KEEP-INGAME | Real entity in a real box, vanilla entity handling, the game log line. Steward's v0.22.0 "last stage placing for ten minutes" stall: this is the regression guard. |
| 5 | C30 3: wait limit 3 s -> TIMED_OUT / stage PARTIAL | L5 FAILED TIMED_OUT, stage ends PARTIAL, batch finishes | ~8 s = 2.2% (~est) | REPLACE · undo-model | Time-based rule in Java; no vanilla needed beyond the occupying entity, which group 3 already proves. |
| 6 | C30 4: survival stage ordering | next stage starts once the street site is PLACED, not built; the player next to the landmark lot holds it APPROVED with one log line; | ~25 s = 7.0% (~est; | KEEP-INGAME | Real construction site (unbuilt, 0 cells) + real player proximity. Steward's second stall (survival stage start after ten minutes). |
| 7 | setup (runner) | client up/world open/teardown | 17.6 s = 4.9% (step `s… | setup | - |

#### `y2-ingame`

p50 2.7 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 34% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base world gen + 12 lot fits | 12 varied-terrain lots, fits only | 22.5 s = 12.8% (measur… | SMOKE · ledger-lint | Restorable. |
| 2 | C25 waiting: start edge | site with nothing fed starts waiting 100-110 ticks after SITE_PLACED, waitingSince == edge game time | ~12 s = 6.8% (~est; | KEEP-INGAME | Real game time (100 ticks = 5 s min). `SiteWaitTest` covers the state machine; the tick count and event timing need the server clock. |
| 3 | C25 waiting: nextNeeded content | lists items in build order, counts + moreUnits == outstanding bill (315+211=526), each count the whole shortfall | ~4 s = 2.3% (~est) | ALREADY-OFFLINE | `SiteWaitTest` + `FullBomTest`; pure function of plan + stock. Target `ledger-lint`: build order and shortfall counts from the IR. |
| 4 | C25 waiting: stop edge | insert nextNeeded[0]; SITE_WAITING stop fires within 20 ticks of the next placed cell | ~10 s = 5.7% (~est) | KEEP-INGAME | Needs the crate/hopper insert and ticks. |
| 5 | C25 paused / player-blocked never wait | paused site: no event, waiting=false; site with player in the first solid cell (1165/1167 built): never waits, builds after player leaves | ~15 s = 8.5% (~est; | KEEP-INGAME | Real crate screen button (`dev.crate.press`), real player position. |
| 6 | C25 waitingSince across reload | clean stop writes waits.json; after reload still waiting since the same tick, no duplicate start event, B still paused | ~6 s = 3.4% (~est) | KEEP-INGAME | Save/reload persistence. |
| 7 | C26 bomFull on 12 lots | for each of 12 lots: `bomFull` == the placed site's outstanding bill item for item (12/12 exact, needs >= 10) | 7.5 s = 4.3% (measured… | REPLACE · ledger-lint | Compares the verdict's predicted bill with the placed site's bill (`dev.bom.predict`, `dev.site.cells`). Needs the plan + terrain-fit (which cells replace existing blocks, doors over air); |
| 8 | item 14: api-compat vs 0.17.0/0.16.0/0.15.0 apitest jars + 0.17.0 surf… | static constant-pool check | ~80 s = 45% (measured… | ALREADY-OFFLINE | `api-compat.mjs --gate6cy2` is pure node/javap, no game; duplicates the `apijars` step (gate6a apijars) for older jars. Move to the unit tier. |
| 9 | item 14: apitest `apiy2` on the live server | old Verdict constructor kept, trailing components `siteWait bomFull bomExact`, waiting is a default method | ~4 s = 2.3% (~est) | KEEP-INGAME | Real apitest mod classloading; tiny. |

#### `y2-bom`

p50 1.0 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 28% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base world gen + 12 lot fits | as y2-ingame group 0 | ~22.5 s = 37% (measure… | SMOKE · ledger-lint | Restorable. |
| 2 | C26 bomFull on 12 lots | 12 lots placed as construction sites in turn; bomFull == outstanding bill, >= 10/12 bomExact, 12/12 exact in the sampled run | ~7.5 s = 12% (measured… | REPLACE · ledger-lint | See y2-ingame group 6. |

#### `4e-megalite`

p50 1.6 min · in 12/12 recent full slices · 2.5 step-min per slice · after all checkers keeps 80% · saves **0.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | flatBase + pre-hash of the 256x256 box | restore "G4E Flat", hash MEGA_BOX once (h0) | ~12 s = 11% (~est) | KEEP-INGAME | Baseline for group 3. |
| 2 | 256x256 pad + 40 lots + 8 roads placed through the queue (LOAD_BOUNDED… | the LAYER batch at 4 ms with a clean client stop after >= 12 items, then resumes | ~45 s = 40% (4 ms wall… | KEEP-INGAME | Largest real-system write: chunk loading (LOAD_BOUNDED), journal volume, save/reload. 3rd copy of "resume after relog". |
| 3 | one lot's undo leaves the pad exact | remove lot L7: pad owns more cells afterwards, 0 differ from its recorded after; 0.07 s | ~10 s = 9% (~est; | REPLACE · undo-model | Journal layering: removing a top layer exposes the pad's own cells. `JournalPropertyTest`, `RegionJournalTest.invariantIiiForRegionsPadAndLotInEitherOrder`. Model: CELL pad with BOX/CELL entries layered over it. |
| 4 | group undo is exact | `sgremove` restores the 759,824 cells; the 256x256x36 box hash equals h0 (10.9 s) | ~20 s = 18% (~est) | SMOKE · undo-model | Scale test of the real undo through chunks (heap, MSPT, 10.9 s). The exactness half is `undo-model`; the at-scale cost is the point. |
| 5 | BAR: lot undo / group undo own tick | own tick max 0 ms CPU / 7.8 ms | ~0 | BAR | recorded. |
| 6 | 1 ms and 10 ms runs placed everything + BAR cells/s | two more full mega runs (15.6 s, 3.0 s wall) | ~28 s = 25% (~est; | KEEP-INGAME | Timing/throughput variants of group 1; only the budget differs. One at 4 ms already proves the write path. |

#### `4e-orders`

p50 7.1 min · in 8/12 recent full slices · 4.9 step-min per slice · after all checkers keeps 9% · saves **4.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | fixture: LAYER batch places T,R,H,X; union box + 8 inside hash box; | the 4-site layered fixture on the flat base plus a 5th site | ~30 s = 7% (~est) | KEEP-INGAME | Real layered placement into real chunks. The journal-state checks (4 ACTIVE, 0 unreferenced, covers) are `undo-model` (JournalTest). |
| 2 | 24 removal orders: all removed, no leak, box+8 exact | for each permutation of {T,R,H,X}: copy world, remove one by one with `keep`; | ~288 s = 67% (24 x ~12… | REPLACE · undo-model | `JournalPropertyTest` already proves invariants (i)-(iv) over 400 random fixtures including every removal order for <= 4 entries, so this is ALREADY-OFFLINE for the journal. |
| 3 | group removal of all four is exact | `sgremove` of the group; hash equals pre-hash (24,039 cells) | ~14 s = 3.3% (~est) | SMOKE · undo-model | Same as 4d group 3 and megalite group 3. |
| 4 | 6 random orders including L: exact, no leak | seeded shuffles of 5 sites with the cabin layered over a road edge | ~84 s = 19.5% (~est; | REPLACE · undo-model | Same as group 1 with an overlapping layer; `JournalPropertyTest` random overlaps cover it. Keep 1 in game. |

#### `4e-crash`

p50 6.2 min · in 8/12 recent full slices · 4.7 step-min per slice · after all checkers keeps 40% · saves **2.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client start/world base | 20.2 s = 5.5% (measure… | setup | - |
| 2 | K1: kill inside the P3 commit (files written, index not) | JVM halts; no file the index names is lost; restart: journal opens, no site/entry, world unchanged, final full removal == pre-hash | ~35 s = 9.6% (~est) | REPLACE · undo-model | Journal-store crash consistency at a file boundary; `JournalStoreTest` is the base. Model: fault injection at each file write/rename/index write of the commit sequence, then the real startup recovery (orphan GC, PLACING release). |
| 3 | K2: after P3, before the record | PLACING entry released at start, nothing written | ~35 s = 9.6% | REPLACE · undo-model | Same fault-injection harness. |
| 4 | K3: kill during ticked block writes (unclean) | restart rolls the placement back from the PLACING entry; world == before | ~44 s = 12% (~est; | KEEP-INGAME | Real chunk writes interrupted by a real kill, rollback through the journal into real chunks. The representative of "crash mid-write". |
| 5 | K4: after the ACTIVE commit, before the record is placed | journal wins: record placed BUILT, final removal exact | ~35 s = 9.6% | REPLACE · undo-model | Journal-vs-record reconciliation at startup. |
| 6 | K5: before the R2 commit (remove) | all four sites stand, owned cells as before the kill | ~33 s = 9% | REPLACE · undo-model | Remove-commit atomicity. |
| 7 | K6: after R2, before records go pending | H reactivated (record and entries ACTIVE) | ~33 s = 9% | REPLACE · undo-model | Reactivation reverses hand-downs (`JournalTest.reactivation...`). |
| 8 | K7: kill during ticked restore of a group removal | restore re-runs at start; box exact; next start settles the group (0 entries); still exact | ~58 s = 15.8% (~est; | KEEP-INGAME | Real ticked restore interrupted, restarted twice. |
| 9 | K8: kill inside the R2 hand-down commit | hand-down did not half-apply, all entries ACTIVE, half-written generations deleted at start (2 -> 0 orphans) | ~33 s = 9% | REPLACE · undo-model | Generation-file cleanup at start; needs the same fault harness. |
| 10 | K3 clean: clean stop mid-placement resumes from the cursor | placement completes BUILT after restart; final removal exact | ~36 s = 9.8% | KEEP-INGAME | Save/reload resume; the third copy. |

#### `4e-throughput`

p50 1.1 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: client restart + flatBase + G4E VBase build (when missing) | restoring "G4E Flat" and "G4E VBase" | 20.4 s = 35% (measured… | setup | `restartClient: true` is deliberate (cold-JIT control). |
| 2 | one unmeasured warm-up + 3 measured village runs (4 roads, 12 lots, RE… | each: fresh copy, open, queue, place (1.25 s wall), leave | ~37 s = 64% (4 x ~9 s,… | KEEP-INGAME | Throughput of the real write path. |
| 3 | check: runs placed everything | `failed.length === 0` | incl. above | KEEP-INGAME | Real write path. |
| 4 | BAR: own tick max <= 50 ms; BAR: median >= 15,000 cells/s | median of 3 (22,778 / 22,093 / 24,162 in the PT run; target 17k) | incl. above | BAR | Recorded, not judged in slices. |

#### `4e-throughput-smoke`

p50 0.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: client restart + flatBase/VBase restore | as above | ~50% (~est; the sample… | setup | - |
| 2 | one village run: placed everything + BAR own tick | no warm-up, cells/s recorded not judged | ~45% (~est, one ~9 s r… | KEEP-INGAME | The slice-tier representative of "real write path ran at all". |

#### `5b-chains`

p50 30.4 min · in 4/12 recent full slices · 10.0 step-min per slice · after all checkers keeps 27% · saves **7.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | v4 refuses FRAME_CHANGED | `deltaCheck(site,4)` not applicable, reason FRAME_CHANGED, once | <1% ~est | ALREADY-OFFLINE | DeltaPlanner/SitePlanner refusal is a pure plan decision on the version cells. OFFLINE-D plans over random chains incl. frame moves; |
| 2 | each apply v_a->v_b applied (186 ops, "N cells") | apply of any version to any version succeeds and writes Delta' cells over the tavern fixture | ~50% ~est | SMOKE · undo-model | OFFLINE-D proves apply/revert/Remove logic over 150 random chains with every rotation. What it cannot prove: vanilla shape updates and guards on stairs, doors, fences, chests, and real chunk writes (the model "writes exactly the p… |
| 3 | E2 revert-to-v equals world before its apply (29) and every revert app… | hash of 88x50x82 box after a top-delta revert == hash before that apply | ~17% ~est | ALREADY-OFFLINE | OFFLINE-D E2 + OFFLINE-J. The in-game copy is the undo-model fidelity check against real block states and block entities. Same SMOKE subset as row 2. |
| 4 | E3 Remove restores pre-site world (21) | after any chain, `remove` gives the exact h0 hash | ~8% ~est | SMOKE · undo-model | OFFLINE-D E3 (player edits included) + OFFLINE-J (i). Same SMOKE subset. |
| 5 | E1 every one of 273 states equals a fresh placement of that version at… | state hash recorded after each op == hash of `place g5b_tavern_v<n>` at its origin in a fresh world (4 reference placements, 273 comparisons… | ~4% ~est | SMOKE · undo-model | OFFLINE-D E1 ("union box + 8 equals a fresh placement"). The comparisons themselves are free (cache lookups); only 4 placements cost time. |
| 6 | per-script setup: fresh world copy + reopen + `placeAtV1` (5 version i… | not an assertion; 22 x leave/copy/open/tp/place | ~18% ~est | setup | Pure cost of repeating scripts. |
| 7 | step setup | flatBase, kit `delta-fixtures.mjs` build, client start | ~2% ~est | setup |  |

#### `5b-village`

p50 2.0 min · in 4/12 recent full slices · 0.7 step-min per slice · after all checkers keeps 53% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | village base: 12 lots placed as one group | batch queue places 12 INSTANT lots, `ids.length==12` | ~30% ~est | KEEP-INGAME | real batch/placement path; also the base for everything after. Cached in ctx when the world exists, but a slice run rebuilt it. |
| 2 | atomic reference: 12 `deltaApply` | each applied (12 ok lines) | ~12% ~est | ALREADY-OFFLINE | OFFLINE-D; used only to produce hAtomic. |
| 3 | batch at 4 ms equals atomic applies | 12 delta items as stage "upgrade" give the same V_BOX hash as the atomic applies | ~12% ~est | SMOKE · undo-model | "batch scheduling == sequential applies" for 12 disjoint lots is order/budget invariance; one budget (4 ms) in game at slice. Model target: undo-model's batch queue (disjoint boxes) if the batch code can be driven headless. |
| 4 | same at 1 ms and 10 ms | same hash equality at two more budgets | ~20% ~est | SMOKE · undo-model | per-budget copies of group 3. |
| 5 | MSPT bars at 4/1/10 ms (4 ms judged at 25 and 50) | Architect own tick max | ~0% (rides rows 3-4) | BAR | recorded, never blocks. |
| 6 | undoStage("upgrade") reverts all 12 exactly; | hash == hPlaced, then == h0 | ~8% ~est | ALREADY-OFFLINE | OFFLINE-D E2/E3 per site + OFFLINE-J group undo equals tile-by-tile. Stage-undo order over a group of sites is the undo-model's removal-order property. Drop from slices; keep at release. |
| 7 | relog mid-batch (3 of 12 applied) resumes identically | leave world mid-batch, reopen, batch completes, hash == hAtomic | ~9% ~est | KEEP-INGAME | save/reload with a persisted batch; timing dependent (350 ms sleep decides how many are applied). |
| 8 | cancelBatch keeps exactly the applied deltas | cancel after 300 ms, result == same applied set applied atomically in a reference world | ~9% ~est | SMOKE · undo-model | batch state machine plus tick boundary; "no half delta" needs a real tick. |

#### `6a-megaA`

p50 9.1 min · in 5/12 recent full slices · 4.3 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: heap GC baseline, plan, 303M-cell snapshot | `dev.heap.gc`, `dev.region.plan` 6.4 s, `region.hash mode snap` 22 s | 7% (14:44:05-14:44:44) | setup |  |
| 2 | realise PLACED, 0 failed items, 0 chunks generated | 301 tiles + 144 buildings placed, `generatedDuringRealise.terrain == 0` | 55% (14:44:44-14:49:44… | KEEP-INGAME | real write path through the journal into real chunks, chunk loading (1.5-1.6k loads), no-generation rule. |
| 3 | realise throughput, own-tick CPU p99/max, writer starved, liveness 45… | cells/s 51.8k (bar 15k), own tick p99 8.65/max 34.9 ms, starved 0.8%, wait 0.0 s, commit p99 4.6 ms | rides row 2 | BAR | timing bars; recorded. |
| 4 | journal and wire size | journal 0.20 bytes/cell (<=1), index 0.18 MB (<=8), wire 0.210 bytes/cell (<=4) | rides row 2 | KEEP-INGAME | real encoding of real data at scale; these two `check`s are the only non-BAR numbers in the realise phase. A synthetic-plan unit could bound them, but the real number is cheap to read at release. |
| 5 | group undo completes + undo timing/own-tick bar | `dev.region.remove` removed, 164 s (bar 600), own tick p99 7.7 / max 23.5 | ~30% (164 s) | KEEP-INGAME | completion at scale needs the real journal on disk; timing recorded. |
| 6 | E-normal: mismatches <= 0.01% and `classes.none == 0` | 28 mismatches (27 gravity, 1 live) of 9.9M cells vs pre-region snapshot | ~6% (settle 10 s + dif… | KEEP-INGAME | gravity (sand/gravel fall), random-tick growth and mob/bee "live" cells are vanilla behaviour on a natural world; undo exactness itself is the undo-model (see eflat), so this row is the E-normal residual: classes must stay explain… |
| 7 | post-realise world save + copy to `G6A MegaA Realised`, reopen, mob ki… | post-mortem copy | ~2% | setup |  |

#### `6a-megaB`

p50 78.4 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | region PLACED, 0 failed, LOADED_ONLY following the player | 6 stages walked by teleport + dwell, 153 lots | ~91% | KEEP-INGAME | chunk load/unload under player proximity; wall time is dwell sleeps, not compute. |
| 2 | relog mid-lots-2 resumes <= 60 s | stopClient/startClient, player to a waiting item, time to progress | ~1% (+~30 s restart) | KEEP-INGAME | save/reload + resume. |
| 3 | sidecar SIGKILL mid-ways, resume <= 30 s | kill sidecar, 30 s wait, `launcher.restart`, resume time | ~1% (+~65 s) | KEEP-INGAME | process kill + IPC reconnect (RG5 does the same on a small region). |
| 4 | REGION_PROGRESS events for every stage | events seen for 6 stages (16 events) | 0% | SMOKE · undo-model | event emission; could be a state-machine unit. |
| 5 | per-stage seconds and chunks loaded recorded | record only | 0% | BAR | recorded. |

#### `6a-megaB-fast`

p50 17.8 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | region PLACED, 0 failed, LOADED_ONLY following the player | 6 stages | ~88% | KEEP-INGAME | chunk load/unload; ground stage alone is 47% (36 waypoints, 5017 chunks generated). |
| 2 | relog resume <= 60 s | same as megaB | ~3% | KEEP-INGAME |  |
| 3 | sidecar-kill resume <= 30 s | same as megaB | ~6% | KEEP-INGAME | duplicates 6a-crash RG5 at small scale; at slice RG5 is the cheaper proof. |
| 4 | REGION_PROGRESS events per stage | 22 events | 0% | SMOKE · undo-model |  |
| 5 | per-stage record |  | 0% | BAR |  |
| 6 | setup | plan + restore | ~2% | setup |  |

#### `6a-crash`

p50 15.7 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 44% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | uninterrupted reference realises and undoes exactly | PLACED and undoHash == h0; gives `refEnd.hash` for later compares | 9% (85 s) | SMOKE · undo-model | needed as the golden for rows 3-4; realise+undo exactness already ALREADY-OFFLINE (OFFLINE-J `groupUndoEqualsTileByTile`). |
| 2 | RG1: kill during prepare, resume | JVM halts during chunk generation; after restart prepare reaches DONE (256/256), no journal entry | 5% (48 s) | KEEP-INGAME | chunk generation + process death. |
| 3 | RG2, RG3, RG4, K3: kill during realise, restart, resume | region resumes to PLACED, same region hash as uninterrupted, undo exact | 47% (449 s, ~112 s eac… | SMOKE · undo-model | The journal/index state machine at each kill point is the undo-model's crash harness: fault injection at every journal and region-record I/O step (JournalStoreTest does this for the store only), reload from disk bytes, resume, com… |
| 4 | RG5: sidecar killed mid-stream | waiting SIDECAR_UNAVAILABLE while gone; resumes <= 30 s after restart; same hash, undo exact | 11% (110 s) | KEEP-INGAME | sidecar process kill + reconnect; repeated in megaB. |
| 5 | RG6, K7: kill during the region group undo | restart settles, region gone, world hash == h0, 0 regions left | 29% (272 s: RG6 111 +… | SMOKE · undo-model | undo interrupted at journal write points then settled on evidence: same fault-injection harness; must model undo commit order and "restore may be lost by halt". K7 stays in game once per release for the real halt. |

#### `6a-eflat`

p50 8.0 min · in 11/12 recent full slices · 7.8 step-min per slice · after all checkers keeps 71% · saves **2.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: heap baseline, plan, 258M-cell snapshot |  | 7% (33 s) | setup |  |
| 2 | realise the mega plan (not asserted here) | 8.85M cells placed in 4803 ticks; no check on state | 50% (15:00:21-15:04:21… | KEEP-INGAME | only a precondition for the undo; the step never asserts PLACED. |
| 3 | edit setup: find pad cell, place gold block, save, 2 world copies, reo… | `dev.site.verify` on terrain tiles, `/setblock`, copyWorld x2 | ~6% | setup |  |
| 4 | E-flat 0 mismatches after group undo | `region.remove` then `region.hash mode diff` over 258M cells == pre-region snapshot, player block excluded | ~28% (undo ~110-120 s… | SMOKE · undo-model | pure journal exactness: ALREADY-OFFLINE in OFFLINE-J/RegionJournalTest on random fixtures. What only the real run adds: scale (9M entries, index, chunk-spanning sections) and real chunk-level capture of old states incl. |
| 5 | player's block survives group undo and is reported kept | gold block on pad cell still gold_block, `rm.kept >= 1` | ~0% | ALREADY-OFFLINE | OFFLINE-J invariant (iv) "player edit survives that entry's undo" + `PlayerBlocksTest`. |
| 6 | lots-3 stage undo exact on the 39,650 cells its 50 lots own | `sundo2 ... lots-3 keep force` (lots-4 placed after, forced), `dev.undo.check` mismatches 0 | ~3% (15 s incl. | REPLACE · undo-model | removal-order property of OFFLINE-J (any order, subset never writes outside the subset) at stage granularity. Must model the stage = set of entries and the "force over later stage" semantics. |
| 7 | one lot's undo exact on its 567 cells, <= 5 s | `remove <lot>` + `dev.undo.check` 0 mismatches, 0.03 s | ~2% (10 s incl. | REPLACE · undo-model | same as row 6 for one site; the 5 s bar is timing. |

#### `6a-forest`

p50 3.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | find a forest, plan, pre-snapshot | `heights` scans, plan, `region.logs`, snap | ~5% | setup |  |
| 2 | realise ground tiles through trees | 9 tiles, 40k cells | ~31% (63 s, 60 s poll) | KEEP-INGAME |  |
| 3 | no floating log after the realise | `region.logs.floating == 0` (logs 2190 -> 1847) | ~0% | SMOKE · undo-model | connectivity of logs to ground is a cell-graph property, but tree blocks come from worldgen so the virtual world does not carry them; check runs on the realised world. |
| 4 | held leaves on the tiles' leaves entries | 4 leaves entries, 3522 cells, 3508 persistent leaves | ~0% | SMOKE · undo-model | `LeafAndBedTest` covers the hold rule; in-game confirms real tree detection. |
| 5 | undo after a 2-minute stand at randomTickSpeed 3 is exact except class… | 614 mismatches: growth 613, live 1, unexplained 0 | ~64% (stand 120 s + un… | KEEP-INGAME | vanilla random ticks (leaf decay on non-persistent leaves, kelp, cane, crops, grass spread) acting while held leaves and the undo must hold. The undo itself is OFFLINE-J; the stand is the point. Classifier: OFFLINE-R. |

#### `6a-inv3`

p50 1.4 min · in 11/12 recent full slices · 1.5 step-min per slice · after all checkers keeps 75% · saves **0.4 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | realise region_small | 14 tiles, 3 buildings, 14.5k cells | ~72% (60 s poll + rest… | KEEP-INGAME |  |
| 2 | pair selection + gold-block edit | tile c5 covering tile c3 (no lot covers a pad on flat ground; gate6a.mjs:941) | ~2% | setup |  |
| 3 | c3 then c5 == c5 then c3 end state | 4 removes done, region hashes equal (37d104d39df1 both) | ~24% (copy, 2 reopens,… | ALREADY-OFFLINE | OFFLINE-J `RegionJournalTest.invariantIiiForRegionsPadAndLotInEitherOrder` and JournalPropertyTest (iii). The in-game version compares realised-region hashes, not just model values, but the step does not assert realised == virtual… |

#### `6a-staged`

p50 6.3 min · in 11/12 recent full slices · 6.1 step-min per slice · after all checkers keeps 47% · saves **3.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | ground and ways approved one by one, no drift hold on the region's own… | drift outcome "ok: 3072/3072 sampled columns within 2" | ~3% (15:25:14-15:25:20… | SMOKE · undo-model | baseline-selection rule is `DriftStageTest` (built > frozen > plan); the in-game piece is real height sampling of just-built land. Journal/order-pure otherwise. |
| 2 | lots-1 holds after land raised 12 over its lot boxes | waiting DRIFTED "land changed since planning", stage PLANNED, `REGION_STATE` event, nothing written for 10 s | ~4% (15:25:20-15:25:34… | SMOKE · undo-model | drift decision = sampled columns vs baseline (`DriftStageTest`), persistence across save/load = `RegionRecDriftTest`. Residual: event firing and "writes nothing while held" via the real batch gate. |
| 3 | approving lots-1 again continues and places it | drift "continued", stage PLACED, region PLACED | ~18% (60 s poll wait,… | KEEP-INGAME | real stage gate through the batch; most of the time is the poll granularity (see Global finding). |
| 4 | maxWait 30 s: items fail TIMED_OUT with the wait reason; | 17 items TIMED_OUT "waited 30 s for: ... not loaded", region PARTIAL after 92 s | ~27% (15:26:40-15:28:2… | SMOKE · undo-model | NOT_LOADED requires the player far away with `spawn_chunk_radius 0` and LOADED_ONLY (real chunk loading); the timer logic (TIMED_OUT message, PARTIAL) is a fake-clock unit candidate (cf. |
| 5 | control without maxWait still waits after ~102 s | 0 failed, batch RUNNING, NOT_LOADED | ~30% (15:28:27-15:30:1… | REPLACE · undo-model | negative check on elapsed time; needs no real world once NOT_LOADED is shown by row 4. Cutting the sleep to ~10 s loses nothing because the 30 s timer fires within that window in row 4's counterpart. |
| 6 | H0 with lots in any stage order: lots-1 before ways, ground not realis… | after `sreorder`, drift check ran before the second stage; 351 snapshot-box columns all frozen pre-lot (heights 64) vs after-lot 64/69 | ~17% (64 s, 60 s poll) | KEEP-INGAME | "lots freeze their columns before they write" reads the ARSV height shards written by the real placement; order logic could be modelled, the freeze-before-write ordering needs the real write path. |

#### `6a-heap`

p50 5.2 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | baseline heap and -Xmx computation | used heap after GC 637 MB -> `-Xmx3G` | ~5% | BAR |  |
| 2 | client restart with capped heap | start client with `ARCHITECT_XMX=3G` | ~6% | setup |  |
| 3 | mega_bench completes under the cap | region PLACED with forced-GC checkpoints (9.56M cells at 58k cells/s) | ~72% (09:45:17-09:49:2… | KEEP-INGAME | real memory behaviour of the write path under `-Xmx`; heap/GC. |
| 4 | used heap at 5 checkpoints <= baseline + 1 GB | 667-764 MB vs bar 1661 MB | rides row 3 | BAR | recorded; pool peaks 2335 MB. |
| 5 | final client restart on Flat Base |  | ~6% | setup |  |

#### `apijars`

p50 4.5 min · in 12/12 recent full slices · 4.1 step-min per slice · after all checkers keeps 81% · saves **0.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | client start per jar (3) + final restart onto G6A Flat Base | JVM + world open with the old jar in `mods/` | ~48% (27+22+23+20 s) | setup | process start. |
| 2 | API VERSION/features, jobs available | `ArchitectApi.VERSION == 1.36.0`, `features()` against a protocol-2 sidecar | ~1% ~est | ALREADY-OFFLINE | `tools/api-compat.mjs --surface` (static descriptor check) + `ApiIrrTest`/Wire tests; but only the live run proves the old jar still loads (class init, no NoSuchMethodError). |
| 3 | site lifecycle: place (AUTO, owner, ext), refusals PLAYER_IN_BOX/OVERL… | old-jar callers still get the same events, threads and refunds | ~33% ~est | KEEP-INGAME | old-jar API compat on a live server: events fire on the server thread, real placement and feeding. Per-tag, three jars with near-identical script; |
| 4 | survey (64x64, 801x301 at 4, LOAD_BOUNDED) | survey grids, missing chunks | ~2% ~est | KEEP-INGAME | chunk loading (unloaded chunks reported missing). |
| 5 | design request, DESIGN_UPDATED, setExt/setTags, makeVariant, delete | library/design API surface on sim sidecar | ~8% ~est | ALREADY-OFFLINE | surface is covered by api-compat; behaviour by `LibraryMetaTest`, `VariantFormTest`; in-game part is old-jar linkage. |
| 6 | ArchitectClientApi.preview on Render thread + screenshot | client preview call, screenshot saved | ~4% ~est | KEEP-INGAME | needs the client render thread (hostWhy in gate-chains.json). |
| 7 | BAR SITE_PROGRESS at most 1/s | min gap 998 ms, quiet-dependent | 0% | BAR | recorded; old apitest prints it without BAR prefix, driver reclassifies (gate6a.mjs:784). |

#### `sim-jobs`

p50 0.5 min · in 12/12 recent full slices · 0.6 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | structured/agent jobs, cost, JOB_UPDATED sequence, Jobs.list/get | j37/j38 done, cost estimate, 4 update events | ~10% ~est | KEEP-INGAME | API semantics on the server thread through the real sidecar link; sidecar-side logic has its own `jobs.test.ts` tests. |
| 2 | tool handlers: threads (server vs `Architect-ToolWorker`), no handler,… | thread assertions | ~15% ~est | KEEP-INGAME | thread affinity on the live JVM. |
| 3 | pause 15 s + long call 18.5 s past a 10 s timeout | ticks frozen while paused, job completes after unpause | ~45% ~est | KEEP-INGAME | real tick pause; wall-clock sleep dominated. |
| 4 | cancel while tool held, late answer dropped, budget stop | cancelled, `no pending tool call` | ~5% ~est | KEEP-INGAME |  |
| 5 | binary blob 2.5 MB SHA-256 in scratch dir |  | ~5% ~est | KEEP-INGAME | real file IO. |
| 6 | sidecar SIGKILL mid call, restart, cached answer re-sent, in-flight ha… | j44/j45 | ~15% ~est | KEEP-INGAME | process kill + reconnect. |
| 7 | JOB_ events all on the server thread, JOB_DONE once per job | 82 events | ~5% ~est | KEEP-INGAME |  |

#### `sim-sets`

p50 1.1 min · in 12/12 recent full slices · 1.3 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | Bibles request/get/list/estimate, BIBLE_UPDATED order | job b7, 8 updates, estimates | ~8% ~est | KEEP-INGAME | API round trip to the sim sidecar. |
| 2 | Designs.estimate, requestGroup g22 with sidecar kill during wave 1, wa… | g22 done $0.9 | ~30% ~est | KEEP-INGAME | sidecar kill + restart + event ordering; sim cost arithmetic also in sidecar tests. |
| 3 | soft budget pause/extend/resume, usage HELD_USAGE until reset | g23, g24 | ~25% ~est | KEEP-INGAME | reset time is a wall-clock wait (the reset was set ~30 s out). |
| 4 | reskinCollection, makeVariant, open type d100 | entry names, bible versions | ~7% ~est | KEEP-INGAME |  |
| 5 | title-screen completion: results while no world is loaded fire once af… | g25/b8/r8 | ~15% ~est | KEEP-INGAME | world lifecycle (title screen to world open). |
| 6 | world mode toggle and WORLD_MODE_CHANGED at first load (creative/survi… | `Sites.survival()` state | ~15% ~est | KEEP-INGAME | creates 2 fresh worlds. |

#### `sim-massing`

p50 1.1 min · in 12/12 recent full slices · 1.7 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | massing request/redirect/detail/delete, MASSING_DONE once per version,… | d85-d87 | ~20% ~est | KEEP-INGAME | API + sim sidecar + disk. |
| 2 | massingFirst group: GROUP_AWAITING_APPROVAL, sidecar kill while awaiti… | g22/g23 | ~30% ~est | KEEP-INGAME |  |
| 3 | title-screen wait then fire after world load (575 ms) | g24, c.f. sets row 5 | ~8% ~est | KEEP-INGAME |  |
| 4 | composite preview: 5 layers on the Render thread, onlyCells, two keys,… | quad/cell counts, 2 screenshots | ~42% ~est | KEEP-INGAME | client rendering; counts are checks, screenshots are recorded for taste. |

#### `6b-smoke`

p50 1.4 min · in 12/12 recent full slices · 1.6 step-min per slice · after all checkers keeps 95% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | smoke plan | crater_works plan via DevBridge: report 0 errors, previews >= 4 kinds | 8 % (world + plan ~7 s… | SMOKE · structure-lint | the sidecar-sim -> mod plan hand-off with previews; the kit side (report, M-rules) is ALREADY-OFFLINE |
| 2 | smoke realise | prepared plan realised with 8 lots, region PLACED, 175,778 cells | 38 % (30 s, ~95 % poll… | KEEP-INGAME | real mod write path end to end (Regions.realise through the journal into real chunks) |
| 3 | smoke group undo | box hash before == after `Regions.remove` (181,921 cells restored, 3.8 s) | 14 % | KEEP-INGAME | E-flat on the largest everyday plan; the per-case copies elsewhere REPLACE with `undo-model`. This is the instance to keep |
| 4 | checktime bars | mega_bench full-resolution check <= 120 s (11.7 s), plan-with-check <= 30 s + check (19.4 s), 0 errors | 38 % (30 s incl. | BAR | node-side check time on the mega world; the survey of 1M columns from real chunks is Java. `checktime` errors==0 is ALREADY-OFFLINE (mega_bench tile golden, unit-kit) |

#### `6b-ghost`

p50 1.2 min · in 12/12 recent full slices · 1.9 step-min per slice · after all checkers keeps 67% · saves **0.6 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | ghost on, crater | `dev.region.ghost` state: tilesShown 9/16 > 0, cellsShown 897,301 > 0, verdict string, errors [] (flat world, claim 200x200) | 31 % (21 s: plan, ghos… | KEEP-INGAME | client ghost renderer (tiles streamed to the client, frustum/range limits) |
| 2 | ghost on, S1 | same on S1 (format-2 IR, 4/4 tiles, 57,410 cells, camera inside / edge / beyond 64 blocks) | 31 % | SMOKE · structure-lint | second instance of the same client proof over a different IR format; one is enough at slice |
| 3 | screenshots | 6 PNGs (3 views x 2 cases) in artifacts/gate6b/shots6b | included in 1-2 (~4 s… | LOOK → release | not asserted |
| 4 | worlds + plans | fresh world copy + plan per case | 34 % (23 s) | setup |  |

#### `6b-volume`

p50 1.9 min · in 5/12 recent full slices · 0.9 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | warm-up + settle | world copy, chunks generated, warm sample, `settle(90 s)` ("fluids from worldgen settle"), `/gamerule` exact, `settle(5 s)` | 97 % (112 s total step… | setup |  |
| 2 | sampling bar | 2 samples of 256x256x128 (8,388,608 cells) each 0.0-0.1 s, 0 ticks over 50 ms, max slice 3.2 ms | ~1 % | BAR | Survey.volume cost per tick (Java sampler); bench resource |
| 3 | sampler determinism | 2nd sample of the unchanged area gives the same sha | ~1 % | KEEP-INGAME | the sampler against the real world; **intermittent**: failed in IRR 133341 (lava cells 3171 vs 3181 between samples; random_tick 0 does not stop lava flow), passed on rerun 162839 |
| 4 | file round trip | frozen file reads back to the sampler's sha | ~0 % | ALREADY-OFFLINE | Java writer vs node reader of the ARVX format: a fixture file + `kit/test` decode test covers it |
| 5 | class presence | ROCK, AIR, WATER, LOG, LEAVES each > 0 on the cliff-and-cave fixture | ~0 % | SMOKE · structure-lint | Survey classification of real vanilla block states (tags) |
| 6 | cell limit | derived: 60 s at 8.6M cells/s, 64 MB disk, 256 MB heap -> 268M (recorded) | ~0 % | BAR | arithmetic; no assertion |

#### `6b-commands`

p50 2.9 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | chat commands plan/check/preview/prepare | `/architect region plan crater_works ...` creates a plan, check, preview, prepare run from chat | 12 % (20 s) | KEEP-INGAME | Brigadier command layer to sidecar; no offline equivalent |
| 2 | settle | `settle(90 s)` after prepare | 56 % (93 s) | setup |  |
| 3 | `/architect region realise fill` + state | PLACED, 215,843 cells, `state` message | 19 % (30 s poll) | KEEP-INGAME | write path through the command |
| 4 | `/architect region remove` exact | box diff `none == 0` and mismatches <= 0.01 % (15 growth) | 13 % (22 s) | KEEP-INGAME | E-normal under the default rules after the settle; classified-mismatch rule |

#### `6b-nudges`

p50 2.9 min · in 5/12 recent full slices · 1.5 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | PREPARE nudge | realise over ungenerated land (3000,3000): first nudge shows size/time (120 chunks ~30 s), second starts it | 10 % (17 s) | KEEP-INGAME | chunk generation estimate vs real chunk state |
| 2 | MOVE_CLOSER | prepared plan, LOADED_ONLY, player teleported 4000 away; nudge names the walk target, after the walk region ends PLACED | 34 % (56 s; realise 30… | KEEP-INGAME | chunk load/unload (items WAITING until chunks load) |
| 3 | START_SIDECAR | sidecar process killed by PID mid-realise; nudge asks the launcher; region ends PLACED | 28 % (46 s; realise 30… | KEEP-INGAME | crash/kill + restart/resume (helper process) |
| 4 | APPROVE_STAGE | ground + ways approved, lot boxes raised 12 by `/fill`, lots stage DRIFTED, nudge approves, region ends PLACED/PARTIAL | 28 % (47 s; realise 30… | KEEP-INGAME | drift detection over real sampled land + Steward-style stage approval (`apitest sapprove`) |

#### `6b-pathstyle`

p50 0.6 min · in 4/12 recent full slices · 0.2 step-min per slice · after all checkers keeps 67% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | control placement | cabin placed (apitest INSTANT, not a region) beside a 4e road: default approach has dirt_path (9 cells) | 46 % (16 s) | KEEP-INGAME | Sites' default entrance approach |
| 2 | styled placement | with `pathStyle=minecraft:stone_bricks`: 0 dirt_path / cobblestone, 18 stone_bricks | 46 % (16 s) | SMOKE · structure-lint | same code path, one option different |
| 3 | cabin undo exact | box hash equal after `remove site` (both variants) | in 1-2 | KEEP-INGAME | `undo-model` for the logic; hash equality in game is the smoke |

#### `6b-versions`

p50 2.7 min · in 10/12 recent full slices · 2.3 step-min per slice · after all checkers keeps 65% · saves **0.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | versiona reference run | rift_city (format-2 IR with a field blob) realised in a world copy, hash taken | 27 % (43 s; realise 30… | KEEP-INGAME | reference for group 2 |
| 2 | versiona drop run | plan dir + blobs deleted after 3 tiles; realise resumes through `ir_unknown` then `blob_unknown`; same region hash as the reference | 20 % (32 s) | KEEP-INGAME | sidecar loses state mid-realise, resume protocol; hash equality in real chunks |
| 3 | versionb format 3 | newer IR refused PLAN_STALE at accept, at realise start, at resume; nothing written (hashes equal before/after and over 20 s) | 26 % (41 s; 25 s sleep… | SMOKE · structure-lint | refusal reason strings are ALREADY-OFFLINE-capable (mod unit); "no cell written after the doctor" needs a live region |
| 4 | versionb kitVersion 0.99.0 | identical, with a future kit version | 26 % (41 s) | SMOKE · structure-lint | exact same code path as 3; one instance suffices at slice |

#### `6b-versionc`

p50 0.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | build region at current | rift_city realised to the ground stage (format 2), snap taken, world saved mid-realise | ~25 % ~est | KEEP-INGAME |  |
| 2 | old jar opens it | worktree checked out at v0.11.0, sidecar rebuilt, client restarted on a world copy; | ~40 % ~est (client sto… | KEEP-INGAME | old-jar API/format compat on a live server |
| 3 | back at current | restart on the same world: region record survives, one `Regions.remove` exact vs snap (0 mismatches) | ~35 % ~est | KEEP-INGAME | save/reload + record survival |

#### `6b-scenario-s1`

p50 8.0 min · in 11/12 recent full slices · 7.8 step-min per slice · after all checkers keeps 79% · saves **1.7 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | base (23 s stale), 2 world copies, 4 plans each, prepare | 13 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 37 % | setup | flat run's 90 s settles an exact-rules world (nothing ticks) |
| 3 | realise + MSPT BAR | 8 lots + 8 tiles PLACED (47,616 flat / 46,751 natural cells), Architect own tick max 19.2 / 8.3 ms CPU, 25-27k cells/s | 12 % (60 s; real ~4 s) | KEEP-INGAME | mod write path + timing; poll slack |
| 4 | G-PLAN | Checker 0 errors, no M1-M4 | ~0 % | ALREADY-OFFLINE | M-rules on the plan |
| 5 | G-REAL bars | Reachability M2 16/16 nodes incl. lot entrances; Structure M3 floating 0, spurs 0, 7 groups one component each; | 4 % (dumps 2.1 + metri… | REPLACE · structure-lint | closure/floating islands by group, bridge span and bearing, guards on edges, dark-spawnable by light, palette share over written cells. Needs the realised==virtual row (above) to stay equivalent. |
| 6 | Buildings | kit checker over the placed entries (`kit/check.mjs` on `g6a_stub_9` nbt) 0 errors, restraint warnings 0 | in 5 | ALREADY-OFFLINE | pure kit check of a library entry; no world needed |
| 7 | organic read | axis-run share 0.296 (rec) | in 5 | REPLACE · look-lint | recorded only |
| 8 | stand | `settle(120 s)` natural | 25 % | KEEP-INGAME | feeds E-normal only here (no ice rows in S1); growth class 924 cells |
| 9 | G-EX | E-flat 0 (flat run); E-normal 924 growth, unclassified 0, undo's own 0 (cap 5) | 7 % | SMOKE · undo-model | see G-EX |
| 10 | G-DET | 3 plans same IR; tiles 1 = 4 workers; golden "match (every tile sha; IR sha differs by kitVersion 0.12.0 -> 0.39.0)" natural; | in metrics | ALREADY-OFFLINE | golden by replan; the flat run's golden FAIL is ignored by the exit-code rule (scenarios.mjs:868-882, `runBad`) |
| 11 | G-LOOK | 6 before + 6 after screenshots, pending | 2 % | LOOK → release |  |

#### `6b-scenario-s1-flat`

p50 2.8 min · in 12/12 recent full slices · 3.6 step-min per slice · after all checkers keeps 0% · saves **3.6 step-min/slice** · whole step: duplicate: the first half of 6b-scenario-s1


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | base 23 s stale, world copy, 4 plans, prepare | 21 % | setup |  |
| 2 | G-SETTLE | 90 s | 48 % | setup |  |
| 3 | realise + MSPT | same as above flat: 47,616 cells | 16 % | KEEP-INGAME |  |
| 4 | G-PLAN / G-REAL / Buildings / G-DET | same bars as 6b-scenario-s1 groups 4-7, 10, on the flat survey | 4.5 % | DUPLICATE |  |
| 5 | E-flat | box hash diff 0 after `Regions.remove`, 47,616 cells | 9 % | SMOKE · undo-model |  |

#### `6cv-scenario-s7`

p50 7.6 min · in 12/12 recent full slices · 8.0 step-min per slice · after all checkers keeps 81% · saves **1.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | base (23 s stale), 2 world copies (+ fixture bible and 5 kit-built lot entries), 4 plans each | 13 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 38 % | setup |  |
| 3 | realise + MSPT BAR | PLACED, 10 lots (flat 329 cells; natural 3,409 cells), own tick max 24.8 / 14.3 ms CPU | 13 % (real ~3 s) | KEEP-INGAME |  |
| 4 | G-PLAN | 1 Plan report: 0 errors; M1-M4, M2:villager, M22-M24 findings 0 | ~0 % | ALREADY-OFFLINE |  |
| 5 | G-REAL village | 2 Reach player 12/12 nodes, 3 Reach villager (kit mover) 10/10, 6 M22 bell area / golem space, M23 trading hall, M24 farm water, 7 Props bui… | 2 % (dumps ~1 s + metr… | REPLACE · structure-lint | rows 2, 3, 6, 8d, 9: structure-lint on virtual. 7 Props: realised==virtual (cells equal planned states) is exactly the missing generic row. |
| 6 | G-LOTS | 4 Door to street: 10/10 lots walk from the placed site's entrance anchor to the street over role blocks; | in 5 | SMOKE · structure-lint | needs real Sites anchors and the pathStyle approach (6b-pathstyle holds the single-lot proof) |
| 7 | G-NAV | 3b Villager paths (vanilla): 10/10 villager lots `dev.nav.villager` door -> bell, both variants | 0.1 % (0.2 s) | KEEP-INGAME | vanilla villager nav; runs in flat as well as natural |
| 8 | stand | 120 s | 25 % | KEEP-INGAME | E-normal only (growth 685); no ice rows |
| 9 | G-EX | E-flat 0; E-normal 685 growth, unclassified 0, residue 0 | 7 % | SMOKE · undo-model |  |
| 10 | G-DET | IR sha x3, tiles 1 = 4, golden match natural (kit 0.18.0 -> 0.39.0); flat golden differs (non-gating) | ~1 % | ALREADY-OFFLINE |  |
| 11 | G-LOOK | 6 + 6 cameras (+ lamp cam) | 2 % | LOOK → release |  |

#### `6cw-scenario-s7`

p50 7.6 min · in 11/12 recent full slices · 7.1 step-min per slice · after all checkers keeps 0% · saves **7.1 step-min/slice** · whole step: duplicate of 6cv-scenario-s7 (same S7 pair; keep the 1 s lampsoff as a kit test)


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | **identical to 6cv-scenario-s7 rows 1-11** (same scenario, `--phase` o… | all 14 S7 bars incl. W's 8b/8c/8d | G-SET 9 %, G-SETTLE 40… | DUPLICATE | duplicate run of 6cv |
| 2 | lampsoff | kit light over the realised S7 natural dump: all lamps lit -> full M5 0.00 %; apron lamps removed -> 11.75 % (> 1 %, "caught") | 0.2 % (1 s) | REPLACE · look-lint | the only thing 6cw has that 6cv lacks. Needs `dumpLight` + M5 over a dump; it is a broken-variant test of the checker, not of the game. Light model = block-light BFS |

#### `6c-scenario-s2`

p50 8.4 min · in 11/12 recent full slices · 8.5 step-min per slice · after all checkers keeps 79% · saves **1.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | base 23 s, 2 world copies + fixture bible + 3 lot entries, 4 plans each (S2's heavy survey: 4-6 s first plan) | 18 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 35 % | setup |  |
| 3 | realise + MSPT BAR + lots | flat 6,381 cells 8/8 lots; natural 8,739 cells 7/7 lots PLACED (hut_3 unplaced: 7 planned), own tick max 13.5 ms | 12 % | KEEP-INGAME |  |
| 4 | G-PLAN | S2 1 Checker 0 errors no M1-M4 | ~0 % | ALREADY-OFFLINE |  |
| 5 | G-REAL route/structure | S2 2 reach player 9/9 nodes + every route end; Route grade 0 of 218 8-cell windows over maxGrade 0.2 (virtual and realised, re-surveyed); | 2.8 % (dumps 0.7 + met… | REPLACE · structure-lint | grade windows over walk runs, floating / gravity blocks, guards, dark-spawnable. Flat variant gates none of these (`rec`) |
| 6 | G-NAV | S2 3 villager edges: kit mover 6/6, vanilla `dev.nav.villager` both ways 6/6, 0 ladders on villager edges (recorded, not gated: SETTLEMENTS… | 0.02 % | KEEP-INGAME | natural only; flat prints "n/a (flat run)" |
| 7 | stand + melt (M17) | after the 120 s stand: M17 realised 0 of 12,930 ice/snow cells; ice 104,341 -> 104,341, snow layers 4,437 -> 4,437, lost 0; | 23.5 % | KEEP-INGAME | vanilla random-tick melt/freeze near the region's lights; S2 is the one with real ice (also F1, F2). Plan-side M17 is ALREADY-OFFLINE |
| 8 | kept natural spikes | ARWD before/after realise: 0 of 74,661 kept cells changed | in 5 | REPLACE · structure-lint | write path respects `keep` sets: realised==virtual over keep cells |
| 9 | G-EX | E-flat 0; E-normal 66 = 64 growth + 2 gravity, unclassified 0 | 6.7 % | SMOKE · undo-model |  |
| 10 | G-DET | IR x3, tiles 1 = 4, golden by replan of committed inputs ("this run's live survey differs in 36,063 columns") | ~1 % | ALREADY-OFFLINE | the live survey changes between world copies; the golden is replanned offline |
| 11 | BAR tile eval | S2 12 p99 1.0 ms, 3.4M cells/s | in metrics | BAR | node timing, offline |
| 12 | G-LOOK | 6 + 6 cameras | 1.9 % | LOOK → release | flat run takes no shots and may run headless |

#### `6cf1-scenario-forms`

p50 8.0 min · in 3/12 recent full slices · 2.1 step-min per slice · after all checkers keeps 78% · saves **0.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | 2 world copies, plans (frozen `/tick freeze` around the 3-plan IR check), prepare | 13.5 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 36.7 % | setup |  |
| 3 | realise + MSPT + own CPU | 6/6 tiles PLACED (flat 14,166 / natural 13,830 cells), tick max 9.0 ms | 12.2 % | KEEP-INGAME |  |
| 4 | G-PLAN | Checker (plan): 0 errors, M1 kept-cells 0, M3 0, M17 0 | ~0 % | ALREADY-OFFLINE |  |
| 5 | G-REAL structure | Structure (item 2): realised floating 0, spurs 0, overhangs over 4 = 0 over form cells | 2.6 % | REPLACE · structure-lint | overhang > 4 without buttress on form voxels |
| 6 | voxels | spire_1: realised cells 1,826/1,826 equal the baked ARVX blob, 0 differ, 0 outside | in 5 | REPLACE · structure-lint | this *is* the realised == baked-blob row for forms; keep as the realised==virtual instance in a generic row |
| 7 | kept natural cells | 0 of 74,661 kept cells changed (ARWD before/after) | in 5 | REPLACE · structure-lint |  |
| 8 | stand + melt (M17) | realised-after-stand M17 0 of 14,214 ice/snow; ice 10,847 -> 10,847, snow 5,723 -> 5,723, lost within lights' reach 0 | 24.6 % (120 s + dump) | KEEP-INGAME | random-tick melt/freeze; duplicate of S2's with a different generator |
| 9 | G-EX | E-flat 0, E-normal 58 growth, unclassified 0 | 6.5 % | SMOKE · structure-lint |  |
| 10 | G-DET | IR x3, tiles 1 = 4, golden match natural (flat golden differs, non-gating) | 1 % | ALREADY-OFFLINE |  |
| 11 | BAR tile eval + Own CPU p99 | recorded | in metrics | BAR |  |
| 12 | cameras | shots taken though "Gallery: not asked for F1" | 3.2 % | LOOK → release | 10.5 s before-shots in the natural run |

#### `6ct1-scenario-relief`

p50 7.6 min · in 9/12 recent full slices · 5.7 step-min per slice · after all checkers keeps 81% · saves **1.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | 2 world copies, plans frozen for the IR check (`/tick freeze`), prepare | 8.4 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 40.2 % | setup |  |
| 3 | realise + MSPT | flat 72,369 cells, **PARTIAL** (lot `failed:LOT_TOO_SMALL`, 1 of 3), natural 6,694 cells PLACED 3/3 lots; own tick max 6.2-6.5 ms | 13.4 % | KEEP-INGAME | the flat run's PARTIAL is expected and the step passes |
| 4 | G-PLAN | T1 10 Checker 0 errors no M1-M4 | ~0 % | ALREADY-OFFLINE |  |
| 5 | G-REAL relief | T1 1 Blend smoothness virtual and realised (98.6 % of steps <= 1, 0 over 3); T1 2 pads at target 0 of 616 off (virtual + realised); | 2.2 % (dumps 0.7 + met… | REPLACE · structure-lint | slope between adjacent surface columns, pad elevation, cut/fill limits; realised side re-surveys dump tops (excluding columns another writer topped, 13 left out) |
| 6 | G-EX | E-flat 0, E-normal 95 (94 growth + 1 live), unclassified 0 | 7.2 % | SMOKE · undo-model |  |
| 7 | G-DET | IR x3, tiles, golden by replan ("live survey differs in 1,701 columns") | 1 % | ALREADY-OFFLINE | S3's flowing water moves the survey between world copies (scenarios.mjs:307,493) |
| 8 | stand | 120 s | 26.8 % | KEEP-INGAME | E-normal only |
| 9 | BAR tile eval | T1 7 p99 0.7 ms, 10.8M cells/s | in metrics | BAR |  |
| 10 | cameras | 6 + 6 shots | 1.8 % | LOOK → release |  |

#### `6ct2-scenario-route`

p50 8.4 min · in 5/12 recent full slices · 3.5 step-min per slice · after all checkers keeps 78% · saves **0.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | base 23 s, 2 world copies, plans frozen for the check, prepare, owner protect via apitest | 16 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 35 % | setup |  |
| 3 | realise + MSPT | flat 996,983 cells (hill raised on a flat survey; real placement ~12 s, 81k cells/s), natural 5,156 cells; own tick max 20.4 / 7.5 ms | 11.7 % | KEEP-INGAME | the 997k-cell flat run is the heaviest write in the block |
| 4 | G-PLAN + offline replans | T2 9 Checker 0 errors no M1-M4 hairpins 0; T2 5 keep-out: route length vs the unconstrained plan; | ~1 % (4 node-side repl… | ALREADY-OFFLINE | pure planner re-plans (`planRegion` in scenario-route.mjs:78-90); a kit test |
| 5 | G-REAL route | T2 1 grade every 8-cell window virtual and realised re-surveyed (0 of 118 over); T2 3 player reaches both ends of 3/3 edges; | 1.5 % + flat dump/remo… | REPLACE · structure-lint | grade windows and walkability on route cells; realised==virtual |
| 6 | G-NAV | T2 4 vanilla `dev.nav.villager` along every villager edge both ways, 2/2 (natural only) | 0.01 % | KEEP-INGAME |  |
| 7 | keep-out in game | `apitest protect` a rect, then ARWD diff: 0 cells written in [[3682,-982,3698,-979]] | in 5 | SMOKE · structure-lint | the owner-protection path (Steward-style API) + the write path honouring `keepOut`. The IR carries the rect (`ir.keepOut`), so the plan side is offline |
| 8 | stand | 120 s | 23.5 % | KEEP-INGAME | E-normal only (302 growth + 2 live) |
| 9 | G-EX | E-flat 0, E-normal 304, unclassified 0 | 8.4 % (flat remove 11.… | SMOKE · structure-lint |  |
| 10 | G-DET + BAR tile | IR x3, golden by replan (live survey differs in 1,650 columns), T2 11 p99 0.5 ms | 1 % | ALREADY-OFFLINE |  |
| 11 | cameras | shots | 1.6 % | LOOK → release |  |

#### `6cd-scenario-districts`

p50 8.8 min · in 11/12 recent full slices · 8.9 step-min per slice · after all checkers keeps 77% · saves **2.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | G-SET | 2 world copies, plans (natural: first plan 9.7 s, x4), prepare, `/tick freeze` | 15.5 % | setup |  |
| 2 | G-SETTLE | 2 x 90 s | 35.9 % | setup |  |
| 3 | realise + MSPT | flat 316 cells (lots "pad","pad","placed" x4), natural 4,050 cells; own tick max 18.6 / 7.9 ms | 12 % | KEEP-INGAME |  |
| 4 | G-PLAN / bands / loop | D checker (0 errors, no M1 M2 M4; M5 over routes 100 % flat / 0.62 % natural); | ~1 % | ALREADY-OFFLINE | district placement and graph cost are plan meta; `kit/regions/districts*` tests |
| 5 | G-REAL connect | D 3 one graph (26 nodes, 1 component), edges routed 2/2, realised player 2/2 and kit villager reach 2/2 along every edge | 6 % (dumps 1.3 + metri… | REPLACE · structure-lint |  |
| 6 | G-NAV | D 3 vanilla `dev.nav.villager` both ways along every edge 2/2 (natural only) | 0 % | KEEP-INGAME |  |
| 7 | stand | 120 s | 24 % | KEEP-INGAME | E-normal only (103 growth + 2 live) |
| 8 | G-EX | E-flat 0, E-normal 105, residue 0 | 6.6 % | SMOKE · structure-lint |  |
| 9 | G-DET + BAR | golden by replan (live survey differs in 1,664 columns), D 11 tile p99 0.4 ms | in 5 | ALREADY-OFFLINE |  |

#### `6cf2-scenario-scatter`

p50 12.7 min · in 8/12 recent full slices · 9.2 step-min per slice · after all checkers keeps 89% · saves **1.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | harvest | 72 vanilla feature stamps (9 features x 8 seeds) placed in a flat scratch world, re-harvested, byte-identical (72 of 72), none touch the cap… | 1.1 % (8 s) | KEEP-INGAME | vanilla ConfiguredFeature placement per seed (trees, mushrooms, dripstone) is the input; BAR 1 s |
| 2 | G-SET | 3 world copies, 4 plans each, prepare, stamp library | 9.7 % | setup |  |
| 3 | G-SETTLE | 3 x 90 s | 35.8 % | setup |  |
| 4 | realise + MSPT | flat 7,065 / natural 1,399 / cave 2,863 cells PLACED; own tick max 28.6 / 16.9 / 5.1 ms CPU (recorded) | 11.9 % | KEEP-INGAME |  |
| 5 | G-PLAN | Checker (plan) 0 errors, M3 0, M17 0 | ~0 % | ALREADY-OFFLINE |  |
| 6 | supports (G-REAL) | 0 floating cells in scatter/stamp parts; plants on `#supports_vegetation` soil 0 of 508 / 13 wrong; | 1.5 % (dumps 1.1 + met… | REPLACE · structure-lint | vegetation soil tag table pinned to the vanilla version, floating-by-support, exclusion zones |
| 7 | stamps + placements as planned | stamps realised exactly (stamp_oak_1 62/62 etc., 0 differ); "Scatter as planned" 6,418/6,418 (flat), 489/491 natural (2 ferns -> air, record… | in 6 | REPLACE · structure-lint | recorded `rec`; this is the realised==virtual row for scatter. The 2 differing cells are the world's own plant breaking |
| 8 | stand + melt | natural: snow layers 6,157 -> 6,157, lost within a light's reach 0; M17 0 of 14,579 | 32 % (2 stands: demo a… | KEEP-INGAME | random-tick melt/freeze. The cave run has no ice (0 of 0 cells), so its stand feeds E-normal only |
| 9 | G-EX | flat E-flat 0; natural E-normal 75 (72 growth, 2 gravity, 1 freeze); cave E-normal 242 (165 growth, 75 distant, 2 amethyst), unclassified 0 | 6.6 % | SMOKE · structure-lint | cave is the source of the `distant` and `amethyst` classes (lava settling, budding amethyst) |
| 10 | G-DET + tile independence | IR x3, tiles 1 = 4 forward and shuffled, golden = stamps-off committed inputs replanned | in 6 | ALREADY-OFFLINE | cave has no golden |

#### `0a-stub`

p50 0.2 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 25% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | packed jar carries the helper | BUNDLE.json modVersion, extracted with no node_modules, helper runs sim with no Agent SDK | ~25% ~est | KEEP-INGAME | only check that the released jar's bundled helper starts; cheap, no Minecraft; keep as is |
| 2 | job.run scripted card / schema mismatch fails | scripted answer returned; non-matching card fails at once | ~5% | ALREADY-OFFLINE | sidecar/test/jobs.test.ts, simcosts.test.ts |
| 3 | bible + massingFirst group flow at the protocol | awaiting approval at 3.7 s, owner-only approve refused, redirect round 2, helper restart while awaiting re-reads unchanged, details done, co… | ~55% (9.6 s of 15) | ALREADY-OFFLINE | bundle.e2e.test.ts "massingFirst group with owner approval across a SIGKILL", slice0a.test.ts C7, simcosts.test.ts. Same run on the packed bundle, not a different property |
| 4 | sim modes | sim:fail fails; sim:repair one repair round + cost; sim:usage_limit HELD_USAGE then finish | ~15% | ALREADY-OFFLINE | sidecar sim tests (jobs/limits/simcosts) |

#### `0a-flow`

p50 2.1 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 60% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: client + world | client up at +39 s | ~31% | setup | `client: self` boot |
| 2 | API version + last Reasons, estimate(EstimateRequest) lines sum | ArchitectApi.VERSION, byKind totals | ~3% | ALREADY-OFFLINE | estimates-0a.test.ts, ApiRulesTest, Wire0bTest |
| 3 | bible, massingFirst: GROUP_AWAITING_APPROVAL once per round, redirect… | events fire once per massing round (1, then 2 after redirect) | ~14% ~est | SMOKE · structure-lint | event delivery mod<-sidecar is the protocol; sidecar half in slice0a.test.ts/groups.test.ts. One group is enough |
| 4 | client restart while awaiting approval | group re-read AWAITING_APPROVAL, seq 18 = 18, nothing re-fires | ~33% (client down + up… | KEEP-INGAME | real mod<->sidecar reconnect across a client JVM restart; the "no re-fire" property lives in the mod's snapshot diffing |
| 5 | details done, GROUP_UPDATED seq strictly increasing, C7 stage lines/co… | accounting over the wire | ~8% | ALREADY-OFFLINE | slice0a.test.ts "C7: seq strictly increases...; breakdown lines sum", breakdown-copy.test.ts, estimates-0a.test.ts |
| 6 | batch of the 3 details DONE, 3 placed; | real placement + group undo | ~11% | SMOKE · undo-model | needs real Sites placement; exact removal -> undo-model (JournalPropertyTest already fuzzes site undo) |

#### `0a-budget`

p50 1.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up at +89 s in one run (p50 total 77) | ~85% | setup | `client: self` |
| 2 | $5 soft budget: group PAUSED_BUDGET at $4.91 (80%) | sidecar budget gate | ~5% | ALREADY-OFFLINE | sidecar limits.test.ts / groups.test.ts / simcosts.test.ts |
| 3 | extend + resume in flight: no re-sent awaiting/paused events, seq stri… | event dedup | ~5% | ALREADY-OFFLINE | slice0a.test.ts C7 seq rule |
| 4 | extended to $20, group ends DONE at $7.18 | resume path | ~5% | ALREADY-OFFLINE | same |

#### `0a-fit`

p50 0.5 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up at +26 s | ~87% | setup |  |
| 2 | fitMassingToLot == fitToLot, 4 orientations (north/east/south/west) | same rotation, dx = dz =0, same y | ~10% | ALREADY-OFFLINE | mod batch/MirrorFitTest + MassingPredictionTest + sidecar sim-fit.test.ts. Pure function of box + rotation, no vanilla. Y alignment uses a surveyed ground; that part is `structure-lint` territory |
| 3 | unknown massing -> UNKNOWN_BLUEPRINT | refusal | ~3% | ALREADY-OFFLINE | ApiRulesTest |

#### `0a-batches`

p50 3.1 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: client + world, plus batch b1 placed | client up +74 s | ~36% | setup |  |
| 2 | clean stop + load: finished batch still DONE, BATCH_DONE does not re-f… | persistence across save/reload | ~34% (second client up… | KEEP-INGAME | save/reload of the batch record (mod persistence + event replay) |
| 3 | `dev.batch.skipSave` + client JVM SIGKILL: BATCH_DONE fires once on lo… | crash durability of a completed batch not saved | ~30% (SIGKILL at +153… | KEEP-INGAME | crash/kill + restart; write-ahead of batch completion vs world save. Not modellable without the real save path |
| 4 | batch ids never reused: b1,b2,b3 | persisted b<n> counter | ~1% | KEEP-INGAME | BatchKeysTest covers key rules, not persistence across kill |

#### `0a-keys`

p50 2.6 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 92% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up at +90 s | ~57% | setup |  |
| 2 | dropAck then client SIGKILL, restart: jobByKey/groupByKey/batchByKey a… | opKey adoption across a client crash with an unacked request | ~39% (restart +55 s) | KEEP-INGAME | the real ack-drop + kill + restart protocol (mod pending-request journal + sidecar on-disk record). Sidecar half is in slice0a.test.ts C9 |
| 3 | same key+body returns same ids, counts unchanged, different body -> OP… | key semantics | ~2% | ALREADY-OFFLINE | slice0a.test.ts C9, BatchKeysTest |
| 4 | helper down -> SIDECAR_UNAVAILABLE for lookups and cancelJob | error mapping | ~2% | SMOKE · structure-lint | trivial; ApiRulesTest-able, but needs the real launcher state; one check on any restart client |

#### `0a-cancel`

p50 0.8 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 29% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up at +41 s | ~84% | setup |  |
| 2 | cancelJob completes CANCELLED, BIBLE_DONE once |  | ~10% | SMOKE · structure-lint | slice0a.test.ts "bible.cancel acks with the job, cancelled"; mod-side future completion only in game |
| 3 | second cancel fails "already cancelled" |  | ~6% | ALREADY-OFFLINE | same test |

#### `0a-pins`

p50 1.1 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up at +39 s | ~59% | setup |  |
| 2 | pinOwners, VERSION_GONE for unknown version | API wiring | ~5% | ALREADY-OFFLINE | versions.test.ts (entry.pins persisted), ApiRulesTest |
| 3 | three forced-age GCs (helper SIGKILL, edit blueprint.json createdAt, r… | pins hold against GC at helper start | ~36% ~est (3 x ~8 s) | ALREADY-OFFLINE | versions.test.ts "GC: pins always win; 30 days; over 32 the oldest go". The helper-restart-runs-GC wiring is the only in-game residue (SMOKE) |

#### `0a-stopped`

p50 0.8 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | world copy + client up at +36 s | ~78% | setup |  |
| 2 | unacked requestGroup fails WORLD_STOPPED | pending future failed at world leave | ~7% | KEEP-INGAME | real world stop (leave world) with real pending futures |
| 3 | every pending future (volume, removeGroup, regionRemove, group) fails… | futures registry drained on stop | ~9% | KEEP-INGAME | needs a long Sites/Regions future in flight when the server stops; ApiP0Test only rules-checks the reason |
| 4 | after next load the group is found by key | groupByKey across reopen | ~6% | KEEP-INGAME | persistence across reload |

#### `0a-tiles`

p50 6.7 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 10% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: three world copies + three client starts | client up +42 s each | ~31% ~est | setup |  |
| 2 | unhooked run PLACED (baseline sha) | small region realise, 4 lots | ~3% | SMOKE · structure-lint |  |
| 3 | SLOW_TILES=4: PLACED with the baseline sha; TILE_SLOW shown; | helper slow tiles retried at 30/60/120 s; same final world | ~54% (client up 13:15… | REPLACE · undo-model | `TileStreamSlowTest` proves the 30/60/120/300 s schedule, WAITING state, RETRY. The "same sha after delayed tiles" is a property of the writer with permuted tile arrival; |
| 4 | SLOW_TILES=2: passes inside the helper's retries (no TILE_SLOW) |  | ~12% | ALREADY-OFFLINE | TileStreamSlowTest (error count below the threshold) |

#### `0b-ingame`

p50 1.0 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 27% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup | client up ~78 s in the SCH log (p50 total 62) | ~55% ~est | setup | `client: self` |
| 2 | item 5 estimate has ORIGINAL/SMALL/COPY lines; |  | ~3% | ALREADY-OFFLINE | 0b-unit: breakdown-copy.test.ts, copies.test.ts, estimates-0a.test.ts, Wire0bTest |
| 3 | item 5: massingFirst group with x3 item + SMALL: expansion house, hous… | expansion + ordering + stage COPY | ~7% | ALREADY-OFFLINE | copies.test.ts / 0b-unit |
| 4 | item 5: batch of 4 queued, DONE, each copy its own site; | real placement + selective undo | ~15% | SMOKE · undo-model | write path is real; undo exactness of one overlapping/adjacent copy fits undo-model (JournalPropertyTest family) |
| 5 | item 7 versionOf with a site: entry placed, 3 player edits, versionOf… | version bump + outdated detection | ~7% | SMOKE · structure-lint | sidecar half versionof.test.ts, versions.test.ts |
| 6 | item 7: checkDelta reports 3 kept cells; | delta over a player-edited site | ~10% | SMOKE · undo-model | delta apply with player edits then undo is a journal property (edits kept, undo order exact). Predicted 47 changed cells (log 18:05:37) is the kit delta: offline |
| 7 | item 7 refusals: bundled/unknown/COPY/site_mismatch/busy/base_moved | VERSION_REFUSED reasons | ~3% | ALREADY-OFFLINE | versionof.test.ts, Wire0bTest, ApiRulesTest |

#### `sch-roundtrip`

p50 0.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 55% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | every kit example (cabin, gatehouse, tavern, tower) exported twice byt… | export determinism, each 18-280 ms | ~10% ~est | ALREADY-OFFLINE | sch-unit: SchematicTest export goldens + kit codec tests; this is `determinism`. The in-game copy proves the same Java exporter on the live jar |
| 2 | kit reads the mod's v3 export (Offset y -1, N cells as the example) | cross-implementation parse | ~5% | ALREADY-OFFLINE | sch-unit kit codec tests + SchematicTest |
| 3 | import through the API: same cells, groundY, tags, ext (0.9-1.9 s each… | export -> import roundtrip | ~30% | SMOKE · structure-lint | one kind is enough in game (needs real Library install + sidecar import job); the roundtrip equality is in SchematicTest. Keep one entry at slice tier, all four at release |
| 4 | user entry re-exported a second apart byte-identical; |  | ~10% | ALREADY-OFFLINE | SchematicTest / ApiSchTest |
| 5 | Linux: node:22 and eclipse-temurin:25 amd64 (OrbStack): kit goldens +… | cross-platform byte identity | ~45% ~est | KEEP-INGAME | CI runs Linux already (AGENTS.md "Byte-compared outputs must be platform-independent"); this is a duplicate of CI for the gzip OS byte. Candidate for release-only |

#### `sch-refusals`

p50 0.0 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 8% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | unknown block / oversize / corrupt / non-schematic refused FORMAT/TOO_… | import refusals | ~50% | ALREADY-OFFLINE | sch-unit SchematicTest + sidecar import-schem test |
| 2 | nothing installed (100 entries before/after), nothing left in schem-st… | failure cleanup in the real library dir | ~25% | SMOKE · structure-lint | real filesystem side effects; tiny |
| 3 | exportSchematic/exportSiteSchematic refusals; unknownAs substitutes |  | ~25% | ALREADY-OFFLINE | ApiSchTest |

#### `sch-placement`

p50 0.2 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 33% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | imported v3 hut and old-DataVersion .schem place; | placement == template | ~45% ~est | SMOKE · structure-lint | real Sites placement of an imported entry; `structure-lint`-like equality is the verify call |
| 2 | box changed on place; remove-exact: box hash after removal == before (… | undo exactness | ~45% ~est | SMOKE · undo-model | E-flat for a single site; undo-model covers general exactness |
| 3 | import steps (2 imports) |  | ~10% | SMOKE · structure-lint |  |

#### `sch-ingame`

p50 1.6 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 10% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | versions: v2/v3/DataVersion-2586 fixtures import, same 96 cells, entit… |  | ~7% ~est | ALREADY-OFFLINE | SchematicTest fixers; ApiSchTest |
| 2 | sites: edited cabin site exportSiteSchematic == its current 1584 cells… | live world read vs file | ~8% | SMOKE · structure-lint | reads real world cells; `dev.box.hash` compare; one site is enough |
| 3 | ui: Library Export .schem, /architect export, Import… pick + list, /ar… | dev-bridge hooks (`dev.library.export.schem`, `import.pick`) and commands; no rendering | ~7% | KEEP-INGAME | UI entry points; hooks, not pixels; Phase4bUiRulesTest covers rules only |
| 4 | apitest apisch + api-compat --gate6csch (0.20.0/0.19.0/0.18.0 jars + s… | API surface | ~78% ~est (~75 s) | ALREADY-OFFLINE | api-compat is class-file only (see top); apijars + sch-unit/Api tests cover it. Biggest cost of the step |

#### `mp-ingame`

p50 9.5 min · in 3/12 recent full slices · 2.5 step-min per slice · after all checkers keeps 18% · saves **2.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | api-compat vs 0.18/0.17/0.16 jars + 0.18 surface | binary compat | ~14% (77 s) | ALREADY-OFFLINE | class-file diff, no MC; mp-unit/apijars |
| 2 | apitest apimp: Mask/Pattern parse via public API, FIELD_LIMIT with pat… |  | ~0% (1 s) | SMOKE · structure-lint | ApiMPTest covers it offline |
| 3 | prepare + 4 plans (IR sha x3 identical, budget) per variant | determinism of IR over 3 plans; tiles 1 vs 4 workers identical; golden match | flat: ~30 s plan + ~96… | REPLACE · determinism | IR sha x3, 1 vs 4 workers and the golden are existing byte-identity checks (mp-unit "toolbox demo's tiles 1 vs 4 workers and its kit golden", plan-p0 goldens). |
| 4 | realise both PLACED (30 s each); MSPT / cells/s BARs | write path of a 266k / 228k cell crater plan | ~11% (2 x 30 s + queue… | KEEP-INGAME | MSPT is recorded-not-judged; the realise itself is the real mod write path |
| 5 | post-realise analysis of the realised ARWD dump: Checker M1-M4, reacha… | M-rules re-run on the realised world | flat ~24 s, natural ~1… | ALREADY-OFFLINE | kit/lib/region/check*.mjs M1-M27 over the virtual world; running them on the realised dump also proves realised==virtual, so it is NOT a pure duplicate: the survivors are item 5's E-flat and the realised dump |
| 6 | exactness: E-flat 0 over 266089 written cells (flat); | undo restores world; natural remainders are vanilla growth | in the 145 s above | KEEP-INGAME | E-flat is exact on a flat world: undo-model over the real journal. E-normal needs random ticks (growth) and the classifier; keep one natural run |
| 7 | judge: "runs are of this head" | flat run head differs from natural (`flat 76530c7eb3, natural 3670d60f14`) -> FAIL | 0 | setup | see notes |

#### `x-ingame`

p50 7.0 min · in 8/12 recent full slices · 4.5 step-min per slice · after all checkers keeps 45% · saves **2.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | world check (+20 s rebuild when stale) | ~5% | setup |  |
| 2 | lotext: 4096 ok, 4097/non-object/no-namespace ext refuse FIELD_LIMIT w… | validation | ~3% | ALREADY-OFFLINE | x-unit: kit C19 tests, FieldLimitsTest |
| 3 | lotext: realise places every lot (10 lots PLACED, 30 s); | plan -> site ext mapping | ~10% | SMOKE · determinism | write path realise real; ext mapping is `determinism`-able from the plan (x-unit "plan to LotSpec") |
| 4 | lotext: save and reload leaves every site ext byte equal | persistence | ~3% | KEEP-INGAME | real save/reload of site records |
| 5 | lotext: undo (Regions.remove) removes lot sites; | undo/redo cycle | ~12% | SMOKE · undo-model | removal order and re-realise exactness are journal/model properties |
| 6 | keys: plan keys: same key+body = same plan; | key semantics | ~3% | ALREADY-OFFLINE | mod RegionKeysTest, sidecar slice0a/regions tests (opKey canonical body) |
| 7 | keys: realise held future pending, then **world stop -> WORLD_STOPPED*… | durable restart of the keyed realise | ~4% | KEEP-INGAME | world stop + reload with a pending future (sidecar<->mod protocol on a live server, write path interrupted) |
| 8 | keys: the interrupted realise resumes and completes (30 s); | resume + key lifecycle | ~19% | KEEP-INGAME | the resume across a reload is the real thing; key bookkeeping is RegionKeysTest-able |
| 9 | removal (a): injected restore failure mid-removal -> removed=false, re… | C22 | ~14% (incl. 30 s reali… | REPLACE · undo-model | failure injection at each journal step then retry, assert E-flat 0 and the PARTIAL/REMOVED state machine; a model with injected failure is stronger than one hit |
| 10 | removal (b): remove twice, tombstones with `removedAt`, survive save+r… | C22 tombstone | ~13% | KEEP-INGAME | the tombstone's persistence needs one real reload |
| 11 | api-compat vs 0.16/0.15/0.14 jars + apitest api114 |  | ~22% (80 s) | ALREADY-OFFLINE | apijars + x-unit; api-compat is class-file only |

#### `x-resume`

p50 5.8 min · in 6/12 recent full slices · 3.0 step-min per slice · after all checkers keeps 43% · saves **1.7 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | removal stopped mid-way (world left and reopened under slow writes): a… | C23 core resume | ~19% (62 s) | KEEP-INGAME | resume = replay the persisted removal record to completion. Model: build -> remove with crash at write k -> reload (drop in-memory) -> resume -> assert E-flat 0, state REMOVED, time equals group's. |
| 2 | restore failure injected after the reload: PARTIAL never REMOVING, gro… |  | ~17% (58 s) | setup | failure injection after resume: model with fault injection at every step; exact hash equality is checkable on a journal model |
| 3 | two restarts mid-removal: REMOVING both times, ends REMOVED, hash equa… | double resume | ~21% (70 s) | setup | multi-crash orders are exactly what a fuzz of crash points covers; two real restarts cost 14 s each |
| 4 | another requester's removeGroup of the REMOVING region's group refused… |  | ~13% (45 s) | ALREADY-OFFLINE | pure ownership rule on a state; ApiRulesTest-style |
| 5 | world-start reconcile: simulated stop leaves region REMOVING with grou… | reconcile table | ~11% (37 s) | REPLACE · undo-model | the reconcile is a function of (region state, group state): table test over all combos |
| 6 | group ACTIVE after failure -> reconcile ends it PARTIAL; |  | (in f1/f2 block) | REPLACE · undo-model | same table |
| 7 | plain site group (Sites.removeGroup) batch of 3 DONE; | same for site groups | ~7% (24 s) | SMOKE · undo-model | the site group version uses the Journal; JournalPropertyTest/StillOursFluidsTest are the base |
| 8 | base | ~1 s; first case needs world start | ~1% | setup |  |

#### `p0-ingame`

p50 2.6 min · in 10/12 recent full slices · 2.3 step-min per slice · after all checkers keeps 61% · saves **0.9 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | crafted plan checked 3x: READY, one artifact sha, one IR sha; | check determinism + shapes | 16:01:21 -> 16:01:33 ~… | ALREADY-OFFLINE | p0-unit: valid/malformed fixtures, determinism with 1 and 4 workers, catalogue goldens, 59 Steward plans |
| 2 | keys: in-flight twin shares, same key returns same, other body OP_KEY_… |  | ~3% | ALREADY-OFFLINE | RegionKeysTest, ApiP0Test, sidecar plan-check.test.ts |
| 3 | realiseApproved: PLACED (30 s); region irSha == artifact's; | realised == virtual | ~21% | KEEP-INGAME | this is the realised==virtual proof; the check is `vworld` compare (M-rule style). The model side exists offline; the equality with the real world needs the real write |
| 4 | Regions.remove restores world hash (E-flat 0, 1512 cells) |  | ~3% | REPLACE · undo-model |  |
| 5 | pinned artifact survives its region's removal (C36); | artifact store bookkeeping | ~1% | ALREADY-OFFLINE | store logic; ApiP0Test |
| 6 | ARTIFACT_STALE: a block placed on a planned tile -> refuses naming the… | stale rule | ~2% | ALREADY-OFFLINE | PlanStaleTest + p0-unit (stale rule is exact); in game only the dev block placement |
| 7 | recheck, approve, realise (30 s), removal exact | repeat of 3/4 | ~22% | SMOKE · structure-lint | second identical realise/remove; drop at slice tier |
| 8 | keyed realise across a world stop: region record written while future… | durable restart | ~28% | KEEP-INGAME | world stop + resume of a keyed realise; same pattern as x-ingame keys |
| 9 | pins: pinArtifact idempotent; unpin last pin of unreferenced artifact… | artifact lifecycle | ~11% (incl. 30 s reali… | SMOKE · structure-lint | pure store state machine; ApiP0Test |
| 10 | FIELD_LIMIT: plan over 64 KB refuses |  | ~0% | ALREADY-OFFLINE | FieldLimitsTest |

#### `p0-natural`

p50 2.1 min · in 10/12 recent full slices · 2.0 step-min per slice · after all checkers keeps 95% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup: tp to S3's claim, ticks frozen, `L.settle(60_000)` |  | ~60% (76 s) | setup | a fixed 60 s settle; ticks frozen from check to the realised dump |
| 2 | plan checks READY (hamlet fits, blend fits) with artifact |  | ~1% | ALREADY-OFFLINE | p0-unit |
| 3 | realiseApproved PLACED (30 s); irSha equals artifact's; |  | ~24% | KEEP-INGAME | real natural-terrain survey vs realised |
| 4 | every cell kept by its condition is one the realise counted as skipped… | skip accounting | ~1% | REPLACE · structure-lint | `CellCondTest`/vworld accounting; derives from plan + survey |
| 5 | realised vs virtual over 2567 written cells: 0 unclassified (<= 0.01%)… | realised == virtual with classification | ~1% | KEEP-INGAME | needs the real survey with trees/fluids/growth |
| 6 | Regions.remove: E-normal 26 mismatches all classified (growth 22, live… | removal vs vanilla ticks | ~13% | KEEP-INGAME | random ticks (growth), snow melt: real vanilla; `RegionHashClassifyTest`/`ClassifyLiveTest` cover the classifier, not the ticks |

#### `c37-ingame`

p50 1.1 min · in 1/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 24% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup / world open | ~20 s (p50 66 - 46 log) | ~30% ~est | setup |  |
| 2 | 13x14 cottages: auto -> ns; forced "ew" -> ew street, 4 lots; | street orientation | 22:14:04 -> :14 ~15% | ALREADY-OFFLINE | c37-unit: whole kit suite with C37 fixtures (13x14 gives ns/ew, goldens re-plan unchanged). The in-game copy goes through the real sidecar check only |
| 3 | forced-ew plan realised (30 s), world changed |  | ~45% | SMOKE · structure-lint | a plan with an ew street through the real write path; would not need 30 s if the poll floor were lowered |
| 4 | Regions.remove restores world hash exactly (E-flat 0; 319 cells) |  | ~8% | REPLACE · undo-model |  |
| 5 | C37b: Library.Entry.cells() == PlanChecks.cells for all 101 entries; | cells accounting | ~2% | REPLACE · determinism | pure Java computation over the bundled library; a unit test with the library on the classpath (or `kit` check) proves it without MC |

#### `c38-ingame`

p50 0.2 min · in 1/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 20% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | setup / world open |  | ~36% (4 s) | setup |  |
| 2 | planCatalogue() at world start: no region exists; | API shape and threading | ~9% | KEEP-INGAME | "off the server thread, no tick needed" is a live-thread property; PlanCatalogueTest covers the rest |
| 3 | mod's catalogue equals kit planCatalogue(): 88 entries, catalogueVersi… |  | ~0% | ALREADY-OFFLINE | PlanCatalogueTest (unit-mod) + c38-unit catalogue-c38 golden. The only thing in game is that the **packed jar's bundled schemas** are what the kit has |
| 4 | a plan check through the sidecar answers READY; |  | ~55% (6 s) | ALREADY-OFFLINE | c38-unit "a check answer's catalogue = planCatalogue() = the golden". Cross-process (sidecar check vs mod) is the one live element: SMOKE |
| 5 | unchanged after a check with the world loaded |  | ~0% | ALREADY-OFFLINE |  |

#### `d2-findsite`

p50 3.7 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | find and pin the desert/jungle site: scan the seed world for a 192x192… | real vanilla biome/terrain generation under the seed | ~100% | KEEP-INGAME | It is in no chain/tier (grep of gate-chains.json: only the step definition). The site is pinned afterwards; rerun only if the seed or worldgen version changes. |

#### `v-ingame`

p50 2.9 min · in 3/12 recent full slices · 0.6 step-min per slice · after all checkers keeps 23% · saves **0.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base worlds | gate6b base + gate6cv base restore | 5% | setup |  |
| 2 | nav S7 door-to-bell 10/10 | re-reads the S7 run's vanilla `canReach` results for every villager lot | <1% | KEEP-INGAME | not re-run here, reads a stored S7 result; the live proof is s7/d/t2 |
| 3 | nav range + negative controls | vanilla canReach on 100-cell flat path true; raised platform with ladder only false; kit villager mover false / player mover true | 8% | SMOKE · structure-lint | vanilla half calibrates dev.nav.villager itself (one instance suffices at slice). Kit-mover half is route-t2.test.mjs / village.test.mjs |
| 4 | protect: plan honours area | IR keepOut equals the area; every lot and street south of area z | 6% | REPLACE · structure-lint | keep-clear against IR boxes; needs lots/roads/paths footprints plus the protected-area list |
| 5 | protect: realised, 0 cells written in area | ARWD diff over the area after PLACED (2849 cells changed) | 21% (realise ~30s) | SMOKE · structure-lint | the writer-honours-plan half is the same proof t2 (#2) and d (PT) make; one instance in game. History: this exact check once failed with 5400 cells in the area (T2, see bugs) |
| 6 | protect: remove by owner | Regions.remove of 6279 cells | 1.5% | REPLACE · undo-model | journal restore of the region |
| 7 | protect: PROTECTED refusals | plan made before the mark refused PROTECTED at realise, hash and journal 20->20; program with no keep-out refused PROTECTED | 4% | REPLACE · undo-model | pure rect arithmetic over claim and area; must model "force does not override" and mark-after-plan staleness |
| 8 | steward: plan outputs | oversized lot unplaced (no_room), LotSpec ext rows 12/12, >=10 lots | 6% | ALREADY-OFFLINE | kit/test/village.test.mjs, village-layout-*.test.mjs, plus sidecar village test (goldens in gate6cv unit) |
| 9 | steward: sim massingFirst group + fitToLot | group AWAITING_APPROVAL -> DONE with an entry per lot; fitToLot fits all | 13% | SMOKE · structure-lint | Steward API integration through the stub sidecar; one in game |
| 10 | steward: realise(lotEntries) | PLACED, every lot placed | 21% | SMOKE · structure-lint | real write path via lotEntries; same ~30s floor as #5 |
| 11 | steward: one Regions.remove exact | hash equal, 18653 cells | 5% | REPLACE · undo-model |  |
| 12 | survroad | construction-road dirt path free on 6 soil kinds, costs gravel on sand (BOM) | 9% | REPLACE · ledger-lint | BOM from IR cell ops; needs the "free conversion" set (dirt, coarse_dirt, podzol, mycelium, rooted_dirt, grass_block -> dirt_path) and the sand cost row; 13s is mostly plan |

#### `w-ingame`

p50 12.7 min · in 6/12 recent full slices · 4.0 step-min per slice · after all checkers keeps 12% · saves **3.5 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base worlds | restore (this run rebuilt both stale bases: 44s; steady ~5s) | 1-5% | setup |  |
| 2 | frozen: survey reads FROZEN | 5904 frozen-water columns, Sample.frozen 354/784, Sample.water unchanged | 2% | KEEP-INGAME | the survey reader reading real ice/frozen water from vanilla worldgen on seed 2026101102 |
| 3 | frozen: plan keeps street off frozen water | 0 street columns on frozen | <1% | REPLACE · structure-lint | from a stored survey (frozen-survey.bin) + IR; the broken-variant offline step already exercises this |
| 4 | frozen: realised PLACED (never PARTIAL) | writer on the rejected site | 4% (realise 30s) | SMOKE · structure-lint |  |
| 5 | frozen: 4e road over 12 frozen columns refused DEEP_WATER | mod road refusal | <1% | KEEP-INGAME | refusal reads real world water depth; needs the actual chunks. Could become a Java unit with a fake level |
| 6 | variants | gravel verge over a 2-deep gap with rule off -> M3:gravity; FROZEN ignored -> clean plan over 62 frozen columns | 0.4% | ALREADY-OFFLINE | the step header says "kit, no game"; kit/test/village-safety.test.mjs |
| 7 | surveys: S1/S7 unchanged, S2/S3 FROZEN counts | pinned plan-survey shas of 4 seeds equal goldens | 6% | KEEP-INGAME | the survey is vanilla worldgen output; one seed (S1) at slice, 4 at release. The S1 golden mismatched in 3 historic runs (version drift, see bugs) |
| 8 | pathbibles: M5 over street/verges/lanes/square = 0 | 4 full S7-flat runs (coarse_dirt, packed_mud, stone_bricks, oak_planks), walkDark share 0 of 495 | 82% jointly (4 x ~162s… | REPLACE · structure-lint | M5 is a kit rule; run it on the virtual world with each path bible. Needs the light model (emission radius/levels, 14-block spread rule in kit/lib/region/light.mjs) and bible-driven lamp placement. |
| 9 | pathbibles: road lantern count equal across bibles (7 = 7 = 7 = 7) | counts emitters within 3 of street outside the square | in #8 | REPLACE · structure-lint | count over the virtual world; independent of path material |

#### `b-ingame`

p50 4.1 min · in 7/12 recent full slices · 2.6 step-min per slice · after all checkers keeps 68% · saves **0.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | restore (stale rebuild 22s here, steady ~1s) | 1-9% | setup |  |
| 2 | NATURAL_ONLY strokes vs player wall + other owner's road | 9 strokes (raise/smooth/lower/overlay/erode/melt): wall (21 blocks, chest) unchanged; 0 of the road's 87 cells written; | 7% | SMOKE · undo-model | owner-skip and condition-skip are decided from journal ownership + block class; a model needs the journal's ownership map and the brush condition predicate. The vanilla bit is only that the brush reads real blocks |
| 3 | 5 overlapping strokes undone in 3 orders, E-flat 0 | reverse, forward, mixed | 7% | REPLACE · undo-model | the textbook case: fuzz overlap/order against real journal code |
| 4 | PLAYER_BLOCKS permission | refused without actor, without op; with op clears wall + chest, nothing dropped, one undo restores NBT | 4% | SMOKE · structure-lint | needs permission levels and block-entity/item-drop behaviour (chest contents hash with NBT); refusals themselves are a pure policy table (ALREADY-OFFLINE-able via sidecar/Java unit) |
| 5 | IR sha twice | same request+seed -> same IR sha, 1141 cells | 4% | REPLACE · determinism |  |
| 6 | BAR radius-16 strokes latency | p50 951ms over 10 | 5% | BAR | recorded not judged (historic FAIL at load 23: 2298ms) |
| 7 | NOT_ALLOWED / FIELD_LIMIT / NOT_LOADED | survival-toggle world, Nether, radius 33, strength 17, no owner, far unloaded chunk | ~0% | KEEP-INGAME | all but NOT_LOADED are input validation; NOT_LOADED depends on chunk load state |
| 8 | /architect brush + brush undo (command path) | command makes rg, undo restores hash | **47% (121s)** | WAIT (fix the wait) | see notes |
| 9 | apitest apib + Regions.brush through public API | version 1.38.0, limits, a stroke + remove (247 cells) | 0.5% | KEEP-INGAME |  |
| 10 | natural: S3 cave carve M3/M4 on realised dumps | 485 cells carved; 0 floating, 0 breaches | part of 16% (42s) | REPLACE · structure-lint | rules are kit rules; needs the survey/virtual world of S3's corner; realised == virtual is separately provable |
| 11 | natural: 6 strokes PLACED, E-normal after 7 undone | all mismatches classified, 0 unclassified | part of 16% | KEEP-INGAME | E-normal is defined against vanilla settling; compare water-lint |
| 12 | BAR own tick CPU max (flat 4.5ms, natural 2.9ms) |  | 0% | BAR |  |

#### `tile-gravity`

p50 0.3 min · in 11/12 recent full slices · 0.7 step-min per slice · after all checkers keeps 78% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base (stale rebuild 20s in the log) |  | 5% steady | setup |  |
| 2 | (A) sand on grass rewritten to stone stays sand | gravityKept 1, dependentCells 0, no falling_block entity near stroke | ~35% | KEEP-INGAME | the whole point is that vanilla does not drop the sand; the kit can model "support stays solid -> kept" (structure-lint rule) but not that no falling block spawned. This is the sand-vanish fix |
| 3 | (A) one undo restores box exactly | 0 mismatches | ~10% | REPLACE · undo-model |  |
| 4 | (B) sand over water source, overlay rewrites support | hanging sand cleared as a cell of the entry (dependentCells 1); free support written solid | ~35% | KEEP-INGAME | needs strict /setblock to build the hanging sand; the cleared-with-entry rule itself is journal-model |
| 5 | (B) undo restores incl. the hanging sand | 0 mismatches | ~10% | REPLACE · undo-model |  |

#### `c31-felling`

p50 0.3 min · in 2/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 95% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | (1) protected: felling stays out of the cutter's protected area | trunk+outside branch felled (logs 9->0); area unchanged by hash; M3:tree_kept finding recorded | ~50% (10s incl. | KEEP-INGAME | tree rule is decided from the real log/leaf graph; a structure-lint could check "no forbidden cell changes" over a virtual tree but not vanilla tree shape |
| 2 | (1) undo exact | 0 mismatches | ~3% | REPLACE · undo-model |  |
| 3 | (2) owned: another owner's log mound untouched, own trunk felled | tree_kept.owned 1 | ~25% | KEEP-INGAME |  |
| 4 | (3) inside: whole tree felled (logs 7->0, held leaves 3) |  | ~20% | KEEP-INGAME |  |
| 5 | (2),(3) undo exact |  | ~2% | REPLACE · undo-model |  |

#### `t1-ingame`

p50 0.2 min · in 8/12 recent full slices · 0.4 step-min per slice · after all checkers keeps 26% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | 10% | setup |  |
| 2 | passes program on 320x320 claim -> second plan on resolution-1 survey | survey 320x320 columns (716828 bytes); notes name the second survey + pass timing | 70% (~7s, survey read… | SMOKE · structure-lint | resolution selection is sidecar logic (sidecar/test/regions-passes.test.ts, kit/test/relief-t1.test.mjs mention resolution; I did not verify they assert 320x320 res-1). |
| 3 | program without passes keeps resolution-4 survey (80x80), one plan |  | 20% | ALREADY-OFFLINE | same sidecar tests |

#### `f2-harvest`

p50 0.2 min · in 8/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | 10% | setup |  |
| 2 | scratch superflat world + 72/72 stamps harvested | 9 features x 8 seeds via dev.feature.stamp (huge mushrooms, dripstone, fossils, 5 tree species) into architect/stamps | ~60% (~5s world open,… | KEEP-INGAME | stamps are vanilla feature output; cannot be computed offline |
| 3 | re-harvest byte-identical (72/72) | same bytes on same version | ~10% | KEEP-INGAME | determinism of vanilla feature generation; needs vanilla |
| 4 | no stamp touches capture-box edge |  | <1% | REPLACE · structure-lint | else stays with the harvest |
| 5 | BAR 72 stamps twice in 1s |  | <1% | BAR |  |

#### `t2-ingame`

p50 1.2 min · in 1/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 17% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | 2% | setup |  |
| 2 | plan honours protected area across gate-hall line | IR keepOut; every edge routed (gate_hall 127 cells vs 77 unconstrained) | 23% (15s) | REPLACE · structure-lint | keep-clear + route length from IR; the offline `variants` step already does the KEEP_OUT refusal |
| 3 | realised PLACED (989428 cells), 0 cells written in area | ARWD diff | 48% (32s) | SMOKE · structure-lint | one of the three realise-honours-keepout proofs (v #5, d PT). Failed once with 5400 cells in the area (T2 run 20261012-220700): real writer bug |
| 4 | vanilla villager paths along villager edges both ways | gate_hall and hall_chapel [true,true] | <1% | KEEP-INGAME | calibration of the kit's villager mover on a slope route; the offline `synth` step runs both movers on the virtual world |
| 5 | 0 ladder segments on villager edges |  | <1% | REPLACE · structure-lint | ladders on villager edges is M2:villager (offline `variants`) |
| 6 | removal by owner exact, world hash equal (E-flat 0) | 991696 cells | 27% (18s) | REPLACE · undo-model |  |

#### `d-ingame`

p50 2.2 min · in 11/12 recent full slices · 2.2 step-min per slice · after all checkers keeps 20% · saves **1.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | standing flat_village PLACED (S7 lots) | setup | 32% (41s) | SMOKE · structure-lint | real realise; the setup for everything below |
| 2 | district seam holds cell past street_e_end, meets no lot/road/path | kit rule on claim | <1% | REPLACE · structure-lint | kit/test/districts-d.test.mjs |
| 3 | OVERLAP refusals (over street; 41 deep), missing region (OTHER), other… | named refusals + world hash unchanged | 3% | REPLACE · undo-model | claim-rect vs standing-region IR geometry (seam width <= 16 columns); hash-unchanged is "refusal writes nothing" |
| 4 | PT: player cabin one tracked build, IR keep-out holds cabin, no lot/pa… |  | 5% | REPLACE · structure-lint | keep-clear against a tracked player build |
| 5 | PT: cabin's kept cells unchanged after the district realise (kept hash… |  | within #6 | SMOKE · structure-lint | writer honours keep-out (see t2 #3) |
| 6 | join: routed to street_e_end, external edge to rg59, graph edge | IR beside, plan reads rg59 sha | 1% | REPLACE · structure-lint |  |
| 7 | join walkable by player + villager movers (kit), ladders 0, grade wind… |  | <1% | REPLACE · structure-lint | walkability/grade on virtual world |
| 8 | district rg60 PLACED (131 cells), view names beside, join not dangling |  | 24% | SMOKE · structure-lint | writer |
| 9 | vanilla villager nav from every new lot entrance to bell and back (4 l… | all [true,true] | 1.5% | KEEP-INGAME | calibration; kit movers already assert the same in #7 |
| 10 | Regions.remove(new): 0 changed cells in village; | ARWD diff + hash | 3% | REPLACE · undo-model |  |
| 11 | district again, village removed first: join reported dangling; |  | 31% (mostly a 2nd 30s… | REPLACE · undo-model | removal order with dependencies (dangling join note) |

#### `d2-ingame`

p50 3.9 min · in 11/12 recent full slices · 4.0 step-min per slice · after all checkers keeps 47% · saves **2.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | <1% | setup |  |
| 2 | outpost: placed at gap 40, joined to street_e_end; corridor on view | on flat world, village then outpost | ~30% (~72s of the 84s… | SMOKE · structure-lint | kit/test/outpost-s2.test.mjs already covers the plan geometry |
| 3 | outpost stable across reload | IR sha equal after save+reopen | ~3% | KEEP-INGAME | proves nothing in the world leaks into the plan; determinism is the offline half |
| 4 | outpost one undo exact incl. corridor (453 cells) |  | ~3% | REPLACE · undo-model |  |
| 5 | NO_ROOM refusal (no candidate) | named | ~0% | REPLACE · structure-lint |  |
| 6 | shore: street parallel to shore (60/60 cells within 8..16 of water) | geometry on seed survey | ~5% | REPLACE · structure-lint | needs pinned seed survey fixture (S3), a water mask |
| 7 | ridge: street on crest (43/46 within 4) |  | ~4% | REPLACE · structure-lint |  |
| 8 | biome edge: shape within 4 cells of desert/jungle edge (94 cells, 0 pa… |  | ~4% | REPLACE · structure-lint | biome map is part of the pinned survey (vanilla worldgen); needs the stored biome grid |
| 9 | quay/crest/biome district placed (lots, mask cells) | PLACED | 3 x ~20s = ~25% | SMOKE · structure-lint | one writer instance |
| 10 | stable across reload (3 districts) | IR sha after save+reopen | ~10% | KEEP-INGAME |  |
| 11 | one undo restores the claim, ticks frozen; | 4462 / 884 / 4256 cells; unclassified 0 | ~15% | KEEP-INGAME | E-normal is defined against vanilla settling around the claim |
| 12 | NO_EDGE and PROTECTED refusals named |  | ~0% | REPLACE · structure-lint | refusals from the survey and protected list |

#### `voc-registry`

p50 0.1 min · in 6/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | 10% | setup |  |
| 2 | registry vs kit/lib/blocks.mjs | 1286 blocks: ids, property domains, defaults, light per state, random ticking, items, falling, fluid-stopping, flammable, required features:… | ~70% (world open + dev… | KEEP-INGAME | this is a calibration probe of blocks.mjs against the live registry. Note blocks.mjs is already generated by `kit/tools/gen-vocab.mjs` from the jar via BlockDump/VocabDump (voc-unit with the jar), so the in-game dump is an indepen… |
| 3 | listed namespaces, enabled features, every ff flag enabled |  | ~5% | KEEP-INGAME |  |
| 4 | pack digests (recipe 2042, loot 1447, tags/block 300, tags/item 236) a… |  | ~5% | KEEP-INGAME | "loaded ids" is what the game loaded (datapack stack) |
| 5 | negative control: doctored dump reported naming both | pure JS on a mutated copy | <1% | ALREADY-OFFLINE | `compareRegistry` is offline; belongs in kit/test/vocab.test.mjs |

#### `voc-probe`

p50 5.3 min · in 6/12 recent full slices · 3.9 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | <1% | setup |  |
| 2 | concrete powder beside water -> concrete; 2 away stays powder |  | ~1% | KEEP-INGAME | hazards.json calibration row |
| 3 | sponge: reach taxicab 6 over a 9-source trench; cap 99 in 11x7x11 pool |  | ~2% | KEEP-INGAME | calibration; water-lint would model it but needs these numbers from vanilla |
| 4 | magma/soul sand under water -> bubble_column drag true/false |  | ~1% | KEEP-INGAME |  |
| 5 | fire reach {side 2, below 2, above 5}, soul fire {0,0,0}, lava {side 3… | posts lit/not lit after 12,011 game ticks; fire relit young every 20s; bot in creative so fire ticks near a player | ~94% (~300s) | KEEP-INGAME | lava `below` is explicitly not probed (hazards.json says 1, measured 0, `gate6cvoc-a.mjs:392`) |

#### `voc-ingame`

p50 6.7 min · in 5/12 recent full slices · 2.9 step-min per slice · after all checkers keeps 30% · saves **2.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | stale rebuild 20s here, steady ~1s | 1-5% | setup |  |
| 2 | checkPlan READY with artifact; bible rarity reached the plan through t… | 4 chains | ~10% (4 x ~10s) | SMOKE · structure-lint | meta.vocab and ctx.rarity plumbing: sidecar/test/regions-*.test.ts, kit vocab-rules.test.mjs |
| 3 | realiseApproved PLACED, irSha equal, cells counts | 6 chains | ~52% (6 x ~36s) | SMOKE · structure-lint | fixed ~36s floor; the same 271-cell village is realised 4x (v50, v50c, v50r) for different bibles/rules |
| 4 | realised world equals virtual over every written cell outside lots (41… |  | ~8% (6 x 5s) | KEEP-INGAME | this is the realised==virtual proof; one chain at slice, all at release |
| 5 | M20, M26, M27 recomputed on realised dump equal plan's |  | in #4 | REPLACE · structure-lint | on its own it duplicates the virtual-world run; adds value only together with #4 |
| 6 | cost.rarity equals counts of realised cells; |  | in #4 | REPLACE · ledger-lint | items placed vs billed from IR |
| 7 | Regions.remove restores exactly (E-flat 0) | 6 x ~12s | ~17% | REPLACE · undo-model |  |
| 8 | r01/r03: refused part wrote nothing; checkPlan answers VOCAB (waterlog… | rule M27:state / M20 with 16 cells | ~4% | REPLACE · undo-model | refusal from the plan's block set vs blocks.mjs rules; wrote-nothing is undo-model |
| 9 | BibleRequest: malformed rarity FIELD_LIMIT before any job; |  | ~3% | ALREADY-OFFLINE | sidecar wire/schema tests |
| 10 | M26 shares and ext rows for the village (uncommon 0.024 etc.) |  | in #5 | REPLACE · structure-lint |  |

#### `voc-natural`

p50 2.5 min · in 5/12 recent full slices · 1.0 step-min per slice · after all checkers keeps 83% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | <1% | setup |  |
| 2 | v50n on S3's pinned site checkPlan READY (hamlet fits, blend fits) |  | 32% (46s, survey+plan… | KEEP-INGAME | survey reading S3 |
| 3 | realiseApproved PLACED 4181 cells (copper hall in c1) |  | 25% | SMOKE · structure-lint |  |
| 4 | Regions.remove E-normal: 7 mismatches all classified (farfluid), 0 unc… |  | 12% (17s) | KEEP-INGAME | historic: IRR run FAIL with 9 mismatches classed "none" (unclassified drift), pass in int-cu with 7 "farfluid": intermittent natural-world fluid noise |
| 5 | drift probe (recorded): 157/157 unwaxed copper cells weather under dev… |  | 31% (45s) | KEEP-INGAME | exactly the vanilla behaviour; "a lot is a BOX entry" is the journal-model half |

#### `vocc-ingame`

p50 3.2 min · in 1/12 recent full slices · 0.3 step-min per slice · after all checkers keeps 31% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | <1% | setup |  |
| 2 | mod block histogram of entry equals kit's (copper cabin 144 blocks; | Java lotBlocks vs kit | 4% | SMOKE · structure-lint | does not need vanilla: a mod-vs-kit parity check on one entry |
| 3 | r03: checkPlan READY with hall pending; |  | 5% | REPLACE · structure-lint | palette rule over plan cells + bound lot's histogram; refusal evidence is arithmetic |
| 4 | r03 re-bind to copper cabin: PLACED; remove exact |  | ~20% (30+12s) | SMOKE · undo-model |  |
| 5 | v65 no_wood: re-planned with wood group excluded (stairs/planks/fence… |  | ~10% plan/pre-check +… | SMOKE · structure-lint |  |
| 6 | v65 realised world holds no wood in the 3057 plan cells outside lots |  | 2% | KEEP-INGAME | a simple scan on the dump; virtual equivalent trivial |
| 7 | v65 copper lots PLACED, ext row no_wood measured 0; |  | ~25% | SMOKE · undo-model |  |
| 8 | v64: checkPlan copper_only fits with bound lot measured from mod's lot… |  | 2% | REPLACE · structure-lint |  |
| 9 | S-VOCc-2 pre-check: Regions.checkPalette ok; |  | <1% | REPLACE · structure-lint |  |
| 10 | S-VOCc-3: delta to oak version refused PALETTE by checkDelta and apply… |  | <1% | REPLACE · undo-model |  |

#### `6cvoc-look`

p50 5.0 min · in 5/12 recent full slices · 2.2 step-min per slice · after all checkers keeps 0% · saves **2.2 step-min/slice** · whole step: LOOK step (its judged rows repeat voc-ingame)


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | client start + world |  | ~15% (~est 40s before… | setup |  |
| 2 | 4 bibles x (realiseApproved PLACED; realised == virtual 415 cells; | 4 x ~53s | ~70% | SMOKE · structure-lint | exact repeat of voc-ingame's v50 chain with a different bible (the realise assertions are `voc-ingame` #3-#6 again); only the screenshot needs the world |
| 3 | 13 screenshots of the four bibles on v50's village and the four design… | recorded, not judged (Noah N-VOC-5) | ~15% (41s) | LOOK → release | needs the client; tier decision for Noah |

#### `t3a-probe`

p50 0.7 min · in 6/12 recent full slices · 0.4 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | vanilla villager over command-built decks | `dev.nav.villager` crosses 7 beam/arch decks (spans 3-32, rise -4..3, w2-3) both ways; holed deck refused (negative control) | 45% (20 s) | KEEP-INGAME | villager pathing. Property of vanilla plus kit profile; does not touch the mod write path. Tier: release, or when `ropeGeom`/profile/MC version changes. SMOKE at slice (2 decks + hole). |
| 2 | boat under decks | player in a vanilla boat, moved by collision, passes decks with 2 and 3 clear cells, is blocked at 0; | 50% (22 s) | KEEP-INGAME | vanilla entity collision; no model. One-time calibration of the clearance rule (N-T3-2); release only, or on MC bump. Note: 4 x (summon + 4 s settle + 12-cell walk) dominates. |
| 3 | setup | `base` plus fresh flat world | 4% | setup |  |

#### `t3a-ingame`

p50 2.0 min · in 6/12 recent full slices · 1.1 step-min per slice · after all checkers keeps 66% · saves **0.4 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan + golden | crossings_demo flat plans a beam of 24 (3 piers) + arch of 16; IR sha and 18 tile shas equal golden `crossings_demo_flat`, 1 worker = 4 work… | 9% (11 s) | ALREADY-OFFLINE | kit/test/region-golden + scenario-goldens + bridge-t3a.test (determinism). Failed twice in slice runs (HYcore, Hb) only because the golden was stale: a pure determinism check. |
| 2 | realise | 74,886 cells, PLACED | 32% (38 s incl. | KEEP-INGAME | real write path. One per writer kind; this duplicates the t3b/look realises of the same plan. |
| 3 | bridge re-read on the realised dump | per bridge: deck half-block surface = formula, steps <= 1, rails 100%, head room 100%, 0 dark deck cells, piers solid/2 deep/<=24 tall/<=8 a… | 5% (6 s) | REPLACE · structure-lint | span checks, clearance, pier, light run on the virtual world (kit bridge-t3a.test already has them incl. broken variants). Needs a realised == virtual diff to cover the realised side (absent here). |
| 4 | kit movers across both bridges | kit player/villager `walkGraph` both ways | ~0% | ALREADY-OFFLINE | kit walkGraph on the virtual world (bridge-t3a.test). |
| 5 | vanilla villager across both bridges | `dev.nav.villager` landing to landing, both ways (the hard bar) | ~0% (1 s) | KEEP-INGAME | villager pathing across decks. |
| 6 | Regions.remove exact | owner remove, box hash diff: E-flat 0, 74,886 cells restored | 14% (16 s) | KEEP-INGAME | + undo-model for orders/overlap/crash. One in-game remove per writer kind is enough. |
| 7 | checkPlan on a command-built channel | bridge part over a 14-wide channel checks READY through `Regions.checkPlan`, arch 18, clearance 2 | 9% (11 s) | KEEP-INGAME | Java plan-check against live chunks (real survey of command-made water). Clearance rule itself is structure-lint. |
| 8 | channel bridge realised from artifact, crossed, removed | realiseApproved PLACED (694 cells); vanilla villager both ways; remove: 0 mismatches ("channel's water settles") | 30% (36 s) | SMOKE · structure-lint | realiseApproved path + vanilla nav + fluid settle on removal (water lint if calibrated). 2nd realise in this step; drop to release. |
| 9 | setup | base + fresh flat world + tp | 1-2% | setup |  |

#### `t3a-natural`

p50 2.2 min · in 6/12 recent full slices · 1.2 step-min per slice · after all checkers keeps 84% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan | crossings_demo river variant: 1 arch (24) over water, need 2 / have 9 | 11% (14 s) | ALREADY-OFFLINE | needs the pinned S3 survey; kit goldens/bridge-t3a clearance-over-water test. Add this survey to structure-lint fixtures. |
| 2 | prepare + wait | `tp` + fixed 60 s `settle`, then dump + snap | 47% (about 62 s) | WAIT (fix the wait) | a fixed sleep (`L.settle(60_000)` for non-flat), not tied to a condition. Replace by waitChunks/prepare done; no assertion. |
| 3 | realise | 688 cells PLACED | 23% (30 s) | KEEP-INGAME | write path on natural terrain with water. |
| 4 | bridge re-read | the same 13 checks as t3a-ingame #3 plus clearance over water 9/2 | 5% (6 s) | REPLACE · structure-lint | over the committed survey; arch middle-third clearance and landings on real terrain. |
| 5 | vanilla villager both ways + kit movers | across the river arch | ~0% | KEEP-INGAME | real banks. |
| 6 | remove E-normal | 14 mismatches all `growth`, 0 unclassified, no gravity | 12% (15 s) | KEEP-INGAME | random-tick growth classification on a natural world. |

#### `t3a-frozen`

p50 2.4 min · in 6/12 recent full slices · 1.2 step-min per slice · after all checkers keeps 84% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base rebuild of seed 2026101102 | `L.seedBase` creates the frozen-river world (stale recipe in this run) | 10% (14 s) | setup | only when the recipe changed; otherwise about 1 s. |
| 2 | plan | frozen river arch 19, need 2 / have 4 | 10% (14 s) | ALREADY-OFFLINE | needs S7 rejected-site survey as a fixture. |
| 3 | 60 s settle + realise | 680 cells PLACED | 65% (62 + 30 s) | KEEP-INGAME | fixed sleep, as t3a-natural. |
| 4 | the 13-check re-read + movers | same as t3a-natural | 4% | REPLACE · structure-lint |  |
| 5 | ice unchanged | 73 ice cells under the bridge box have identical states before and after | ~0% | SMOKE · structure-lint | realised == virtual on cells the plan must not write (freeze/ice). The plan-level "0 cells written in ice" is ALREADY-OFFLINE (M-rule); the state compare is the only real-world proof. |
| 6 | vanilla villager + remove E-normal | both ways; 0 mismatches | 11% (15 s) | KEEP-INGAME |  |

#### `t3a-look`

p50 23.3 min · in 6/12 recent full slices · 12.4 step-min per slice · after all checkers keeps 0% · saves **12.4 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | `gate6b base` | 2% (28 s) | setup | stale rebuild in this run. |
| 2 | per bible (x3): plan + realise | crossings_demo flat realised in default / infernal / coastal bible; PLACED and 2 bridges | 6% realise (3 x 30 s)… | KEEP-INGAME | the bible only changes block palette; redundant with t3a-ingame. A kit determinism check per bible is enough. |
| 3 | per bible: shots | beam/arch side, deck, high; tunnel portal, interior, narrow (default only): about 10 + 6 + 8 shots | 3% (about 46 s) | LOOK → release | recorded, not judged. Tier decision only. |
| 4 | per bible: 2 tunnels exist | `meta.tunnels.length === 2` | ~0% | ALREADY-OFFLINE | trivial. |
| 5 | **post-bible stall** | after the shots: `dev.release`, `dev.region.remove` (result swallowed by `.catch`), `leaveWorld`, next bible | **86% (623 s after bib… | WAIT (fix the wait) | see notes. |

#### `t3b-ingame`

p50 3.8 min · in 8/12 recent full slices · 2.7 step-min per slice · after all checkers keeps 91% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan (two-plan flow) | crossings_demo flat plans 2 tunnels (3x3, 1x3, length 53), note "read 1 frozen volume" | 5% (12 s) | SMOKE · structure-lint | tunnel-t3b.test + plan-t3b.test (two-plan flow). |
| 2 | realise | 74,886 cells PLACED | 16% (37 s) | KEEP-INGAME | the same plan as t3a-ingame. |
| 3 | gravity stand | falling-block entities counted during realise + 60 s stand: 0 (sand band) | 26% (60 s) | KEEP-INGAME | gravity (sand falling) cannot be modelled; the stand is far longer than needed: gravity acts within ticks after a neighbour update. 60 s -> about 5 s keeps the proof. |
| 4 | tunnel re-read | cover >= 2, bore >= 4, shell solid, exposed soil/loose lined, 0 gravity cells over air, height clear, 0 dark floor, 0 fluid within 2, M1/M3/… | ~1% | REPLACE · structure-lint | static analysis: cover and shell on the frozen volume, lining, gravity-over-air, clearance, light, fluid buffer. Failed in dev (cover 1 / M3:tunnel 10) and was a pure plan bug. |
| 5 | movers through bores | kit mover ALREADY-OFFLINE; vanilla villager through 3-wide and 1-wide bores both ways | ~0% | KEEP-INGAME | villager pathing. |
| 6 | remove E-flat | 74,886 cells restored, 0 mismatches | 8% (18 s) | KEEP-INGAME |  |
| 7 | postern (v40) | cliff ridge by commands, check READY with tunnel landing on `postern_town_wall`; realise 4,422 cells; the 10-check re-read; | 39% (about 90 s: check… | KEEP-INGAME | the closure rule is a pure graph property of the virtual world. A second full realise+remove cycle for a 4.4k-cell plan. |
| 8 | item 5 control (v34) | a plan without a tunnel part plans once: `volumePass === null`, no volume note | 5% (11 s) | ALREADY-OFFLINE | Java plan-check tests (run in t3b-unit) can assert `volumePass` null; needs a fresh world only to run the check. |

#### `t3b-natural`

p50 9.4 min · in 8/12 recent full slices · 6.7 step-min per slice · after all checkers keeps 71% · saves **1.9 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base rebuild | stale seed + flat base rebuilt | 4% (22 s) | setup | first run in a run dir only. |
| 2 | check with volumes | checkPlan of the hill tunnel READY; note "read 1 frozen volume"; answers equal the kit's `checkPlanLocal` for the same volume sha | 2% (14 s) | SMOKE · structure-lint | kit/Java parity on a real chunk read is the only in-game part. |
| 3 | water case (item 4) | water 2 from bore: refused WATER naming the cell; 3: fits; realise (872 cells); **120 s stand**: 0 fluid in void | 32% (182 s; stand 21%) | KEEP-INGAME | water-lint (M25) could model the buffer breach; a short stand (about 10-20 s with random ticks off) is enough for water. |
| 4 | lava case (item 4) | lava 1: refused; 3: fits; realise; 120 s stand: 0 fluid | 26% (151 s; stand 21%) | DUPLICATE | merge into one world with both hazards placed to halve this. |
| 5 | stale rock (item 6) | mined shell cell: realiseApproved ARTIFACT_STALE naming tunnel+cell; recheck READY with new artifact (lined 93 v 92); | 4% (24 s) | KEEP-INGAME | real mod path (live chunk re-verification at realise). Cheap; keep. |
| 6 | hill realise + stand + re-read | realise 872 cells; **120 s stand**; falling blocks 0; the 10-check re-read; villager through | 26% (150 s; stand 21%) | KEEP-INGAME |  |
| 7 | remove E-normal | 0 mismatches, none within 6 of the bore | 3% (16 s) | KEEP-INGAME |  |
| 8 | load policy | unloaded corridor: INCOMPLETE/VOLUME under `loaded`; fits under `generate`; | 2% (14 s) | KEEP-INGAME |  |

#### `t3b-pin`

p50 3.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 80% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | find-site spiral | survey each candidate (about 5 s each, up to 129 tried), sand/water/tree filters | about 80% (~est) | KEEP-INGAME | needs real worldgen; run only on a MC/world-gen change. |
| 2 | line + corridor + hill plan + fluid-within-4 | `pickLine` on the survey file, crossings_demo hill plan clean, no fluid within 4 | about 20% (~est) | REPLACE · structure-lint | pure data once the survey file exists. |
| 3 | the single `check` | "found" a hill |  | setup |  |

#### `t3b-look`

p50 0.9 min · in 8/12 recent full slices · 1.0 step-min per slice · after all checkers keeps 0% · saves **1.0 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | stale rebuild in this run | 32% (24 s) | setup | usually about 1 s (p50 55 vs this run 75 s). |
| 2 | realise + shots | crossings_demo flat realised at dusk; 4 shots (portal, portal_wide, interior, narrow); `check(shots >= 3 && PLACED)` | 16% realise, 11% shots… | LOOK → release | recorded, not judged; the check is trivial. |

#### `k1a-ingame`

p50 0.9 min · in 11/12 recent full slices · 1.0 step-min per slice · after all checkers keeps 84% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | world + 3 checks under /tick freeze | v30 checks READY 3 times, one artifact sha; fits per part | 22% (11 s incl. | SMOKE · determinism |  |
| 2 | realise + tile shas | realiseApproved PLACED, region irSha = artifact's, 19/19 tile shas equal | 61% (31 s) | KEEP-INGAME | Steward flow (artifact -> realise). |
| 3 | realised == virtual | 3,820 written cells, 0 differ, 0 kept, 0 road; every block property (wall connections, door halves/hinges, arch stairs) | 2% (1 s) | KEEP-INGAME | the only realised-vs-virtual cell diff in these four drivers; the justification for running all M-rules offline. |
| 4 | wall bars on the realised dump | 0 walk cells under wall; foot height + 2-over rule on 350 columns; gate clearance; M5 0 dark; | ~1% | ALREADY-OFFLINE | kit plan-k1a.test (items 1-4 in virtual world); with #3 passing it is a duplicate. |
| 5 | gates exact | gates = crossings + `gates.min` | 0% | ALREADY-OFFLINE |  |
| 6 | vanilla villager nav lot -> gate, both ways | 3 lots x 2 gates x 2 directions: 6/6; paths meet the wall only at gate cells | 2% (1 s) | KEEP-INGAME | villager pathing around real wall blocks. |
| 7 | doors opened, remove exact | 4 door cells toggled `open=true` by command (as a villager would), then Regions.remove: world hash back (E-flat 0) | 10% (5 s) | KEEP-INGAME | live block-state change after realise must still restore. |

#### `k1a-natural`

p50 1.6 min · in 11/12 recent full slices · 1.7 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | world open + 30 s settle + 3 checks | v30 READY x3 under freeze, one sha | 47% (45 s; settle 30 s… | WAIT (fix the wait) | fixed 30 s sleep before the check. |
| 2 | realise + tile shas | PLACED, 19/19 | 32% (31 s) | KEEP-INGAME |  |
| 3 | realised vs virtual (natural) | 0 unclassified of 4,588 written (<= 0.01%), 9 kept by condition = skipped, 10 on 4e ground roads | 1% | KEEP-INGAME | write path vs live terrain. |
| 4 | wall bars again, natural terrain | same list as k1a-ingame #4 incl. terrain bypass | ~1% | REPLACE · structure-lint | needs the S7 natural survey as a committed fixture (S3's survey is the kit's; live seed drifts: comment gate7ak1.mjs:408-411). |
| 5 | remove E-normal | 17 mismatches, all `growth`; undo's own 0 | 18% (17 s) | KEEP-INGAME | random-tick growth classification on a natural world (worldClasses). |

#### `k1a-target`

p50 1.3 min · in 11/12 recent full slices · 1.3 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | V town realised as its own region | flat_village (3 lots), 227 cells PLACED | 38% + 13% setup (10 s… | KEEP-INGAME | needs a live region id for `wall.around {region}`. |
| 2 | wall-only plan around a region | checks READY on a claim holding the town; realiseApproved makes its own region; 2,910 cells PLACED | 41% (check 1 s + reali… | KEEP-INGAME | Java resolves the region's footprint (`wall.around {region}`) from the live registry, a real-system integration. |
| 3 | ring closed + gate | closed, 1 `min` gate | ~0% | ALREADY-OFFLINE | plan-k1a. |
| 4 | wall bars on the realised dump | as k1a-ingame #4 (318 columns, 7/7 nodes) | 1% | ALREADY-OFFLINE |  |
| 5 | no wall cell on the town footprint | `standingFootprint(townIR)` (lots, roads, paths, ways) vs wall cells outside gates: 0 | ~0% | REPLACE · structure-lint | pure data from plan files (keep-clear, lots off streets); no game state read. |
| 6 | remove wall alone | wall region removed alone: E-flat 0 over claim, town hash unchanged, town still PLACED; then town removed | 6% (5 s) | KEEP-INGAME | independence of adjacent regions under remove = undo-model (build A, build B in same claim, remove B, A untouched); keep one real run. |

#### `k1a-look`

p50 34.1 min · in 11/12 recent full slices · 31.7 step-min per slice · after all checkers keeps 0% · saves **31.7 step-min/slice** · whole step: LOOK step: recorded cameras, move to release


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | per bible (x3: g6cv_village, infernal, coastal): world open + 20 s set… | v30 on S7 natural claim checks READY (judged) | 6% (about 41 s each =… | ALREADY-OFFLINE | the only judged check besides PLACED; a kit determinism/structure check per bible replaces it. |
| 2 | per bible: realise | realised (PLACED), 4,664-4,666 cells (judged) | 4% (3 x 30 s) | KEEP-INGAME | same plan as k1a-natural. |
| 3 | per bible: before and after cameras | 6 cams (high, north, 2 gates outside, 2 inside) x before/after = 36 screenshots total | about 2% (about 5 s pe… | LOOK → release | recorded, not judged. |
| 4 | per bible: remove, leaveWorld | `dev.region.remove` result unused | **88% (3 x about 600 s… | WAIT (fix the wait) | see notes. |

#### `k1b-ingame`

p50 1.6 min · in 4/12 recent full slices · 0.5 step-min per slice · after all checkers keeps 82% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | probe (villager bar) | 9 command-built slab-deck rope-style bridges (spans 8-40, rise -5..5, widths 1 and 2) crossed both ways; holed deck refused | 24% (23 s) | KEEP-INGAME | villager pathing across slab decks; SMOKE (3 of 9) at slice, full at release or on ropeGeom change. |
| 2 | plan + golden | links_demo flat: 3 rope bridges (8/24/40), IR + tile shas = golden `links_demo_flat` | 11% (10 s) | ALREADY-OFFLINE | goldens; failed in K1b/hk3 slice runs only for stale goldens. |
| 3 | realise | 38,095 cells PLACED | 39% (37 s) | KEEP-INGAME |  |
| 4 | rope re-read | formula per deck cell, steps <= 1, rails, head room, 0 dark, 4 posts 2 deep, M3 | 6% | REPLACE · structure-lint | rope-k1b.test, M10:rope + broken variants. |
| 5 | kit movers + vanilla villager across 3 bridges | both ways (hard bar) | ~0% | KEEP-INGAME |  |
| 6 | remove E-flat | 38,095 cells, 0 mismatches | 17% (16 s) | KEEP-INGAME |  |

#### `k1b-natural`

p50 2.2 min · in 4/12 recent full slices · 0.8 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | world + tp | fresh seed world, rift site | 11% (14 s) | setup |  |
| 2 | plan + golden | links_demo natural: 3 rope bridges (35 each) from lip to lip; IR + tile shas = golden `links_demo` | 1% | ALREADY-OFFLINE | golden needs the rift survey fixture (already in goldens). Failed in hk3 for a stale golden. |
| 3 | prepare/settle wait | fixed 60 s settle + dump + snap before realise | 47% (63 s) | WAIT (fix the wait) | fixed sleep, as t3a-natural. |
| 4 | realise | 109,944 cells PLACED (also writes ways and lots) | 23% (30 s) | KEEP-INGAME |  |
| 5 | rope re-read + movers + vanilla nav | same as k1b-ingame on natural lips | 5% | KEEP-INGAME |  |
| 6 | remove E-normal | 15 mismatches all `growth`; unclassified <= 0.01% of 3,015,936 cells | 14% (18 s) | KEEP-INGAME |  |

#### `y-ingame`

p50 5.1 min · in 4/12 recent full slices · 1.9 step-min per slice · after all checkers keeps 53% · saves **0.9 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | Y survival base world ready | ~3% | KEEP-INGAME | world restore only |
| 2 | store: INSTANT twin equality | 6 targets (3 houses, 2 roads, delta target) BUILT from the stockpile equal their INSTANT twins cell for cell incl. block-entity NBT; | ~7% (~est within store… | SMOKE · ledger-lint | needs the real Builder/RoadBuilder write path; one house + one road at slice, all at release |
| 3 | store: batch placement, 3 crates, feed order | batch PLACED, only the 3 named crates placed, default feed order = batch item order | ~3% ~est | SMOKE · ledger-lint | `FeedOrderTest.batchItemsJoinInBatchItemOrder`; crate-block placement is world |
| 4 | store: delta/revert refund | v1->v3 delta and the revert are paid forward deltas; removed cells credited under one key; refund 48/returned 69, 138/138 | ~4% ~est | REPLACE · ledger-lint | model: Refunds tally of the standing blocks over a virtual cell diff + credit-once key; StockpileTest has the key rule, not the delta tally |
| 5 | item 4 conservation at 18 checkpoints | ledger identity constant across feeding and building | ~0% (rides on 2-4) | REPLACE · ledger-lint | StockpileTest.consumeAndIdentityAtEveryStep covers the ledger; lint must also interleave feed/consume/refund across several targets |
| 6 | order: setFeedOrder, unknown id FIELD_LIMIT, shuffled exact BOM finish… | house 3 first then rest; reservations counted unavailable in nextNeeded; waiting carries 3 waits (C25) | ~16% ~est (feed waits… | ALREADY-OFFLINE | `FeedOrderTest` (setFront, exactBomsFedInAnyOrderFinishInFeedOrder, surplus-only); `FullBomTest` for nextNeeded; the 45 s is hopper feed waiting |
| 7 | order: house 6 blocked by a player standing in a cell | others use only the surplus, 6 keeps its reservation, builds when the player steps out | ~7% ~est | KEEP-INGAME | player-in-site occupancy is a world query; one SMOKE copy is enough (the reservation arithmetic is in FeedOrderTest) |
| 8 | unloaded: first target wholly in unloaded chunks reserves nothing (Ste… | second target builds and C takes the cobblestone A needs; A reserves again once loaded | 12% | KEEP-INGAME | chunk load/unload state decides it (FeedOrderTest covers the rule with a stubbed loaded flag, not the real predicate) |
| 9 | refunds: deconstruct s3, undo road r1 | returned equals Refunds tally of paid cells standing (509/509); player's 3 blocks drop at the site; road 40/40; conservation 0 | 7% | SMOKE · ledger-lint | tally = items of blocks standing minus unpaid/air cells; player-block drop is a world entity |
| 10 | overflow: one-crate stockpile (27 stacks) | returned + refundOverflow = tally (485+24, 188+321); returned up to capacity; overflow = item entities at the crate | 7% | SMOKE · ledger-lint | `StockpileTest.capacityInStacks`, `refundOverflowIsOutsideTheIdentity`; the entity count at the crate is the only in-game part |
| 11 | once: injected restore failure, retry after reload | removal answers removed=false, house credited, road not; retry after reload resumes; 549 = 509 + 40 exactly once; | 8% | KEEP-INGAME | crash+resume of the real restore job; credit-once rule itself is `StockpileTest.refundsAreCreditedOncePerKey` + `C29CreditTest`; the resume order is an `undo-model` fuzz candidate |
| 12 | restart a/b: clean stop | ledger after the stop equals stockpiles.json; conservation 0 after reload; building resumes | 7% | KEEP-INGAME | `StockpileTest.persistenceRoundTrip` + `StockpileFileTest` prove the file; "building resumes" is the real thing; keep one |
| 13 | gone: crate /setblock air | missingCrates lists it, capacity 81->54, excess forced removal drops 226 items, last crate refused | 4% | SMOKE · ledger-lint | capacity/excess arithmetic is ledger-lint (StockpileTest capacity); detecting the missing crate block is world |
| 14 | dissolve (Steward) | reserved stock + building target: withdrawn/dropped identity ends at 0, crates restored, target keeps building with no stockpile, waiting re… | 7% | SMOKE · ledger-lint | identity over withdraw/drop is pure ledger; crate restore is world |

#### `c29-ingame`

p50 5.4 min · in 5/12 recent full slices · 2.5 step-min per slice · after all checkers keeps 46% · saves **1.4 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | survival base | ~9% (with start overhe… | KEEP-INGAME |  |
| 2 | c29wait item 1 | group removal waiting for a player in the site: target leaves the feed at once, reserves nothing, consumes nothing for 20 s, C is fed the fr… | 16% | SMOKE · ledger-lint | reservation release and refund = placed are ledger/Refunds; the wait itself is a real player in a cell (one SMOKE) |
| 3 | c29restart item 2 | same across a reload mid-wait: still waiting, still out of the feed, REMOVED once the player leaves, refund credited at restore not before,… | 17% | KEEP-INGAME | save/reload of the REMOVING group; credit-at-restore is `C29CreditTest`; the ledger half duplicates group 2 |
| 4 | c29stage item 4 | undoStage waits then ends, h1 fed past h2, refund 263=263; single road removal credits 40 once; RemoveResult.refund holds the credits | 15% | REPLACE · ledger-lint | same model as group 2 over stage/road removal paths; needs the removal-waits state machine as an input event, not a world |
| 5 | c29pause item 3 | `Sites.pause` of house and road, idempotent, unknown id FIELD_LIMIT, paused reserves nothing, C fed past B, order kept across reload, resume… | 12% | SMOKE · ledger-lint | `FeedOrderTest.pausedAndUnloadedTargetsDoNotReserveBlockedOnesDo` + `ApiC29Test`; reload persistence one SMOKE |
| 6 | apicompat item 14 | apitest 1.18.0/1.17.0/1.16.0 jars + surface: every referenced member exists with the same descriptor; apitest apiy1 and apic29 calls | 31% | SMOKE · ledger-lint | descriptor existence is `tools/api-compat.mjs` (also in `apijars`, `c29-unit`); only the apitest call on the live server (apic29, ~2 s) is not offline. Biggest single saver: ~91 s |

#### `pt-ingame`

p50 8.4 min · in 7/12 recent full slices · 5.1 step-min per slice · after all checkers keeps 48% · saves **2.7 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base (stale rebuild this run) | G6B Seed/Flat base recipe changed, rebuilt | 4% (20 s; ~0 on a warm… | KEEP-INGAME |  |
| 2 | record (item 1) | 200 fake-player placements track exactly 202 cells with the placer UUID; 20 bone meals and 61,494 region-stroke cells record 0 | 3% | KEEP-INGAME | real place hooks (useItemOn/useItem) and Placed.set predicate; PredicatePathsTest covers the write paths statically |
| 3 | clear (item 2) | 50 breaks, 4 TNT, water over torches: 52 records = 52 blocks; grass spread and copper weathering keep their records | 5% | KEEP-INGAME | explosions, fluid, random ticks (grass spread, copper weathering) |
| 4 | pistons (item 3) | 12 blocks pushed/pulled keep records and placers; save mid-move keeps them | 3% | KEEP-INGAME | piston block-entity movement + save mid-move |
| 5 | reload (item 4) | /save + restart hash/index equal; 600 blocks away the chunks unload, reload equal | 8% | KEEP-INGAME | restart + chunk unload/load of the attachment |
| 6 | builds (item 5) | cabin HOUSE 273, walls WALL PROVISIONAL, farm FARM 162, torches/hole/patch 0 builds, 30-cell provisional goes after grace | 5% | SMOKE · ledger-lint | build classifier is a pure function of the tracked set (no unit has it among pt-unit's named tests: gap); keep the cabin + provisional case |
| 7 | hyst (item 6) | 40 cut to 21 stays, 19 demotes after debounce + 60 s gap, regrown stays incidental, id survives +50, merge/alias, reload | 22% | REPLACE · ledger-lint | state machine over (cells, time); 60+ s is sleeping on the wall clock. Must model the tick clock and merge/alias; not one of the named linters. Keep none in game except the reload (covered by group 4) |
| 8 | village (item 7) | plan keepOut holds the cabin/wall rects; realise PLACED over a flat_village: 0 of 309 player blocks lost; findings recorded; | 10% | KEEP-INGAME | `kit/test/builds-pt.test.mjs` keep-outs; the realise skipping `player_build` and the remove restoring E-flat 0 go through the real journal (`undo-model` can fuzz the skip rule) |
| 9 | brush (item 8) | 4 stroke kinds x NATURAL_ONLY/PLAYER_BLOCKS at the cabin: 0 of 273 lost; all strokes undone E-flat 0 | 3% | SMOKE · undo-model | N copies of one proof; keep raise NATURAL_ONLY + the undo; rest is the player_build skip rule (`undo-model`) |
| 10 | felling (item 9) | felling flood stops at the cabin's logs (tree_kept.build 9), one undo exact | 3% | SMOKE · ledger-lint | one representative of tree_kept |
| 11 | undo (item 10) | consented stroke clears 93 build + 20 incidental cells; one undo E-flat 0, 229 records 0 mismatches | 2% | REPLACE · undo-model | blocks + records restored exactly after an arbitrary stroke order; model = journal + record index together |
| 12 | refusals (item 11, Steward's PATH) | building over the cabin refused PLAYER_BUILD naming build-1 with first 8 positions equal to the world; partial road span; | 4% | SMOKE · ledger-lint | refusal text derived from the tracked set; keep one + the PATH join |
| 13 | incidental (item 12) | realise over 20 torches/patch writes with no refusal, undo restores blocks and records; building over 8 incidental cells and removal | 4% | REPLACE · undo-model | E-flat 0 plus record equality for incidental cells; no vanilla behaviour |
| 14 | claim/release (item 13) | claimed pre-PT cabin kept by a stroke, released then cleared, supports kept | 3% | SMOKE · ledger-lint | claim state + stroke skip; one case |
| 15 | claimhut C34/C34b | 11 claim variants (door row, size, margin, floor in ground, Steward box) + player-use hut + C34b door-half order on ground / y 100 / +40: al… | 11% | SMOKE · ledger-lint | N copies; keep the player-use path and Steward's lifted /setblock-order repro (C34b regression from Steward), the other variants are a classifier unit over cell sets |
| 16 | plan (item 14) | `near/adjacent/endpoint {build}` on the live index; `Regions.checkPlan` fits; road ends on the apron | 3% | SMOKE · ledger-lint | `kit/test/builds-pt.test.mjs` (feature.build, endpoint.build, apron, pick); the in-game live-index call is one SMOKE |
| 17 | cost (item 15) | B/block disk/heap, setBlockState ns, classifier CPU/tick | 3% | BAR | `FAIL BAR item 15` classifier max 1.11 ms vs 1 ms budget (recorded; step still PASS because `okLines:false`) |
| 18 | apitest (item 16) | /apitest apipt: public API builds/playerPlaced/place refusal | 2% | SMOKE · ledger-lint | public API on a live server |

#### `pt-nomod`

p50 0.9 min · in 6/12 recent full slices · 0.6 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | with the mod | cabin tracked, chunk NBT holds `fabric:attachments/architect_mc:placed` | 31% | KEEP-INGAME | real save format |
| 2 | second server without Architect | never-loaded chunk keeps the attachment; a loaded one drops it (Fabric API "Skipping invalid attachments") | 54% | KEEP-INGAME | Fabric API behaviour with a mod missing (documented limit, coordinator's ruling 2026-10-13); restart on a different mod set |
| 3 | reinstall | world loads, cabin untracked (hash equal), "claim my build" restores it, a stroke leaves it unchanged | 15% | KEEP-INGAME | restart; protection part is SMOKE-able but is 8 s |

#### `pt2-ingame`

p50 5.7 min · in 4/12 recent full slices · 2.2 step-min per slice · after all checkers keeps 37% · saves **1.4 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | adopt (items 2, 3, 13) | adopt writes 0 blocks, hash equal, 277 records unchanged; entry has 296 cells/2 block entities, 0 inventory items; | 4% | SMOKE · ledger-lint | `kit/test/adopt-pt2.test.mjs` (source gives back v1 exactly), `AdoptTest`, `JournalAdoptTest`; adopt of a real cabin with 0 writes is one SMOKE |
| 2 | refusals (item 1) | ~16 ADOPT_REFUSED/FIELD_LIMIT/OVERLAP/NOT_LOADED/TOO_LARGE cases (consent, actor, tracking off, ext shape, size limits, unloaded chunk); | 29% (98 s; the 65x64x6… | SMOKE · ledger-lint | argument checks are pure; NOT_LOADED needs chunk state; TOO_LARGE needs only a bounding box, not a built 8,698-cell shell |
| 3 | flow (items 4, 5, 7, 9) | versionOf "add a floor": installed v2, capturedChanged 1 of 297, checkDelta, applyDelta KEEP of hand edits, revert, `/save` + restart identi… | 19% | KEEP-INGAME | revert hash = adopted state + edits and KEEP rule are DeltaPropertyTest-shaped; restart/unload equality needs the real thing |
| 4 | undoA/run B (item 8) | adopt then remove: hash equals pre-adopt, 0 written, records 0 mismatches; remove with its delta: storey cells gone, cabin and edits stand | 4% | REPLACE · undo-model | un-adopt/remove order over adopt+delta journal entries |
| 5 | protect (item 10) | 4 stroke kinds, felling, road, region plan, growth over a lean-to with consent: adopted cells skipped as `owned`; | 9% | SMOKE · ledger-lint | N copies of the brush proof from pt-ingame; one stroke + the un-adopt contrast |
| 6 | states (item 11) | cut to 10 cells stays ADOPTED vs ACTIVE demotes; merge keeps adopted; two adopted within 2 do not merge; split keeps largest; | 26% (90 s of waiting o… | REPLACE · ledger-lint | same classifier state machine as pt-ingame hyst, plus an `adopted` flag |
| 7 | elsewhere + c35bible | place/check of an adopted entry refuses placed_elsewhere; polish refuses; library delete refuses; C35 bible ignored for a captured source | 8% | SMOKE · ledger-lint | API refusals; C35 was Steward's repro |
| 8 | old027 (item 13) | v0.27.0's reader (built from tag) refuses adopt entry files, reads 4 others, keeps adopt rows of the index | 1% | KEEP-INGAME | old-version compat by actually running the old code |

#### `pt2-survival`

p50 0.3 min · in 4/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 73% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | start | server + survival world, stockpile of 3 crates | ~65% | KEEP-INGAME | startup (13 s of 20 in the log) |
| 2 | adopt cost | adopt costs 0, writes 0 (ledger {}, stock 0) | ~3% | REPLACE · ledger-lint | adopt as a zero-charge event on the ledger |
| 3 | update from the stockpile | versionOf "add a floor" is a construction delta fed by the stockpile (outstanding 209), no refund for the adopted roof block the hatch remov… | ~25% | SMOKE · ledger-lint | model: delta over adopted cells = pay only added cells, refund only paid cells (an adopted cell has no paid key) |
| 4 | revert / un-adopt | revert is a forward delta (paid blocks refunded, hatch log built from stock); | ~7% | REPLACE · undo-model | same model, plus the world equality via undo-model |

#### `cu-measure`

p50 0.7 min · in 2/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 100% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | start + plan | server start, cu_demo plan (123 cells, 18 warnings) | 21% | setup |  |
| 2 | realise cu_demo | tiles placed, PLACED after 30 s (123 cells) | 71% | KEEP-INGAME | real Regions.realise path (the 30 s is a constant wait: see notes) |
| 3 | weather, remove, list | unwaxed copper ticked until weathered, Regions.remove, cells that stood listed by class/block (recorded) | 5% | KEEP-INGAME | copper weathering is a vanilla random tick; recorded never judged (LOOK-like measurement) |

#### `cu-ingame`

p50 2.3 min · in 2/12 recent full slices · 0.4 step-min per slice · after all checkers keeps 48% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | item 3 | cu_demo realised, 28 of 28 unwaxed copper reach oxidized, half waxed, quarter scraped, Regions.remove: E-flat 0, kept 0 (restored 123) | 31% (9 s start + 30 s… | KEEP-INGAME | weathering needs `dev.copper.use`/random ticks; the "still ours" canonical form is `CopperTest` + `JournalPropertyTest` offline; the E-flat result through the real journal is the in-game part |
| 2 | item 6 | player mines our copper_block and places own oxidized_copper: kept 1, PT record survives | 30% | SMOKE · ledger-lint | needs fake-player interaction + PT; the rule is `StillOurs.holdsOurs` (offline-testable). Re-realises cu_demo for one cell: costs 38 s |
| 3 | item 5 (recorded) | the field corner's other drift kinds (farmland->dirt etc.) | 32% | LOOK → release | re-realises a 140-cell plan for a recorded list; vanilla farmland drift |
| 4 | item 4 | copper chests + golem statues weathered/waxed/scraped: no removal blocker, box back exactly | 7% | KEEP-INGAME | block-entity identity through remove; small |

#### `cu-survival`

p50 0.6 min · in 2/12 recent full slices · 0.1 step-min per slice · after all checkers keeps 51% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base + place | Y survival base, cu_shed construction site on the stockpile | 33% (6 s base + 6 s pl… | KEEP-INGAME |  |
| 2 | item 8a: weathering while waiting | fed all but the lightning rod, 164 built copper cells forced to oxidized (394 stages), still 259/260, consumed unchanged; | 54% | SMOKE · ledger-lint | the "does not re-queue or re-charge" claim is a Builder scan rule over a world where built cells changed block: ledger-lint must model cells changing to an equivalent block while the bill stays; |
| 3 | items 7/8c: delta over weathered cells | checkDelta (PlayerEdits REFUSE): no PLAYER_EDITS; removed cells refunded at the standing block (oxidized_copper, oxidized_cut_copper_stairs) | 5% | REPLACE · ledger-lint | refund by standing block, not planned block |
| 4 | item 8b: deconstruct after weather/wax/scrape | stockpile credited the standing blocks' items (255), 0 copper dropped, charged 259 vs refunded 259 differing by 170 named steps, terrain bac… | 8% | REPLACE · ledger-lint | per-cell charge vs refund with the weathering steps named |

#### `voc-survival`

p50 0.8 min · in 6/12 recent full slices · 0.5 step-min per slice · after all checkers keeps 33% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | start | server start + survival world | 16% | setup |  |
| 2 | item 4 | design with bedrock / reinforced_deepslate refused CREATIVE_ONLY_BLOCK; the same hut without them not | ~1% | ALREADY-OFFLINE | `kit/test/vocab.test.mjs` (generated creative-only list) and `ApiVocTest`; function of design + generated list |
| 3 | item 11 voc_shrine | bomFull lists beacon/iron_block; placed site's bill = check's bomFull (128); hopper chain fed exactly the bill builds 129/129; | 57% | SMOKE · ledger-lint | `FullBomTest` already covers bomFull; fed-exactly/refund = standing is ledger+Refunds; built==instant is the Builder write path |
| 4 | item 11 voc_copper_hall | same for 252 cells, 251 items, copper_block 88, bulb 4 (hash e1389f8304ed) | 24% | SMOKE · ledger-lint | second copy of group 2 with copper-family blocks; one design at slice, both at release |

#### `h-ingame`

p50 17.2 min · in 10/12 recent full slices · 14.1 step-min per slice · after all checkers keeps 64% · saves **5.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan on h_core_demo | Regions.checkPlan two-plan flow READY, M25/M20 0 on the plan's own check | 1% (11 s) | ALREADY-OFFLINE | kit/test/h-core.test.mjs runs M25 on h_core_demo; the Java PlanChecksHTest covers the trigger. Only the volume-read wiring is mod-only. |
| 2 | realise + census == prediction + settle | PLACED only when every body settled within settleTicks; census (sources, levels) equals `predicted` exactly; | 2.5% (30 s) | KEEP-INGAME | The only place vanilla's FlowingFluid is compared with sim.predicted. water-lint can predict; this is what calibrates it. |
| 3 | 2-minute stand at default rules | after settle nothing changes in 2 min (+0 cells) | 10% (120 s) | SMOKE · water-lint | Redundant with "no fluid tick scheduled" in #2 for the physics; it guards against slow vanilla random/fluid ticks. Keep a short stand (e.g. 20-30 s) at slice, 2 min at release. |
| 4 | single breach of each body + removal after | break one shell cell per body: flow reaches nothing beyond cells + spill + watched breach reach; | 1.3% (15 s) | SMOKE · water-lint | water-lint: sim `breach` per shell cell (BREACH_CAP) must be a superset of what vanilla does; calibrate vs this one in-game instance (4 bodies here). Sweep over all designs/shell cells offline. |
| 5 | exact undo under exact rules | exact-rules realise then Regions.remove: E-flat 0 over 376,320 cells, fluid cells by state | 4% (48 s) | KEEP-INGAME | Removal = drain (vanilla must actually empty), settle bound, then solids. undo-model can fuzz journal/overlap/order and E-flat exactness for the solid part; |
| 6 | breached bodies' removal exactness | same as #5 after the breach (E-flat 0) | 4.8% (58 s) | SMOKE · water-lint | Same exactness proof as #5 on a breached world; one of #5/#6 is enough at slice. |
| 7 | negative control: no_shell_cell with check bypassed | leaks in game within settle bound, census names the open rim cell, escape guard drains it, 0 water left | 3.3% (40 s) | KEEP-INGAME | Proves the runtime guard (mod's fluid stage) actually catches a real leak; sim only proves the offline variant is caught (h-core.test). Needs real fluid ticks + the guard code path. |
| 8 | escape guard: predict_short | a spill declared one cell short: guard drains the spout, `escaped` names the cell, region PARTIAL, 0 fluid after a bound | 3.6% (43 s) | KEEP-INGAME | Runtime guard on real flow. Could be merged with #7 (same guard path, different trigger) to save one realise. |
| 9 | protected area over a shell cell | realise-time check: pond not written, PARTIAL naming it, 0 fluid | 3.3% (40 s) | KEEP-INGAME | Real mod write path + protection; no fluid dynamics, so it could share a realise with #8 to cut 30 s. |
| 10 | removal review defects 1, 2 | fluid ticking in the watch set for ever: removal ends REMOVED in 4.8 s via the 2 x bound cap, note recorded; | 4.2% (50 s) | KEEP-INGAME | Needs vanilla ticks + a player-placed source; mod removal semantics. (Bugs found by the H batch review, see end.) |
| 11 | farm pond two-plan flow | v49: both farm lots get their pond in the 2nd plan | 1.2% (14 s) | ALREADY-OFFLINE | h-a.test.mjs (farm pond); also re-done end-to-end in ha-farm below. Pure duplicate. |
| 12 | ha-flat: plan + realise (water_demo) | READY for yard/moat/road/pond/pool/pit/fountain/falls; realised 16,475 cells, 9 fluid bodies PLACED | 5.6% (67 s) | KEEP-INGAME | The real write path at settlement scale. Duplicated in ha-ingame and ha-look. |
| 13 | ha-flat: every body's census == prediction, M25/M20/M17 0 on realised… | 9 bodies (ponds, pool, pit lava, fountain+spout, falls basin+falls, moat): sources, ice, flowing levels, no stray fluid; | 0.6% (7 s) | SMOKE · water-lint | N copies of the #2 proof over body kinds. Calibration is #2; the M-rule re-run on the realised dump is the only realised==virtual proof for fluids here, so keep one. water-lint predicts the rest. |
| 14 | ha-flat: 2-minute stand | every census still equals prediction after 2 min | 10% (120 s) | SMOKE · water-lint | Repeat of #3 on 9 bodies. |
| 15 | ha-flat: lava pit fire | random tick 300 + fire ticks for 1 min: 0 fire blocks in the claim | 5% (60 s) | KEEP-INGAME | Vanilla fire spread (random ticks); M20 models the reach statically, h-probe calibrates it. Release-only or one instance. |
| 16 | ha-flat: villager stand | 30 villagers (4 per body edge + 1 in each surface centre) 2 min: 0 drowning damage, 0 deaths, path to a bank | 10% (120 s) | KEEP-INGAME | Vanilla mob swimming/drowning. Offline M25:trap/exit (surface within 4, exit within 8) is the predictor; this is its calibration. A one-body stand calibrates; the rest is lint. |
| 17 | ha-flat: nav round every body + moat bridge | vanilla dev.nav.villager bank to opposite bank both ways, and over the moat bridge | 1.3% (16 s) | KEEP-INGAME | Real villager pathing (dev.nav.villager); cheap. |
| 18 | ha-exact | exact-rules realise (16,475 cells) + Regions.remove: E-flat 0 (16,654 cells by state) | 7.2% (86 s) | SMOKE · undo-model | undo-model should own exactness; keep as the settlement-scale instance. Duplicated in ha-ingame. |
| 19 | ha-farm (v49 + Steward's hamlet) | 2 resp. 1 farm pond: planned, realised, census == prediction, M25/M20/M17 0, Regions.remove E-flat 0 | 12.4% (149 s) | SMOKE · water-lint | Same proof as #2/#13/#5 for a pond family already covered by #13; kept for Steward's hamlet fixture (it found real RC issues). One instance in slice. |
| 20 | hb-flat: plan answers | crossing/landing/harbour answer fits/adjusted | 1.4% (17 s) | ALREADY-OFFLINE | h-wet.test.mjs; mod wiring only. |
| 21 | hb-flat: realise | 7,910 cells (wet beam, quay, harbour wall) PLACED | 3% (36 s) | KEEP-INGAME | Real write path through natural water. |
| 22 | hb-flat: wet writes re-read | 535 cells that held water/ice are the written blocks: 0 air, 0 water, 0 waterlogged under surface; M25:wet 0 on realised world | <1% | KEEP-INGAME | Real writes through natural water; also proves realised == virtual for M25:wet. |
| 23 | hb-flat: structure checks on realised world | piers solid to 2 into the bed, <=8 apart; quay solid, step down, exits every 16; M5/M6/M8/M3 clean; | <1% | REPLACE · structure-lint | Closure/clearance/walkability/light on the virtual world; re-running them on the realised dump is the only realised==virtual proof, so keep the run but it costs nothing. |
| 24 | hb-flat: nav across wet beams and onto quays | dev.nav.villager both ways | <1% | KEEP-INGAME | Vanilla pathing. |
| 25 | hb-flat: remove E-flat 0 + edge wall crossing | 7,925 cells restored; claim edge wall crosses the lake as harbour wall (plan answer) | 1.8% (21 s) | SMOKE · water-lint | Exactness repeat; crossing answer is plan-level (ALREADY-OFFLINE). |

#### `h-crash`

p50 2.0 min · in 10/12 recent full slices · 1.9 step-min per slice · after all checkers keeps 91% · saves **0.2 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan | h_core_demo two-plan flow | 9% (10 s) | ALREADY-OFFLINE | see h-ingame #1 |
| 2 | FL1+save: after shells, before any source | server halted, reopened; settle at start completes: PLACED, each body census == prediction, 0 fluid outside cells | 13% (14 s) | KEEP-INGAME | crash/kill + restart/resume of the fluids stage. undo-model can fuzz journal crash orders, but the fluid stage state machine (shells -> sources -> settle) and vanilla settle must be real. |
| 3 | FL3: stop between drain and solids of a removal | settle at start finishes the removal: REMOVED, E-flat 0 | 21% (22 s) | KEEP-INGAME | removal drain-order resume. undo-model must model the removal stages (drain, bound, solids) with stop points; the drain-empties part needs vanilla. |
| 4 | FL2+save: mid-stage, written, settling | resumes the census and completes; 0 outside; undo exact E-flat 0 | 29% (32 s) | KEEP-INGAME | crash mid fluid stage. |
| 5 | FL1, no save: shells lost with chunks | bodies drained/uncontained, PARTIAL; 0 fluid outside | 26% (29 s) | KEEP-INGAME | The case where the shells are lost: exercises the escape guard on reload; chunk save semantics. |

#### `h-probe`

p50 2.7 min · in 10/12 recent full slices · 2.3 step-min per slice · after all checkers keeps 99% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | item 14(b): relief_demo falling water | T1's committed inputs re-planned: FLUID_STATE 0, no op names fluid, the level-8 cells' source named | 0.6% (1 s) | ALREADY-OFFLINE | Pure kit, no game at all (relief-t1.test / lint FLUID_STATE in h-core.test). Runs in the game step only for convenience. |
| 2 | item 14(a): sand anomaly under natural water | a brush stroke leaves a water column alone: sand stays, no journal entry in its column; undo exact | 14% (23 s) | KEEP-INGAME | gravity (sand falls) + real write path under natural water; the dry case is tile-gravity's. A brush rule offline could cover "leaves water column alone", but the sand fall needs vanilla. |
| 3 | item 13: lava fire reach | lava pool + flammable posts 1-4, random ticks 300 for 2 min sampled every 5 s: lava lit 5 of 80 posts itself (farthest 2 sideways), 21 more… | 85% (138 s) | KEEP-INGAME | Fire spread is vanilla random ticks. This calibrates M20's FIRE_REACH (side 3, below 1, above 3). The result is vanilla-version-dependent only, so run it on a game-version bump or at release, not per slice. |

#### `h-natural`

p50 2.3 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 71% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | ha-natural: plan | S3 river-bank pond + lip-existing waterfall READY | 4.6% (21 s) | ALREADY-OFFLINE | h-a.test.mjs. |
| 2 | ha-natural: realise + census == prediction | 630 cells, 3 bodies settled, census equals prediction at a natural site | 14% (63 s) | KEEP-INGAME | Prediction against natural water/terrain neighbours (flowing_water cells in the world): extends the calibration to non-flat sites. |
| 3 | ha-natural: villager stand | 15 villagers 2 min: 0 drowning damage | 26% (120 s) | SMOKE · water-lint | repeat of h-ingame #16 on a natural site. |
| 4 | ha-natural: nav round every body | bank to bank both ways ({w_falls_basin:[false,true]} accepted: banks unjoined on the restored world too) | 3% (14 s) | KEEP-INGAME | vanilla pathing. A real discrepancy was found here (see notes). |
| 5 | ha-natural-exact: realise + removal E-normal | 392 mismatches all classified (live 1, flow 391), 0 unclassified, 0 gravity, none within 6 of a body/shell/watch cell | 21% (94 s) | KEEP-INGAME | E-normal exactness classified by cause; undo-model's E-normal classifier covers the solids, but "flow"/"live" mismatches arise from vanilla fluid and mobs, so the in-game census stays as the calibration. |
| 6 | hb-natural: S3 crossing/landing answers | landing adjusted, crossing refused HEADROOM, no `until` | 4% (18 s) | ALREADY-OFFLINE | plan-level (h-wet.test). |
| 7 | hb-natural: quay realise | 93 cells PLACED | 20% (93 s incl. | KEEP-INGAME | write path through natural water. The 63 s before PLACING is world/chunk setup. |
| 8 | hb-natural: wet writes re-read, M25:wet, quay solid, M5/M6/M8/M3, nav | as h-ingame #22-24 on a natural site | 2% (9 s) | KEEP-INGAME |  |
| 9 | hb-natural: E-normal removal | 2 mismatches (live 2), 0 unclassified, 93 cells | 5% (21 s) | SMOKE · water-lint |  |

#### `h-cold`

p50 0.4 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 84% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | ha-cold: plan + realise | ice-capped pond + uncapped twin, 644 cells, 2 bodies settled (82 + 46 sources) | 15% (51 s) | KEEP-INGAME |  |
| 2 | ha-cold: ice cap is planned | 51 cap cells in the plan | 2% (6 s) | ALREADY-OFFLINE | h-a.test ice caps; M17 planned light over ice. |
| 3 | ha-cold: freezing stand + probe | after 2 min every capped surface cell reads ice (51/51); uncapped twin: 31 of 31 surface cells froze on their own (recorded) | 36% (120 s) | KEEP-INGAME | vanilla random-tick freezing on the cold site. Records the freeze fact the plan depends on (cap before it freezes, sources only). Calibrate once per game version. |
| 4 | ha-cold: removal | no water/ice where the snapshot had none (0 cells) | 7% (23 s) | SMOKE · water-lint |  |
| 5 | hb-cold: plan answers | landing adjusted; crossing refused WATER deep; no `until` | 5% (16 s) | ALREADY-OFFLINE |  |
| 6 | hb-cold: quay realise | 110 cells PLACED, ~61 s setup before PLACING | 27% (91 s) | KEEP-INGAME |  |
| 7 | hb-cold: wet writes, M25:wet, quay checks, nav | 54 cells that held water/ice are the written blocks; nav both ways | 2% (6 s) | KEEP-INGAME |  |
| 8 | hb-cold: E-normal removal | 0 mismatches, 110 cells | 6% (20 s) | SMOKE · water-lint |  |

#### `6ch-look`

p50 3.2 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | hb-look (default, infernal, coastal bibles) | wet scene plan READY, realise 7,910 cells, camera shots of quay/harbour wall | 87% (167 s) | LOOK → release | Noah's taste review; one tier decision. |
| 2 | ha-look (same as ha-look step) | 21 shots of H-a's bodies + moat bridge in 3 bibles (see ha-look) | ~250 s ~est (not in th… | LOOK → release | duplicate of ha-look step |

#### `ha-ingame`

p50 8.4 min · in 2/12 recent full slices · 1.7 step-min per slice · after all checkers keeps 0% · saves **1.7 step-min/slice** · whole step: duplicate: runs inside h-ingame


Its groups are the ha-* halves listed inside the matching h-* step (h-ingame: ha-flat, ha-exact, ha-farm; h-natural: ha-natural; h-cold: ha-cold; 6ch-look: ha-look), with the same dispositions.

#### `ha-natural`

p50 4.9 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: duplicate: runs inside h-natural


Its groups are the ha-* halves listed inside the matching h-* step (h-ingame: ha-flat, ha-exact, ha-farm; h-natural: ha-natural; h-cold: ha-cold; 6ch-look: ha-look), with the same dispositions.

#### `ha-cold`

p50 3.4 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: duplicate: runs inside h-cold


Its groups are the ha-* halves listed inside the matching h-* step (h-ingame: ha-flat, ha-exact, ha-farm; h-natural: ha-natural; h-cold: ha-cold; 6ch-look: ha-look), with the same dispositions.

#### `ha-look`

p50 4.2 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan x3 bibles (default, g7ak1_infernal, g7ak1_coastal) | water_demo READY per bible | 28% (69 s) | ALREADY-OFFLINE |  |
| 2 | realise x3 | 16,475 cells PLACED, bodies settled | 44% (110 s) | KEEP-INGAME |  |
| 3 | 21 camera shots | pond, pool, pit, fountain, falls, moat, moat bridge x3 bibles | 26% (64 s) | LOOK → release | recorded, not judged |

#### `hy-ingame`

p50 18.2 min · in 6/12 recent full slices · 14.1 step-min per slice · after all checkers keeps 59% · saves **5.8 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | plan hy_core_demo | two-plan flow READY (feed, stream) | 0.7% (13 s) | ALREADY-OFFLINE | hy-core.test |
| 2 | realise: write order downstream first, S-HY-6 rows, settle, census ==… | each body written after its landing settled (r3, r2, r1, feed); census exact incl. fall lip/column/landing/spillway film; settleTicks | 1.6% (30 s) | KEEP-INGAME | The `predicted` model for courses (levels, lips, columns, films) vs vanilla. Order itself is `writeOrder` (checkFluids.mjs) = REPLACE via water-lint/ALREADY-OFFLINE (M25:order), and "each after its landing settled" is a mod-stagin… |
| 3 | 2-min stand | adds nothing | 6.3% (120 s) | SMOKE · water-lint | repeat |
| 4 | single breach of a bank, a weir cell, a lining cell + removal | flow reaches nothing past bodies' cells/spill/breach reach/joins; weir breach connects nothing | 0.9% (17 s) | SMOKE · water-lint | water-lint `breach`; the weir 2-thick M25:shell rule is already offline |
| 5 | exact undo (E-flat 0) head first then down the course | 2.9 s removal | 3.4% (65 s) | SMOKE · undo-model | undo-model for exactness + removal order; drain order head-first KEEP one |
| 6 | exact-breach undo | E-flat 0 after breach | 3% (57 s) | SMOKE · water-lint | duplicate of #5 |
| 7 | negative control: _unsafe.noLiningCell | feed's spillway floor missing leaks, census names the cell, guard drains, PARTIAL | 2.4% (45 s) | KEEP-INGAME | runtime guard vs real flow (offline variant caught in hy-core.test) |
| 8 | negative control: _unsafe.wrongOrder | head written first pours into r2's empty basin; guard drains | 2.5% (48 s) | KEEP-INGAME | `writeOrder` is offline; this proves what the order protects against and that the guard catches it. |
| 9 | escape guard: predict_short on middle reach | r2 drained, escaped named, upstream closure (r1, feed) drains across parts; r3 stands; 0 fluid after bound | 2.5% (48 s) | KEEP-INGAME | runtime guard + upstream closure |
| 10 | protected area over a weir cell | r1 not written, feed not written, downstream stand, 0 water | 2.3% (43 s) | KEEP-INGAME | real write path/protection |
| 11 | capped removal | fluid ticking whole removal: cap 2 x 50 ticks, REMOVED 5.4 s, E-flat 0 | 2.7% (51 s) | KEEP-INGAME | vanilla ticks + removal cap |
| 12 | stale guard buffer | block set in r2's guard buffer after check: realiseApproved ARTIFACT_STALE naming reach, nothing written | 0.7% (13 s) | KEEP-INGAME | the approval-guard (frozen volume sha) is Java; could be a Java unit test. |
| 13 | fall damage (recorded) | 12 (depth, height) combos: 0 damage landing in water | 1.8% (35 s) | KEEP-INGAME | vanilla fall damage into water; calibrate once. |
| 14 | probes p01/p01b/p02: riffles 2/4/6 per drop x 1-3 drops, long run past… | 9 courses: plan READY, guards flat, realise, census == prediction | 9.4% (179 s) | SMOKE · water-lint | This is the sweep that calibrates `predicted` over geometry. Keep as the calibration table (record per-body diffs); after it passes, water-lint (sim.predicted) is trusted over the whole family offline. |
| 15 | nav v57b + v50 + swept stand | villager both ways over every bridge on a course and round terminal pools, no path cell in a fluid; | 14.9% (283 s) | KEEP-INGAME | villager pathing, drowning, fall damage in a course. Swept stand 120 s = SMOKE (same as h-ingame #16). |
| 16 | "every new kind" v50-v57, v57b, v59, steward (12 designs): plan, guard… | 3-4 s removal each | 34% (649 s) | SMOKE · water-lint | N copies of the same proof (~54 s each) over design kinds: brook, canal, leat, race, ditch, fountain, moat+brook, hamlet. One per writer kind in slice (stream, canal/weir, race, ditch, fountain-fed); all 12 at release. |
| 17 | water gate hy_gate_demo | refusals sealed/max (UNREACHABLE), crossing, guard flat, grate cells joined bars 12/12, lintel 6/6, census 48/48, dev.nav.villager never thr… | 7.3% (139 s) | KEEP-INGAME | mob physics (0.6-wide mob through unjoined bars) is vanilla; the geometry is checkable. |
| 18 | v58: routed course through a ring wall | water gate on a ring wall: grate/lintel, nav goes round through a walk gate, E-flat 0 | 3.1% (58 s) | SMOKE · water-lint |  |

#### `hy-crash`

p50 4.0 min · in 6/12 recent full slices · 2.1 step-min per slice · after all checkers keeps 59% · saves **0.9 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | FL1+save (after shells and lining) | restart settle completes, PLACED, census == prediction, 0 outside | 12% (27 s) | SMOKE · water-lint | repeats the h-crash stage on a course |
| 2 | FL1+save undo exact | E-flat 0 | 2.6% (6 s) | SMOKE · water-lint |  |
| 3 | FL4+save (between reaches: downstream written, upstream not) | settle at start completes the realise; census; 0 outside | 12% (27 s) | KEEP-INGAME | stage unique to courses (resume across reaches) |
| 4 | FL4 undo exact | E-flat 0 | 2.6% (6 s) | SMOKE · water-lint |  |
| 5 | FL5+save (removal between the head and the tail) | settle at start finishes the removal REMOVED, E-flat 0 | 27% (61 s: realise 44… | KEEP-INGAME | course-specific removal resume |
| 6 | FL3 (between drain and solids) | finishes removal REMOVED, E-flat 0 | 44% (100 s: realise 44… | SMOKE · water-lint | repeat of h-crash on a course; keep FL5 and FL4 (the course-specific ones), drop FL1/FL3 at slice |

#### `hy-natural`

p50 1.7 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 48% · saves **0.0 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base | fresh bases "stale (recipe ...)" rebuilt | 18% (23 s) | setup |  |
| 2 | S3 pinned claim plan + guards flat | brook READY, 3 guards | 13% (17 s) | ALREADY-OFFLINE |  |
| 3 | realise + census == prediction + nav (0 walks, vacuous) | 3 reaches (14/14/22 sources), census exact; dev.nav.villager walked 0 paths | 25% (32 s) | KEEP-INGAME | natural-site calibration |
| 4 | natural-exact: plan, realise, Regions.remove E-normal | 0 mismatches | 44% (56 s) | SMOKE · water-lint | exactness repeat |

#### `hy-cold`

p50 6.5 min · in 6/12 recent full slices · 3.2 step-min per slice · after all checkers keeps 80% · saves **0.6 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | freezing probe on frozen site 2026101102 (recorded) | 2 min random ticks 300: 33 of 87 source cells froze, 0 of 18 flowing/falling | 40% (158 s) | KEEP-INGAME | vanilla random-tick freezing, sources only (§1.7 assumption). Same fact as ha-cold's probe; run once per game version. |
| 2 | cold: plan + realise (capped brook with submerged outlet and fall + un… | READY, 4 bodies PLACED, census == prediction | 14% (54 s) | SMOKE · water-lint |  |
| 3 | cold stand + freeze probe on the course | 120 s: only the twin's sources froze (253), brook's caps hold | 30% (120 s) | KEEP-INGAME |  |
| 4 | cold-exact + E-normal removal | plan, realise, 0 mismatches | 16% (63 s) | SMOKE · water-lint |  |

#### `6chy-look`

p50 10.9 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | base |  | 4% (25 s) | setup |  |
| 2 | plan + realise + census of 10 scenes in 3 bibles (default: stream, can… | same plan/realise/census as hy-ingame #16 | ~80% (~520 s ~est) | KEEP-INGAME | the scenes only need realising; census repeats |
| 3 | 32 camera shots | recorded not judged | ~16% (~105 s ~est) | LOOK → release |  |

#### `kc-ingame`

p50 2.4 min · in 2/12 recent full slices · 0.4 step-min per slice · after all checkers keeps 29% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | v51 plan + realise (ring repaired) | READY, PLACED, w_fount 24 sources + spout settled, census == prediction | 36% (51 s) | SMOKE · water-lint | repeat of the fountain census (h-ingame #13) |
| 2 | M25:clear 0: the wall writes 0 cells of the fountain's sets | basin, spout, shell, spill, watch: 0 | 0% | ALREADY-OFFLINE |  |
| 3 | v51 Regions.remove E-flat 0 | 3.3 s | 4% (6 s) | SMOKE · water-lint |  |
| 4 | k01 (v51 as VOC committed it) | in game checkPlan answers the wall OVERLAP {kind: body, part: fount}, wouldFit ring [4,17], fountain fits, overall NEEDS_REPAIR | 13% (19 s) | ALREADY-OFFLINE | kc.test.mjs: OVERLAP {kind: body} with its wouldFit re-checked alone; keep only the Java wiring (PlanChecksHTest) |
| 5 | v61 plan + realise | town + wall + moat + brook + fountain + pool: 5 bodies, 20,531 cells | 41% (58 s) | SMOKE · water-lint |  |
| 6 | v61 water gate | wall's meta waterGates; grate 12/12 joined waterlogged bars; lintel 6/6 at y 74 | 0% | SMOKE · structure-lint |  |
| 7 | v61 Regions.remove E-flat 0 | 4.6 s | 6% (8 s) | SMOKE · water-lint |  |

#### `irr-ingame`

p50 4.2 min · in 1/12 recent full slices · 2.4 step-min per slice · after all checkers keeps 86% · saves **0.3 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | v62 live: plan, realiseApproved with bound field entries, census == pr… | all from one realise of two irrigated farms | 2.4% (51 s) | SMOKE · structure-lint | irr.test.mjs already proves the mask, the grid, irrigationDropped; the realised mask re-read is the realised==virtual proof. |
| 2 | hydration after 540 s | every farmland cell of the field moisture=7 (78/78), the dry control field 0 of 88; crops planted | 26% (542 s) | KEEP-INGAME | random-tick hydration (FarmBlock.isNearWater within 4 horizontally). irr.test's grid proves the geometry; this proves vanilla agrees. Calibrate once per game version; the wait (540 s) is a vanilla random tick wait. |
| 3 | 3 farmer villagers 5 min | drowning 0, 3 alive; harvest/replant ripe wheat 23 -> 31; nav round every source both ways, no path cell in a source | 14% (300 s) | KEEP-INGAME | villager nav + farming (vanilla). |
| 4 | live-world removal (recorded) | E-flat 44,749 (crops, mobs: "not as hoped", recorded not judged) | 0.3% (6 s) | BAR |  |
| 5 | v62a: artifact/mask/census repeated | same as #1 on a second realise | 2.5% (52 s) | SMOKE · water-lint |  |
| 6 | item 4: one farmland side broken | water stays in own lot's box (1 new fluid cell, 0 outside); fluid row recorded | 1.4% (30 s) | SMOKE · water-lint | water-lint breach (M25:keep outside its lot) with the field-model limit recorded (pad has no lot entry: 73 cells, 8 outside). irrBreachOut caught offline. |
| 7 | item 5(c,d): versionOf replacement | field entry v2 (carrots): mask holds, sources unchanged census-exact; no irrigation cell in a site entry (ownership) | 0.2% (5 s) | KEEP-INGAME | site delta + ownership; the mask offline already proves. |
| 8 | item 5(b): f2 site removed alone (S-IRR-4) | 1 source drained first and exactly, 0 water left, region still PLACED, farmland sides 4/4 | 6% (125 s) | KEEP-INGAME | lot removal drain order (S-IRR-4); undo-model must model "remove a lot site with its sources" as a partial removal. |
| 9 | breach fix: pond + player's well beside f2, breach trench to box edge,… | drain takes the breach flow back, spares pond 4/4 and the well; Regions.remove REMOVED, E-flat over f2 box 0 | 10% (216 s) | KEEP-INGAME | drain vs vanilla flow with foreign water; undo-model cannot model vanilla flow. |
| 10 | item 5(a) full region removal with every lot standing | E-flat 0 | 2.8% (58 s) | SMOKE · undo-model |  |
| 11 | h0 control (farm_hamlet without irrigate) | E-flat 0, equals s01's | 2.7% (57 s) | SMOKE · undo-model | control for the hamlet's lantern E-flat; undo-model |
| 12 | v63 (40 x 40 farm, 25 sources, 175 irrigationDropped), s01 (hamlet, 4… | each: plan READY, realiseApproved, census == prediction, irrigation frame, mask held, E-flat 0 | 8.6% (181 s) | SMOKE · water-lint | three more copies of #1 over lot kinds. irr.test covers detection/grid/mask over sizes 3..62 and all of v63/s01/d01. |
| 13 | broken variant irrUnmasked | live check refuses every source (uncontained), PARTIAL, E-flat 0 | 2.7% (56 s) | KEEP-INGAME | the guard/refusal at realise time; offline variant caught by irr.test. |
| 14 | bare pad breach | 73 new cells, 8 outside the lot's box (field-model limit, recorded) | 4% (86 s) | KEEP-INGAME | records the model's limit. |
| 15 | hydration reach probe (recorded) | 5 min: c9 79/80, c11 78/120, corner 24/80, over 80/80, under 0/80 | 14.7% (309 s) | KEEP-INGAME | calibrates irrigate.mjs HYDRATE reach (4 horizontal, level or 1 over). Same wait-heavy vanilla random tick fact as #2; combine to cut ~5 min. |

#### `irr-crash`

p50 2.7 min · in 1/12 recent full slices · 0.2 step-min per slice · after all checkers keeps 65% · saves **0.1 step-min/slice**


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | FL1+save on v62 | restart settle at start completes: PLACED, every source settled, 0 fluid outside | 22% (36 s) | SMOKE · water-lint |  |
| 2 | FL2+save | same, fluids 1/2 at kill | 22% (36 s) | SMOKE · water-lint |  |
| 3 | FL6+save on a lot removal's drain | drain saved ('lot removed: f2'), the removal asked again finishes, 0 water in the lot | 47% (76 s: realise 52… | KEEP-INGAME | lot-removal resume is unique to IRR; undo-model needs "lot removed" partial-removal state |
| 4 | region afterwards Regions.remove E-flat 0 (x3) | 2.7, 2.7, 2.4 s | 9% | SMOKE · undo-model |  |

#### `irr-look`

p50 1.6 min · in 0/12 recent full slices · 0.0 step-min per slice · after all checkers keeps 0% · saves **0.0 step-min/slice** · whole step: LOOK step


| # | assertion group | what it checks | share | disposition | why / what the checker must model |
|---|---|---|---|---|---|
| 1 | v62 realise with bound field entries | PLACED, 5 bodies | 14% (54 s) | KEEP-INGAME |  |
| 2 | 5 shots (overview, fields, a source close up) at noon | recorded, not judged | 86% (~320 s) | LOOK → release | the long tail is camera/render settling and the time-of-day wait (est.) |
