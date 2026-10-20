# HANDOFF: Phase 6c slice HY-core (the course foundation)

Branch `slice/HY-core`, worktree `../architect-mc-HYcore`; the frozen interface is pushed as `hy/core`. Contract: docs/CONTRACT.md
"Phase 6c slice HY" (FROZEN 2026-10-19; Steward's review and the coordinator's decisions win). Placeholders: API 1.36.0, mod 0.39.0,
kit 0.37.0, catalogue 8 (VOC releases first as 1.35.0; the coordinator renumbers at merge). Ports 8918-8923, at most 3 slots. $0.

## Rules for HY-b and HY-c (from the coordinator, 2026-10-19)

- **Never edit `kit/regions/plan_v0.mjs`.** Its source hash is in every plan's IR. HY-a's `hydrology` pass runs from compile.mjs before
  the zones resolve, only when the plan has a course, race or ditch part (`isCoursePart`, now R24's `channelForm`), and reaches the
  region through `r._hydrology`.
- HY-a bumped no versions; versions are HY-core's (all seven constants and catalogue 8 are set on this branch).
- HY-a is merged into `hy/core` (origin/slice/HY-a f3967b36).
- **origin/main v0.37.1 is merged into `hy/core`** (kit 0.35.1 on main: hk3's even-width rope/tunnel fix with v33/v34 in H's
  UNCHANGED_EXCEPTIONS, the guard reader and apijars over 0.37.0, hb-unchanged retired, host-stamped base worlds). HY keeps its
  placeholders (kit 0.37.0, API 1.36.0, mod 0.39.0); VOC releases first as v0.38.0. The crossings_demo_flat, links_demo and
  links_demo_flat goldens are re-cut for kit 0.37.0 (only the IR's kitVersion; irShas 0e9c3219, 01bc72a4, 8ab69970).

## The frozen interface (round 1)

| Piece | Where | Shape |
|---|---|---|
| Catalogue 8 | `kit/schemas/plan.json` x-catalogue, golden, `fixtures/plan/catalogue-h.json` (catalogue 7) | channel.course supported (limits §6), channel.race, channel.ditch, wall.water_gate supported, channel.aqueduct reserved until 7c; connector.channel forms [moat, course, race, ditch]; five notes; sinceApi 1.36.0. The diff from catalogue-h.json is exactly §6's (hy-core.test.mjs). |
| Schema, R24 | `plan.json` connector.channel def (`look`, `flow`, `drop`, `where.along {feature, sides}`), x-rules R24; `schema.mjs` `channelForm` (moat, course, ditch), `channelBlock(part, lotIds)` (adds race), `planLotIds(plan)` | |
| The fluid op | `kit/lib/fluids/body.mjs` | members only when non-empty: `after: [ids]`, `joins` entries `{body, cells: runs}` beside natural runs, `lining: runs`, `grate: runs`. Any of them: the IR requires `courses` (realise.mjs and IrStale KINDS_FORMAT2), so 0.37.0 refuses PLAN_STALE. An H op is byte for byte as before. |
| `r.fluidBody` | body.mjs | new opts: `lining`, `weir` (lining written with role `weir`), `joins: [{body, cells}]` (landing cells hold that body's fluid for the flow; the body goes into `after`), `after`, `grate`, `overflow: [{cells, lining, into: {body, cells}}]`, `raised`, `_unsafe.noLiningCell`, `_unsafe.after`. shellRole(x, y, z, where) gets `where` 'lining' and 'weir'. Record adds `lining, after, planJoins, grate`. `reachId(part, k)` = `<part>_r<k>`, k from 1 at the head. `GRATE_STATE`, `isCourseOp`, `splitJoins`. |
| Overflow hook | `kit/lib/fluids/hooks.mjs` | `registerOverflow(C, {from, course, cells, lining, into})` in step 2 (refused, false, when X's module has no `acceptsOverflow = true`); `overflowsOn(K, partId)` in X's emit, passed to r.fluidBody `overflow`; compile.mjs emits H parts in `emitOrder` (a fed part after its courses; plan order without overflows) and drops a course's overflows when it does not fit or rolls back (`dropOverflows`); checkpoint/rollback carry `r._overflows` and `meta.courses`. HY-b adds `export const acceptsOverflow = true` to pond, fountain, moat. |
| Dispatch | hooks.mjs | a channel goes by `channelBlock`: moat.mjs, course.mjs, race.mjs, ditch.mjs (HY-b's, stubs answering `refused UNREACHABLE {until: HYb}`); an ext `architect_mc:unsafe.handCourse` goes to handcourse.mjs (HY-core's gate fixture). |
| Crossings (HY-c) | hooks.mjs `registerCrossing(K, rec)`, `crossingsOf(K)`; record in `fluids/gate.mjs` header | `{course, body, wall, cells: [[x, z]], level, lintel, grate: [[x, y, z]]}`; gate.mjs `waterGates(K, wall)`, `grateState()` (stubs). |
| `r.course(path, opts)` | program.mjs `_bindCourse`, course.mjs `course(r, path, opts)` | path: data.courses[i] `{cells: [[x, z]], accumulation?}` or a polyline; returns `{id, part, bodies, steps, ends, refused}`; the stub lays nothing (refused until HYb), never throws. |
| M25 for courses | `kit/lib/region/checkFluids.mjs` `courseRules` (only when the IR has a course op) | `M25:order` (a spill landing in a body not written before it, a cycle, an unknown `after`), M25:shell over lining and the 1-thick weir, M25:keep for a breach beside natural water, lining in the single breach; sim.mjs `spillLands`: a course's spill exits are judged in the landing body. `writeOrder(bodies)` (the mod's rule). |
| siteplan | `siteplan.mjs`, `siteplan-1.json` | `courses: [{id, part, kind, look, flow, bodies, steps, ends, serves?, waterGates?}]` from `meta.courses`; waters kind course, race, ditch. |
| Java | `RegionFluids` | ordered regions (any course op): the tiles write every source, bodies not due are cleared, each written and forced once its landings settled (FL4 between waves); the upstream closure on escape, unsettled and uncontained (`reason: "upstream of <body>"`, `held`); removal in exact reverse (FL5 after the head); grates; rows `{part, body, state, reason, at}` plus H's extras; `dev.fluid.state` adds `ordered`, `order`, per body `writtenAt`, `held`. Features `hydrologyPass`, `regionCourses`, `waterGates` (sidecar `region.hydrology`, `region.courses`, `region.waterGates`). |
| Gate | `tools/gate6chy.mjs`, steps `hy-unit`, `hy-ingame`, `hy-crash`, `hy-natural`, `hy-cold`, `6chy-look` (chain `6chy`, `6chy-look`) | HY-b's items in `tools/lib/gate6chy-b.mjs`, HY-c's in `gate6chy-c.mjs` (`items[step] = [{name, run(ctx)}]`, ctx.core = HY-core's helpers: checkCourse, realiseApproved, censusOf, snap/diff, removeWait, bodiesOf). Item 12's byte identity: `gate6chy-core.mjs unchanged()` with `UNCHANGED_EXCEPTIONS` (h/r08, extension/e15). |
| Pending fixtures | `fixtures/plan/hy-pending-b.json` (course, race, ditch; reserved channel.aqueduct), `hy-pending-c.json` (wall.water_gate) | each half deletes its file when its valid/ fixtures land. h/r08 answers the stub's refusal; HY-b renames it valid/v51_canal. |

**Item 9 is HY-b's:** no plan Claude writes reaches a course until HY-b's router. HY-core's own in-game items send hy_core_demo's plan
(two hand-built channel parts, ext `architect_mc:unsafe.handCourse`) through `Regions.checkPlan` and `realiseApproved`, so the ordered
writes, the closure, the guards and the removal go through the real plan path; every new kind (stream, canal, race, ditch, fountain
and pond overflows, moat, water gate, riffle) must still go through it in HY-b's and HY-c's items.

## State

- Round 1 committed and pushed (`hy/core`). Kit suite 575/0 with hy-core.test.mjs (7), RegionFluidsHYTest 5/0, api-compat --gate6chy clean.
- Next: the in-game items (hy-ingame, hy-crash, hy-cold) on the new runner, then the slice tier, the gate-verifier, "HY-core as built".
