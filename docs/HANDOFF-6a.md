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

| Step (contract build order) | State |
|---|---|
| 1. timeout diagnosis, chunk-status verification, index bench | in progress |
| 2. kit: IR, shapes, noise, realise, packing, lint, primitives, goldens, mega_bench | not started |
| 3. sidecar: region.plan, worker pool, region.tiles | not started |
| 4. mod: prepare, GENERATED_ONLY, CHUNK_BOUND, heights, tiles, records, RG points, undo | not started |
| 5. API 1.8.0, apitest, api-compat | not started |
| 6. gate items 1, 4-9 | not started |

## Gate status

| Gate item | State | Evidence |
|---|---|---|
| 1 unit/property tests | - | |
| 2 timeout diagnosis | - | `timeouts.md` |
| 3 chunk-status verification | - | |
| 4 mega_bench A | - | |
| 5 mega_bench B | - | |
| 6 exactness | - | |
| 7 crash RG1-RG6 | - | |
| 8 invariant iii | - | |
| 9 regressions | - | |

## Resume

```
cd ~/Developer/LarattaLabs/architect-mc-6a
cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline
```
