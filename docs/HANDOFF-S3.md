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

In flight: in-game natural dev run (chain 6cs3-dev, ports 8924/8925, run dir ../architect-mc-S3-run, out scratchpad/s3-build/runs).

Next: realised M5 from that run; re-pin planSurvey from its raw/plan/survey.bin; gate6cs3.mjs (unit, feasibility, plan, apicompat,
report) + chain steps (s3-unit, s3-plan, 6c-scenario-s3) + impact rule; item 4 driver; flat variant run; golden; gallery;
full kit + sidecar suites; byte identity over all fixtures; verifier; as built.
