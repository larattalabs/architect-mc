# HANDOFF: slice H-a (water bodies)

Resume notes for slice H-a (docs/CONTRACT.md "Phase 6c slice H", FROZEN 2026-10-18, §15 step 2): ponds (water and lava pits),
fountains, waterfalls, the moat (`channel.moat`), ice caps, the opt-in farm pond (`farmPond: true`) and the wet well. Branch
`slice/H-a` in `../architect-mc-Ha`, from `origin/h/core` (a2f86072, round 1). Ports 8918-8923, at most 3 slots. Placeholders: API
1.34.0, mod 0.37.0, kit 0.35.0, catalogue 7 (the coordinator renumbers at merge). Delete this file when the gate passes (it becomes
"H-a as built").

## What is built (kit)

| File | What |
|---|---|
| `kit/lib/fluids/place.mjs` (new) | The shared helpers: compile.mjs's locator mirrored over the same `env` (no import of compile.mjs), `scanRects`, lenient `readParams`, the bible's `fluids` roles (§11: `fluidRoles`, `fluidsError`), the interim freezing rule (`biomeFreezes`, `freezesAt`), `bodyBom` (§12 through connectors/bom.mjs), `volumeAnswer` (incomplete VOLUME), body rollback, the plan-time M25:keep reading (`reachMeetsKeep`, `volumeKeep`) |
| `kit/lib/fluids/pond.mjs` | `form.pond` (water: natural ellipse or built rect; lava: a lined pit, M20's reach clear of trees/protected/builds, its plants cleared), `emitPond`, the ice decision `iceFor` (R23), the farm pond (`stageWanted`, `emitFarmPonds`), the wet well (`wetWell`), `bodyAnswer` |
| `kit/lib/fluids/fountain.mjs` | `form.fountain`: raised basin, spout pillar and its source body; coping 1 thick, 2 when the single breach would reach what may not be flooded, else LEAK; R22 |
| `kit/lib/fluids/waterfall.mjs` | `form.waterfall`: the frame (rows/lanes), `judgeSite` (existing lip from the survey, or a sculpted outcrop up to 12), `siteOf` (lips existing then sculpt; basins join then pond for auto), header pool + lip run + curtain (spill) + basin pond or join; S-H-7 hollow deviation |
| `kit/lib/fluids/moat.mjs` | `channel.moat`: ring offsets, walls on the same feature (berm 5), open side, `emitMoat`; `passInput` (every body's water, shells, lava and raised works for the route pass); `planWaterClearance` (N-H-5) |

Shared files touched (small, additive; listed for the coordinator and the siblings):
- `kit/lib/fluids/hooks.mjs` (H-core's): **added** `fluidFarmPonds(K)`, `asksFarmPond(order)`, `fluidFallbackClearance(K, l)`. Nothing
  existing changed.
- `kit/lib/plan/compile.mjs`: the farm ponds after the zones (only when a zone writes `farmPond: true`; their guards); the fallback
  clearance (N-H-5) right after T3's `bridgeFallback`.
- `kit/lib/region/passes/route.mjs`: consumes `intent.fluids` (the plan's own water: FLAG_WATER/FLAG_LAVA on the pass's own copy of
  the flags, the body surface as the ground there, the shell's real top as the bridge row's head room, raised works as hard rects,
  `env.planWater` (1 water, 2 shell, 3 lava) for the special rows); `sealedByPlanWater` (an edge across a closed moat fails ROUTE_WATER
  at once instead of exhausting the node budget). Absent `intent.fluids`, byte for byte as before.
- `kit/lib/region/program.mjs`: `_route` passes `it.fluids` through (one line).
- `kit/lib/fluids/sim.mjs` (H-core's): two changes, flagged for H-core: (1) `breachReach` shortcut: a body with no spill and a shell
  cell with no enterable neighbour: reach = cells + the opened cell (no result changes; a moat's check went 72 s -> 3 s); (2) M25 trap
  and exit: a spill cell under another reached cell is inside a falling column, so it is no surface cell, and a falling column open to
  the sky is not trapped (a tall waterfall's curtain read as trapped and exit-less before).
- `kit/lib/region/plan.mjs`, `kit/tools/region.mjs`, `kit/lib/bible.mjs`, `sidecar/src/regions.ts`: the bible's `fluids` member
  (format 2), passed like `connectors` (ctx.fluidsGiven).
- `kit/test/h-foundation.test.mjs`: the foundation stub test now checks only H-b's quay stub (H-a's parts are built).

## Open items / interface asks (for the coordinator, H-core and H-b)

1. **H-b (bridge row, wet piers):** plan water reaches the bridge row through the pass's flags (FLAG_WATER, the ground at the body's
   surface) and `env.planWater` (1 water, 2 shell, 3 lava). A wet pier must never stand on `planWater[k] > 0` (§8: plan water stays an
   obstacle to piers). Nothing in H-b's files was edited.
2. **T3 finding (even-width fallback bridges with a raised landing):** a width-2 path crossing a moat on an arch raised 2 on the walk's
   fill gets M10:bridge "adjacent deck cells differ by 4 half blocks" and "landing ... not 2 deep" at the rail-side column: the walk's
   footprint and the deck's lateral cover different columns for an even width (a ground-level landing hides it). Odd widths are clean.
   Recorded; H-a's fixtures cross moats with width-3 roads. Over sunk plan water every clearance-1 crossing raises its landings (a beam
   needs a pier for a 5-wide moat and a pier may not stand on the shell, so the arch wins).
3. **H-core (Java, round 2):** the plan check's two-plan trigger must include a plan whose zones write `farmPond: true` (the kit's
   `checkPlanVolumes` does); else the farm pond's volume never arrives (M25:shell "no volume").
4. **H-core (kit, round 2):** the biome `freezes` table: H-a uses an interim `biomeFreezes` in place.mjs (26.3 base temperatures under
   0.15, the height adjustment over y 80); switch it to the generated table when it lands.

## Status

- Kit: pond, lava pit, fountain, waterfall (sculpt, existing, join, pond), moat with the route interplay, farm pond and fluids roles
  built and smoke-tested; the recorded asks: hidden_village/waterfall_curtain `adjusted` (sculpt 6 high, joins the lake, the hollow
  deviation), redstone_gate/moat `fits` (ring 11 beside the curtain wall).
- Next: the wet well in flat_village, fixtures (valid v41-v45, v49; fixtures/plan/h refusals), kit/test/h-a.test.mjs, the asks gap
  tables, water_demo, gate6ch-a.mjs items, then the in-game items after H-core round 2.
