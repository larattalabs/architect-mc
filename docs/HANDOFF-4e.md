# Phase 4e handoff (journal-backed sites)

Branch `phase/4e` in the worktree `~/Developer/LarattaLabs/architect-mc-4e` (from `origin/main` 6de8f43, v0.7.0 / API 1.4.0 plus
the frozen 4e contract). Spec: docs/CONTRACT.md "Phase 4e contract", including "Coordinator decisions on N1-N7" and the final
"Changes from Steward's review" (which wins). Do not merge, tag or publish: the coordinator does that after the gate check.

## Layout

- `~/Developer/LarattaLabs/architect-mc-4e`: development worktree (branch `phase/4e`).
- `~/Developer/LarattaLabs/architect-mc-4e-run`: a detached worktree the gate client runs from (so compiling in the dev worktree
  never changes the classes of a running client). Update it with `git -C ../architect-mc-4e-run checkout --detach <commit>`.
- `~/Developer/LarattaLabs/architect-mc-v070`: detached worktree at tag v0.7.0 (the 0.7.0 client for the migration and downgrade
  steps, DevBridge 8893 / sidecar 8892). Its jars: `mod/build/libs/architect_mc-0.7.0.jar`, `apitest/build/libs/architect_apitest-0.7.0.jar`.
- Evidence: `~/Developer/LarattaLabs/architect-mc/artifacts/gate4e/` (main checkout, untracked).

## State

Built (compiles, unit tests green) and the gate is being run: `tools/gate4e.mjs <step>` (steps: smoke, orders, edits, crash,
migration, downgrade, roads, survival, sizecap, megalite, megabig, bench, api, api14; `start [world]` / `stop` manage the
gate client by PID, `eval '<js>'` runs ad-hoc checks). The fixture worlds are flat meadows (`G4E Flat`); size-cap random
ticks use a normal world (`G4E Normal`, seed `4e`).

## Gate status

Evidence is local, under `~/Developer/LarattaLabs/architect-mc/artifacts/gate4e/<step>.json` (+ all.log). Steps run on a build
older than the latest commit must be re-run on the final build (every step, plus gate 9's gate4d/gate3/phase 1 re-runs).

| Gate | Step | Status (evidence) |
|---|---|---|
| 2 any order | `orders` | PASS earlier build: 24/24, group, L 6/6 (orders.json) |
| 3 player edits | `edits` | PASS earlier build (edits.json) |
| 5 crash K1-K8 | `crash` | PASS earlier build, incl. K3 clean (crash.json) |
| 6 roads + village | `roads` | PASS earlier build (roads.json); 4 ms throughput 19.5k cells/s after the same-tick start fix (village probe), roads.json older |
| 7 survival layering | `survival` | PASS (survival.json) after the rule 3b fix |
| 8 size cap | `sizecap` | FAIL: keep placement spikes (tryStart 260 ms: cold TemplateGrid 118 ms + two checkSite passes; P3 submit 30 ms, start 30 ms, first template step 45 ms); single Remove of the keep took 1.4 s in one tick (plan 417, commit 199, write 776 ms). Work in progress: ticked/sliced removal and placement start |
| 4 migration, downgrade | `migration`, `downgrade` | written, not run |
| 9 4d regression | gate4d.mjs + gate3 + phase 1 | earlier: all pass but L3 (pre-existing on v0.7.0: worldgen gravel over a cave at the lot edge); `leaves` step written, not run |
| 10 mega-lite, bench | `megalite`, `bench`, `megabig` | written, not run |
| 11 API | `api`, `api14` | written, not run |
| 6 ghost | `ghost` | written, not run |

## Known issues

- A building's `after` (P6) is captured before the placement's deferred block ticks run, so a few cells differ from it
  afterwards (dirt_path under a solid block turns to dirt). Removal is unaffected (BOX); `dev.site.verify` reports them.

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-4e
git fetch && git status
cp -c -R ~/Developer/LarattaLabs/architect-mc/.gradle-home . 2>/dev/null; cp -c -R ~/Developer/LarattaLabs/architect-mc/mod/.gradle mod/.gradle 2>/dev/null
cd mod && JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/../.gradle-home ./gradlew build --offline
# gate client (from the run worktree), DevBridge 8891 / sidecar 8890:
cd ~/Developer/LarattaLabs/architect-mc-4e-run && git checkout --detach <commit>
ARCHITECT_AUTOWORLD_NAME="G4E Base" nohup tools/run-gate4e-client.sh > ~/Developer/LarattaLabs/architect-mc/artifacts/gate4e/client.log 2>&1 &
ARCHITECT_DEV_PORT=8891 node tools/devcli.mjs wait
```

Ports 8890-8895 only (other sessions use other ranges). Kill only clients this session launched, by PID (`pgrep -f
architect-mc-4e-run/mod/.gradle/loom-cache/launch.cfg`), preferably with `devcli quit`.
