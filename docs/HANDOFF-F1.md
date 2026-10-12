# HANDOFF: Phase 6c slice F1 (forms I: ice spikes and rock spires)

Resume notes for `slice/F1` (worktree `../architect-mc-F1`). Delete this file when the gate passes.

- **Contract:** docs/CONTRACT.md "Phase 6c slice F1" (frozen by the batch's Steward review), SETTLEMENTS §9 and §11 (M17).
- **Numbers:** API 1.16.0, mod 0.19.0, kit 0.19.0 (one commit, "F1: version bump", redo it at merge if W/C23/MP land in
  another order; the coordinator says).
- **Ports:** 8918-8923 only (shards 8918:8919 and 8920:8921; old-version client 8922/8923). Run worktree
  `../architect-mc-F1-run`, gate runs under `../architect-mc/artifacts/gate-runs-F1`, lock there.
- **api-compat:** against the 0.17.0, 0.16.0 and 0.15.0 apitest jars; the 0.17.0 baseline built from tag v0.17.0.
- **Spend:** $0 (sim and stub only).

## Plan (build order)

1. Version bump. 2. `voxels` op (realise, opBounds, M13, mod IrStale kinds). 3. Generator rules (32 primitives per op, bake past
400 ops). 4. `iceSpike`, `keepNatural`. 5. `rockSpire` (buttress past an overhang of 4). 6. M17 (with volume ICE/SNOW as meltable).
7. `forms_demo` (S2's claim; soul lanterns, melt-safe), scenario fixture, `tools/gate6cf1.mjs`, gate-chains steps and impact map.

## State

- [x] worktree, version bump; run worktree `../architect-mc-F1-run` (mod/run cloned from V-run); the 0.17.0 baseline built from tag
  v0.17.0 in `../architect-mc-F1-v0170`, archived in `../architect-mc/artifacts/gate6c-f1/v0170/` (jars + tools copy for apijars)
- [x] kit: voxels op (`lib/region/voxels.mjs`, realise, opBounds, M13), rules (`lib/forms/rules.mjs`: 32 primitives, bake past 400,
  settleForm), `iceSpike`, `rockSpire`, `keepNatural`, M17 (26.3: ice melts over 10, snow layers over 11), M3:overhang, M1 keep;
  `forms_demo` (cell-level placement off the kept ice: S2's land is dense with natural spikes); kit tests `forms-f1.test.mjs`
- [x] mod: IrStale kinds + voxels, features formsIce/formsRock/voxelsOp from the sidecar's `region.forms1`, Api116Test
- [x] tools: `gate6cf1.mjs` (start/stop/base/unit/variants/stale/apicompat/pin/flat/natural/report), scenario `forms_demo`
  (`scenarios/forms_demo.json`, phase 6c-f1, short `forms_demo`), F1 bars in `tools/lib/scenario-forms.mjs`, gate-chains steps
  `f1-unit` and `6cf1-scenario-forms` + impact rule, apijars and api-compat on 0.17.0/0.16.0/0.15.0
- [x] first in-game runs on 8918/8919: flat all bars; natural all bars but determinism (a live volume changed by 2 PLANT cells
  between plans) -> the F1 scenario freezes the world (/tick freeze) for its 3 IR-sha plans
- [ ] natural re-run, golden `scenarios/goldens/forms_demo.json`, whole kit/sidecar suites, slice tier, gate-verifier, CONTRACT
  as-built, retire this file
