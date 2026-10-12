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

- [ ] kit: relief op (evaluator), pass framework, relief pass + erosion, `pad.edge: 'blend'`, relief_demo, tests, lint
- [ ] sidecar: pass budget, FEATURES, tests
- [ ] mod: versions, IrStale, features, resolution-1 second survey, test
- [ ] gate: tools/gate6ct1.mjs, gate-chains steps + impact rule, scenario rows, goldens
- [ ] slice tier run, gate-verifier, CONTRACT as-built, retire this file
