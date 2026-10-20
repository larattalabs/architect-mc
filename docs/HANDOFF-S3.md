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

## State

- (2026-10-20) Worktree made; orientation done. Nothing built yet.
