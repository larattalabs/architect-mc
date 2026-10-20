# HANDOFF: slice FL (free layouts)

Resume notes for `slice/FL` (worktree `../architect-mc-FL`). Contract: docs/CONTRACT.md "Phase 6c slice FL: free layouts (FROZEN)",
its "Steward's review" and "Coordinator decisions" win. Placeholders: API 1.38.0, mod 0.41.0, kit 0.39.0, catalogue 10, feature
`freeLayouts`. Fixtures v66-v71. Ports 8912-8917. Scratch under `scratchpad/fl-build/` (git-excluded).

## State (pushed: origin/slice/FL)

- [x] FL-core: catalogue 10 (the six flips, catalogue 9 archived as fixtures/plan/catalogue-vocc.json), versions, `freeLayouts` /
      `plan.layouts`, kit/lib/region/frontage.mjs (Field mask, integer polar curves, frontage engine, hub, emitFree), kit/lib/plan/free.mjs
      (resolve, around, outlines, wouldFit re-checks, forms around), compile.mjs dispatch, S-FL-5 street ext (compile stamps V, D1, D2, FL
      streets; Java Ir.Road.ext -> the road's batch item ext), KC zone row (FL masks cut every H footprint; street zones near/adjacent a
      body too; clearRefusals refuses the dependent zone; clearScan reads zone streets over a body's hard columns)
- [x] Ring and spiral (+ forms around), grid, organic and outlines (kit/lib/region/layouts/*.mjs)
- [x] Kit tests: fl.test.mjs, fl-layouts-1/2.test.mjs; moved by name: builds-pt, districts-d2, plan-p0 item 1 (e07/e14/e15), vocc item 2;
      the whole kit suite 676/0, sidecar 758/0; byte identity 254/262 identical, the 8 movers all named (tools/lib/gate6cfl-kit.mjs)
- [x] Gate driver tools/gate6cfl.mjs (unit, ingame, natural, look), gate-chains steps fl-unit/fl-ingame/fl-natural/fl-look, chain 6cfl,
      impact rule "6c FL free layouts (slice FL)"; apijars and api-compat over 0.40.0 (built from its tag into
      ../architect-mc/artifacts/gate6c-fl/v0400), 0.39.1, 0.39.0
- [ ] In game: fl-ingame (item 6), fl-natural (item 7), fl-look (item 13) never run yet
- [ ] Slice tier run, gallery artifact, gate-verifier, "FL as built" in CONTRACT.md, this file deleted

## Next step

Smoke fl-ingame alone (`node tools/gate-run.mjs change --only fl-ingame --ports 8912:8913 --run-dir ../architect-mc-FL-run --out
../architect-mc/artifacts/gate-runs-FL`), fix what the game shows, then the slice tier on 3 shards (8912:8913,8914:8915,8916:8917).

## Decisions taken while building (for the as-built)

- The street is its centre line itself (an integer polar ring/spiral, a grid's straight streets, an organic lane's seeded walk), checked
  by V's ground-road rule (no water, cut/fill within 3 with steps of 1) and emitted as `road()` items in ground mode; no T2 route pass
  in the search (it is too slow per candidate). A closed ring is two arcs (`street_ring`, `street_ring_b`).
- Lots on a curve are pushed out (a longer lane) where the street runs on across their front (lotAt's push, D2's FOLLOW_PUSH idea).
- Organic setback is measured beyond the road's edge (front edge 2..6 from the centre), so "1 to 5" never puts a lot on the road.
- around: offsets measured from the feature's resolved rect (polar extent, widened); an H body's registered footprint stays hard.
- ring_city/ring_town answers blocked (its explicit dependency on crater_lake, form.crater until 7c), not the predicted fits/adjusted.
- Byte identity: the IR is compared with `roads[].ext["architect_mc:street"]` normalised away (S-FL-5 adds it to every V/D street).
- The standalone flat_village program (S7) does not go through compile.mjs, so its streets stay unmarked (scenario goldens hold).
- M1 gains a road-item rule (a road's cells inside a lot box); no committed result moved.
