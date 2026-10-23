# HANDOFF: slice CW (catwalks along a face)

Branch `slice/CW`, worktree `../architect-mc-CW`, off `origin/7a/foundation` (merged 97766cf6). Contract: docs/CONTRACT.md "Phase 7a
slice CW". Delete this file when the slice gate passes.

## State

- Kit built and unit-tested: `connectors/catwalkGeom.mjs` (geometry, `catwalkRun`, `emitRouteCatwalks`), `region/passes/moves/catwalk.mjs`
  (route row 10), `connectors/catwalk.mjs` (the compile hooks), `region/checkCatwalks.mjs` (M10:catwalk, M5catwalk in check.mjs),
  the catalogue flip (`connector.catwalk` supported, schemaVersion 1, `sinceApi: NEXT`), style chains (N-CW-1), the feature `catwalks`
  (sidecar `region.catwalks`, ApiRules, ApiCWTest), `kit/regions/catwalks_demo.mjs` with `connectors/catwalksDemo.mjs`.
- Fixtures: `valid/v7a_cw_cliff.json`, `cw/` (r01-r05 refusals, u01-u03 broken variants, k01 KC), `even/ew03_catwalk_even_width.json`.
- Lint: S-LAND reads catwalks, `M10:catwalk` gated, `even:catwalk`, `p0:cw`, writer kind `catwalks`.
- Shared-file edits (small, in CW's own lines): program.mjs (the catwalk landing row like a bridge's far landing; `rec.t7`), check.mjs,
  structure.mjs, lint-cases.mjs, writers.mjs, style.mjs, plan.json, gate-chains.json, f7a-foundation.test.mjs (the 7a flips left out
  of the foundation's own three-entry diff: CL and K2 need the same), e15.
- Gate driver `tools/gate7acw.mjs`; chains cw-unit, cw-ingame, cw-survival, cw-pin, cw-natural, cw-look.

## Left

1. Main is frozen for v0.42.0; after it is tagged: merge origin/main, run `cw-pin` once (commit the pinned `scenarios/sites/cliff_face.json`),
   then the slice tier (`node tools/gate-run.mjs slice --since origin/main --plan`), and `cw-look` for the gallery (N-CW-1).
2. Gate-verifier; as-built evidence row in CONTRACT.md.
