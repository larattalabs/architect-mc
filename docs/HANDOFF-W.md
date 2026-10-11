# HANDOFF-W: slice W, village safety (API 1.15.0, mod 0.18.0; renumbered after slice X merged first as 1.14.0 / 0.17.0)

Contract: docs/CONTRACT.md "Phase 6c slice W" (FROZEN), its "Changes from Steward's review of W" and the "Coordinator
addition (Noah, 2026-10-11)" (bible-styled lamps). Branch `slice/W`, worktree `../architect-mc-W`. Ports 8906-8911 only
(a release-tier run holds 8890-8899). Spend $0.

## State

- [x] 0.16.0 baseline: `../architect-mc/artifacts/gate6c-w/v0160/` (apitest + mod jar, tools), from tag v0.16.0 in
      `../architect-mc-W-v0160`. `node tools/api-compat.mjs --gate6cw`: 4 checks clean.
- [x] Item 0 COPY ms (`sidecar/src/breakdown.ts`; `variants.ts` records `variantStarts`; `breakdown-copy.test.ts`, R's group).
- [x] Item 4 gravity (`blocks.mjs` `g` from FallingBlock, `surfaceOps` rule, `M3:gravity`, the 500-claim test, the variant).
- [x] Item 3 frozen water (`Columns.FROZEN`, `Sample.frozen`, `RoadTerrain`, kit `frozenAt`, M24 unfrozen, find-site noFrozen).
- [x] Item 2 road lanterns on the owner's built verge (`RoadPlan.OwnFoot`, `RoadPlanTest`).
- [x] Item 1 `r.lightCover` (`kit/lib/region/light.mjs`) and the fixture catalogue (`fixtures.mjs`, square lamps, `road:lamp`).
- [x] Driver `tools/gate6cw.mjs`, `dev.region.survey`, W rows on S7, `scenarios.mjs run --bible`, W bibles, impact rules.
- [x] Merged origin/main (X, v0.17.0); renumbered to API 1.15.0 / mod 0.18.0 / kit 0.18.0; 0.17.0 baseline in
      `artifacts/gate6c-w/v0170/` (tag v0.17.0, `../architect-mc-W-v0170`); api-compat --gate6cw against 0.17.0/0.16.0/0.15.0 clean.
- [x] First slice tier `artifacts/gate-runs-W/20261011-194019-slice` (pre-merge): FAIL on w-ingame (bible not installed on a fresh
      run worktree: fixed, `scenarios.mjs prep`), 6cw-scenario-s7 (lampsoff's OUT env: fixed), 4d-all (tick bar 51.5 ms at load 28),
      6a-megaA (TIMEOUT: one lot WAITING OCCUPIED). MSPT A/B (`artifacts/gate6c-w/mspt-ab.json`): v0.16.0 also over 50 under load.
- [ ] Chain 3 (post-merge) on 8906/8907: S7 flat/natural, golden, lampsoff, frozen, variants, pathbibles, gallery; then republish.
- [ ] In-game chain on 8906/8907 (client pid in the run log; run worktree `../architect-mc-W-run`): base, s7flat, s7, lampsoff,
      frozen, variants, surveys, pathbibles, gallery. Log: the session scratchpad `w-chain.log`; evidence `artifacts/gate6c-w/`.
- [ ] S7 golden re-committed from W's natural run; S2/S3 `fixture.planSurvey` written (`GATE6CW_REPIN=1 ... surveys`).
- [ ] Slice tier (3 shards, 8906-8911), gate-verifier, gallery section W, CONTRACT as-built, retire this file, push.

## Decisions so far (record as deviations in as-built)

- `architect_mc:village.lamps` is a `lamps` list inside the existing `LotSpec.ext["architect_mc:village"]` object (Steward
  already reads that object; VPlan.java).
- COPY time falls back to the variant's `createdAt` when no start was recorded (records from before W, e.g. R's fixture).
- Street lamps: the IR road's `lamp` member (format 2, kind `road:lamp`) only when the fixture isn't 4e's own fence and lantern;
  the kit resolves the fixture into a block stack written for an eastward road, the mod turns it.
- Item 7: the scenario files' `fixture.surveySha` is find-site's Sample summary sha, which W doesn't change (Sample.water and
  the summary are unchanged). The plan survey (ARSV) is what FROZEN moves: S1/S7 are compared with their goldens' survey.bin,
  and S2/S3 get `fixture.planSurvey` (sha, FROZEN count, V's-reading sha) recorded with the reason.
- The apron rule of item 4 needs no op change: the apron stands on the pad's foundation fill (box(0) to t-1, IF_NATURAL fills
  water and air), so it can't sit over a gap; the property test covers it.
- `flat_village` gains a bool param `apronLamps` (default on) so the 500-claim property tests stay fast; S7 uses the default.
