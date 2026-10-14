# HANDOFF K1b: rope bridges and `connector.auto` (slice/K1b)

Contract: docs/CONTRACT.md "Phase 7a slice K1" (FROZEN; Steward's review and the coordinator decisions win). K1a (walls,
gates and the shared foundation) builds in parallel on `slice/K1a`; its foundation lands as `k1/foundation`.

- Worktree `../architect-mc-K1b`, branch `slice/K1b` off main 7f9dba35 (v0.32.0 / API 1.29.0 / kit 0.30.0 / catalogue 3).
- Placeholders: API 1.30.0, mod 0.33.0, kit 0.31.0 (the coordinator sets the real ones at merge).
- Ports 8918-8923. Run worktree `../architect-mc-K1b-run`.

## State

- [x] villager half-slab probe in game (vanilla `dev.nav.villager`, headless, by commands): spans 8/24/36/40, rise -5..+5,
      widths 1 and 2, every one crossed both ways; a deck with a hole refused (negative control). Script: scratchpad, rerun in the gate.
- [x] rope geometry `kit/lib/connectors/ropeGeom.mjs` (profile, checkSpan, ropeCells, ropeBridge, emitRouteRopes, BOM)
- [x] kit movers: bottom slabs are half-height floors; a step's real rise decides step/jump (vworld `half`, check.mjs walkGraph)
- [x] `M10:rope` in the foundation's `kit/lib/region/checkRopes.mjs` (deck read from the world), `metrics.ropes`, `M5rope`
- [x] rope row `kit/lib/region/passes/moves/rope.mjs` (+ optional `fail` member), compile hooks `kit/lib/connectors/rope.mjs`
- [x] fixtures: valid/v33, v34 (flat claim, rift_city); fixtures/plan/rope/rb01-rb09; `kit/test/plan-k1b.test.mjs` (§9 rows,
      determinism), `kit/test/rope-k1b.test.mjs`
- [ ] `links_demo` (flat + rift variants), scenario/in-game steps, gate driver `tools/gate7ak1b.mjs`, chains
- [ ] slice run, gate-verifier, look step + gallery, as-built

## Readings recorded for the as-built

- n = deck cells (8..40); landings at 0 and n+1; y2(0) = 2 y0, y2(n) = 2 (y0 + rise) (the last deck cell level with the far
  landing). Odd y2: bottom slab at floor(y2/2)+1 over a full-block hanger (M3 face-connectivity through half steps).
- Cost 300 + 30 n (T2 units: "30 + 3 per deck cell" in cells).
- Approach: a rope_bridge edge searches the two Chebyshev squares of radius `approach` round its ends (route.mjs `withinM`).
- Posts: frame role, landing-2 .. landing+2 on the rail lines at both landings; anchors check the 2 cells under each landing and
  post cell (pre-region class ROCK/SOIL, or a frozen volume's class when the caller gives one).
- Headroom: the deck, hangers, rails and 2 over, across width + rails: the pre-region column top (ground; a tree column counts
  64 high: no trunk heights in the pass) must lie below; water counts as its surface.
- rift_city: its carved ground reaches the routes through `connectors/templateLand.mjs` (its numbers recomputed: the template's
  file is untouched, so its program sha and goldens hold); the rim rail opens where a K1b route crosses it and the approach
  inside is fenced.

## Shared-file hooks (for the coordinator's merge)

- `kit/lib/region/passes/route.mjs`: SPECIAL_MOVES rope row gains `fail: ropeFail` (+ its doc line); `routePass` calls a row's
  `fail` before T2's water check; a `spanOnce` edge sets `withinM` to its approach squares.
- `kit/lib/region/program.mjs`: `r.ropeBridge(a, b, opts)`; `_route` records `rec.rope` (a failed rope edge's reason).
- `kit/lib/plan/compile.mjs`: `ropeFailAnswer` import and the failed-leg mapping (`why === 'ROPE'`); the route call merges
  `rope.hard` into `hard` and passes `rope.base` as `base` (only when `ropePassInput` returns them).
- `kit/lib/plan/finish.mjs`: an answer's `cost.bom` (set in the links stage) is kept.
- `kit/lib/region/check.mjs`: `metrics.M5rope` in M5; walkGraph half-slab steps. `kit/lib/region/vworld.mjs`: palette `half`.
- `kit/test/plan-helpers.mjs`: `checkPlanLocal({volumes})`, `flatSurvey()`. `kit/test/plan-p0.test.mjs`: `SV.flat`, fixture
  `anchors` over Steward's (run and item 1's validation). `kit/test/region-lint.test.mjs`: `lib/connectors/` on the plan path.
- Deleted `kit/test/fixtures/plan/k1-pending-b.json` (v33/v34 landed).

## Asks for the coordinator

(none yet)
