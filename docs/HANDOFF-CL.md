# HANDOFF: slice CL (7a: climbs, stairs, switchbacks and ladders)

Resume notes. Delete this file when CL's gate passes.

- **Branches.** `slice/CL` lives in `../architect-mc-CL`, off `7a/foundation`, which lives in `../architect-mc-7a-foundation`. Merge
  `origin/7a/foundation` whenever it moves; K2 and CW push shared commits there too.
- **Code.**
  - `kit/lib/connectors/climb.mjs`: the compile hooks.
  - `kit/lib/connectors/climbGeom.mjs`: the fittings, the face rule and `emitClimbs`.
  - `kit/lib/region/checkClimbs.mjs`: the rules M10:climb, M8:climb and M5:climb.
  - `kit/lib/region/passes/moves/profiles.mjs`: CL's values.
  - `kit/regions/climbs_demo.mjs`.
  - `mod/.../client/dev/SliceClDev.java`: `dev.climb`.
  - `ApiRules`: the feature `climbConnectors`.
- **Tests and the driver.**
  - The kit test is `kit/test/cl.test.mjs`.
  - Fixtures: `valid/v7a_cl_*` and `fixtures/plan/cl/` (the refusals r01-r05, the walked stair a01, KC's k01, survival's s01, the asks
    gap tables).
  - The driver is `tools/gate7acl.mjs`, with steps cl-unit, cl-ingame, cl-natural, cl-survival and cl-look.
  - The lint cases are `cl:climbs_flat`, `cl:climbs_natural` and `p0:cl`.
- **State (2026-10-23).**
  - cl-unit passes offline, except api-compat: it waits for main's `--gate6ccoa` jars.
  - The in-game steps have not run yet. They wait for v0.42.0 to be tagged.
- **Next.**
  1. Merge origin/main once v0.42.0 is tagged.
  2. Set `GATE7ACL_APICOMPAT`, or the flag, to the newest jar set.
  3. Run `node tools/gate-run.mjs slice --since origin/main` detached.
  4. Build the look gallery from `artifacts/gate7a-cl/look`.
  5. Run the gate-verifier, which re-runs item 10 (the undo).
  6. Write the evidence row of the as-built section.
