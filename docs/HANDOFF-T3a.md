# HANDOFF: slice T3a (bridges) and T3's shared foundation

Resume notes for `slice/T3a` (worktree `../architect-mc-T3a`, ports 8912-8917). Contract: docs/CONTRACT.md "Phase 6c slice T3"
(FROZEN 2026-10-17; its "Steward's review" and "Coordinator decisions" win). Placeholders: API 1.33.0, mod 0.36.0, kit 0.34.0,
catalogue 6 (the coordinator renumbers at merge). T3b (tunnels) runs in parallel on `slice/T3b`; the two release as one batch.
Delete this file when T3a's gate passes (its content moves to "T3a as built").

## The foundation (`t3/foundation`): the interface T3b merges

Pushed as branch `t3/foundation`. Change it after that only if a slice must, and record the change here (round 2, 3, ...).

**Files each slice owns** (the other never edits them, so the merge never conflicts there):

| T3a (bridges) | T3b (tunnels) |
|---|---|
| `kit/lib/region/passes/moves/bridge.mjs` (row 7) | `kit/lib/region/passes/moves/tunnel.mjs` (row 8) |
| `kit/lib/connectors/bridge.mjs` (compile hooks) | `kit/lib/connectors/tunnel.mjs` (compile hooks) |
| `kit/lib/connectors/bridgeGeom.mjs` (generator, `r.bridgeSpan`) | `kit/lib/connectors/tunnelGeom.mjs` (generator, `r.tunnel`) |
| `kit/lib/region/checkBridges.mjs` (`M10:bridge`) | `kit/lib/region/checkTunnels.mjs` (`M3:tunnel`, `M4:tunnel`) |
| `kit/test/fixtures/plan/t3-pending-a.json` (delete when the bridge valid/ fixtures land) | `kit/test/fixtures/plan/t3-pending-b.json` (likewise; it also covers `tunnel.under`) |
| `tools/gate6ct3a.mjs`, its gate-chains steps and impact rule | `tools/gate6ct3b.mjs`, likewise; `PlanChecks.java` and the stale rule |

In the foundation every T3b-owned file is an **inert stub with the final names and signatures**: no throwing placeholder, nothing
another file must replace. `tunnelInit` returns null (the row is off), the other row hooks are no-ops, `tunnelResolve` refuses a
tunnel part (`UNREACHABLE`, "built by slice T3b", `until: 'T3b'`), the other compile hooks return `{}`/null, `tunnelRules` checks
nothing. T3b replaces the bodies only.

**Shared files, written once in the foundation** (a slice touches them only through its own hook files):
- `kit/lib/region/passes/route.mjs`: `SPECIAL_MOVES` rows bridge (code 7, segment `bridge`, flag true; `fail`) and tunnel (code 8,
  segment `tunnel`, flag true; `blocks`, `fail`, `prune`), imported from the two row files. `onceOf(edge)`: `edge.once`
  ('rope' | 'bridge' | 'tunnel'), or K1b's `spanOnce` read as 'rope'. Any `once` edge searches only the two `approach` squares round
  its ends (K1b's `withinM`), approach from `edge.approach` (default 16). Per-edge T3 options ride in `edge.t3` (`{bridge: {...},
  tunnel: {...}}`, opaque to the pass); pass-level inputs in `intent.bridge` / `intent.tunnel`. A row reads `edge.spans`
  (`includes('bridge')` / `'tunnel'`) in `active`, and `onceOf(edge) === name` in `needsFlag`; it sets the flag only on an edge
  whose `once` names it. A failed edge: the row's `fail` sets `edgeOut.failed = 'BRIDGE' | 'TUNNEL'` and `edgeOut.bridge |
  edgeOut.tunnel = {code, evidence}` (the region program copies them to the meta edge as `rec.bridge` / `rec.tunnel`).
- `kit/lib/region/program.mjs`: the route intent passes each edge's `once` and `t3` and the pass's `bridge` / `tunnel` through;
  segments of kind `bridge` and `tunnel` are not written by the route (the links stage writes them, as rope); graph edges may be
  `type: bridge | tunnel`. Comment markers mark where `r.bridgeSpan` (T3a) and `r.tunnel` (T3b) are each defined, once.
- `kit/lib/plan/compile.mjs`: `LINK_KINDS` = K1's + T3's kinds get the `links` stage and the K context. Hooks called (from
  `connectors/bridge.mjs` and `connectors/tunnel.mjs`; kinds from the leaf module `connectors/t3kinds.mjs`):
  - `bridgeResolve(K, p)` / `tunnelResolve(K, p)` before routing: an answer stops the part, null routes it.
  - A tunnel's `via` is read leniently in compile.mjs itself (R19, S-T3-6): its legs are from -> via[0], with a note.
  - `bridgeLeg(K, p)` / `tunnelLeg(K, p)`: the leg options merged into the route edge (`spans`, `once`, `approach`, `width`,
    `movers`, `t3`). For `auto`: `bridgeAutoLeg(K, p)` / `tunnelAutoLeg(K, p)` return `{spans: [...], t3: {...}}` (or `{}`), appended
    to K1b's rope options (`legOptions`); with both `{}` the auto edge is exactly K1b's.
  - `bridgePassInput(K)` / `tunnelPassInput(K)`: the pass-level `bridge` / `tunnel` inputs (null: none).
  - A failed leg: `why === 'BRIDGE'` -> `bridgeFailAnswer(K, l, m)`, `'TUNNEL'` -> `tunnelFailAnswer(K, l, m)` (m: the meta edge).
  - The street fallback (S-T3-2): a street, road or path leg failing `ROUTE_WATER` calls `bridgeFallback(ensureK(), l)`; options
    returned are merged into the leg (`l.fallback = true`) and the group is routed again (one more round per fallback batch). K is
    made lazily for a plan without K1 or T3 parts (no walls planned then).
  - `bridgeAnswer(K, p, legs)` (bridge, auto, and any connector with a fallback leg) and `tunnelAnswer(K, p, legs)` (tunnel, auto):
    extra answer fields, merged after K1b's (`mergeExtras`: geometry member by member, notes and deviations appended).
  - The links stage: walls, gates, ropes, then `emitBridges(K)`, then `emitTunnels(K)`.
  - Plan meta `bridges` and `tunnels` (checkpointed and rolled back with the others).
- `kit/lib/region/check.mjs`: `bridgeRules` / `tunnelRules` (same arguments as K1's rules) when `meta.bridges` / `meta.tunnels` are
  non-empty; `metrics.M5bridge` / `metrics.M5tunnel` (dark spawnable over each record's `cells`: the deck or floor blocks, feet one
  over) with an `M5` finding when any.
- `kit/lib/region/siteplan.mjs` + `kit/schemas/siteplan-1.json`: `bridges: [{id, part, form, span (= record.n), piers ([x, z] from
  record.piers[].x/z), landings ([from, to])}]`, `tunnels: [{id, part, portals, length, carved}]`; edge `crossing` widened
  (`type` rope_bridge | bridge | tunnel; `form, over, depth, clearance, span, lands` / `through, length, cover, lands`).
- **Meta record fields the foundation reads:** bridge `{id, part, form, n, piers: [{x, z, ...}], from, to, cells}`; tunnel `{id,
  part, portals, length, carved, cells}`.
- `kit/lib/connectors/ropeGeom.mjs`: `profile(n, y0, rise, d = sagOf(n))` (signed sag; rope unchanged).
- `kit/lib/connectors/style.mjs`: bible `connectors.bridge {deck, rail, pier, arch}`, `connectors.tunnel {lining, portal, floor}` with
  §7's default chains.
- Schema, catalogue 6 (golden regenerated; catalogue 5 archived as `fixtures/plan/catalogue-k1.json`), R18-R20, reason codes
  `NO_COVER` and `VOLUME`, the drawbridge block in the validator (a bridge with `params.mechanism` or `params.movable: true`),
  R8 on a bridge's `span` and a tunnel's `length`. `diffCatalogues` gains `limitsChanged` (auto's moves).
- Versions: `PLAN_API` / `ArchitectApi.VERSION` 1.33.0, mod 0.36.0, `KIT_VERSION` = `EVAL_KIT_VERSION` = `IrStale.KIT_VERSION`
  0.34.0. Features: sidecar `region.bridges` -> `bridgeConnectors`; `region.tunnels` -> `tunnelConnectors` + `planCheckVolumes`
  (ApiT3Test). The sidecar's compact plan/0 size bound 60,000 -> 66,000 (system-refs.test.ts).
- apijars and `api-compat --gate6ct3`: the 0.35.0 (built from the v0.35.0 tag here), 0.34.0 and 0.33.0 jars, each with its tag's
  `tools/`, in `<main>/artifacts/gate6c-t3/v0350|v0340|v0330`.
- P0 tests: `e15_every_reserved_a` drops connector.bridge/tunnel and gains connector.tube and the drawbridge; item 9's coverage
  reads `t3-pending-a/b.json`; the K1 diff expectations read `catalogue-k1.json`. `k1-foundation.test.mjs` adjusted;
  `t3-foundation.test.mjs` new.

### Foundation round 2 (pushed to `t3/foundation` after round 1; additive)

- `kit/lib/region/plan.mjs`: the plan meta exports `bridges` and `tunnels` (round 1 missed it: `res.meta` had neither).
- `route.mjs`: a row may say `crossesWater: true` (the bridge row does): its edges find their coarse corridor over the claim without the
  water obstacle, so a corridor exists across a river (a street fallback's search was otherwise too big for the whole claim).
- `program.mjs`: the route writes a `bridge` segment's far landing (its last path cell) as a one-cell walk run (a landing on the walk's
  fill is no natural ground). The rope and tunnel segment lines are now separate (`if (g.kind === 'tunnel') return;` is T3b's line to
  change for a tunnel segment's own handling).
- `compile.mjs` `mergeExtras`: a hook's `class` applies only over `fits` (an `adjusted` never hides a refusal).
- `plan.json`: deviation `what` gains `crossing` (a street's fallback bridges, S-T3-2: `{what: crossing, kind: crossing, value, bridges}`).
- `plan-p0.test.mjs`: a fixture may give `terrain` ({W, D, x0, z0, y, bands}: plan-helpers.mjs `flatSurvey`) instead of `on`.
- `kit/regions/crossings_demo.mjs` (T3a owns it): params `variant` (auto | flat | river | frozen | hill) and `bank`; stages ground, routes,
  links; a shared base; it calls `bridgeSection` (`lib/connectors/crossingsBridges.mjs`, T3a) and `tunnelSection`
  (`lib/connectors/crossingsTunnels.mjs`, **T3b's file**, a stub here: see its header for the interface), routes both halves' edges in
  one pass (`bridge`/`tunnel` pass inputs from the halves), emits the bridges then the tunnels in `links`. The flat claim (at least
  256x112) gives the bridges its west 128 columns and the tunnel the rest; `hill` gives the tunnel the whole claim.

## T3a status

- [x] Foundation committed and pushed as `t3/foundation`.
- [ ] Bridge geometry (`bridgeGeom.mjs`): span, beam, arch, clearance, piers, lamps; `r.bridgeSpan`.
- [ ] Bridge row (`moves/bridge.mjs`) and its `fail`; compile hooks; the street fallback; `M10:bridge`.
- [ ] Fixtures (v35, v36, v38 bridge part, v39; refusals), §9 rows, gap tables.
- [ ] Gate driver `tools/gate6ct3a.mjs` (t3a-unit, t3a-ingame, t3a-natural, t3a-look); probes (boat, villager).
- [ ] Look gallery, slice tier, gate-verifier, as-built.

## Decisions and deviations (to record in "T3a as built")

- A 1-deck-cell span is level (rise at most floor(n / 2) besides §3's max(1, floor(n / 8))), so every step is one half block.
