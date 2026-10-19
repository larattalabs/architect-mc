# HANDOFF: Phase 6c slice HY-b (courses)

Branch `slice/HY-b` from `origin/hy/core` (c0aefdfb), worktree `../architect-mc-HYb`. Contract: docs/CONTRACT.md "Phase 6c slice HY"
(FROZEN; Steward's review and the coordinator's decisions win) and docs/HANDOFF-HYcore.md (the frozen interface). Placeholders API
1.36.0, mod 0.39.0, kit 0.37.0, catalogue 8. Ports 8924-8929, at most 3 slots. $0.

## Files (HY-b's)
- `kit/lib/fluids/profile.mjs`: the profile (levels -> reaches and steps: fall, spillway, riffle; merges, long drops, straight steps).
- `kit/lib/fluids/course.mjs`: the router (A* with the level in the state), the geometry (lanes, lips, lining, weirs, banks), the
  ends (spring, pool, weir head/tail, fall join, overflow from a plan body, fall over a plan body's rim), layCourse, r.course, the
  plan part (resolve/emit/answer).
- `kit/lib/fluids/race.mjs`, `kit/lib/fluids/ditch.mjs`: the race and the ditch.

## Seams
- HY-c: course.mjs emit reads `crossingsOf(K)` and passes a crossing's `grate` cells to its reach's r.fluidBody (`grate`), so HY-c never
  edits course.mjs. The router does not yet force a still reach at a wall line (HY-c's): a course meeting a wall answers as the
  router finds it.

## State
- In progress: kit generators. Next: ditch, race, overflow acceptance in pond/fountain/moat, fixtures, hydro_demo, gate items.
