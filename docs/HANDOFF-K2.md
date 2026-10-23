# HANDOFF K2 (slice/K2, worktree ../architect-mc-K2)

Resume notes for Phase 7a slice K2 (docs/CONTRACT.md "Phase 7a slice K2"). Delete this file when the gate passes.

## State

- Kit side built and green: `wall.along` (kit/lib/connectors/line.mjs `alongSide`/`alongLine`, wall.mjs `alongOf`, `wallsCutAnswer`,
  along gates.min), walks (kit/lib/connectors/wallWalk.mjs, wired in wall.mjs `emitWall`), the checker's walk rules
  (kit/lib/region/checkWalls.mjs `walkRules`: M2:walk, M8:walk, M6:walk, M5:walk), the structure lint (GATED and the `k2:walk` case
  with broken variants, corpus dir `k2`), siteplan `walls[].walk`/`spine`, graph nodes `access` and edges `wall_walk`, the catalogue
  flip, `walk` in plan/0, features wallAlong/wallWalks (sidecar + ApiRules).
- Tests: kit/test/k2.test.mjs (11). Fixtures: valid/v7a_k2_along_edge, v7a_k2_along_shore, v7a_k2_walk; k2/ (4 refusals,
  k2_shore_routes, k2_kc_pond, k2_rs_walk).
- Gate: tools/gate7ak2.mjs (unit, ingame, natural, survival, look, report); chains k2-unit, k2-ingame, k2-natural, k2-survival,
  k2-look; impact rule "7a K2 ..."; step-inputs rebuilt.

## Left

1. When v0.42.0 is tagged: `git merge origin/main`, rebuild step-inputs if asked, commit; then
   `node tools/gate-run.mjs slice --since origin/main --plan`, then the run detached (nohup, own process group), one until-loop on
   its summary.json.
2. The look gallery for Noah from `artifacts/gate7a-k2/look/` (close-ups of the walk: rail, corbels, an access landing).
3. gate-verifier (it re-runs item 9).
4. CONTRACT as-built with the evidence row; delete this file.

## Coordinator rulings (2026-10-23)

- The inner rail overhangs one cell inward on a corbel; along walls never take the harbour fallback; features need two ApiRules
  lines; the inside of an along wall faces away from its spine. Each is a deviation in the as-built.
- S3's shore: gates.min 2 instead of route-crossing auto gates (the gate move can't open on the stepped bank: PLAN "Queued from slice
  K2"); routes the wall cuts answer UNREACHABLE {kind: wall}; the crossing bar is on the flat biome-edge fixture.
