# Phase 5a handoff (critique loop and eval harness)

Working notes for resuming phase 5a after a pause. Deleted when the gate passes.

- Branch `phase/5a` (worktree `~/Developer/LarattaLabs/architect-mc-5a`), from main 15fbdf6 (v0.8.0 / API 1.5.0, 5a contract frozen).
- Spec: docs/CONTRACT.md "Phase 5a contract" (its last section, "Changes from Steward's review", wins).
- Evidence (local, not committed): `~/Developer/LarattaLabs/architect-mc/artifacts/gate5a/` (probe.json, spend.json, REPORT.md later).
- Do not merge, tag or publish.

## State

| Step | Status |
|---|---|
| 1. Image probe | DONE 2026-10-06: image content blocks work under the claude login ($0.0098, apiKeySource none). Critic and judge send images; `job.images` ships. |
| 2. Sim build | in progress |
| 3. Real runs (smoke, full, Opus subset) | not started |
| 4. Gate G1-G4, clutter, regressions | not started |
| 5. Docs | not started |

Baseline before 5a (15fbdf6): kit 102 tests, sidecar 507 tests (18 files), mod 291 tests, all green.
The unchanged 1.5.0 apitest jar (`architect_apitest-0.8.0.jar`), the 0.8.0 mod jar and the 0.8.0 `tools/` are stashed in
`artifacts/gate5a/v080/` for the binary-compatibility check.

## Spend (API-equivalent, claude login, cap $120)

| What | USD |
|---|---|
| probe | 0.0098 |
| **total** | **0.0098** |

The ledger of record is `artifacts/gate5a/spend.json` (eval.mjs reads and writes it).

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-5a
git pull
(cd sidecar && npm ci && npm run check)
node --test kit/test/*.test.mjs
(cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline)
```
