# HANDOFF: slice IRR (farm irrigation)

Branch `slice/IRR`, worktree `../architect-mc-IRR`, ports 8912-8917 (at most 3 slots). Placeholders: API 1.38.0, mod 0.41.0,
kit 0.39.0. Contract: docs/CONTRACT.md "Phase 6c slice IRR" (FROZEN); Steward's review S-IRR-1..5 overrides it (S-IRR-4: removing
the lot drains and removes its sources, exactly).

## State

- Main v0.39.1 + `origin/slice/CU` merged (83c9319d; conflicts: versions take CU's API 1.37.0 / mod 0.40.0 with KC's kit 0.37.1;
  api-compat keeps --gate6ckc and --gate6ccu). Versions now the placeholders (API 1.38.0, mod 0.41.0, kit 0.39.0).
- Built: the kit (irrigate.mjs, irrfield.mjs, reserved.mjs, body.mjs rim/raised options, checker field model and own-lot keep,
  compile and finish wiring, fixtures v62 v63 irr/*), Java (LotMask, TemplateWriter skip, PlaceJob, SiteJournal begin/retake,
  DeltaPlanner excluded, Sites.standing, RegionFluids.drainLot + hooks in Sites/Groups, PlanChecks.hasH/lotProblem,
  DesignRequest.reserved, ApiRules features), sidecar (Reserved schema, brief line, checker args, sim --leave-reserved), tests
  (kit irr.test 9/0, ApiIrrTest, LotMaskTest, PlanChecksHTest, sidecar reserved.test), gate driver tools/gate6cirr.mjs.
- Offline: kit suite 633/0 (+irr 9); byte identity 245/245 vs the merge base, no exception; api-compat --gate6cirr 4/4.
- In game: first irr-ingame run (artifacts/gate-runs-IRR/20261020-115507-6cirr) found driver bugs (setRules('default') leaves
  random ticks 0; v2 installed before the realise; the dropped count's frame order; the bed check) - fixed, rerun pending.

## Plan (decisions)

Kit (`kit/lib/fluids/irrigate.mjs`, new):
- Detection like `farmPondZones` but over `program.lots`, `params.lots` and `program.districts[].lots`; type-implied farms;
  `false` on a lot overrides its zone. Notes: not a farm, too small, biome freezes.
- Field = footprint less 1 border less the front row; grid n = ceil(L/9) per axis, each source at its segment's centre (ties to
  the back and to the left seen from the entrance). Every field column within 4 (Chebyshev).
- Body `<lot>_irr_<i>_<j>` kind `irrigation` via r.fluidBody with `rim: false` (bed + 4 sides only), shell stage `ground`
  (after the pads), sides `farmland[moisture=7]`, bed the bible's `fluids.bed`. One volume per lot (box footprint, floorY-2..+2).
- Shells are written in the `street` stage (ALWAYS_OURS skips a write over the same stage's pad top).
- The mask also covers the bed (floorY - 1): an entry with groundY 1 writes row 0 there (the advisor's point; a clarification of §4).
- Field model for the flow: the field's floorY cells (not reserved) are the design's farmland ('stop') for the plan-time sim and the
  checker; the checker's exit treats feet over the field as exits. Keep: an irrigation body's reach must stay in its own lot box
  (own box exempt, outside it `M25:keep`). Breach stays in its broken cell by construction.
- `lots[].irrigation {cells (world runs), lotCells (lot-relative, front-as-south), sources, bodies, field}` on the IR lot and the
  artifact.
- KC: register bodies with keep.mjs at emit.

Java:
- Mask: `architect_mc:irrigation` packed cells in the lot item's ext -> TemplateWriter skip, PlaceJob fill/clear/approach filtered,
  `WorldJournal.sections(..., skip)` at SiteJournal begin and retake, DeltaPlanner.outcome excluded; `irrigationDropped` count.
- Lot removal drains the lot's bodies first (RegionFluids.drainBodies) from Sites.removeDetailed / removeLarge / Groups stage undo.
- PlanChecks.hasH gains irrigate; lotProblem's count excludes dropped cells.
- DesignRequest gains trailing nullable `reserved` (+ 1.11.0 ctor kept, withReserved); wire; sidecar zod + brief line + kit
  checker `--reserved`; sim honours it.

Gate: `tools/gate6cirr.mjs` (irr-unit, irr-ingame, irr-crash), fixtures v62, v63, irr/*.

## Next

Everything above.
