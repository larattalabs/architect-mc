# HANDOFF: slice K1a (walls and gates) and K1's shared foundation

Branch `slice/K1a`, worktree `../architect-mc-K1a`, ports 8912-8917. Contract: docs/CONTRACT.md "Phase 7a slice K1" (FROZEN;
"Steward's review" and "Coordinator decisions" win). Placeholders: API 1.30.0, mod 0.33.0, kit 0.31.0, catalogue 4.

## The foundation (branch `k1/foundation`, merged by K1b)

§11 steps 1-3 plus the shared hooks. K1b merges it; after that its interface changes only if it must (and then here and in
the as-built).

- **Archived:** `kit/test/fixtures/plan/catalogue-d2.json` (catalogue 3). The apitest jars for apijars/api-compat are built
  from tags v0.32.0, v0.31.1, v0.31.0 into `<main>/artifacts/gate7a-k1/v0320|v0311|v0310` (K1a's gate step).
- **Schema** (`kit/schemas/plan.json`): `$defs` `wallWhere`, `connector.wall`, `connector.gate`, `connector.rope_bridge`,
  `connector.auto`; x-rules R15-R17; catalogue 4 (the four flips, `wall.line|around|edge` supported, `wall.along` reserved until
  K2, `layout.elevated` reserved until 7b and in the layout enum, `locator.around`'s note); reason codes `NO_GAP`, `SPAN`,
  `ANCHOR`, `HEADROOM`, `MOVER` appended; deviation `what: join` appended. Golden regenerated.
- **Validator** (`kit/lib/plan/schema.mjs`): R15 (`wallForm`), R16 (a gate's `wall` names a wall, `crossing` a routed
  connector: `ROUTED_KINDS`), a wall's path form as its own block id (`wall.along` answers unsupported), a gate's `at`, `wall`
  and `crossing` as references (implicit dependencies).
- **Lenient params** (`kit/lib/connectors/params.mjs` `readParams(kind, part)`): reads wall `height`, `closed`, `gates` (a
  number), `torches: true`; lists every other key in notes; lot-naming keys are `joins`.
- **Bible connectors** (`kit/lib/connectors/style.mjs`): `connectorRoles(roles, given)` with §6's defaults (rope: chains unless
  the bible says `"none"`), `shapeOf(block, shape)`, `doorOf(frame)`, `connectorsError`. The bible's format-2 `connectors`
  member is validated (`kit/lib/bible.mjs`) and passed sidecar -> `tools/region.mjs` -> `planRegion({connectors})` ->
  `ctx.connectors` (each slot a resolved role name).
- **Route pass hook** (`kit/lib/region/passes/route.mjs` `SPECIAL_MOVES`; rows in `passes/moves/gate.mjs` (K1a) and
  `passes/moves/rope.mjs` (K1b, a stub: `ropeInit` returns null, so the row is off)). The table's comment is the interface:
  `init/active/needsFlag/blocks/expand/cells/commit`, move codes 5 (gate) and 6 (rope), one state flag bit (F = 2 only when a
  row with `flag` is active for the edge, so T2's state space and ties are unchanged otherwise), the goal needs the flag when
  `needsFlag`. Order: built-in moves, then the rows in table order; heap ties (f, g, x, z, heading, k, d, flag).
  `program.mjs _route` forwards an edge's `spans`, `spanOnce`, `span`, `approach` and the intent's `walls` and `rope`; a
  `rope` segment is not written by the route (the links stage's), a `gate` segment is a graded run.
- **Compiler hooks** (`kit/lib/plan/compile.mjs`): `K1_KINDS`; a plan with K1 parts gets stage `links` after `routes`;
  the context `K` (env, r, answers, ans, depState, checkpoint/rollback, mark, endpointNode, `record` -> `planCheck.links`,
  `routed`); K1a's `planWalls(K)` before routing, `wallsPassInput(K)` per route pass, `wallsRouted(K, edges)` after a pass that
  routed, `finishGates(K)` and `emitWalls(K)` after routing; K1b's `ropeResolve(K, p)` (an answer that stops the part, or
  null), `ropeLeg(K, p)` (leg options), `ropePassInput(K)`, `ropeAnswer(K, p, legs)` (fields merged into the route's answer),
  `emitRopes(K)`. K1b owns `kit/lib/connectors/rope.mjs` and `passes/moves/rope.mjs`; K1a owns `connectors/wall.mjs`,
  `connectors/line.mjs`, `connectors/gate.mjs` and `passes/moves/gate.mjs`.
- **P0's tests moved** (item 15): item 2's required-unsupported example and `extension/e02_catwalk_draft.json` use
  `connector.catwalk`; `e15` drops the four flipped ids and covers `wall.along` and `layout.elevated`; item 11's oracle skips
  parts whose block is supported now; item 9 diffs D2 -> K1. `fixtures/plan/k1-pending-a.json` / `-b.json` stand in for each
  half's valid/ fixtures in item 9's coverage check: each half deletes its own file when its fixtures land.
- **Features:** mod `wallConnectors` (sidecar `region.walls`), `ropeBridges` and `autoConnector` (`region.rope`).
- **Foundation round 2** (same branch, fast-forward): the plan meta carries `walls` (K1a) and `ropes` (K1b) and the compiler's
  checkpoint/rollback restores them; the checker calls `wallRules` (`kit/lib/region/checkWalls.mjs`, K1a) and `ropeRules`
  (`checkRopes.mjs`, K1b, a stub) when the meta has them; graph nodes may be `kind: gate` and edges `type: rope_bridge` with a
  `crossing` (`graphEdge({..., crossing})`); siteplan/1 gains `walls`, node kind `gate`, edge type `rope_bridge` and `crossing`;
  a gate without `wall` depends on the plan's one wall (validator); a failed leg's UNREACHABLE evidence merges
  `wallsEvidence(K, leg)`; apijars and `api-compat --gate7ak1` run the 0.32.0, 0.31.1 and 0.31.0 tag jars
  (`<main>/artifacts/gate7a-k1/`, keyed by jar version: two share API 1.28.0).

## K1a: state

- [x] foundation committed and pushed as `k1/foundation`
- [ ] walls: lines (around, edge, line), emission, the gate move, auto/sealed/at/crossing gates, M2:wall, M8:wall, joins
- [ ] fixtures: v30, v31, v32; sealed-wall, gate_lot deviation, unread-keys; refusal fixtures WATER, PROTECTED, OUT_OF_CLAIM
- [ ] gate driver `tools/gate7ak1.mjs`, chains, items 1-4, 6-15 (wall parts), the look step gallery
- [ ] slice tier, gate-verifier, as-built, HANDOFF retired
