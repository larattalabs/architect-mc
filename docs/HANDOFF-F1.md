# HANDOFF: Phase 6c slice F1 (paused by Noah, 2026-10-12)

Slice F1 (forms I) is built, verified (gate-verifier PASS on the pre-W branch) and recorded in docs/CONTRACT.md "Phase 6c slice F1
as built". Work paused in the coordinator's post-W round: ship F1 with MP as v0.19.0 (API 1.16.0, mod 0.19.0, kit 0.19.0; these are
already the branch's numbers).

## Done in this round

1. **Merged origin/main (W + Y2, v0.18.0, 9c0c700)**: commit 8f284ff. Rebase points: `KIT_VERSION`/`EVAL_KIT_VERSION`/
   `IrStale.KIT_VERSION` 0.19.0; `KINDS_FORMAT2` = W's list + `road:lamp` + `voxels` (kit and IrStale); sidecar `FEATURES` =
   W's + `region.forms1` (and the two sidecar tests); `RULES` keeps M17; `plan.mjs` takes W's `assembleParts` with F1's voxels
   bounds and part `keep`; plan meta keeps W's `gravity` and F1's `forms`; REGIONS.md has both sections; `Api115Test` checks
   minor >= 15 (it asserted exactly 1.15.0).
2. **Baselines**: apijars (`tools/gate6a.mjs`, gate-chains links) and `api-compat --gate6cf1` on 0.18.0/0.17.0/0.16.0. The 0.18.0
   baseline was built from tag v0.18.0 (`../architect-mc-F1-v0180`) into `../architect-mc/artifacts/gate6c-f1/v0180/` (jars +
   tools copy); 0.17.0 is W's `gate6c-w/v0170`. `api-compat --gate6cf1`: all 4 clean. `gate6cf1 stale` now checks v0.18.0's kit
   and mod (expects "this is kit 0.18.0"). Mod build + tests pass; key kit tests pass.
3. **Golden re-cut**: fresh flat + natural forms_demo runs at 8f284ff (dev client, 8918/8919): every F1 row passed; W's
   frozen-as-water did not move placement (forms_demo's land test already used the volume's top class). Golden re-cut from
   `artifacts/scenarios/6c-f1/forms_demo/20261012-052203` (IR sha 611fae337c70): commit 1407147.

## Left

- **Runner evidence for the change tier**: `f1-unit` PASSED (13 ok) in `artifacts/gate-runs-F1/20261012-054535-change` at
  1407147, but that run was stopped (pause) before `6cf1-scenario-forms`. Re-run:
  `node tools/gate-run.mjs change --since origin/main --only f1-unit,6cf1-scenario-forms --ports 8920:8921
  --run-dir ../architect-mc-F1-gate-s2 --out ../architect-mc/artifacts/gate-runs-F1` (8918/8919 were taken by slice T1's
  client at the time; check `lsof` and the 3-run slot limit first).
- Then add the post-W gate line to the as-built (head, run dir, forms_demo evidence sha), push, and report head + evidence sha.
  No new verifier is needed unless something beyond the merge and golden changes.
- Leftover worktrees: `../architect-mc-F1-run`, `-F1-gate`, `-F1-gate-s2`, `-F1-v0170`, `-F1-v0180`.
