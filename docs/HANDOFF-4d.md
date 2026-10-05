# Phase 4d handoff (work in progress, branch `phase/4d`)

Spec: docs/CONTRACT.md "Phase 4d contract ... FROZEN after Steward review" (its "Changes from Steward's review" win).
API 1.4.0, mod 0.7.0. The gate has **not** been run; this file says where things stand and how to resume.

## Done (committed)

- **API 1.4.0** (`dev.larattalabs.architect.api`): Batch, BatchView, ItemEvent, SiteGroup, Stage, Stock, LotFit, FitOptions,
  OverlapMargin; `Sites` gains queue/batch/batches/cancelBatch/groups/group/removeGroup/approveStage/skipStage/reorderStages/
  undoStage/stock/fitToLot/overlapMargin as **default methods** (1.3.0 implementers still link); events BATCH_PROGRESS,
  ITEM_PLACED/FAILED/WAITING, BATCH_DONE, STAGE_STATE; Reason CANCELLED/LOT_TOO_SMALL/TIMED_OUT and State PLACING appended;
  SiteView (+group, batchId, itemKey) and Library.Entry (+front, anchors, groundY, approach) keep their old constructors;
  features batchPlacement, siteGroups, stages, groupCrate.
- **Pure logic, unit-tested** (`mod/src/main/java/.../batch/`): BatchRules (checks, stage assignment, order by stage/after/
  proximity, cancel, skip), StageRules (state machine, undo refusal, reorder), LotFitting (all street sides x fronts),
  QBatch/QItem JSON, SiteGroupRec JSON. `./gradlew build --offline`: 258 tests, 0 failures.
- **Ticked placement**: `site/TemplateWriter` (vanilla `placeInWorld` as a resumable cursor, cell lists cached per template
  and rotation), `site/PlaceJob` (template, beds, fill, clear, approach, cut plants, in the atomic order), `site/TickDeferral`
  + `mixin/LevelTicksMixin` (block/fluid ticks scheduled during our writes are held back and released at completion),
  `site/Placement` (per-tick budget `placementBudgetMs` 1-20 in architect-world.json, job registry, queue file
  `architect-queue.json`, clean-stop resume / crash rollback+requeue, stats, ghost progress via the construction ghost
  payloads), `site/RestoreJob` (snapshot restore over ticks: rollback, group/stage removal). `Sites.beginPlacing` records
  the site as `placing` right after its snapshot; Remove during placing rolls it back atomically.
- **Queue** `site/Batches` (waiting every 20 ticks for PLAYER_IN_BOX/OCCUPIED/NOT_LOADED up to the wait limit, LOAD_BOUNDED
  tickets, job chunk tickets, actor as UUID, mode resolved at queue time, actorless INSTANT only in a creative world or with
  the toggle off, toggle-on fails queued INSTANT items NOT_ALLOWED, stopOnFailure, cancel) and `site/Groups` (stages,
  removeGroup/undoStage in reverse placement order). Groups persist in architect-sites.json.
- **Shared crate** (R6) in `site/Builder` (one crate per group, crate BE owner `group:<id>`, acceptance and stock over the
  group's building sites, refunds at the crate cell); the builder stops at the shared budget after its first cell.
- Commands: `/architect batches | batch cancel <b> | groups | group remove <g> [force] | group approve|skip|undo <g> <stage>
  [force] | budget [ms]`. DevBridge: `dev.placement.stats {reset}`, `dev.placement.jobs`, `dev.placement.slow {on}`.
  apitest steps: bqueue, batch(es), bcancel, sgroups, sgroup, sgremove, sapprove, sskip, sreorder, sundo, stock, fit, margin.
- Placed view shows `group <g>` and `placing`.

## Gate status

| item | status |
|---|---|
| Equality (single cabin probe, 1 ms budget, normal-preset hill with trees) | **PASS** in-game: ticked == atomic over box+7-ish region (after a 3 s settle; leaf distances need it). 12-lot run not done. |
| Ticks/MSPT, relog, waiting, group undo, stages, survival crate, fitToLot, 0-gap, actor gone/Patron, toggle, cancel, append, throughput | **not run** |

Probe numbers (one cabin, 1 ms): 1359 cells, ~0.34 s, placement time per tick max 15.5 ms (the start tick: checks + snapshot
write), others ~1 ms. Note: these stats were taken before the MSPT fix below.

## Known issues / to check

- **MSPT measure fixed but untested**: Fabric's END_SERVER_TICK runs after the server tallies its tick time, so the server's
  MSPT excludes our work; `Placement.Stats` now times START -> a late END phase (`architect_mc:tick_stats`). Verify.
- The job start tick (checks, capture, compressed snapshot write + readback, leaf hold) is not sliced: the likely MSPT max.
- Construction items and construction-site removal stay atomic (one per tick slot); documented choice, not yet in CONTRACT.
- Ghost progress for placing sites and the Placed-view label are untested in game.
- Default shared crate position (beside the first site's approach end) may sit in a later lot; pass `crateAt` for dense layouts.
- Hashes must wait for ticks to settle (leaf distance propagation) in both worlds.
- Not written yet: docs/CONTRACT.md "Phase 4d as built", PLAN.md status line, README commands, DEVBRIDGE.md changelog,
  artifacts/gate4d/REPORT.md and throughput.json.

## Resume

```sh
cd ~/Developer/LarattaLabs/architect-mc-4d     # worktree on phase/4d (or: git worktree add ../architect-mc-4d phase/4d)
export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home
# (.gradle-home / mod/.gradle missing? cp -c -R ~/Developer/LarattaLabs/architect-mc/.gradle-home . ; same for mod/.gradle)
(cd mod && ./gradlew build --offline)
# mod/run/options.txt: enableVsync:false (else the hidden window blocks in SDL_GL_SwapWindow at the loading screen)
ARCHITECT_AUTOWORLD_NAME="G4D Probe" tools/run-gate4d-client.sh &     # DevBridge 8891, sidecar 8890, apitest, stub sidecar
ARCHITECT_DEV_PORT=8891 node tools/devcli.mjs wait
node tools/gate4d.mjs probe        # atomic vs ticked cabin; evidence -> ~/Developer/LarattaLabs/architect-mc/artifacts/gate4d
ARCHITECT_DEV_PORT=8891 node tools/devcli.mjs quit
```

Plan for the rest of tools/gate4d.mjs (only `probe` exists): a `base` step makes "G4D Base" (normal preset, gamerules
random_tick_speed 0, mob_griefing false, advance_time/weather false, spawn off), plans 12 lots with `/apitest fit` in a 4x3
grid around spawn (cabin/gatehouse/tavern/tower x3, streets on the north side, player in a street), then the world is
byte-copied (`cp -c -R mod/run/saves/G4D Base ...`) per scenario: equality (queue at 4 ms, record ITEM_PLACED order, hash each
lot's restoreBox+7, then atomic replay in that order in another copy and compare; then removeGroup and compare with the
pre-queue hashes, SITE_REMOVED order reversed), relog (dev.placement.slow, leave/open mid-item, actor:true), waiting (player
in a lot; a lot ~800 blocks away), stages (approve 1, skip 2, approve 3, undo 1 refused, undo 3, undo 1), survival shared
crate (3 CONSTRUCTION, crateAt, hoppers from chests holding the stock's outstanding total; compare with instant placements
in a reference copy), fit (4 lots per side, default and into), gap0 (+ OVERLAP third), Patron (creative world, toggle on,
actorless) and actorless refused in survival, toggle on mid-batch, cancel mid-item (hash), append (second batch into the group,
duplicate stage / other owner refused, removeGroup exact), throughput at 1/4/10 ms -> throughput.json. Use `/save-off`
during MSPT runs. Don't use DevBridge ports outside 8890-8895.
