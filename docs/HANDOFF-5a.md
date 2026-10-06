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
| 2. Sim build | sidecar loop, critic, budgets, estimates, bible format 2/admin, report mode, job.images, eval.mjs: DONE (sidecar 536 tests). Kit (phase/5a-kit, merged): views, slices, attach/facing, metrics, restraint, PLAYBOOK (kit 126 tests). Migration tests (phase/5a-mig, merged): 19 new mod tests. Java 1.6.0 + UI: in progress on phase/5a-java (subagent). |
| 3. Real runs | **PAUSED 2026-10-06 18:10 (coordinator: Noah's subscription near its limit; no real calls until he says so).** Smoke tier DONE (complete, not partial). Mosswater format-2 revision DONE (fixture committed). Full tier NOT STARTED. Opus subset NOT STARTED. |
| 4. Gate G1-G4, clutter, regressions | not started |
| 5. Docs | not started |

Baseline before 5a (15fbdf6): kit 102 tests, sidecar 507 tests (18 files), mod 291 tests, all green.
The unchanged 1.5.0 apitest jar (`architect_apitest-0.8.0.jar`), the 0.8.0 mod jar and the 0.8.0 `tools/` are stashed in
`artifacts/gate5a/v080/` for the binary-compatibility check.

## Spend (API-equivalent, claude login, cap $120)

| What | USD |
|---|---|
| probe | 0.0098 |
| smoke tier (briefs 1, 3, 10, 13; run `smoke-2026-10-06T1738`) | 9.2970 |
| smoke rejudge (judge stability) | 0.3891 |
| Mosswater bible.revise, 1st try (failed: a format-field bug, fixed in 6f…/"a bible draft is always validated as format 2") | 0.2790 |
| Mosswater bible.revise to format 2 (with the sheet critique) | 1.1248 |
| **total** | **11.0997** (= spend.json totalUsd) |

The ledger of record is `artifacts/gate5a/spend.json` (eval.mjs reads and writes it).

## Smoke tier results (2026-10-06, Sonnet, maxRevisions 1)

| Brief | End | Round 0 -> round 1 (critic overall) | Best | Judge | Cost |
|---|---|---|---|---|---|
| 1 woodcutters_cabin | max_revisions | 5.0 -> 5.33 | 1 | win | $1.90 |
| 3 watchtower_plot | max_revisions | 5.67 -> 5.33 | 0 | identical (round 0 installs) | $1.74 |
| 10 hellish_lair | max_revisions | 5.67 -> 5.83 | 1 | tie | $3.11 |
| 13 stilt_house | max_revisions | 5.5 -> 5.67 | 1 | win | $2.55 |

- Nothing shipped (the critic scores 5-6; shipScore 7). Loop spend mean $0.63 = 39% of round 0 ($1.60); added wall time 2.4 min; estimates within +-50% (4/4, total +0.4%).
- Judge stability: `rejudge` agreed 4/4 (3 real judgings + 1 identical).
- P0 at install in 3 of 4 (the critic keeps finding a P0 the one revision did not fix). G2 (rise >= 1.0) looks unlikely with these scores; record honestly.
- Calibrated from it (committed): critic seed $0.02-0.08 / 0.1-0.4 min, Sonnet revision $0.25-1.0 / 1-4 min, Opus revision $0.4-1.6 / 1.5-6 min (scaled). Frozen: `DETAIL_NOISE_MAX = { sparse 0.32, moderate 0.42, rich 0.5 }`.
- Mosswater v2 (eval/fixtures/bibles/mosswater/versions/2): format 2, 6 motifs, 3 hero motifs, accentShareMax 0.06, sparse, 8 components; sheet critique overall 5 (legibility 4, restraint 6, craft 5).

## What is left (in order)

1. Merge `phase/5a-java` (Java 1.6.0 + UI, subagent stopped mid-work: check its last commit and finish it), build mod 0.9.0, all mod tests green.
2. **Full tier** (all 18 briefs, briefs 16-18 use Mosswater v2 automatically via the fixture's versions/2... NOTE: the group brief files name `bible: "mosswater"` = its latest version, i.e. v2). Cap $85; total ledger stays under $120:
   `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN node tools/eval.mjs run --tier full --label full --max-usd 85 --out ~/Developer/LarattaLabs/architect-mc/artifacts/eval --ledger ~/Developer/LarattaLabs/architect-mc/artifacts/gate5a/spend.json --total-cap 120 --reserve 8`
   (reserve ~$8 for step 3). A paused/killed full run resumes with `--resume <runId>` (same --out); finished briefs are never re-run, in-flight designs resume in the sidecar's data dir.
3. Other real checks (~$3-5): `design.critique` report of a 4b entry, one massing critique (maxRevisions 1), one `loop` design through the Java API (apitest `critique` suite on the claude-login sidecar).
4. Opus subset (`--models opus-subset`, briefs 5, 8, 10, 14) only if the ledger total stays under $120.
5. Gate: G1-G4 from `eval/results/full/summary.json` aggregates; clutter (briefs 16-18 vs the 4b set: blind legibility judge vs the stored 4b renders, design-critic agents, detailNoise/accentShare); regressions (all tests, 4a-4c sim checks, the 1.5.0 apitest jar in `artifacts/gate5a/v080/` against 0.9.0, the 4e in-game migration step, a Designs-tab screenshot); REPORT.md in artifacts/gate5a.
6. Docs: CONTRACT "Phase 5a as built", PLAN status line, README (critique), DEVBRIDGE changelog.

## Eval runs

`node tools/eval.mjs run --tier sim --label sim` (sim, ~20 s); real tiers write to the main checkout's artifacts:

```sh
cd ~/Developer/LarattaLabs/architect-mc-5a && (cd sidecar && npm run build)
L=~/Developer/LarattaLabs/architect-mc/artifacts/gate5a/spend.json
node tools/eval.mjs run --tier smoke --label smoke --out ~/Developer/LarattaLabs/architect-mc/artifacts/eval --ledger $L --total-cap 120 --reserve <N>
# resume after a pause: node tools/eval.mjs run --resume <runId> --out ~/Developer/LarattaLabs/architect-mc/artifacts/eval
```
Never with an API key in the environment (the runner refuses).

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-5a
git pull
(cd sidecar && npm ci && npm run check)
node --test kit/test/*.test.mjs
(cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline)
```

## Pause note (coordinator, 2026-10-06)

- Paused to conserve Noah's subscription. Real spend so far: $11.10 API-equivalent (spend.json).
- **Not yet merged into phase/5a:** `phase/5a-java` (worktree `../architect-mc-5a-java`, head f1784d3): API 1.6.0, mod 0.9.0,
  critique UI, the apitest `critique` suite (20/20 sim), `tools/api-compat.mjs` (466 refs and 1088 members compatible), 320
  mod tests. Merge it first on resume. Left there: an end-to-end run of the UI submit paths (Design tab, set dialog, massing
  first plus critique), the 1.6.0 "as built" note, the N1 settings toggle, and `tools/gate4e.mjs`, which still hard-codes 1.5.0.
  The 1.5.0 jar run needs `APITEST_API_VERSION=1.5.0`.
- Resume order: merge 5a-java -> full tier (fresh run) -> Opus subset if under $120 -> critique-real via the Java API ->
  gate G1-G4, clutter, regressions -> docs -> gate-verifier.
- Smoke signal to watch: no design reached ship (5-6 vs 7), 3 of 4 installed designs kept a P0, so G2 is at risk.
