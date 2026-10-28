# HANDOFF: slice GJ (a district joins a walled town through a standing gate)

Contract: docs/CONTRACT.md "Phase 7a slice GJ" (FROZEN 2026-10-20) and its "as built" section at the end of the file (read that first:
the deviations, with reasons). D3's as-built wins over GJ's facts about D3. Branch `slice/GJ` off origin/main d8da5f21, worktree
`../_work/architect-mc-GJ`. DEV MODE: unit tests, instant lints, the slice's own in-game steps; the verifier re-runs items 6, 7 and 9
(removal and the dry check). Ports 8912-8917.

## Status (2026-10-28)

- [x] kit: `besideGates` (beside.mjs), the third step (`kit/lib/region/gateJoin.mjs`), the districts emission (two legs + the traverse
      edge), plan/0's endpoint.region through a gate (compile.mjs), the IR's `reach.gate`/`gatesSha`/`around`, M28's gate rule and the
      broken variant `writeGate`, land's `via`; `kit/test/gj.test.mjs` 12/12; parity fixture `kit/test/fixtures/gj/parity.json`
      (`node kit/test/gj-parity.mjs --write`), plan fixture `valid/v7a_gj_endpoint.json` (`node kit/test/gj-parity.mjs --endpoint`)
- [x] mod: `region/GateJoin.java` (gates = the kit's, the plan-time `stands` check, the wall region round a town, the re-check, journal
      tops), RegionsImpl (inputs, saveReach, re-check, dangling), PlanChecks, Drift, PlanRetention, DistrictLand, BesideVerdicts, ApiRules
      (`gateJoins`); `GateJoinTest` 3/3, `ApiGJTest` 1/1, `DistrictLandTest` 7/7
- [x] sidecar: the reach inputs' `gates[-id].json`, protocol `gates`, FEATURES `region.plan.gateJoin`; `npm run check` 50 files pass +
      `versions.test.ts` (a beforeAll timeout under load) 17/17 alone
- [x] lints: lint-structure 67/0, lint-look 13/0, water-lint 130/0 (p3-lint: in the gradle build)
- [x] driver `tools/gate7agj.mjs`; steps `gj-unit`, `gj-ingame`, `gj-town`, `gj-steward` (chain `7agj`, impact rule "7a GJ");
      step-inputs rebuilt, `check` clean. `gj-unit` + `apicompat` run directly: PASS (0 failures)
- [~] the in-game steps (released by the coordinator 18:20):
      - run `20261028-182318-change`: gj-unit 4/0, **gj-ingame 19/0** (items 3, 4, 6, 7, 9 on the gated d3_walled), gj-town 9/1 (the
        fountain refused: its anchor sat on the street end), gj-steward 14/2 (the stale floor bug below; fixed in fc914018)
      - run `20261028-184554-change` at fc914018: **gj-steward 17/0** (items 5, 8, 9); gj-town 2/4: with the fountain off the axis the
        ring [4, 8] refused round it. Fixed after (kit rehearsal): ring [8, 14], the fountain 7 straight in from the gate (on the inner
        run), every part READY in the kit. **gj-town needs one more run.**
      - the bug run 1 found: a block across the opening turns the walk's dirt_path to dirt (vanilla), and the re-check then stayed stale
        forever; now the opening is checked first and dirt for dirt_path is the walk (GateJoin.sameKind)
- [ ] gate-verifier (it re-runs items 6, 7, 9: `gj-ingame` and `gj-steward`'s refusals), then push and "ready to merge"

## Resume

```sh
cd ~/Developer/LarattaLabs/Minecraft/_work/architect-mc-GJ
export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home
node tools/gate-run.mjs change --only gj-unit,gj-ingame,gj-town,gj-steward --ports 8912:8913,8914:8915,8916:8917 \
  --run-dir ../architect-mc-GJ-run --out ../architect-mc-GJ-gate-runs --lock ../architect-mc-GJ-run.lock --plan
# then the same without --plan, detached; ONE until-loop on the run's summary.json
```

The in-game fixtures (all built by the driver on `G6B Flat Base`, each in its own world):
- `ingame` (d3_walled, gated): D3's 8-lot town at (60000, 20000), a C38 ring (`wall.around {feature: {region}}`, ring [4, 12], height 5,
  gates.min) through checkPlan + realiseApproved; the district east of it ([A2+1, A1+30, A2+90, A3-30]). Items 3, 4, 6, 7, 9.
- `town` (gj_town_wall): a plan/0 town zone with its own ring [4, 8] and a 3-wide wooden-door gate at anchor `east`; a first check finds
  the gate, then a fountain 8 inside it (item 10's KC). Items 3, 4, 7, 10.
- `refusals`: gj_sealed (gates 0), gj_fence (an `at` gate part with `door: fence_gate`), a gate walled up with cobblestone after the plan
  (ARTIFACT_STALE naming it), the dry check keeping nothing. Items 8, 9.
- `steward`: Steward's keys (`steward.b1.vplan`, a stale `.vrealise`, `.vplan2`/`.vrealise2`, realiseByKey after a restart),
  v7a_gj_endpoint in game. Item 5.

Known risks for the first in-game round (untested in game): the fountain anchor in `town` (a form `near` an anchor inside the ring);
`wallRound`'s gates.min gate facing the east street end (it did in the kit fixture); a refusal's `refused` shape (matched on its JSON).

## K3 follow-up (passage gates)

See the contract's as-built "K3 follow-up": read `passage:<lot>` nodes and `onWall.passage` (front/back ports as the outer/inner cells)
in `besideGates` and `GateJoin.gates`, and let the re-check accept the gatehouse lot's site as the holder. If K3 merges into this branch
first, nothing breaks: a passage node is not a `gate` node, so a gatehouse-only wall answers `NO_JOIN [wall]` as before.

## RC note for Steward (S-GJ-2)

GJ changes what stands in a walled town's claim at removal, so Steward's RC comes before release. What to run on the RC jar:
1. A walled V town with a C38 wall round it (`wall.around {feature: {region: <town>}}`, default gates), then a district beside it:
   `checkBeside` (fits; its land's join part has `via: "<wall region>:<gate>"`, `junction` the end or side it ends at), then the real plan
   under `steward.<b>.vplan` and realise under `.vrealise` (ext `steward_mc:district`, `steward_mc:build`).
2. Undo in both orders: the district first (the town and the wall exactly as before it); the wall region first (the ring and its gate
   go; the district stays with `architect_mc:beside.dangling` true and `gateRemoved: <wall region>`, `land.standingRemoved` set), then
   the district (the world before both); and the same after a restart (`realiseByKey`).
3. A stale gate: wall the gate up after the plan: the realise answers `ARTIFACT_STALE` naming the gate (also through plain
   `Regions.realise`, not only `realiseApproved`), nothing written; re-plan, realise under `.vrealise2`.
What changed for Steward's reads: `join_external.junction.kind` may be `gate` (its `then` is the end or side); `BesideJoin` is unchanged
(its kind is the `then`'s); a walled town no longer refuses `NO_JOIN [wall]` while it has an open or wooden-door gate.
