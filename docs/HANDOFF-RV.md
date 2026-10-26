# 6d RV (additive revisions): RV-a and RV-b handoff, and the RC note for Steward

Branch `slice/RV` off `origin/main` (e8c0c2dc, then c5df0fea: Steward's GR review). The binding text is docs/CONTRACT.md "Phase 6d slice
RV" (FROZEN 2026-10-20) with its §13 split: this branch is **RV-a** (the kit) and **RV-b** (the mod foundation). RV-c (undo and fluids) and
RV-d (readers, realiseApproved's branch, lots and refills, survival) come after on the interface below; GR after them. Versions are `NEXT`
placeholders (no constant moved). $0: sim and stub only. Ports 8960-8969, run dir `../architect-mc-RV-run`, runs in
`artifacts/gate-runs-RV/`.

**Status: stopped before merging, as asked. RV changes the API Steward calls, so it needs Steward's RC (S-RV-10, shared with GR's).**

## RC note for Steward (relay)

What ships in RV-a + RV-b, and what Steward can call now:

1. **Plan a revision.** `Regions.planRevision(regionId, new RevisionRequest("revise", params, opKey, actor))` with
   `params = {spec: {parts: [{id, call}], refill: [lotId]}}`. A call is one region primitive: `columns`, `fill`, `carve`, `terrace`,
   `pond`, `form` (`rockSpire`, `iceSpike`, `giantTree`, `giantMushroom`), `lot`. Materials are the style's role names (or air): a raw block
   refuses `NOT_ALLOWED [theme]`. The answer is a candidate `RegionPlan` whose trailing `revisionOf` is `RevisionOf(region, rid, position,
   parentRid, parentIrSha)`. Any number of candidates may stand on one parent; planning never moves the head.
2. **Refusals at plan, nothing written** (the message starts `CODE: [kind]`): a write in a standing lot box plus 1 `COVERED [lot]`; on a
   road, path or path-set cell `OVERLAP [road|path]`; on a body's hard or watch cells `OVERLAP [body]`; on a column another site or the
   region's own non-terrain write holds `OVERLAP [held]`; on a beside region's reach or hold column `OVERLAP [beside]`; in the owner's
   protected area `PROTECTED`; over an unfinished tile `NOT_ALLOWED [unfinished]`; a non-additive edit `NOT_ALLOWED [not_additive]`; an
   irrigated refill `NOT_ALLOWED [irrigated]` (S-RV-14); a busy or removing region `OVERLAP_BUSY`; 64 standing revisions `REGION_LIMIT`
   (S-RV-2: treat it as `NO_ROOM`).
3. **Realise it** with `Regions.realise(new RealiseRequest(planId, ...))` (opKey as for any realise). The future completes with the
   **region's own id** (no new region). Accepting is a compare-and-set: the parent must still be the head and the region's history at the
   revision's tiles unchanged, else `PLAN_STALE` (`parent_moved` or `history` in the message), nothing written. The other candidates on that
   parent then refuse `PLAN_STALE parent_moved` at their realise.
4. **While it writes** the region reads `PLACING` and `RegionView.busy` is `revising <rid>`; another revision refuses `OVERLAP_BUSY`.
   **Afterwards the region reads its own pre-revision state again** (your point 1); the revision's outcome (`PLACED`, `PARTIAL`, `FAILED`) is
   only in `RegionView.revisions`.
5. **Your GR review, ask 1 (one growth = one history entry):** every site a revision writes (its tile cell sites, its lots, and GR's street
   pieces when GR lands) carries ext `architect_mc:revision {region, rid}` on its batch and items, and `RevisionView.sites` lists them in
   write order. `LotState.revision` names the revision that added a lot (0: the realised plan's). Log one history entry per `rid`; undo it
   with `undoRevision` (RV-c).
6. **Ask 2 (`land.outside` shrinks after `undoRevision`):** confirmed as the design. `architect_mc:land` and every other reader read the
   effective IR of the **head** (`effective/<head>.json`, §4.5); `undoRevision` moves the head down, so the land is recomputed from the older
   snapshot and `land.outside` shrinks. The readers' switch to the effective IR and `undoRevision` itself are RV-c/RV-d (not on this branch);
   the RC covers them.
7. **Keys:** your scheme is recorded in the contract (no `dplan`/`dgrow` keys anywhere now): each build plans and realises under
   `steward.<buildId>.vplan` / `steward.<buildId>.vrealise` (`.vrealise2` after a stale re-check), with ext `steward_mc:district=<id>` and
   `steward_mc:build=<buildId>`; a growth is an ordinary build under the same scheme.
8. **Not in this build** (refused, nothing written, so you can code against the final shape now): an added fluid body is planned but its
   realise refuses `NOT_ALLOWED` until RV-c; refills and survival revisions refuse `NOT_ALLOWED` until RV-d; `undoRevision` throws
   `UnsupportedOperationException` (the API default) until RV-c; plan/0's revision mode answers in the kit (keep, add, refill, grow, change)
   but `checkPlan` does not send it the parent yet (RV-d), so a plan with `revision.parentArtifact` is checked as today's.

### The exact API (all `Since NEXT`; binary compatible: api-compat clean against 0.47.0, 0.45.0, 0.44.0 and the 0.47.0 surface)

```java
// Regions (defaults throw UnsupportedOperationException; feature "regionRevisions" from the helper's "region.revise")
default CompletableFuture<RegionPlan> planRevision(String regionId, RevisionRequest r)
default CompletableFuture<RemoveResult> undoRevision(String regionId, int toPosition, String actor)   // RV-c implements it

record RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor)
record RevisionOf(String region, int rid, int position, int parentRid, String parentIrSha)
record RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt,
    List<String> stages, List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact,
    boolean survivalAllowed, @Nullable String waiting, List<String> sites)
    // + the contract's §11 constructor without `sites`

RegionPlan  ... int irFormat, @Nullable RevisionOf revisionOf)          // old constructors kept
RegionView  ... @Nullable RegionBuild build, int position, @Nullable String busy, List<RevisionView> revisions)   // old constructors kept
LotState(String id, @Nullable String siteId, String state, int revision)  // the 1.8.0 constructor kept (revision 0); state may be "removed" (RV-d)
```

States in `RevisionView.state`: `ACCEPTED`, `PLACING`, `PLACED`, `PARTIAL`, `FAILED` (this build); `UNDOING`, `UNDONE`, `STALE` (RV-c;
candidates are never in the view). Journal stages are `rv<rid>:<stage>`; the revision IR keeps the base's stage names.

Sidecar: `region.plan` gains `revision` (the kit's `--revision`); features `region.revise`, `plan.revision`.
Catalogue (`sinceApi: NEXT`, appended): `revision.keep`, `revision.add`, `revision.refill` supported; `revision.grow` (until GR) and
`revision.change` (until RV2) reserved. plan/0's lot spec gains the optional `refill: true`.

## The interface frozen for RV-c, RV-d and GR (§13)

| Item | As built |
|---|---|
| The revision IR | a valid region IR of only the additions (`kit/regions/revise.mjs`), the base's stage names, part/lot/body ids `rv<rid>_*` (plan/0's revision mode keeps the plan's ids, `revision.naming: "plan"`), member `revision {format: "revision/1", rid, position, base, parent: {rid, irSha}, lots: {add, refill}, roads: {add}, graph: {nodes, edges} (ids), seed}`; seed `fnv64(base seed, rid)` (`revisionSeed`) |
| ctx.standing | `revisionStanding` (kit) = `Revisions.standing` (mod): `besideStanding` of the effective IR + `held {runs, town, terrain}` + `beside [{id, reach, hold}]` + `keepOut` + `unfinished` + `lots {id: {state, siteId?, irrigated?}}`; the kit fills `ids` from the effective IR (`withStandingIds`) |
| The guard and M29 | `reviseGuard` at plan (planRegion, intended cells, conditions aside); `M29:revision` in the checker (`checkRegion({standing})`), its five broken variants (`spec.unsafe`) |
| `effective.json` | `effective/<rid>.json`, written before the accept, never rewritten; the kit's `mergeEffective` = the mod's `Revisions.merge` (parity fixture `kit/test/fixtures/rv/merge.json`); `region.json` is authoritative (its head) |
| The realise manifest | `rev/<rid>/op.json {op: "realise", rid, planId, items, lotEntries, autoApprove, state: prepared → installed → done}`; `rev/<rid>/ir.json` |
| `region.json` | `revisions {nextRid, headRid, position, busy?, manifest?, list: [Rev]}` (only once a revision was planned) |
| The hashes | `tileSha` = RP's; `historySha(key)` = sha256 of `[[layer, stage, set, tileSha hex, status]]` over the realised records at that key (layer order) |
| The candidate | `planned.revisionOf {region, rid, position, parentRid, parentIrSha, dirty, history}` in the plan's file |
| Records | RP's realised records at layer `rid`, stage names the revision IR's; raced cells in that layer's `sites.json` `raced` |
| Driver steps | `rv-unit`, `rv-ingame`, `rv-crash` (`tools/gate6drv.mjs`, chain `6drv`, impact rule "6d RV"); RV-c/RV-d add theirs (`rv-undo`, `rv-natural`, ...) |

## Conflicts with the frozen text, and deviations (for the coordinator)

1. **Versions and catalogue.** The contract's placeholders (API 1.43.0, catalogue 12, kit 0.44.0) predate CL/K2/CW/D3/U0-U5: main is at API
   1.42.0, catalogue 14. Everything is `NEXT`; no constant moved; the coordinator numbers it.
2. **Stage names.** §2.1 names stages `rv<rid>:<s>`, and the kit's `STAGE_NAME` keeps `:` out of an IR. As built: the revision IR keeps the
   base's stage names (§12's "added parts reuse stage names"); the mod's journal stages, item keys and StageRecs are `rv<rid>:<s>`.
3. **RP's `sites()`.** RP's `mergePrior` may list several sites per tile; RV reads RP's records (status over every listed site) unchanged.
4. **§3.3's RACED cells are not removed from the PLACING entry.** A cell that changed between its capture and its write is not written and is
   recorded (`sites.json raced`); it stays in the entry with its planned after, and the journal's own rule (a CELL cell restores only if the
   world holds its after) leaves it alone at undo (reported as kept). A RACED code in the per-cell record (by payload index) is not written.
5. **A refusing holder at the write** (a site over a raced cell) stops the revision by failing the rest of its batch (`Batches.failRest`):
   its written tiles stand and it ends `PARTIAL`. At the check (§3.2), a held, build or protected cell fails that tile only; the rest of the
   revision goes on (it ends `PARTIAL`/`FAILED`), rather than stopping at once.
6. **No drift check for revisions.** A revision's stages skip the stage drift check; the accept's `historySha` CAS and the per-cell
   same-tick check replace it. The revision's plan survey has the region's frozen heights over its columns (`Revisions.overlayFrozen`).
7. **`unfinished`** = a tile key of the realised plan's IR with no realised record in any stage and set (a pre-RP region reads every tile
   unfinished: RV §3.7's derived records are not built; such a region can't be revised until they are).
8. **plan/0's revision part ids** stay the plan's own (Steward's life-layer hooks address them); `revision.naming: "plan"`.
9. **§4.5's reader list predates CL, K2 and CW**: their walls, climbs and catwalks are parts of the effective IR like any other; RV-d should
   check `BesideReach.standing`'s `walls` (K1/K2) and the 7a connectors' readers when it switches the readers.
10. **AD's dependency** names 7a's link pass, which moved to 7b (C:19876): AD's order needs re-checking (not RV's).

11. **The same-tick check compares each cell with its capture.** A cell that changed is RACED unless the change is the tile's own: it
    already holds its planned after (a dependent that popped), or the tile wrote the cell under or over it (a gravity block that fell).
    A change two or more cells away caused by the tile's own writes (a long sand column, a vine) would still read RACED: item 21's natural
    round (RV-d) is where that shows.
12. **planRevision's survey** reads generated chunks (`GENERATED_ONLY`), loaded or not; the frozen heights go over it.

## Not shown on this branch (each with its reason)

| Item / row | Why not shown |
|---|---|
| 3: the pond (an added body) | added bodies are RV-c (§7: the fluids stage, settle, census, drain); the kit plans it, the mod refuses its realise `NOT_ALLOWED` (shown) |
| 3: `rv_layers` (skipped and felled cells under an added relief form) | the gate's town is on a flat world with no trees; the kit's 300-revision test covers layering over terrain columns; the in-game felling row is RV-d's natural round |
| 6: a PT build, a C17 area, an unfinished tile, `blockers` | the PT build and C17 refusals are in the kit's guard tests (rv-a) and in TileCheck's revision mode, not driven in game; `unfinished` needs a region with a failed tile (fault injection, RV-c); `blockers` is undo's (RV-c) |
| 9: depth (LAYER_DEPTH) | not built: a revision does not pre-check stack depth; the journal's own depth limit applies at the commit (RV-c with undo's stacks) |
| 10: undo's kill points (§4.4 steps 2-5, K6, mid-R4) | undo is RV-c |
| 11: a candidate whose dirty tile's history moved without the head moving | needs an undo or a lot removal under a standing revision (RV-c, RV-d); `historySha` is unit-tested in the kit and computed at plan and accept in the mod |
| 20: a site taking a cell between capture and write (the stop path, `Batches.failRest`) | DevBridge can set a block in that window (shown: RACED) but not place a site there; a site placed after the plan is refused at the tile's check (shown) |
| 4, 5, 12-16, 18, 19, 21 | RV-c and RV-d (readers, realiseApproved's branch, plan/0 in game, lots and refills, survival, fluids, the natural round) |

## What was run ($0: sim and stub only; DEV MODE)

| Check | Where | Result |
|---|---|---|
| kit suite | `node --test kit/test/*.test.mjs` at 854bb2d6 (+ the four catalogue tests fixed after) | 910 tests; rv-a.test 11/0; the catalogue tests 0 fail after reading the `revision.*` entries as rv-a's |
| sidecar | `npm run check` (tests and the bundle) | 784/784 |
| mod | `./gradlew build --offline` | 959 tests, 0 failed after ApiDTest (RegionView's new components) and PredicatePathsTest (the race hook through /setblock) were fixed; RevisionsTest 5/0 |
| instant lints | lint-structure, lint-look, water-lint (kit/lint), p3-lint (LedgerLintTest, RegionFluidsLintTest, in rv-unit) | structure 64/0, look 13/0, water 126/0, p3 pass |
| api-compat | `tools/api-compat.mjs` vs the 0.47.0 and 0.45.0 apitest jars (built from their tags: `artifacts/gate6d-rv/jars`, SOURCE.txt) and 0.44.0's (`artifacts/release-0440/v0440`), `--surface` vs the 0.47.0 mod jar | clean (every referenced member; the whole surface) |
| **chain 6drv** | run `artifacts/gate-runs-RV/20261026-180250-6drv` at 5ba05fca, ports 8960/8961, run dir `../architect-mc-RV-run` | **PASS: rv-unit 4/0, rv-ingame 27/0, rv-crash 27/0** |

rv-ingame (items 3, 6, 11, 20): the refusals (COVERED lot, OVERLAP road, OVERLAP held, NOT_ALLOWED theme/refill/empty, the added body at
realise) wrote nothing; revision 8 (a mound and a rock spire, 1382 cells) matched the whole-world oracle over claim + 8 with 0 cells
different, every intended cell inside the compared box; head, position, the region PLACED again, the effective IR and its snapshot, the
layer's two records committed, the sites `c5`, `c6`; two candidates on one parent (the second `PLAN_STALE parent_moved`, nothing written);
a site placed after the plan refused its tile at the check (`OVERLAP ... held by site c7`; the revision FAILED, nothing written, the region
PLACED); a player's block set between capture and write kept and unwritten (RACED), the tile's other cells written; `Regions.remove` with 4
revisions standing: E-flat 0 (the cells that are not the region's kept, then cleared).

rv-crash (item 10's realise half): RV1, RV2 (nothing accepted after the restart, the snapshot an orphan; realised again), RV3, RV4
(accepted; recovered and installed once: one batch, each key once), RG4+save (a revision tile mid-write): each revision PLACED, then
`Regions.remove`: E-flat 0 for RV1-RV4. **RG4+save leaves one cell** (the halted tile's first written cell) after the removal, and so does
the control row (the same kill in the town's own realise, no revision): **main's behaviour**, RP §6's PLACING leftover (the first attempt's
entry left PLACING is not undone by the group removal). Judged against the control; a finding for the coordinator's queue.

Earlier runs (the fixes they found): `20261026-172944-6drv` (the gate's cell reader and the spire's y: the flat ground read as 255),
`20261026-173848-6drv` (the compared box missed the spire's footing), `20261026-175007-6drv` (RG4+save's leftover cell found; the control row
added). A recovery path for a batch lost before its save (RV4 with the async queue save) and planRevision's refusals as Reasons were fixed
before the passing run.

**Gate-verifier (review + strict re-run of rv-crash): PASS.** Run `artifacts/gate-runs-RV-verify/20261026-181129-6drv` at bcde362a (ports
8962/8963): rv-crash 27/0, every row as above; rv-a.test re-run 10/0. No real defects. It accepted the RG4+save control judgment (RP §6's
PLACING leftover, "deferred to undo hardening B"), noting the comparison checks the count only (hardening: assert the cell is in the
halted tile and its entry the PLACING one). Its nits, for RV-c: `recover` ends a revision whose batch is gone PARTIAL even if every item
placed (an `end()` save lost; conservative); a tile resumed mid-write after a restart has no race check (`raceBefores` is transient);
`selfMoved` also spares a player's change over or under a written cell. Fixed after the review: a resumed revision reads `PLACING` again
(it could read `ACCEPTED` while its batch placed).

**Still to come:** Steward's RC (after RV-c/RV-d, or now for the shape, at the coordinator's call).
