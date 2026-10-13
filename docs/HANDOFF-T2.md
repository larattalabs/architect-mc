# HANDOFF-T2: slope-aware routing and switchbacks (slice T2)

Resume notes for `slice/T2` (worktree `../architect-mc-T2`, from origin/main 31f1b56 = v0.21.0). Delete when the gate passes.

## Placeholders
API 1.22.0, mod 0.25.0, kit 0.24.0 (coordinator: after C29 v0.22.0, F2 v0.23.0, C30 v0.23.1 and B v0.24.0; origin/main 1840942 merged). Feature `routePass` (sidecar `region.route`, appended).
Ports 8918-8923. $0 (sim/stub only).

## Done
- `kit/lib/region/passes/route.mjs`: the pass. State (cell, heading, k = straight cells since the last turn, d = surface offset from
  the land); the profile is fixed point and moves at most maxGrade per cell, so every 8-cell window of a walk run is within the grade
  by construction. Moves: walk (45-degree turns after 3 straight cells), stair flights (1..8 + 2 flat; cardinal), hairpins (a flat
  landing holding both lanes), ladders (player-only edges), walking an earlier edge's built cells (step <= 1, `shared` segments).
  Coarse corridor (16), then 48, then the whole claim; a self-crossing route is searched again with the crossing blocked (<= 8).
  No stair or ladder within 1 of an edge's end (approaches stay walks that later edges share).
- `program.mjs` `r.pass('route', ...)` -> `_route`: ends from nodes / lots (entrance, out of the front) / graph nodes; movers inferred
  (S-T2-1, `inferMovers`), ladders only without villagers (S-T2-2); obstacles lots+aprons, forms, keep sets, keep-out (ctx.keepOut);
  emission per edge column-exact (`edgeColumns`): 4e ground roads where the walk lies on the surveyed ground, `_routeRun` graded
  columns elsewhere, stairs, landings, `_ladder`; graph edges with `movers`/`segments`; KEEP_OUT guard; `meta.route`.
- `check.mjs` `routeRules`: M2 (player per edge), M2:villager (villager per villager edge, ladder on one), M2:grade; `M5route`.
- `light.mjs` lightCover `extra`/`extraCap`/`part` (opt-in; S7 unchanged). `route.mjs` `lampSpots`.
- `kit/regions/route_demo.mjs`: gate, hall, chapel, lookout; sites from params (gateX..lookoutZ) or found; flat variant hill via base.

## Next
Unit tests (kit/test/route-t2.test.mjs), ladder/keep-out/broken variants, hysteresis, plan time 1024x1024 x 20 edges, scenario
(protect a rect across gate-hall in-game), tools/gate6ct2.mjs, tools/lib/scenario-route.mjs, gate-chains steps + impact rule,
api-compat --gate6ct2 and apijars on 0.22.0 + 0.21.0 (T2's tag builds) + SCH's 0.20.0, golden, slice tier, verifier, as-built.

## Notes
- S3 needs stairs at maxGrade 0.25 (stairs:false finds no route); the synthetic 1:2 slope (stairs off) gives ~1 hairpin per 7 rise.
