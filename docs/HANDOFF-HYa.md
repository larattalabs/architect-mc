# HANDOFF: slice HY-a (the hydrology pass)

Branch `slice/HY-a`, worktree `../architect-mc-HYa`, from main 23fb4921. Pure kit. Contract: docs/CONTRACT.md "Phase 6c slice HY"
§5 and §15 (HY-a: `passes/hydrology.mjs`, plan_v0's conditional run, D1's tag rule, `data.courses`; items 1 and 17).

## Plan
1. `kit/lib/region/passes/hydrology.mjs` (pure): priority flood, D8, accumulation, `flow`, `wet`, `data.courses`.
2. Register in `passes/index.mjs`; `r.pass('hydrology')` branch in `program.mjs` (plan water from the region's bodies).
3. plan_v0: declare `hydrology`; compile runs it only when the plan has a course, race or ditch part.
4. D1: the `wet` tag reads the `wet` field when the pass ran, else surveyed water as today.
5. Tests `kit/test/hy-a.test.mjs`; byte identity driver against origin/main; timing recorded.

## State
- [x] 1-5 built; kit suite 566/0; unchanged 191 of 193 identical (r08, e15 excepted); timing recorded; "HY-a as built" written.
- [ ] gate-verifier; retire this file; push.
- plan_v0.mjs must stay unedited (its sha is every IR's programSha): compile registers the pass via r._hydrology.
