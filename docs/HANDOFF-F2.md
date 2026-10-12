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

- [x] harvester spike: 9 features x 8 seeds, every stamp byte-identical on a re-harvest (headless; `gate6cf2 harvest`)
- [x] kit: scatter op (evaluator), anchors, supports, bundled items, property tests (`kit/test/scatter-f2.test.mjs`)
- [x] kit: stamp op, skirt, rotation; synthetic stamps in tests; kit golden `scatter-demo.golden.json` (synthetic stamps)
- [x] sidecar `--stamps` (+ sandbox read), FEATURES `region.scatter`; mod versions, IrStale, features, ApiF2Test, jar exclusion
- [x] scatter_demo / scatter_cave scenarios pinned (dev run `../architect-mc-F2-run`, headless on 8926/8927)
- [x] gate: tools/gate6cf2.mjs (unit, stale, apicompat, harvest, pin), gate-chains f2-unit / f2-harvest / 6cf2-scenario-scatter,
      impact rule; apijars + api-compat on 0.21.0 (built from the tag: artifacts/gate6c-f2/v0210), 0.20.0, 0.19.0
- [ ] scenario runs green (flat, natural, cave); scatter_demo golden (stamps off) committed
- [ ] slice tier run, gate-verifier, CONTRACT as-built, retire this file

## Decisions made while building (for the as-built)

- A scatter item stays inside its own grid cell (the point is clamped; reach r needs grid >= 2r + 1), so placements of one op
  never overlap (a later placement took an earlier one's support in the property test). Reach at most 4, not 8: a placement's
  decision reads its whole footprint, so K2's 8 is footprint (4) + reach (4).
- Kept natural cells (F1 keepNatural) are kept cell by cell in the evaluator (the volume's class in the kept box), not by avoiding
  whole columns (S2's land is dense with kept spikes).
- Lantern melt safety on S2: no ice within level - 11, no snow other than the columns' own snow layers within level - 12 (the
  checker reads natural snow as a block), no tree or frozen column within level - 12; the snow layers there are cleared (air),
  written under every placement's own cells.
- Stamp fluids dropped (dripstone_cluster/2 holds 9 water cells): F2 places no fluid (H's M25).
- The committed scenario golden is the stamps-off re-plan of a run's own survey and volume; the run's own IR (with the local
  stamps) shows its determinism over 3 plans and 1 vs 4 workers.
