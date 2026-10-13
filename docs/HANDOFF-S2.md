# HANDOFF S2: the ice-spike outpost goes green

Branch `slice/S2`, worktree `../architect-mc-S2` (from origin/main 10bcaf5 = v0.27.0 / API 1.24.0). Placeholders: API 1.25.0,
mod 0.28.0, kit 0.27.0. Ports 8906-8911. $0 (sim and stub only).

## State

- **Item 1 (feasibility): PASS offline** on the re-pinned plan survey (sha 708981a8, `goldens/forms_demo/survey.bin` + its
  `vol_1`): 7 lots on the land band (longhouse, watch tower, smithy, store, farm, 2 huts; hut_3 has no site), every lot routed
  from the gate, checker 0 errors. Evidence `artifacts/gate6c-s2/feasibility.json` (local).
- `kit/regions/ice_outpost.mjs` written (lots, relief blend, routes, generated spikes, scatter, light cover, cameras).
- Kit fixes S2 needed (composition gaps between W/T1/F1/T2), all in the kit suite (358 pass):
  - `_route`: a keep set is an obstacle at its kept columns, not its whole box (F1's claim-wide keep blocked every route).
  - `relief`: kept columns are fixed and walls to the relaxation (`keep` from `r.pass`).
  - route retaining columns never on a kept column.
  - route grade quantum keeps every 8-cell window within floor(maxGrade * 8) (0.2 rose 2 over 8 rounded cells).
  - `lightCover`: a draft with side blobs is format 2 and reads the plan's volumes.
  - plan meta carries `outpost`.

## Next

1. Unit tests + broken variants for the kit fixes; KIT_VERSION 0.27.0, API 1.25.0, mod 0.28.0, feature `scenarioS2`.
2. Bible `scenarios/bibles/g6c_s2_outpost.json`, scenario wiring (`scenarios/s2_ice_spikes.json` program/params/entries;
   `tools/scenarios.mjs` phase `6c` for S2: prep, mob clearing, tick freeze, after-stand dump, freeze/melt classes, golden).
3. Pin, runs (flat headless, natural on client), golden, gallery (republish "Architect 6c-V gallery" with an S2 section).
4. Slice tier, gate-verifier, as-built, retire this file.
