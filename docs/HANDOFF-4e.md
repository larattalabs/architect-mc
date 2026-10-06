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

## Gate status (stopped 2026-10-05 for a shutdown)

Evidence is local, under `~/Developer/LarattaLabs/architect-mc/artifacts/gate4e/<step>.json` (+ all.log). "Current" = run on
a build within the last few commits (since the large-site work); "earlier" = an older build: re-run on the final build.

| Gate | Step | Status (evidence) |
|---|---|---|
| 2 any order | `orders` | PASS, earlier build: 24/24, group, L 6/6 |
| 3 player edits | `edits` | PASS, earlier build |
| 5 crash K1-K8 | `crash` | PASS, earlier build (incl. K3 clean) |
| 6 roads + village | `roads` | PASS, earlier build; 4 ms throughput 19.5k cells/s after the same-tick start fix (`village A 4` probe) |
| 6 client ghost | `ghost` | PASS, current: shots g4e-ghost-road.png / -noroad.png looked at (approach 4 rows -> 2, stops at the road) |
| 7 survival layering | `survival` | PASS, earlier build (after the rule 3b fix) |
| 8 size cap | `sizecap` | PASS, current: keep place max 15-43 ms, remove 25 ms, rts 300 by feature trees 25 ms, 304k-cell cell site 20/22 ms, all exact |
| 9 leaves (adjacent toggle, held leaves both orders) | `leaves` | PASS, current (after the cut-plant and two-block fixes) |
| 10 mega-lite | `megalite` | PASS, current: 759,824 cells, relog resume, lot undo leaves the pad exact, group undo exact (max 30 ms), MSPT max 17/39/33 ms at 1/4/10 ms |
| 10 bench, megabig | `bench`, `megabig` | bench PASS (pad 0.04 B/cell, stack p50 1.0 / p99 1.4 µs at depth 4). megabig recorded: 11.6M cells, 33 min, 11 of 610 lots timed out NOT_LOADED (LOAD_BOUNDED 64 chunks at 1000x1000), MSPT max 237 ms (chunk generation of unexplored terrain) |
| 4 migration, downgrade | `migration`, `downgrade` | PASS, current (0.7.0-made world: index, legacy, 8/8 Removes, C half built 47% then identical to instant, P resumed, D settled, LAYER over migrated both orders, kills before/after commit; downgrade round trip) |
| 11 API | `api`, `api14` | PASS, current: every 1.5.0 call and new Reason; the 1.4.0 jar (unchanged) passes v0.7.0's apitest survival (45 ok), the 1.5.0 suite too (45 ok) |
| 9 4d regression | gate4d.mjs all + gate3.mjs + phase 1 Remove on the 4e client | earlier build only: all pass but L3 (pre-existing on v0.7.0: floating worldgen gravel at the lot edge, a known limit for "as built") |

Left: gate 9 re-runs; then a full re-run of every step on the
final build; CONTRACT "Phase 4e as built" (deviations listed below in Known issues and the commit log since 711e4b5), PLAN
status line. README and DEVBRIDGE are updated.

Bugs the gate found and fixed so far: `Journal.Value` helpers used `Name`/`Properties` (26.x writes `id`/`properties`);
removal blockers ignored block entities a LAYERed BOX site owns by its journal `after`; a group removal reported sites as
restored cells; K4 rolled back instead of placing; K6 left entries UNDONE; pending roads and cell sites were never settled;
group-undo evidence used the entry's own `before`; DevBridge could not rebind after a halted client; survival rule 3b refunded
a block the covering site kept (duplicate); a batch lost a tick per item (commit waits, next item a tick late);
`Map.copyOf` on packed positions went quadratic in undo planning (a size-cap undo planned for minutes).

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
