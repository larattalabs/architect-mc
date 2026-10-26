# 6d GR (growing a standing region): GR-a and GR-b handoff, and the RC note for Steward

Branch `slice/GR` off `origin/slice/RV` (0cd4a088; RV is in Steward's RC and not merged yet: when it merges, `origin/main` is merged in
here). The binding text is docs/CONTRACT.md "Phase 6d slice GR" (FROZEN 2026-10-20) with Steward's GR review (PLAN "Steward's GR review",
2026-10-26: S-GR-1..7 defaults, the key scheme, Ask 1, Ask 2). Versions are `NEXT` placeholders (no constant moved). $0: sim and stub only.
Ports 8960-8963 (the GR lane's 8960-8969), run dir `../architect-mc-GR-run` (`-s2` for the second shard), runs in
`artifacts/gate-runs-GR/`.

**Status: stopped before merging, as asked. GR shares RV's RC line: the RC note below is for Steward (relay).** The coordinator's two rows
for this RC (2026-10-26) are in it: a survival growth with bills equal to its BOM, and the undo refusals `joined` and `survival_building`.

## RC note for Steward (relay)

What GR gives Steward, and how to call it:

1. **A growth is an ordinary Steward build.** Plan it with `Regions.planRevision(regionId, new RevisionRequest(<the region's own program>,
   {grow: {...}}, "steward.<buildId>.vplan", actor, ext))` with `ext = {steward_mc:district: <id>, steward_mc:build: <buildId>}`, then
   `Regions.realise(new RealiseRequest(planId, ..., lotEntries, ..., ext, ..., "steward.<buildId>.vrealise"))` (`.vrealise2` after a stale
   re-check). The program is the region's own: `flat_village` for a V town, `districts` for a districts region (`plan_v0` too); `revise`
   with `{spec: {grow}}` or `{grow}` is the same thing. The future completes with the region's own id (no new region).
   - `grow`: `{lots: [LotSpec] | n, district?, prefer?: frontage | extend, extend?: auto | <end node id> | none, type?, size?}`.
     `lots` is V's LotSpec list (`{id, type, size: [along, deep], villager?, landmark?, placement?, brief?, ext?}`); **the lot ids are yours**
     (unique across the region: a standing id refuses `NOT_ALLOWED [not_additive]`). A count `n` names them `<district>_<k>` continuing
     the district's numbering. `district` is required on a districts region.
   - **Frontage first (S-GR-1):** each lot takes the cheapest free slot along the standing streets (nearest the square; the lot-free side
     first), then the rest go on **one straight extension** from a street end nobody uses (a V town's or plain district's or outpost's
     street; an along district continues along its boundary, §5). Rings, spirals and organic layouts never extend (`NO_ROOM [layout]`).
   - A lot that fits nowhere is listed in the IR's `revision.grow.unplaced` (`{id, reason: NO_ROOM, kind}`, kind `frontage | street |
     claim | held | body | layout | boundary`); **a growth that places no lot refuses `NO_ROOM: [kind] ...`** (a new `Reason.NO_ROOM`;
     treat it like `REGION_LIMIT`: full, propose a district), nothing planned, no rid taken.
2. **What it builds.** New lots (pads; the buildings from your `lotEntries`), their lanes, an apron lamp where no standing lamp is within
   6, and for an extension the street's own look (N-GR-1): road 3 of the same surface and lanterns plus its verges, joined end to end with
   the standing road, flagged `architect_mc:street {zone, district?}` (zone `town` for a V town without a plan zone), road id
   `<roadId>_g<rid>`. Its new end node `<roadId>_g<rid>_end` is terminal: a later district (D3) or a later growth can use it; the old end
   is no longer an end. Standing lots, streets, verges, junctions and the square never move and are never written.
3. **One growth = one revision = one history entry (S-GR-2, your Ask 1).** Every site a growth writes carries ext `architect_mc:revision
   {region, rid}` - its pads and lanes (tile cell sites), its street piece (the road site) and its lot sites - **and your realise ext**
   (`steward_mc:district`, `steward_mc:build`: every key of the realise's ext not `architect_mc:*` is copied onto every item, so every site).
   `RevisionView.sites` lists them; `LotState.revision` names the revision that added a lot. Each grown lot's own ext carries
   `architect_mc:grown {revision, street, side, u}` and V's `architect_mc:village` (entrance, lane, slot `frontage` or `extension`).
4. **Keys after a restart (S-GR-3).** `planByKey(owner, "steward.<b>.vplan")` finds the growth's plan; **`realiseByKey(owner,
   "steward.<b>.vrealise")` now finds a growth too** (it answers the region's view; `RegionView.revisions` names the revision). A repeated
   realise with the same key and plan answers the region again; another plan under a used key refuses `OP_KEY_CONFLICT`. An undone growth
   frees its key, as a removed region does.
5. **Undo (S-GR-2, S-GR-5):** `undoRevision(regionId, toPosition, actor)`, one building at a time, last first. Refused at preflight with
   nothing written:
   - **`NOT_ALLOWED ... (joined)`** when a beside region (a later D3 district) joined what the growth added: its new end (`<region>:
     <roadId>_g<rid>_end.<port>`), its extension road by a T (`<region>:<roadId>_g<rid>`), or a frontage junction. The message names the
     region. Remove that district first (D3's town-first removal still works: `dangling`).
   - **`NOT_ALLOWED ... (survival_building)`** while a survival growth's targets are still building (let it finish or cancel it).
6. **Your land (Ask 2).** `architect_mc:land` becomes **v 2** at a districts region's first accepted revision and stays 2 after any undo:
   each growth is a part `{kind: grown, id: rv<rid>, district, revision, runs, rect, cells, insideCells}`; an along district's new band is
   also `{kind: district, id, shape: mask, revision}`; every part carries `revision` (0: the realised plan's). `union`, `outside` and
   `inside` are recomputed from all parts at every realise and undo, so **`land.outside` grows with each growth and shrinks after
   `undoRevision`** (shown in game on a district with a land ext: gr-beside). A growth never takes town land (`insideCells` 0; `inside`
   unchanged). An ungrown district's record is v 1 as before.
7. **Survival (RV §8, additive).** A survival region grows in survival: plan it in survival, realise it, feed its targets. Its bills equal
   its BOM (gr-survival: the check's `cost.bom` less the lots' bills, item for item, against the growth's targets); `undoRevision` refunds
   what it consumed, once.
8. **plan/0 (§8):** a revision plan (`revision.parentArtifact`) whose zone's `program.lots` only gains lots (every standing lot spec equal)
   grows that zone: `checkPlan` answers the zone `fits` with `standing: true` and `grown: [ids]` (and `unplaced` when some don't fit); the
   artifact's `$.lots` are the grown lots; `realiseApproved` realises it as the next revision. A districts zone grows through
   `planRevision` (not plan/0, in this slice). Catalogue: `revision.grow` supported (`sinceApi: NEXT`).
9. **On your side when GR ships** (your GR review): standing beside districts take buildings again (`growDistrict`); along districts and
   outposts are growable (frontage on their streets; along districts also extend along their boundary); your own street pieces in a region
   town move onto town growth: stop laying `street#n` on a region town (S-RV-13) and plan a town growth instead. Your street pieces that
   already stand stay held cells: a growth routes around them.

**Rows for your RC** (the coordinator's 2026-10-26 note: these are GR's RC, not RV's):
- **Row 2, a survival growth:** gr-survival - a survival town checked, realised and fed; a frontage growth checked in survival (fits
  standing grown), realised, fed: the growth's targets' bills equal its BOM item for item; `undoRevision` refunds once.
- **Row 3, the undo refusals:** `joined` - gr-town items 7 and 7b (a D3 district joined at a growth's new end, and one by a side T onto the
  extension road: `undoRevision` refused at preflight, nothing written (hash); the district removed, then the undo exact);
  `survival_building` - gr-survival (an undo while the growth's targets build: refused, nothing written).

### The exact API delta (all `Since NEXT`; binary compatible: api-compat clean against the 0.47.0 and 0.45.0 apitest jars and the 0.47.0
mod surface)

```java
// RevisionRequest (RV's record, unreleased) gains a trailing ext; RV's 4-component constructor kept
record RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor, JsonObject ext)
RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor)   // (RV) ext {}

// Reason gains, appended at the end
NO_ROOM      // a growth that places no lot: "NO_ROOM: [frontage|street|claim|held|body|layout|boundary] ..."

// behaviour (no new method):
Regions.planRevision(regionId, new RevisionRequest(<region's program>, {grow: {...}}, opKey, actor, ext))   // a growth
Regions.realiseByKey(owner, opKey)   // also finds a growth realised under its key (the region's view)
```

- **Features:** `growDistrict` (helper feature `region.grow`), `planRevisionGrow` (with `plan.revision`).
- **IR:** a growth's revision IR member gains `revision.grow {format: grow/1, district, lots, frontage: [{street, side, u, lot}], extension:
  {kind?: boundary, from, road, along, run, lots} | absent, follow?: {district, mask}, unplaced: [{id, reason, kind}], lamps}`. Grown
  roads carry `architect_mc:street` (and an along band's road `architect_mc:band {district, runs}`); grown lots `architect_mc:grown`.
  The graph's frontage edges are two real `along` road edges per new junction (`along: <roadId>`, `span`, `segments`; no cell written).
- **`architect_mc:land` v 2** (above). Catalogue `revision.grow` reserved -> supported.
- The `revise` program's sha moved (RV's revision IRs re-plan to a new IR sha; RV is unreleased, so nothing recorded moves).

### The `gr_beside` fixture, with Steward's real key scheme (gr-beside, item 5)

1. gr_town (`flat_village`, 6 lots, 4 built) as region `rg1`.
2. `checkBeside(districts, {districts: [{id: east, size: [48, 48], lots: [east_1, east_2]}]}, claim = the reservation east of the
   town's east street end plus the 16-column seam into the town's claim, beside rg1)`: fits, the join at the street end.
3. Building 1: `Regions.plan(... , opKey "steward.b1.vplan", ext {steward_mc:district: east, steward_mc:build: b1})`, realised under
   `"steward.b1.vrealise"` with the same ext and `east_1`'s entry: district region `rg2`, `land` v 1.
4. Building 3: `planRevision(rg2, RevisionRequest("districts", {grow: {district: east, lots: [{id: east_3, type: house, size: [9, 9]}]}},
   "steward.b3.vplan", actor, {steward_mc:district: east, steward_mc:build: b3}))`, realised under `"steward.b3.vrealise"` (same ext,
   `east_3`'s entry). Building 4 the same with `b4`, `east_4`.
5. `undoRevision(rg2, 1)` (building 4), then `undoRevision(rg2, 0)` (building 3): the world before each, land.outside back.

## What was run ($0; DEV MODE)

| Check | Where | Result |
|---|---|---|
| kit suite | `node --test kit/test/*.test.mjs` at 9dfb900b | **935/935** |
| GR's kit tests | `kit/test/gr-a.test.mjs` (12), `gr-parity.test.mjs` (1); rv-a.test 10, plan-p0, districts-d3 and its parity | all pass |
| sidecar | `npm run check`: 50/51 files under machine load (versions.test.ts a 60 s hook timeout), that file alone 17/17 | pass |
| mod | `./gradlew test --offline` (the whole suite, incl. DistrictLandGrTest, DistrictLandTest, RevisionsTest, ApiDTest, PlanCatalogueTest) | **EXIT 0** |
| instant lints | `tools/lint.mjs structure` 65/0 (S-THEME clean), `look` 13/0, water lint (`kit/lint/*.lint.mjs`) 128/0, p3-lint in the mod build | pass |
| api-compat | `tools/api-compat.mjs` vs the 0.47.0 and 0.45.0 apitest jars (`artifacts/gate6d-rv/jars`) and `--surface` vs the 0.47.0 mod jar (in gr-unit) | clean |
| step-inputs | `node tools/step-inputs.mjs build` after the gr-* steps and the "6d GR" impact rule | rebuilt |
| **chain 6dgr** | run `artifacts/gate-runs-GR/20261026-224525-6dgr` at 5394546c (ports 8960-8963, 2 shards) | **gr-unit 5/0, gr-town 28/0, gr-beside 18/0, gr-plan0 12/0, gr-survival 12/0, gr-crash 34/0 PASS**; gr-along 8/1 (its second growth's expectation: fixed below) |
| gr-along | run `artifacts/gate-runs-GR/20261026-232113-6dgr` at 9dfb900b (driver-only change) | **PASS 10/0** |
| gr-look | run `artifacts/gate-runs-GR-look/20261026-223101-6dgr-look` (a client) | PASS 2/0; 5 shots |
| **gate-verifier** | review of 0cd4a088..5394546c (Revisions, TileCheck, RegionItems, InfraJob, RegionsImpl, DistrictLand/land.mjs, grow.mjs, revise, districtsEmit, reach) and a strict re-run on its own ports 8968/8969: `artifacts/gate-runs-GR-verify/20261026-224604-6dgr` | **PASS: no defects; gr-town 28/0, gr-beside 18/0, gr-survival 12/0, gr-crash 34/0** |

**gr-town (items 3, 4, 7, 7b, 8, 9; Ask 1):** an added pond (RV) on the lot-free frontage; 2 lots grown on free frontage nearest the square
(street_e's lot-free side), every standing street's road and verges unchanged (hash), the lots clear of the pond's hard and watch columns
(KC), the Steward addition untouched; every growth site tagged `architect_mc:revision` (tile cell sites and lot sites); every new lot
walkable to the bell and back (`dev.nav.villager`), graph.cut []. A 6-lot extension `street_e_g3` (41 long, flagged `{zone: town}`), the
new end terminal and the old end 2 edges, its street piece tagged, its lots walkable; its undo cell for cell. A 1-lot extension; a beside
district planned east joins its new end (`rg1:street_e_g4_end.street`): `undoRevision` refused at preflight `NOT_ALLOWED ... (joined)`
naming the district, nothing written (hash); the district removed: the world as before it. A district on the extension's free side joins
it by a T (`rg1:street_e_g4`, junction side s): refused `joined`, nothing written; removed; the undo exact. Every frontage slot held (a
Steward site along both sides of every street): `NO_ROOM [held]`, no rid taken. The town removed with its pond, frontage and extension
standing and a beside district (then removed, dangling): E-flat 0 over the claims + 8 (the Steward addition's and the PT build's own cells
aside).

**gr-beside (items 5, 11, 12; S-GR-3; Asks 1, 2):** the `gr_beside` flow above. checkBeside fits (the end, the reach); building 1 PLACED,
land v 1. Building 3 as a growth under `steward.b3.vplan` (planByKey finds it), realised under `steward.b3.vrealise`: every site tagged
and carrying `steward_mc:build b3`; land v 2: the grown part `rv1` (district east, insideCells 0), outside 781 -> 896, inside unchanged,
every part's revision; realiseByKey finds the district. Building 4: outside 896 -> 1156; every column the district holds in the journal in
land.union (584 columns). After a restart, realiseByKey(`steward.b4.vrealise`) and planByKey(`steward.b4.vplan`) find them.
`undoRevision` 4: the world before it (0 cells), outside 1156 -> 896; then 3: the world before it (0 cells), union equal to the one before
the growths, no grown part, v 2. The town's claim hash unchanged throughout. An outpost grown by 2: its corridor byte-identical, the new
lots walkable to the town's bell.

**gr-along (item 10):** a shore district (d3_shore, longer) grown by 3: 2 on its street's free frontage, 1 along the boundary (a new band
from the free route end); every grown lot walkable to the street end; graph.cut []; land v 2 holds the band (a district mask part,
revision 1), outside 1465 -> 2570; a further growth where the boundary ends inside the claim answers `NO_ROOM [boundary]`, nothing
planned; undo to 0: the world before the growths, outside back to 1465.

**gr-plan0 (item 6):** checkPlan of the zone gaining h4, h5: READY, `fits` `standing` `grown [h4, h5]`; the artifact's `$.lots` are the two,
`revision.grow [town]`; a competing growth realised first under one key; the first artifact's realiseApproved under `gr.p0.k1` refuses
stale; after a restart the retry checked on the new head and realised under `gr.p0.k2`: PLACED, its lots with their revision; both undone
exactly, the artifact tombstoned; removal E-flat 0.

**gr-survival (item 13; Steward's RC rows 2 and 3):** a survival town checked, realised and fed; the growth checked in survival (READY,
`grown [h4, h5]`, bill `{lantern: 2, oak_fence: 2}`), realised; **while its targets build, `undoRevision` refuses `NOT_ALLOWED ...
(survival_building)`, nothing written (hash)**; fed and built: **the stockpile paid exactly the check's BOM**; `undoRevision`: the world before
it, the refund `{lantern: 2, oak_fence: 2}` = what it consumed, once (a second undo has nothing left); removal E-flat 0 but the crates.

**gr-crash:** kills during a growth's realise (6 lots, an extension: tiles, a road, a lot): RV3, RV4, RG4+save, RD3 (the road after its
first cell), RD3+save: after each restart the growth PLACED, each item once in one batch (the street piece among them),
`RevisionView.sites` lists every site its items placed, all tagged; then `undoRevision`: the world before it (0 cells; RG4+save and
RD3+save 1 cell: RP §6's PLACING leftover, RV's recorded finding, main's behaviour). Kills during the undo of a growth with a road: RVU1,
RVU2, K6: resumed and finished, the revision UNDONE, the world before it (0 cells).

Earlier runs and what they found (all in `artifacts/gate-runs-GR/`): `20261026-210152-6dgr` (frontage/extension green; the test's beside
district overlapped the extension, a side T went elsewhere), `20261026-212345-6dgr` (a frontage junction's `along` edge made a street end
non-terminal: fixed in grow, D3's besidePorts and streetNetwork; RG4+save: a revision's own halted path tile held its cell against the next
tile: fixed in TileCheck; the survival undo answered OVERLAP_BUSY while revising: now `survival_building`), `20261026-215349-6dgr` (town,
beside, crash green; `RevisionView.sites` missed a site placed before a halt: rebuilt from the batch at the end), `20261026-222746-6dgr`
(crash, survival green), `gate-runs-GR-b/20261026-223536-6dgr` (a boundary growth could not continue from an earlier growth's end:
fixed).

## Conflicts with the frozen text, and deviations (for the coordinator)

1. **Versions and catalogue.** The contract's placeholders (API 1.44.0, catalogue 13, kit 0.45.0) predate the batch; everything is
   `NEXT`, no constant moved.
2. **The request's program (§9).** RV's `planRevision` took only `revise`; GR accepts the region's own program when `params.grow` is
   given (any program name, since the region record keeps none: the kit reads the effective IR to know what grows) and maps it to
   `revise`'s `spec.grow`.
3. **`RevisionRequest.ext`** is new (not in §9): Steward's keys put `steward_mc:*` on the plan; `architect_mc:*` keys are refused there.
   The realise's own ext (already in `RealiseRequest`) is carried onto every item of the revision, so the sites carry it.
4. **`Reason.NO_ROOM`** is new: §9 names NO_ROOM as the kit's refusal, and the API had no such reason (districts' NO_ROOM surfaced as
   OTHER). Appended at the end.
5. **Frontage geometry (§3).** A frontage lot's front edge is `FRONT_LANE` = 3 rows past the verge row (`v = c + s (2 + 1 + 3)`), so its
   pad's batter (PAD_MAX 2) and apron stay off the verge and the road: RV's guard counts a pad's conditional fill under the batter as
   intended cells, so a lot fronting the verge directly (V's own geometry) would refuse `OVERLAP [road]`. The lane is 3 cells, from the
   entrance to the row next to the verge, never on it (§3's verge contact). Extension lots (on the growth's own new street) stand as V's.
6. **Extension verges past a standing lot's apron.** V's street often ends beside its outermost lot, whose box + 1 covers the first
   verge cell past the end on that side. The extension's verge skips cells in a standing lot's apron ring (they stay the lot's apron);
   the road rows must be clear. An end blocked otherwise is not extendable (`held`).
7. **Extension junction names.** §6 names frontage junctions `<roadId>_g<n>_j<k>`; the extension's own junctions are `<roadId>_g<n>_e<k>`
   (`_j<k>` would collide when one growth does both), its end `<roadId>_g<n>_end`.
8. **"Nearest the square" for districts without a square** (along districts): the slots nearest the street's ends come first.
9. **The cheapest extendable end (§2.1 `auto`)**: the end that places the most remaining lots, then the one nearest the square, then id.
10. **Along districts (§5).** Frontage uses §3's rule on the straight runs (9+) of the following street (`route_st_<d>_<n>`); the boundary
    extension traces the boundary again over the revision's survey (the claim, frozen heights), continues the band from a free route end
    (`<d>_s<k>` with only the street's own edges), lays a ground road along the band's middle (a polyline, decimated every 8 cells; not a
    T2 route) and places lots with D2's `followLots` (slope pads within FOLLOW_PAD, each pad + batter clear of every standing class). The
    mask is recorded on the new road's ext (`architect_mc:band`) as well as in `revision.grow.follow`, because the effective IR keeps
    roads with their rid but not a revision's member: `land` reads it from the road.
11. **Lamps (§3).** One W fixture per grown lot beside its entrance, skipped within 6 (Chebyshev) of a standing lamp spot (props, apron
    lamps, the 4e lanterns' possible spots) or another new lamp; along districts' grown lots take none (D2's lots have none). Not W's
    `lightCover` (that walks the revision IR's own virtual world, which holds only the growth).
12. **plan/0 `revision.grow` (§8)** is built for V zones; a `program.districts` zone gaining lots answers unsupported (it grows through
    `planRevision`). `v8x_6d_gr_zone` / `v8x_6d_gr_district` are not committed fixtures: a revision plan needs the mod's revision input,
    so (as RV's `rv-pending.json`) kit/test/gr-a.test.mjs checks it and `revision.grow` is listed in `rv-pending.json`'s ids.
13. **`land` v 2 and undo.** `v` is 2 once the region record has any accepted revision (the mod passes `revised`); the kit's
    `districtLand(ir, claim, {revised})` mirrors it. A grown part's `district` is the district whose `rv<rid>_<d>_` parts or flagged road
    it holds (comma-joined if one growth spanned two, which GR never does). The recompute keeps a dangling district's `standingRemoved`.
14. **Test hooks:** kill point `RD3` (a revision's road mid-write, after its first cell; `RD3+save` with a save first); `dev.rv.plan`
    takes `params` (a growth), `program` and `ext`; `dev.rv.state` adds `siteCaller` (each revision site's non-architect ext and kind);
    `dev.region.plan` and `dev.region.realise` take `ext`.

## Not shown (each with its reason)

| Item | Why |
|---|---|
| 15, the natural round (S3's pinned claim) | The gate's worlds are flat (as RV's item 21); growth on natural ground is covered offline (300 seeded towns on synthetic terrain, gr-a) |
| FL grid, ring, spiral towns in game | The search treats their straight street runs as any street's (unit-tested on `streetRuns`); no FL town was grown in game |
| plan/0 `program.districts` growth (`v8x_6d_gr_district`) | Not built: a districts zone gaining lots answers unsupported; districts grow through `planRevision` (gr-beside) |
| The player mover (item 3 says "player and villager") | `dev.nav.villager` both ways only; the kit's player walk is not run on the revision (its virtual world holds only the growth) |
| A growth's `joined` via a frontage junction | Detected by the same id match (the revision's added nodes); not driven (D3 joins ends and street sides, never a frontage junction) |

Look note for Noah (gallery https://claude.ai/artifact/JAfWetdckqZnmPgE2HHu8T, private; shots also in the scratchpad `gr-shots/`): where
the old street ends beside a standing lot, the extension's first verge cell on that side is the lot's apron corner and stays grass (one
cell). Paving it would write inside a standing lot's apron. A follow-up could let the verge take that one corner cell.
