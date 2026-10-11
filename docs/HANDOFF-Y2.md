# HANDOFF Y2 (construction waiting status C25 and full BOM C26)

Branch `slice/Y2`, worktree `../architect-mc-Y2`, ports 8936-8941 (shard 1 on 8936:8937), spend $0. API 1.19.0 / mod 0.22.0 are
provisional: the coordinator renumbers at merge. Delete this file when the gate passes.

## State

- Done: API (SiteWait, ItemCount, Verdict.bomFull/bomExact, SiteView.siteWait, Sites.waiting, SITE_WAITING, features siteWaiting and
  fullBom), `survival/WaitCalc` (pure walk and latch), `site/SiteWaits` (state, events, waits.json, Source seam for Y1),
  `site/FullBom` (bill from the dry-run plan), hooks in `Builder`/`RoadBuilder`, unit tests, `tools/gate6cy2.mjs`, steps `y2-unit` and
  `y2-ingame`, api-compat `--gate6cy2`, apijars on 0.17.0/0.16.0/0.15.0 (baseline in `artifacts/gate6c-y2/v0170`, built from v0.17.0).
- In progress: first in-game run of `y2-ingame`.
- To do: slice tier, gate-verifier, CONTRACT as-built, retire this file, push.

## Decisions

- `SiteView.wait` is not a legal record component name (clashes with `Object.wait()`): it is `siteWait`.
- Waiting is a latch (starts after 100 starved ticks, holds until a cell is placed or the target is paused, built or removed), so a
  chunk unloading or a restart never ends it. `waitingSince` is the world game time, saved in `<world>/architect/waits.json`.
- Y1 seam: `SiteWaits.source(Source)` returns the supply (available units per item) of a target; the legacy source reads the crate.
- `bomFull` mirrors `Builder.planConvert` (last write per cell, cost via `Cells.cost`); drift sources flag `bomExact` false and are
  listed in `Verdict.notes`.
- Files Y1 will also touch (merge by hand): `tools/gate-chains.json`, `tools/gate6a.mjs` (apijars list), `tools/api-compat.mjs`,
  `ApiRules.JAVA_FEATURES`, `ApiRulesTest`, `SiteWait.java`/`ItemCount.java` (defined exactly as CONTRACT §1).

## Resume

`cd ../architect-mc-Y2 && node tools/gate-run.mjs change --only y2-ingame --since origin/main --ports 8936:8937 --run-dir ../architect-mc-Y2-run --out ../architect-mc/artifacts/gate-runs-Y2`
(commit first: clients run HEAD). Wait on `summary.json` with one until-loop.
