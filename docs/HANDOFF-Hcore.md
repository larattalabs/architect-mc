# HANDOFF: slice H-core (the fluid foundation)

Resume notes for slice H-core (docs/CONTRACT.md "Phase 6c slice H", FROZEN 2026-10-18, §15 step 1). Branch `slice/H-core` in
`../architect-mc-Hcore`; the frozen shared interface is pushed as `h/core` for H-a (water bodies) and H-b (wet structures). Ports
8912-8917, at most 3 slots. Placeholders: API 1.34.0, mod 0.37.0, kit 0.35.0, catalogue 7 (the coordinator renumbers at merge).
Delete this file when the gate passes (its interface becomes "H-core as built").

## The shared interface (frozen, round 1, `h/core`)

What H-a and H-b build against. Every module a sibling owns exists with its final name and exports, as an inert stub that answers (never
throws a placeholder): an H part answers `refused UNREACHABLE` with `until: 'Ha'` / `'Hb'` at resolve, so no body is emitted and every
plan compiles exactly as without it.

| What | Where | Shape |
|---|---|---|
| Plan schema | `kit/schemas/plan.json` | defs `form.pond`, `form.fountain`, `form.waterfall`, `form.quay`, `connector.channel` (§5); `waterDepth` on `connector.wall` (0..8) and `connector.bridge` (0..16); `farmPond` on a lot and on `zone.standard` (S-H-2, opt-in); x-rules R21-R23; codes `LEAK`, `FIRE` appended |
| Validator | `kit/lib/plan/schema.mjs` | R21: `channelForm(part)` (moat \| course \| null: malformed); a from/to channel answers `unsupported {channel.course, until: HY}`; a fountain's basin odd; a lava pond 1..2 deep. R22/R23 are the compiler's (H-a) |
| Catalogue 7 | `plan.json` x-catalogue, golden `kit/schemas/plan-catalogue.golden.json`, archive `kit/test/fixtures/plan/catalogue-t3.json` | flips `form.pond`, `form.waterfall`, `connector.channel`; new `form.fountain`, `form.quay`, `channel.moat` (supported), `channel.course` (reserved, HY); limits `waterDepth` on wall and bridge; notes on `bridge.beam` and `connector.tube`; sinceApi 1.34.0. `diffCatalogues` reports a note that arrives with a flip as part of the flip |
| Kinds (leaf) | `kit/lib/fluids/kinds.mjs` | `BODY_FORM_KINDS` pond, fountain, waterfall; `WET_FORM_KINDS` quay; `H_CONNECTOR_KINDS` channel; `FLUIDS_STAGE` 'fluids'; `isHPart`, `isBodyPart` |
| Compiler hooks | `kit/lib/fluids/hooks.mjs` (H-core) dispatching by kind to `pond.mjs`, `fountain.mjs`, `waterfall.mjs`, `moat.mjs` (H-a) and `quay.mjs` (H-b) | each module: `resolve(C, p) -> {klass, rect?, footprints?, reasons?, deviations?, notes?, wouldFit?}` (compile step 2, with the forms; C = {env, ctx, plan, V, byId, geom, geomOf, res, answers, okClass, tolOf, judge, notes, order, taken}); `emit(K, p, res)` (step 3, before the routes; throw `'CODE: message'` to refuse; K is compile.mjs's makeK context); `answer(K, p, res) -> {geometry, cost, notes, deviations} \| null` (step 6). `pond.stageWanted(C)` (a farm lot's pond brings the fluids stage); `moat.passInput(K)` (the route pass's `fluids` input: plan water the routes keep 1 off; null: none) |
| Wet fallback | `kit/lib/fluids/wet.mjs` (H-b) | `wetBridgeFallback(K, l, m, why) -> leg options \| null`, called in compile.mjs's route rounds after T3's street fallback, for a leg failing `ROUTE_WATER` or `BRIDGE` (once per leg, `l.wet`); `wetWallFallback(K, wall, failure) -> options \| null`, called by H-b from wall.mjs where a ring or line fails on `OB.WATER`. Costs (§8): +10 per wet pier cell; wet wall columns 3 a cell (dry 1) |
| Stage list | compile.mjs | `[..., 'lots', 'props', 'fluids']`: `fluids` appended last only when `fluidStageWanted` (a body part fits, or `pond.stageWanted`); `stageOf('routes' / 'lots' / 'props' / 'links')` never falls into `fluids` |
| The body | `r.fluidBody(cells, opts)` (`kit/lib/fluids/body.mjs`, bound late into program.mjs) | opts `{id, part, kind, stage (the shell's), shellPart?, fluid='water', level?, shellRole='structure' \| block \| (x, y, z, 'floor' \| 'side' \| 'rim') -> material \| null (the generator writes it), outlets?, joins?, ice? (true \| cells), solid?, world?, volume = true, breach = true, _unsafe?: {noShellCell, predictShort, flowingState}}`. It writes the shell (columns op, ALWAYS_OURS) in `stage`, asks `needVolume(box grown by 2, by 9 when raised, {fluids: true})` (skipped past 4,000,000 cells: `volumeState 'cap'`), simulates the flow over the plan's own draft virtual world (the earlier ops, the shell, the frozen volumes), and emits the `fluid` op in part `id`, stage `fluids`. Returns `{id, part, kind, fluid, level, cells, shell, spill, joins, watch, ice, predicted, settleTicks, path, findings, raised, volume, volumeState, guardRuns}`; records `r.meta.waters` |
| The `fluid` op | IR (format 2, `requires: ['fluid']`) | `{op: 'fluid', id, part, fluid, level, cond: 2, walk: false, cells, ice, shell, spill, joins, watch: [[x, z, y0, y1]] (column runs), predicted: [[x, y, z, level]] (non-source cells: 1..7 flowing, 8 falling), settleTicks}`. The evaluator writes `cells` as sources and `ice` as ice; the rest is the mod's. A frozen volume with the fluid layer adds `volume:fluids` |
| Shell rule | `shellOf(cells, {open})` | face neighbours not in the body, plus the cell one over each side wall beside a surface cell; never the cells over the surface, never an outlet |
| Flow | `kit/lib/fluids/sim.mjs` | `simulate(world, bodies, {breach}) -> {bodies: [{id, reached, spill, predicted, path, settleTicks, breach?}], reached, predicted, findings}`; `world.at(x, y, z)` -> 'stop' \| 'open' \| 'water' \| 'lava' \| 'flowing_water' \| 'flowing_lava', optional `keep`, `shell`, `surface`, `exit`, `solid`. `reach()` (conservative), `steady()` (vanilla's FlowingFluid replayed), `settleBound(fluid, path)` = delay x (path + 2) + 20 |
| Wet records | `recordWet(r, {id, part, kind: pier \| wall \| quay, columns: [[x, z, y0, y1]] (bed - 3 .. surface + 1), volume})` -> `r.meta.wet` | read by M25:wet, the guards and the mod |
| Checker | `kit/lib/region/checkFluids.mjs` | M25 (leak, convert, mix, shell incl. "no volume", keep with the single breach, wet, trap, exit, model) per body, M20 for lava bodies; `RULES` gains M20, M25 (errors); runs only when the IR has a fluid op or meta.wet. `FIRE_REACH` {side 3, below 1, above 3} until item 13's probe |
| Blocks | `kit/lib/blocks.mjs` (generated) | `isFluidStopping(name)` (`fs`: 26.3's canHoldFluid refuses flowing water and lava: canHoldAnyFluid is a LiquidBlockContainer or the tag `washed_away_by_fluids`), `isFlammable(name)` (`fl`: ignitedByLava or ignite odds > 0); BlockDump.java dumps both facts. The biome `freezes` table: round 2 |
| Volumes | `kit/lib/region/volume.mjs` | ARVX version 3 = version 2 + per-column fluid runs (`FLUID_CODES`: none, water_source, water_flowing, water_falling, waterlogged, lava_source, lava_flowing); `fluidAt(v, x, y, z)`; `encodeArvx(..., blocks, fluids)`; the virtual world reads flowing (level 1) and falling (level 8) cells from it |
| Guards | the compile record's `links.guards` -> the artifact's `guards` (finish.mjs) | `{part, body, kind: 'body' \| 'wet', fluids: true, volume: {sha, box: [x0, y0, z0, x1, y1, z1]}, runs: [[x, z, y0, y1]]}` (a body: its shell, the buffer within 2 behind it, its joins; a wet record: its columns). realiseApproved compares classes and the fluid layer there (round 2, Java) |
| siteplan/1 | `kit/lib/region/siteplan.mjs`, `kit/schemas/siteplan-1.json` | `waters: [{id, part, kind: pond \| fountain \| waterfall \| moat \| farm_pond \| well, fluid, level, cells, spill, ice}]` (counts) from meta.waters; `quays: [{id, part, along: [[x, y, z], [x, y, z]], length, reach, wetCells}]` from meta.quays (H-b) |
| Realise report | Java (round 2) | the region's `fluids: [{part, body, state: 'settled' \| 'drained', reason, at}]` (S-H-6), extras `{sources, spill, settledAt, escaped}` |
| Versions and features | | API 1.34.0, mod 0.37.0, kit 0.35.0 (`KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION`), `PLAN_API` 1.34.0; features `regionFluids` + `fluidVolumes` (sidecar `region.fluids`), `wetWrites` (sidecar `region.wet`); `IrStale.KINDS_FORMAT2` + `fluid`, `volume:fluids` |
| Gate | `tools/gate6ch.mjs`; steps `h-unit`, `h-ingame`, `h-crash`, `h-probe`, `h-natural`, `h-cold`, `6ch-look` (gate-chains.json) | H-a's items in `tools/lib/gate6ch-a.mjs`, H-b's in `tools/lib/gate6ch-b.mjs` (`items[step] = [{name, run(ctx)}]`, run after H-core's); H-core's in `tools/lib/gate6ch-core.mjs`. Item 11's byte identity: `gate6ch-core.mjs unchanged(root)` (59 of 59 committed fixtures without an H part identical to origin/main at round 1) |
| P0 coverage | `kit/test/fixtures/plan/h-pending-a.json` (H-a), `h-pending-b.json` (H-b) | the supported ids whose valid/ fixtures land with each half; each half deletes its file |
| Test helpers | `kit/test/h-helpers.mjs` | `synthVolume(box, survey, claim, {fluids, edits})`, `planTwice(planRegion options)` (the two-plan flow in process) |

Not H-core's (left to the halves): retiring `until: 'H'` at `bridgeGeom.mjs:246` and `compile.mjs`'s street fallback answer (H-b,
§8.4); the farm pond and the wet well (H-a); `form.hidden_room` handling for the waterfall's hollow (H-a, S-H-7); R22/R23 answers (H-a).

## Round 2 (H-core's own, after the freeze)

- Java: ARVX v3 sampling (`VolumeSurvey`, `Arvx`, a cross-language fixture); the plan check's trigger (`PlanChecks.check0`: a body part,
  a quay, or meta `wet.asked`) and the fluid guards in `realiseApproved` (classes and the fluid layer); the `fluids` stage
  (`RegionFluids`: the live shell and joins check per body, occupancy waits as ITEM_WAITING, watched cells journaled, forced ticks,
  settle and census, the escape guard draining and reporting PARTIAL, the per-body report); exact undo (drain first: sources and ice,
  the watched cells holding new fluid, one settle bound, persisted across a crash; then the group undo); `StillOurs` for fluids;
  dependents under natural water; crash settle; DevBridge `dev.fluid.census`, `dev.fluid.tick`, `dev.entity.damage`.
- Kit: the biome `freezes` table; the narrowed T1 `flow` class; the probes (sand anomaly, T1's falling water, the fire reach).
- Gate: items 1-3, 5-7, 13 (fire reach), 14 and 17 on h_core_demo, headless, with the new runner.

## Status

- Round 1 (the interface): kit done and tested (h-foundation 4/4, h-core 7/7, P0/K1/T3 foundation tests green, byte identity 59/59).
- The sand anomaly: chore/housekeeping-2's fix (70fc0dd0, `TileCheck.keepsGravity`) is merged into this branch, not duplicated.
- v0.36.0's apitest and mod jars built from the tag into `<main>/artifacts/gate6c-h/v0360` (with its tools/).
