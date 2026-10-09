# Phase 6a handoff (macro kit engine and scale)

Working notes for resuming phase 6a. Deleted when the gate passes. The spec is docs/CONTRACT.md "# Phase 6 contract" (the
6a scope, gate, build order, the coordinator decisions and Steward's review changes, which win).

## Where things are

- Branch `phase/6a` (worktree `~/Developer/LarattaLabs/architect-mc-6a`), from `origin/main` 1c8d03b (v0.10.0, API 1.7.0).
- Gate evidence (local, not committed): `~/Developer/LarattaLabs/architect-mc/artifacts/gate6a/`.
- Ports: 8892/8893 (sidecar/DevBridge) for the gate client, 8894/8895 for a second client. 8890/8891 belong to another
  session (fix/construction-dupe); never touch them.
- Run worktrees (unique basenames, the harness finds clients by them): `architect-mc-6a-diag` (0.10.0 + diagnostics),
  `architect-mc-6a-run` (the gate client).

## State

- Kit (177 tests), sidecar (601) and mod (373) built. Step 1 done (timeouts.md, index bench PASS, api-compat clean).
- megaA PASSES every bar (2026-10-08 23:58, before the group-save coalescing): 9.56M cells, 57.8k cells/s, MSPT max 27 ms /
  p99 15.7 ms, 0 generated, starved 1.3%, journal 0.20 B/cell, wire 0.21 B/cell, undo 136 s max 47.8 ms, E-normal 31
  mismatches all classified (gravity 30, live 1). Evidence `megabench-A.pass1.json`.
- Running (chain1): megaA (final), chunkstatus, heap, megaB, eflat, forest, inv3, crash. Then apijars and the regressions
  (4d, 4e orders/crash/roads/megalite, throughput x3, 5b chains/village/MSPT, 4a/4b/4c sim), REPORT.md, docs.
- Sidecar e2e (bundle 4c, eval sim tier) failed 2-3 tests while a game client ran megaA: rerun idle before calling it.

## Deviations so far (for CONTRACT "Phase 6a as built")

- CHUNK_BOUND refuses building items only; oversized road/cell items keep 4e's "run alone" (megalite's 256x256 pad).
- Heights freeze is per item window (tiles); lots and 4e roads do not freeze (fine for stage orders where lots come after
  their tiles, as in mega_bench; a later-stage tile over earlier lot columns would freeze post-lot).
- Plan flow: plan (LOADED_ONLY: the prepare estimate) -> prepare -> plan again (GENERATED_ONLY: complete survey) -> realise.
  GENERATED_ONLY(n) in a survey means n at once, unlimited in all; LOAD_BOUNDED keeps 4a's total cap.
- Exactness guards, tick slicing and journal format 2: see CONTRACT "Phase 6a as built" (drafted).
- Drift checked at region start only, on `height` (stored heightmaps, no chunk loads), not per stage.
- RegionPlan has no checker report/previews (6b adds them); futures fail with `RegionRefused(reason)` (API, new).
- Lots fit flush (setback 0, approach into the street); unmapped lots stay pads; the gate maps lots with `fitLots`.
- Group undo: a player standing in a tile's box holds it (4e rule kept); the gate uses a spectator player.
- `Sites.list(owner)` hides tiles (S1); the client Placed view still lists tiles individually (no player UI in 6a).
- `RemoveResult.kept` for group/stage undos now counts kept cells (was 0).
- Sidecar plan dirs live under `<data>/regions/plans`; the 30 s plan limit is wall clock.

## Resume

```
cd ~/Developer/LarattaLabs/architect-mc-6a
cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline
```
