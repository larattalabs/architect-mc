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

## Status

- [x] kit: relief op, pass framework, relief pass + erosion, `pad.edge: 'blend'`, relief_demo, tests (263/263), lint; REGIONS.md
- [x] sidecar: pass budget from the declared passes (source regex), `region.passes`, region.planned `passes`; test regions-passes
- [x] mod: 0.20.0 / 1.17.0, IrStale relief, planPasses/reliefOp, resolution-1 second survey (secondSurveyRes), PassesT1Test; build green
- [x] merged origin/main (v0.18.0: W, Y2, C23) at c3b766f
- [x] gate driver tools/gate6ct1.mjs; steps t1-unit, t1-ingame, 6ct1-scenario-relief; impact rule; plantime/stale/apicompat green
- [x] relief_demo pinned (run worktree ../architect-mc-T1-run, ports 8918/8919)
- [ ] scenario runs flat + natural, golden (scenarios.mjs golden relief_demo <natural run>), res1 in game
- [ ] slice tier run (`--since origin/main`, ports 8920-8923 for the runner), gate-verifier, CONTRACT as-built, retire this file
