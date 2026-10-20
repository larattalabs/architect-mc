# HANDOFF: slice RS-b (regions in survival, the hard kinds)

Branch `slice/RS-b`, worktree `../architect-mc-RSb` (from `origin/rs/core` 4ad93e64). Run worktree `../architect-mc-RSb-run` (detached,
the driver checks out HEAD). Ports 8942 (sidecar) / 8943 (DevBridge). Evidence: `../architect-mc/artifacts/gate6c-rsb/`. Scratch:
`scratchpad/rsb/`. Placeholders as on rs/core (API 1.41.0, mod 0.44.0, kit 0.42.0); the coordinator renumbers. Build list: HANDOFF-RS.md
"The split", RS-b items 1-6.

## Driver

`node tools/gate6crsb.mjs <start|base|unit|rs04|rs04half|ice|lava|brush|report|stop>` (or `ingame` = rs04, rs04half, ice, lava, brush).
Its defaults are RS-b's own (run dir, ports, output), so it never moves RS-a's server; `start` waits for a free machine slot and hands it
to the server's pid; `stop` releases it. Item 16's rows run through the runner, one slot:
`node tools/gate-run.mjs slice --only hy-ingame,irr-ingame,h-ingame,ha-ingame,kc-ingame --ports 8944:8945 --run-dir ../architect-mc-RSb-gr --out ../architect-mc/artifacts/gate-runs-rsb`.

## What RS-b changed (and why)

- **Tunnels ring by ring** (§6.2, §6.4, §7.2).
  - Finding: on rs/core a tunnel's lining was in the `routes` stage and its carve in `links` (T3b's `liningStage`, so INSTANT writes
    line before carving). In survival that made two targets per tile: the carve's target waited (§6.3) for the whole lining. So no ring
    order was possible.
  - Kit (survival only): the lining stays in the carve's stage (`tunnelGeom.mjs`: `liningStage` ignored when `ctx.survival`), so a
    tile's bore is one target; `ir.survival.bores` = `[{group, from, dir, box}]` per tunnel (only when the plan has one). **An additive
    member of the frozen `ir.survival`**: an older mod ignores it.
  - Mod: `RegionTargets.ringOrder` for a target whose group has bores: ring = the step along the bore's heading; ring k's lining
    (bottom up) in run k, its carve in run k+1 (after ring k+1's lining, which lies beside it within 1, §6.4); every cell no earlier
    than what blocks it in `stepFed` (solid below, support, a cut's paid neighbours); runs per ring cut by the quarter cap. Spec member
    `rings: true`. A target with no bore keeps RS-a's course order exactly (unit-tested).
  - Seams: a bore's cut also waits for unbuilt paid cells of the same part's other targets beside it (`seamOpen`, tunnel targets only).
  - Bug fixed on the way: a hanging lantern deadlocked its roof in `stepFed` (the roof waited for the solid cell under it, the
    lantern for its support). The below rule now skips an attachable hanging from the cell.
- **Ice caps** (N-RS-4): free in the kit already (a fluid op's cells are class 0); `rs08_ice` (a built-edge pond, a snowy biome grid;
  the driver sets the claim to snowy plains with `/fillbiome`) proves it in game.

## Status

- [x] kit + mod ring order, unit tests (`TunnelRingsTest` 5, `kit/test/rs-b.test.mjs` 4; RS-a's RegionTargetsTest, rs.test, T3b tests green)
- [ ] in game: rs04 (item 5 row + ring evidence), rs04half (item 6 row), ice, lava (items 8, 9 lava rows), brush (item 13 row)
- [ ] item 16 rows via the runner
- [ ] verifier, "RS-b as built", push, report

## Open / notes

- Provenance (`feat/realised-provenance`): when it lands on main, merge and make unbuilt tunnel rings report "unfinished" (coordinator
  will say).
