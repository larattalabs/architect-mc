# HANDOFF: Phase 6c slice HY-b (courses)

Branch `slice/HY-b` from `origin/hy/core` (merged up to 8525a046), worktree `../architect-mc-HYb`, run worktree `../architect-mc-HYb-run`,
ports 8924/8925, evidence `../architect-mc/artifacts/gate-runs-HYb/`. Contract: docs/CONTRACT.md "Phase 6c slice HY" (FROZEN; Steward's
review and the coordinator's decisions win), docs/HANDOFF-HYcore.md (the frozen interface). Placeholders API 1.36.0, mod 0.39.0, kit
0.37.0, catalogue 8. $0.

## Files (HY-b's)
- `kit/lib/fluids/profile.mjs`: levels -> reaches and steps (fall, spillway, riffle; short runs merged, long drops split, steps moved
  upstream to straight path, the cut judged).
- `kit/lib/fluids/course.mjs`: the router (A*, the level in the state, fill, cut, turn costs, the flow field), the geometry (lanes,
  lips, riffles, lining, weirs, raised lips on fill), the ends (spring, pool, weir head and tail, fall join, overflow from a plan body,
  fall over a plan body's rim or apron), layCourse, r.course, the plan part (resolve, emit, answer). `planBodyOf` reads a pond's,
  fountain's, moat's, course's or ditch's geometry from its res.
- `kit/lib/fluids/race.mjs` (the band along the lot's side, the forced wheel fall, serves, NO_ROOM with the plain course),
  `kit/lib/fluids/ditch.mjs` (one body along the long sides that are not the lot's front, water 4 from the box).
- Additive in H-a's files: pond, fountain, moat `acceptsOverflow` and `overflow` passed to r.fluidBody only when non-empty;
  moat.mjs `passInput` adds a course's spill (water), lining (shell) and its ends' runs to the claim edge (a course from edge to edge
  seals the claim) for course and ditch bodies only.
- `kit/lib/fluids/sim.mjs` (HY-core's): one line in breachReach's no-spill shortcut: an opened cell takes the fluid only when a body
  cell is beside it (a weir course behind its shell was counted as reached: M25:keep's false positive on a weir head with no step).
  H bodies are unchanged (their shell at or under the surface is always beside a cell). Reported to the coordinator.
- `kit/regions/hydro_demo.mjs`, fixtures `valid/v50..v56, v59, v60`, `hy/` (refusals r01..r11, v57, v57b, s01 Steward, n01 S3, c01
  cold, p01/p02 probes, asks gap tables), `kit/test/hy-b.test.mjs`; r08 is `valid/v51_canal`; `hy-pending-b.json` deleted;
  HY-core's and HY-a's tests moved by name (r08's path, the stubs' test).
- `tools/lib/gate6chy-b.mjs`: items unit (11), ingame (18c probe, 10, 9), natural, cold, look (20). `tools/gate6chy.mjs`: a dev-only
  `GATE6CHY_SKIP_CORE=1` (the halves' items only); `HYB_ONLY=tag,...` narrows item 9.

## Seams
- HY-c: course.mjs emit reads `crossingsOf(K)` and passes a crossing's `grate` cells to its reach's r.fluidBody (`grate`). A wall
  across a course with no crossing answers `UNREACHABLE {kind: wall}` (emit). The router does not force a still reach at a wall
  line (HY-c's).

## State
- Kit: all fixtures answer as expected; hy-b.test.mjs. In game: v50 passed item 9 once (single reach then: the terrain bug, fixed).
- Running: `6chy --only hy-ingame` with GATE6CHY_SKIP_CORE (items 18c, 10, 9). Next: natural, cold, look (client), the unit tier,
  the slice tier, the verifier, the gallery, "HY-b as built".
