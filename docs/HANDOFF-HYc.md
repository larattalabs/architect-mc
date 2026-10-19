# HANDOFF: Phase 6c slice HY-c (water gates, `wall.water_gate`)

Branch `slice/HY-c`, worktree `../architect-mc-HYc`, run worktrees `../architect-mc-HYc-run[-s2|-s3]` (ports 8942-8947). Base
`origin/hy/core` (8525a046 merged). Contract: docs/CONTRACT.md "Phase 6c slice HY" §8.3, §14 item 14 and item 9's water-gate row.
Placeholders as HY-core's (API 1.36.0, mod 0.39.0, kit 0.37.0, catalogue 8). $0.

## Interface asks (for the coordinator; HY-core's files)

1. **The grate must be joined bars (defect in the frozen interface, fixed on this branch, a6df78dd).** Probe (headless, flat world, a
   3 x 2 x 2 grate across a 2-deep channel under a 2-thick wall, mobs pushed at it for 20 s): `iron_bars[waterlogged=true]` as written
   (no neighbour update: every connection false, posts 2/16 wide, gaps 14/16) let 2 of 6 mobs (zombies, 0.6 wide) through; open water
   let every mob through (the control); bars joined north/south stopped all. Fix: `RegionFluids.writeBody` re-reads each grate cell after
   the body is written and sets `Block.updateFromNeighbourShapes` (vanilla's own joins to the next bars and the shell), still without
   an update. No op, IR or kit change: the kit's evaluator and `GRATE_STATE` stay `iron_bars[waterlogged=true]` (the kit's movers don't
   dive), HY-core's census regex and "still ours" (`is(IRON_BARS)`) already accept any connection state.
2. **One dispatch line in `hooks.mjs` (additive):** a channel whose ext `architect_mc:unsafe` carries `handGate` goes to HY-c's
   `fluids/handgate.mjs` (the gate fixture: a still reach across a planned wall, as handCourse is HY-core's). No plan Claude writes
   reaches it; hy_core_demo and every other plan are unchanged (item 12: 191 of 193 identical, only r08 and e15 differ, by name).
3. **v58 waits for HY-b.** `fixtures/plan/hy-pending-c.json` stays: P0 item 9 wants a valid/ fixture that fits with a real course
   (v58: a stream through v30's walled village), and only HY-b's router makes one. A hand-gate fixture would cover the id with an
   `architect_mc:unsafe` part, so it is not added. When HY-b lands: v58 = v30 + a channel.course whose path crosses the ring; delete
   hy-pending-c.json.

## For HY-b: the call your course.mjs makes (the router's forced still reach, §8.3)

compile.mjs resolves H parts (step 2) before `planWalls` and emits them (step 3) after it, so only a course's **emit** sees both its
reaches and `K.walls`. In `emit(K, p, res)`, per reach, before `r.fluidBody`:

```js
import { waterGate, reachAcross } from './gate.mjs';
const wg = waterGate(K, { course: p.id, body: reachId(p.id, k), cells, level, outlets, lining, spill });  // throws 'UNREACHABLE: ...'
r.fluidBody(cells, { ...opts, grate: wg.grate });
```

- `waterGate` finds every planned wall over the reach's columns, checks it (not sealed; under its gates.max with the standing water
  gates; a straight run, no corner, end or tower; at most 3 positions wide; the reach under the whole thickness and 2 cells past each
  face; no outlet, lining or spill of the reach there; no walk gate or its jamb), registers the crossing (`K.courseCrossings`, the
  frozen record plus `positions` and `normal`) and returns the grate cells. On a refusal it throws `UNREACHABLE: ...` with
  `e.evidence = {kind: 'wall', wall, why: sealed | max | corner | width | still | step | gate, ...}`: let it propagate (compile.mjs
  answers the course refused with that evidence and rolls it back; a rolled-back course's crossing stops counting).
- A path that crosses a wall must be **still** there: one reach through the wall and 2 cells past each face. `reachAcross(K, wallId,
  at, {width, beyond, depth, level})` lays such a reach at the wall's free straight run nearest `at` (handgate.mjs uses it); a router
  can instead force its profile level over the crossing and call `waterGate` on the reach it made.
- The wall does the rest (lintel, footing on the banks, meta `walls[].waterGates`, the answer's `crossing`).

## State

- Kit: gate.mjs, handgate.mjs, hy_gate_demo, wall.mjs (lintel, footing, gates.max, runFree, gates.min capped), checkWalls metric;
  `kit/test/hy-c.test.mjs` 7/0; whole kit suite 583/0; item 12 (`unchanged`) 191/193, r08 and e15 excepted, ok.
- In game on my own server (dev runs, artifacts/hyc-dev): every HY-c ingame check ok (READY, PLACED, census 48/48 with 12 joined
  grate cells, lintel 6/6, nav never through the grate, push 0 of 5 through and the open control 3 of 5, sealed and max refused
  UNREACHABLE {kind: wall}, E-flat 0); look 12 shots in 3 bibles.
- Running: the slice tier (`artifacts/gate-runs-HYc`, 3 shards, 8942-8947). Next: verifier, "HY-c as built", the gallery, push.
