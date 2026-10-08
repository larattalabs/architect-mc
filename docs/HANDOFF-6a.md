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

- Kit (merged from phase/6a-kit, 177 tests, Linux node:22 golden OK), sidecar (merged, 601 tests) and the mod are built.
- Step 1 done: timeouts.md (lost shared chunk tickets; spikes = journal reads on the server thread, not generation), index
  bench PASS. Chunk-status cost: measure with `dev.chunks.status` (todo in REPORT).
- In game (flat world, mega_bench): 8.87M cells, 82-86k cells/s first-to-last, MSPT max 24 ms, 0 generated, wire 0.21 B/cell,
  E-flat 0 mismatches over 258M cells; group undo took 110 s with 342/278 ms ticks -> fixed (commit prepared off-thread,
  covering scan off-thread), to be re-measured. Writer starvation 11-13% (bar 5%) -> fixes in (head retried per tick, head
  before freeze-ahead, check prep ahead, tile tickets released at P7), to be re-measured with the `starvedBy` breakdown.
- Gate runs: `prepare` + `megaA` running on the mega6 world (run client on 8894/8895).

## Deviations so far (for CONTRACT "Phase 6a as built")

- CHUNK_BOUND refuses building items only; oversized road/cell items keep 4e's "run alone" (megalite's 256x256 pad).
- Heights freeze is per item window (tiles); lots and 4e roads do not freeze (fine for stage orders where lots come after
  their tiles, as in mega_bench; a later-stage tile over earlier lot columns would freeze post-lot).
- Plan flow: plan (LOADED_ONLY: the prepare estimate) -> prepare -> plan again (GENERATED_ONLY: complete survey) -> realise.
  GENERATED_ONLY(n) in a survey means n at once, unlimited in all; LOAD_BOUNDED keeps 4a's total cap.
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
