# HANDOFF: slice H-b (wet structures)

Resume notes for slice H-b (docs/CONTRACT.md "Phase 6c slice H", §8, §14 items 5, 8, 9 (wet), 11's re-answers, 19's wet shots). Branch
`slice/H-b` in `../architect-mc-Hb`, from `origin/h/core` (a2f86072). Ports 8924-8929, at most 3 slots. Placeholders: API 1.34.0, mod
0.37.0, kit 0.35.0, catalogue 7 (H-core's; the coordinator renumbers). Delete this file when the gate passes ("H-b as built").

## Done (kit, offline: committed)

- `kit/lib/fluids/wet.mjs`: `wetColumn` (a wet write stands on still natural water only: sources, ice over water, water plants, to the
  bed, at most waterDepth; flowing, falling, lava, a bubble column, an owned/player/block-entity cell never; in a second plan a column
  no fluid volume covers is `unread`), `wetBridgeFallback` (only a bridge-row WATER or ROUTE_WATER after T3's fallback, kinds street,
  road, path, bridge; holds the caller's fluid volumes outside the round's checkpoint and drops the bridge pass input's cache),
  `wetWallFallback`, `askWet`/`noteWet` (meta.wet records, bed - 3 .. surface + 1), `underwaterOk`/`underwaterBlock`.
- Wet piers: `checkBridge` `opts.wet` {waterDepth, floorAt, vols} (bridgeGeom.mjs), footing bed - 1, a wet site weighs 10 a wet cell;
  WATER {kind: deep | flowing | lava | unread} with no `until` (the dry search: kind `water`, no `until`); the bridge row
  (`moves/bridge.mjs`: `t3.bridge.wet`, the cost +10 a wet cell, the survey floor from route.mjs's `env.F`, a span over read water
  names the leg's WATER before an unread one); `bridgeSpan` asks the volume over the span's water footprint, re-reads each wet column,
  writes the wet pier block (appended material: dry bridges' bytes unchanged), records `wet` on the meta record and `piers[].wet`;
  emitBridges answers `incomplete VOLUME` (first plan) and pushes `kind: wet` guards; answers gain `bridges[].wet {cells, waterDepth,
  piers: [{i, wet}]}` and a note; `bridgeFailAnswer` WATER `unread` -> incomplete VOLUME.
- Harbour walls (`line.mjs` wet grid, `wall.mjs`): a ring failing WATER, or a line with no clear leg on a claim with water, is
  searched once more; each side keeps its first dry offset; a line's wet step costs 3; plan-made water (`r._fluidBodies` cells and
  shells) stays WATER; no gate in a wet section; wet cells from bed - 1, in the body where `underwaterOk`, else foundation/structure;
  first plan incomplete VOLUME; geometry `wet: [{from, to, depth}]`, `crossing {type: wall, over: water, depth}`; meta walls `wet`.
- `form.quay` (`quay.mjs`): locator along/near water (NO_FEATURE without natural water), a straight bank within a step of a deck 1
  over the surface, length and reach shortened (adjusted) where needed, deck solid from bed - 1, path top, posts every 4, lamps,
  steps every 16 (the exits), rails over water under 2 deep, meta.quays (siteplan), the entrance on the bank's middle.
- Checker: M10:bridge leaves wet pier columns to M25:wet (written-in-water count, clearance scan), a wet footing may sit on sand.
- `compile.mjs:1245`'s `until: 'H'` removed (evidence kind `crossing`); `bridgeGeom.mjs:246`'s too.
- Fixtures: valid/v46_quay, v47_wet_beam, v48_harbour_wall (`volume: {}`: the two-plan harness); t3a/r06, r07 re-answered fits
  (wet beam), new t3a/r06b WATER deep with the arch wouldFit; refused/k1a_r01 now `waterDepth: 3` -> WATER deep; h/hb_r01 deep,
  hb_r02 flowing, hb_r03 quay NO_FEATURE, hb_v01 the street fallback on wet piers. `h-pending-b.json` deleted.
- Tests: kit/test/h-wet.test.mjs (12); bridge-t3a, plan-t3a, h-foundation (quay now NO_FEATURE on a dry claim) adjusted. Kit suite
  522/0 at 9c803eb9 (+ covers fix).
- Gate: `tools/lib/gate6ch-b.mjs` (unit: hb-kit, hb-unchanged, hb-asks; ingame: hb-flat; natural: hb-natural; cold: hb-cold;
  look: hb-look) and `tools/gate6chb.mjs` (H-b's items alone; ports 8924/8925, run dir `../architect-mc-Hb-run`).

## Findings so far

- The 59 asks: no recorded part takes the wet fallback or answers WATER (hb-asks); answers identical to h/core.
- Byte identity vs origin/main: 56 of 59 identical; the 3 that differ are exactly the named re-answers.
- S3's river is 20-32 deep in its middle (survey): a beam there needs piers past waterDepth, so it answers WATER deep (the gate
  records it); the natural wet beam is the frozen site's (hb-cold). S3 holds a 6-long quay.
- Pre-existing (T3a): a width-2 bridge whose landing stands on the walk's fill gets M10:bridge warnings (r06's terrain, dry arch
  too). Not H-b's.

## For H-core (reported, not changed by H-b)

- `tools/lib/gate6ch-core.mjs unchanged()` needs the named exceptions (`t3a/r06_water_arch`, `t3a/r07_water_rope`,
  `refused/k1a_r01_wall_water`), else its `same === n` bar fails on the merged branch. H-b's `hb-unchanged` checks that exact list.
- `checkpoint`/`rollback` (compile.mjs) don't save `meta.wet`, `meta.quays` or `_fluidBodies`. H-b leaves the first plan's wet
  records on purpose (finish.mjs's `wetAsked` reads meta.wet), and asks volumes before or outside checkpoints.
- The trigger: H-core's finish.mjs `wetAsked` (meta.wet non-empty) matches what H-b emits.

## Next

- In game (needs H-core round 2 on `h/core`: ARVX v3 sampling and `PlanChecks` wetAsked): `node tools/gate6chb.mjs` ingame,
  natural, cold, then the runner's slice tier; the look step and the gallery; the gate-verifier; "H-b as built".
