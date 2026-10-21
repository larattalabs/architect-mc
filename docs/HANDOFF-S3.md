# HANDOFF S3: the mountainside monastery v1, terraced, goes green

Branch `slice/S3`, worktree `../architect-mc-S3`, from origin/main e755d663 (v0.40.0: API 1.37.0, kit 0.38.0, catalogue 9).
Placeholders: API 1.40.0, mod 0.43.0, kit 0.41.0, catalogue unchanged. Fixture numbers from v78. Ports 8924-8929.
Scratch: `scratchpad/s3-build/` (ignored). Contract: CONTRACT.md "Phase 6c slice S3 ... (FROZEN 2026-10-20, Steward reviewed)".

## Order

S3-a (kit):
1. `terrace(..., {edge: 'blend'})` (program.mjs): levels pinned into the relief (`{rect, y}` row runs), no batters, retained only
   where a rim stands over 2; throws without the relief pass; a blend terrace no relief pinned refuses the plan (as blendLots).
2. `kit/lib/region/terraces.mjs`: `layoutTerraces` (pure, its own candidate evaluation) and its emitter; the districts pass
   (parseDistricts, placeDistricts, emitDistricts) reads a district's `terraces` only when present (byte identity).
3. plan/0: `terraces` on `zone.standard` and `district` (not `zone.outpost`); a terraced standard zone resolves as one district
   on its locator's candidates; compact plan/0 measured.
4. Byte identity right after the first schema/compile edit: KC's `unchanged()` and `asksGap` against main.

S3-b (scenario):
5. Rough monastery draft, in game early: the realised M5 number first (T2 saw 5.25% on S3). Blocker if it can't get under 1%.
6. Re-pin the site from a survey after the 90 s settle; consumers of the fixture/sha checked first; previousSha kept.
7. Program `terraced_monastery`, bible, entries; harness `isS3` (plans after the settle); classes (farfluid moved into
   scenarios.mjs; growth/grazed/live only at unwritten cells); gate6cs3 (unit, feasibility, plan, apicompat, report); chains.
8. Item 4 (s3-plan): the shared plan/0 builder through checkPlan, realiseApproved, Regions.remove (copy + flat hill).
9. Golden, gallery (republish the 6c gallery after reading it), S2's approval recorded in PLAN.md; verifier; as built.

## State (2026-10-20 evening)

Done (committed):
- Kit: `terrace(..., {edge: 'blend'})` (program.mjs; pins per level, rims retained after the relief in `Region._retainTerrace`,
  plan.mjs refuses an unpinned blend terrace). `kit/lib/region/terraces.mjs`: parseTerraces, layoutTerraces (ladder levels, trees
  and water avoided, junctions 3 apart, steep joins costed), junctionOf/terraceEnds (ends are lot junctions), chainTerraces,
  ringOf/emitTerraces (wall pads + retaining ring in `structure` + rails, or blend pads). districtsEmit: terraced districts
  (candidate eval, the joins verified in ONE dry pass as the real pass lays them, failed joins retried then dropped, junction
  edges first, routeKeepOut, guard). compile.mjs: `terraces` on zone.standard (resolveTerracedZone: one district on the
  locator's candidates) and districts; grade from tolerance.grade; dropped lots counted; geometry.terraces. route pass:
  per-edge `stairs`, pass-level `nearEnd` (unused now), program `_route` `guard` (parapet + rail over drops > 3; guarded routes
  never lay 4e ground roads). plan.json: `$defs/terraces`, member on zone.standard and district. finish.mjs: a program check
  without a plan param makes no artifact (was a crash for terraced_monastery).
- Program `kit/regions/terraced_monastery.mjs` (exports SPRING, LOTS, monasteryAnchors, monasteryPlan), `kit/regions/s3_hill.mjs`
  (flat variant's hill), bible `scenarios/bibles/g6c_s3_monastery.json` (format 2; fluids: copper coping, sea-lantern spout).
- Harness: isS3 in tools/scenarios.mjs (settle before p2; classes s3Unwritten, s3NearBodies, farfluid moved here; census
  before/after; S3 rows tools/lib/scenario-s3.mjs). Scenario file s3_monastery.json v1 (program, entries, cams offline).
- tests: kit/test/terraces-s3.test.mjs (11 pass). Byte identity: valid/ + asks/ (118 fixtures) identical at a8350d93 (before
  later compile edits: re-run tools/lib/gate6cs3-kit.mjs unchanged() over all 315 fixtures).
- api-compat `--gate6cs3` (artifacts/gate6c-s3/v0400 = an APFS copy of FL's v0.40.0 tag build); gate6a apijars mirrors FL's.
- Versions bumped (API 1.40.0, mod 0.43.0, kit 0.41.0, PLAN_API, catalogue golden api/kitVersion); features region.terracedZones
  -> terracedZones, region.monastery -> scenarioS3; ApiS3Test.

Offline on the pre-settle S3 survey (scratchpad/s3-build/an.mjs): 12/13 lots (orchard dropped), virtual M5 0.4%, M8 100%, M3 0,
lookout path fits, spire_1 refused NO_ROOM (spire_2 placed), fountain adjusted (2-thick coping).

Dev runs 1-3 failed before the realise (finish.mjs crash; plans past 120 s: fixed). Run 4 (20261020-220539) realised: 11/11
PLACED, checker clean, realised M5 0.72% (under 1%: the M5 risk is met, no blocker), fountain census OK. It failed on realised M8
(15 open, all relief floors beside natural caves/overhangs the survey can't show), 3 floating relief cells (a cut onto a thin cave
ceiling) and 14 grass->dirt cells under the fountain coping.
Fixed since (offline on run 4's settled survey + a volume built from its before dump, scratchpad/s3-build/an.mjs VOLDUMP=):
- footing (journalled subsurface under the bodies' solid cells);
- walk volume (the program asks the claim's volume, ground -12..+8, ~5M cells) so the draft world sees caves; underpin (rock under
  relief/route cells over a natural void, <= 24 deep);
- every route pass merged into meta.route (the checker's grade/villager rows saw only the lookout's); the lookout at the zone grade;
- a guarded route pass (terraced plans only) treats earlier passes' runs as obstacles (the lookout cut stairs across cloister_t6).
Offline now: M8 0 unguarded, M5 0, no M3, no M2:grade, 13/13 nodes; M6 (head room) warnings recorded.

Run 5 (20261021-000420, 23 s plan, 11/11 PLACED, M5 0.46%): the realise kept generated packed ice under routes (the mod's
TerrainFit.natural lacked ice while the kit's ICE class is natural: fixed in the mod, ice/packed/blue), the lookout's stair railings
on cloister_t6, 3 open rims (relief cut unwalled ring cells: now pinned at their ground), 4 M8 at top snow layers, 3 floating brink
rails over grass (parapet cond 0 now), 1 grass spread under a cherry trunk the fountain room felled (grass journalled under felled
trunks within 8 of a body). Offline on run 5's survey + its before dump: all clean.

Since run 6: lamps drop to a solid foot or are left out; floating decor trimmed; an empty walk run no longer registers (its
-Infinity box refused the plan); the flat hill by vanilla /fill (a realised s3_hill made it OWNED land). Scenario run
20261021-024127-6cs3-scn: flat and natural pass every bar but the golden (none yet) and the gallery. Golden cut from that natural run
(re-cut at kit 0.38.0); planSurvey re-pinned (cc52144b, previousSha kept) + feasibility record; gate6cs3 feasibility passes.
Merged origin/main (release tool): versions reverted to main's (API 1.37.0 / mod 0.40.0 / kit 0.38.0; S3 javadoc `Since NEXT`), the
release tool re-plans goldens with their biomes/bible, its set test counts a tree's own placeholders. Kit 682/0, sidecar check ok,
mod build ok, identity 262/262 + 59 asks. Item 4 (chain 6cs3-item4, 20261021-034205): PASS natural (after Steward's repair drops a
refused optional spire) and flat.

Slice tier 20261021-040412: 72 PASS / 5 FAIL, none S3's (pt2-ingame 13 and h-unit 10 fail on main; voc-unit needs docker;
apijars bee flake and sim-jobs sidecar reuse both PASS on re-run 20261021-081316). Gallery republished (section S3 v1, evidence
39d6ddb1bbf3). CONTRACT "S3 as built" written; PLAN queue and approvals row done.

In flight: gate-verifier (reviews origin/main...HEAD, recomputes the evidence sha, re-runs item 4 with chain 6cs3-item4 on
8928/8929, out scratchpad/s3-build/verify-runs).

Left: the verifier's verdict (fix anything it names); then delete this file, push, report "ready to merge".
