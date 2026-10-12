# HANDOFF T1: passes, fields and relief (resume notes; delete when the slice gate passes)

Branch `slice/T1` (worktree `../architect-mc-T1`), from `origin/slice/W` (9c75e83). Placeholders: API 1.17.0, mod 0.20.0,
kit 0.20.0. Ports 8918-8923. $0. Contract: docs/CONTRACT.md "Phase 6c slice T1" plus the batch's coordinator decisions
(N-T1-1: `blend` is the default pad edge only for programs that declare passes) and S-T1-1 (120 s worst-case plan accepted).

Gate range: `--since origin/slice/W` until W lands on main (then merge origin/main and use `--since origin/main`).

## Decisions so far

- Relief ops go into the pads' stage (a column is frozen once, before any write to a tile that needs it; same frozen `g` as the
  pass's survey).
- The sidecar reads a program's declared passes from its source (`export const passes = [...]`, a literal), for bundled,
  non-catalogue and programsDir programs alike; the kit echoes the declared list in plan.json and the CLI summary, and the mod's
  second-survey decision reads the kit's word from `region.planned`.

## Status (paused by the coordinator, 2026-10-12; WIP)

Done:
- kit: relief op, pass framework (`r.pass`, declared passes, PASS_UNDECLARED), relief pass + erosion, `pad.edge: 'blend'`
  (N-T1-1), relief_demo, `kit/test/relief-t1.test.mjs` (the whole kit suite 263/263 before the merge), the passes lint, REGIONS.md.
- sidecar: pass budget (regionPassPlanMs 120 s / regionPassPlanHeapMb 2 GB) from the program source's `passes`; FEATURES
  `region.passes`; region.planned `passes`; `test/regions-passes.test.ts` (5/5).
- mod: mod 0.20.0 / API 1.17.0 / kit 0.20.0 placeholders, IrStale `relief`, features planPasses + reliefOp, resolution-1 second
  survey (`RegionsImpl.secondSurveyRes`), no-check plan wait 300 s, `PassesT1Test`; Api115Test's version check allows later
  minors. `gradlew build` green after merging origin/main (v0.18.0: W, Y2, C23).
- gate: `tools/gate6ct1.mjs` (unit, plantime, stale, apicompat, res1, reliefflat/relief, report), gate-chains steps `t1-unit`,
  `t1-ingame`, `6ct1-scenario-relief` and the T1 impact rule; scenario rows in `tools/lib/scenario-relief.mjs`.
- evidence so far (artifacts/gate6c-t1/, artifacts/scenarios/6c-t1/relief_demo/), all ad hoc on ports 8918/8919, $0:
  - plantime: 1024x1024 synthetic in the sandbox, median of 3: relief pass 1.06 s, plan 9.3 s wall, 233 MB peak; IR and field
    shas equal over 3 plans; tiles 1 = 4 workers.
  - stale: v0.17.0 kit and mod refuse the relief plan PLAN_STALE, the old evaluator writes nothing.
  - apicompat (--gate6cw): 4/4 clean.
  - res1: relief_demo on 320x320 gets a resolution-1 second survey; region_small keeps resolution 4.
  - relief_demo flat `20261012-054808-flat`-ish (latest -flat dir): every row passes, E-flat 0.
  - relief_demo natural `20261012-055047`: every T1 row passes (smoothness 99.5% <= 1, 0 over 3; pads 0 off; clamps 100%;
    erosion max 1; organic 0.2 vs slope 0.8 recorded; checker clean); E-normal all classified (2 `flow`); IR sha identical over
    3 plans (tick freeze). Its only FAIL was "golden none": the golden `scenarios/goldens/relief_demo*` is now committed from
    this run (needs one re-run of the natural scenario to show `match`).

Open decisions / deviations to record in the as-built:
- relief op: `cut` is every cell's condition; cells `min(g, top)..max(top, g+2)` (air above top clears plants).
- the pass emits two ops (delta over the band, target over corridors), not "one op per stage"; pads are their lots' own.
- the flat variant raises its hill through the pass's `base`, not an `add` op (the relief reads the frozen pre-region ground).
- E-normal `flow` world class (flowing, non-source water that moved; SETTLEMENTS §4.2) in scenarios.mjs, at a cell the plan
  writes: the verifier should judge this one.
- realised smoothness and clamps leave out band columns topped by another writer (a lot's approach stair).
- api-compat runs `--gate6cw`; at merge the coordinator swaps in the three previous jars.

Left:
- re-run `6ct1-scenario-relief` natural to show the golden `match`; commit nothing from artifacts.
- slice tier (`node tools/gate-run.mjs slice --since origin/main --ports 8920:8921,8922:8923 ...`), gate-verifier (re-runs
  items 1, 6, 8), CONTRACT as-built, retire this file, report ready to merge.
- the run worktree `../architect-mc-T1-run` holds a set-aside save `zz-discarded G6B Flat Base (autoworld normal)` (a normal
  world the autoworld created under the flat name; the start step now opens a lobby world).
