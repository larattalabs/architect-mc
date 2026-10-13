# HANDOFF-P0: plan check v0 (slice P0)

Resume notes for `slice/P0` (worktree `../architect-mc-P0`, from origin/main 15fa03e = v0.25.0, API 1.22.0). Delete when the gate passes.

## Placeholders
API 1.23.0, mod 0.26.0, kit 0.25.0 (the coordinator assigns the real numbers at merge). Ports 8906-8911. $0 (sim/stub only).
Slice PT runs in parallel. Conflict points with PT: `kit/schemas/plan.json` (PT adds `feature.build`, `target.build`,
`endpoint.build`; P0 does not touch those defs), the catalogue golden `kit/schemas/plan-catalogue.golden.json`, `api/Reason.java`
(both append: P0 `ARTIFACT_STALE`, `ARTIFACT_UNAPPROVED`; PT `PLAYER_BUILD`), the FEATURES list, `ArchitectApi.VERSION` and the
version tests (`Api*Test`), `IrStale.KIT_VERSION`/`KIT_VERSION`/`EVAL_KIT_VERSION`, `tools/gate-chains.json`.

## Decisions (recorded before the resolver; they go to the as-built section)
1. **Brushes stay `unsupported` in P0.** A B stroke is one region per stroke (S-B-1). Its destruction and layering rule live on
   the stroke region's own record (`RegionRec.brush`, read by `site/TileCheck` for every tile of that region; ARTL's two condition
   bits are full, so the rule can't ride on an op). Folding a stroke into `plan_v0`'s single region (S-P0-1) would change how tile
   checks treat ordinary regions. So `form.brush` stays reserved. Its catalogue `until` moves from `B` (shipped, misleading) to
   `P1` (a later plan slice) with a `note`; `tools/plan-catalogue-diff.mjs` reports `until` changes.
2. **N-P0-1 templates** (`program.crater_works`, `program.rift_city`, `program.floating_islands`, additive catalogue entries,
   supported). They plan a whole claim and call `region(ctx)` themselves, with minimum claim sizes. Rule: such a template zone
   compiles only as the plan's **sole zone over the whole claim** (its rect is the claim; it runs first, with its own params, on
   the region `plan_v0` then adds routes and forms to). Another zone beside it is refused `OVERLAP`; a claim outside the program's
   catalogue claim range is refused `NO_ROOM`. `flat_village` is different: it compiles in its zone's rect like a lots program.
3. **Artifacts live world-side** (`<world>/architect-regions/artifacts/<sha>.json`, pins and tombstones beside), written by the mod
   from the kit's canonical body. `artifact(sha)` is synchronous and survives a restart. The sidecar's plan dir keeps the IR.
4. **The stale rule is exact.** `realiseApproved` re-surveys the claim at the artifact's survey resolution with the same codec
   and compares every column (ground, height, floor, flags) inside the plan's tiles with the plan survey. Any difference refuses
   `ARTIFACT_STALE` naming the columns. Natural drift (flowing water, leaves) can make an artifact stale: Steward rechecks
   cheaply. The gate runs under `/tick freeze`. Protection: the fingerprint (every protected area and every other owner's standing
   region meeting the claim, sorted) recomputed and compared.
5. **Cache = a cold check.** Each zone is placed from its own locator and dependencies only (cacheable). A whole-plan overlap pass
   then runs in resolve order: a zone meeting an earlier accepted zone is re-placed around them (never cached) or refused
   `OVERLAP` with `wouldFit`. The cache lives in the sidecar per owner (`<data>/regions/plancache/`), read by the kit through
   `--plan-cache`, never part of params, so the IR is the same warm or cold.
6. **Lot ids are unique across the plan** (one region's lots): a second zone reusing a lot id is `malformed` (SCHEMA, the lot's
   path). Zones compile with a part-id prefix `z<n>_` (`streetLayout` gains additive `rect`/`prefix` options; S7 unchanged).
7. **The 59 recorded plans** are copied whole (prompt, answer, waits) under `kit/test/fixtures/plan/asks/` with `SOURCE.json`
   (steward-mc 8703dbd, `fixtures/strange-asks/plans/`). `answer.waits` is the oracle: a part it names answers `unsupported` or
   `blocked`; any other part never `malformed`. Anchors used: stone, player, claim_* (all supplied by the harness).

## Done
- Kit: `kit/lib/plan/` (schema.mjs validator + dispatch + x-rules; compile.mjs resolver/compiler run inside `kit/regions/plan_v0.mjs`;
  finish.mjs cost, overall, artifact, class map; catalogue.mjs), `tools/plan-catalogue-diff.mjs`, `kit/schemas/plan-catalogue.golden.json`,
  fixtures (valid 15, malformed 16, extension 16 incl. every reserved id, asks 59 + SOURCE.json, catalogue-next.json), tests
  `kit/test/plan-p0.test.mjs` (items 1-3, 7-9, 11) and `plan-ops.test.mjs` (item 10, `fixtures/ops/` 9 families). Additive engine edits:
  streetLayout `rect`/`prefix`/`padEdge`/`layout`, emitProps `prefix`, route pass `maxExpanded`, json param `maxChars`, planRegion
  `planCache`, siteplan `part`/`planParts`, partAnswer `notes`, plan.json catalogue: 3 N-P0-1 templates, form.brush until P1. KIT 0.25.0.
- Sidecar: region.plan `planCache`/`previewViews`/`timeoutMs`/`heapMb`, planCheck in region.planned, per-owner cache, feature
  `region.planCheck`; `sidecar/test/plan-check.test.ts`.
- Mod: API 1.23.0 records/methods/Reasons, `region/PlanChecks.java`, `TileStream.TILE_SHAS`, `client/dev/SliceP0Dev.java` (genHooks),
  `ApiP0Test`. apijars + api-compat `--gate6cp0` on 0.25.0 (built from tag: `artifacts/gate6c-p0/v0250`), 0.24.0, 0.23.0 (clean).
- Gate: `tools/gate6cp0.mjs` (unit, ingame, natural, report), gate-chains `p0-unit`, `p0-ingame`, `p0-natural`, impact rule.
- Unit suites green locally: kit 352+, mod 617, sidecar plan-check.

## Next
Run `p0-unit`, `p0-ingame`, `p0-natural` (change tier, ports 8906:8907, run dir ../architect-mc-P0-run, out
../architect-mc/artifacts/gate-runs-P0), fix, then the slice tier (3 shards 8906-8911), gate-verifier, as-built, retire HANDOFF.
