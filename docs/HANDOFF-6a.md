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
| 1. timeout diagnosis, chunk-status verification, index bench | timeouts reproduced + classified (artifacts/gate6a/timeouts.md; run 2 of the diag finishing); index bench PASS (1.7-2.9 MB, p99 11-14 ms at 2k); chunk status: ChunkGen (chunk map latest status, then IOWorker.scanChunk of `Status`), cost to measure in game (`dev.chunks.status`) |
| 2. kit (sub-agent, branch phase/6a-kit) | engine core pushed (ad35d24); program API, plan CLI, mega_bench, region_small, goldens in progress |
| 3. sidecar (sub-agent, phase/6a-sidecar) | DONE, merged (e4be292, ba316b8); 601 tests |
| 4. mod | written: ChunkTickets, GENERATED_ONLY, CHUNK_BOUND, ChunkGen, GenCounter, Columns/Packed codecs, heights shards, TileStream, TileCheck (conds, ownership, trees, leaves entry), RegionItems (tile items, freeze-ahead), RegionsImpl (plan/prepare/realise/remove/records), Prepare governor, Drift, RegionHash (hash/snap/diff + classifier), MsptTrace, RG1-RG6; not yet run in game |
| 5. API 1.8.0 / apitest / api-compat | API types + apitest region steps written; api-compat clean vs 1.7.0/1.6.0/1.5.0 jars and the 1.7.0 surface (artifacts/gate6a/api-compat.txt) |
| 6. gate | harness tools/gate6a.mjs (base, smoke so far) |

Worktrees: `architect-mc-6a` (build), `architect-mc-6a-run` (gate client, detached; `gate6a.mjs start` checks out HEAD and builds
the sidecar), `architect-mc-6a-diag` (0.10.0 + diag, ports 8892/8893 while it runs), `architect-mc-6a-kit`,
`architect-mc-6a-sidecar` (sub-agents). The 1.7.0 jars: artifacts/gate6a/v0100/.

## Resume

```
cd ~/Developer/LarattaLabs/architect-mc-6a
cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline
```
