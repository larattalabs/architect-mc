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

(filled in below as the runs finish)

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

(filled in below)
