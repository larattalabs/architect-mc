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

| Gate | Step | Status |
|---|---|---|
| 2 any order | `orders` | PASS: 24/24 orders, group removal, L in 6 orders (no leak, box + 8 exact) |
| 3 player edits | `edits` | PASS |
| 5 crash K1-K8 | `crash` | PASS (and K3 clean resume) |
| 4 migration, downgrade | `migration`, `downgrade` | written, not run |
| 6 roads + village, 8 throughput | `roads` | running |
| 7 survival layering | `survival` | written, not run |
| 8 size cap, sliced 300k | `sizecap` | written, not run |
| 9 4d regression | gate4d.mjs on the 4e client | earlier run: all pass but L3 (pre-existing, also on v0.7.0); adjacent-lot leaf check not written |
| 10 mega-lite, bench | `megalite`, `bench`, `megabig` | written, not run |
| 11 API | `api`, `api14` | written, not run |

Bugs the gate found and fixed so far: `Journal.Value` helpers used `Name`/`Properties` (26.x writes `id`/`properties`;
`Journal.AIR` never equalled a world value); removal blockers ignored block entities a LAYERed BOX site owns by its journal
`after`; a group removal reported sites as restored cells; K4 (record still placing, journal ACTIVE) rolled back instead of
placing; K6 (undo committed, record not pending) left the site's entries UNDONE; pending roads and cell sites were never
settled; group-undo evidence compared against the entry's own `before` instead of the group's written value; DevBridge could
not rebind its port after a halted client (SO_REUSEADDR).

Old 4d note: the 4d gate's L3 lot fails group-undo equality on v0.7.0 too (floating worldgen gravel, `regress4d/`).

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
