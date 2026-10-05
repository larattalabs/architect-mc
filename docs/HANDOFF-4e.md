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

Built (compiles, 291 unit tests green):
- journal package: Journal (AgentCraft ab08a02 rules + PLACING + interned values), Sections (per-section planning), JournalStore
  (per-entry per-region files, generations, index commit point, section map, LRU cache, I/O thread), JournalNbt, WorldJournal
  (capture, stacks, per-section undo planning against the world, kill points), StillOurs (volatile properties), UpdateMask +
  BlockStateUpdateMixin (no updates into covered cells during a restore with holes), ChangeTracker + LevelChunkMixin (sliced
  captures), JournalMigration (4d import, late import).
- sites on the journal: SiteJournal (P1-P3, P6-P7, undo R1-R4, restore template from `written`), Sites (place/remove/move/forget/
  settle), PlaceJob (CAPTURE/COMMIT/START ... AFTER/AFTER_COMMIT/CONSTRUCTION_CLEAR), RestoreJob (plans its own rollback; writes
  committed undos; roads and cell sites), Groups (a group or stage removal is one undo), Builder (target = site entry's after,
  crate entries).
- roads and cell sites: RoadPlan (pure), RoadTerrain, Roads, InfraPlace, InfraJob, InfraApi, Infra/Infras records (`infra` array).
- API 1.5.0 surface, mod 0.8.0.

Not yet: DevBridge hooks (dev.journal.*, dev.road.*, dev.cells.place, dev.region.hash), apitest 1.5.0 steps, commands
(/architect road, /architect journal), the approach ROAD rule + road_cells sync + client ghost, UI (Place on top, Remove both),
survival layering refund rules, gate4e.mjs, bench, docs.

## Gate status

- 4d gate re-run (`artifacts/gate4e/regress4d/`, tools/gate4d.mjs on the 4e client): every step passes except "group undo:
  every lot region back exactly", which fails on lot L3. The same base world fails the same check on the **v0.7.0 jar**
  (`equality-v070.json`, `undodebug-v070.json`: identical 40-cell diff): worldgen gravel floating over a cave at L3's box edge
  is written back by Remove and then falls (its restore schedules the falling-block tick). Pre-existing, not a 4e regression;
  gate4e uses a base world without it and REPORT.md records it.

## Known issues

- A first 4e version re-captured positions changed during the async PLACING commit; that let a neighbour's falling gravel into
  a site's `before`. Fixed: a one-tick capture is the world at P1 (as 4d), only sliced captures track changes (until P3).

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
