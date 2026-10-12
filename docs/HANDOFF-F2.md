# HANDOFF F2: scatter and feature stamps (resume notes; delete when the slice gate passes)

Branch `slice/F2` (worktree `../architect-mc-F2`), from origin/main 31f1b56 (v0.21.0 / API 1.18.0, T1 + MP + F1 on main).
Placeholders: API 1.20.0, mod 0.23.0, kit 0.22.0 (the coordinator assigns the real numbers at merge). Ports 8924-8929
(gate runner shards 8924:8925, 8926:8927, 8928:8929). $0: sim and stub only. Contract: docs/CONTRACT.md "Phase 6c slice F2"
(frozen with the batch), the batch's coordinator decisions, **N-F2-1 (Noah): stamps are local-only**.

Run dir `../architect-mc-F2-run`, gate out `artifacts/gate-runs-F2`, evidence `artifacts/gate6c-f2/`.

## Decisions so far

- **N-F2-1:** the stamp library lives in the player's game dir, `<gameDir>/architect/stamps/<feature>/<seed>.bin`
  (`Blueprints.gameDataDir()`), written by the harvester `dev.feature.stamp`; never in the repo or the jar (`kit/stamps/` is
  gitignored and excluded from the jar's kit copy; a gate check lists the jar). The sidecar passes it to the plan CLI as
  `--stamps <dir>`. A plan that uses a stamp embeds it as a side blob (kind `voxels`, ARVB), so tiles and the mod's blob path
  don't change. A missing stamp is a typed plan note and the item's fallback, never a silently different IR. Kit tests use
  synthetic stamps built at test time; `scatter_demo`'s committed golden is its stamps-off variant.
- Anchors at realise read only ARSV (ground, flags) and the IR's frozen volume classes (ARVX). Plant and snow-layer items need a
  volume (class SOIL for plants); without one only non-plant items fire on dry ground. Item 3's realised check uses the exact
  26.3 tags over the ARWD dump.
- Lights and walk cells come from other ops: plan-time fields from the draft virtual world (`draftIR`, as W's lightCover);
  lot boxes and keep-out are hard exclusions in the evaluator.

## Status

- [ ] harvester spike (each library feature twice, byte-compared)
- [ ] kit: scatter op (evaluator), anchors, supports, bundled items, property tests
- [ ] kit: stamp op, skirt, rotation; synthetic stamps in tests
- [ ] sidecar: --stamps, FEATURES; mod: versions, IrStale, features, ApiF2 test, jar exclusion
- [ ] scatter_demo (S2 claim, flat variant, cave box), scenario rows, golden (stamps off)
- [ ] gate: tools/gate6cf2.mjs, gate-chains steps + impact rule, apijars/api-compat on 0.21.0/0.20.0/0.19.0
- [ ] slice tier run, gate-verifier, CONTRACT as-built, retire this file
