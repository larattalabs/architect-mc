# HANDOFF: Phase 6c slice F3 (forms II)

Resume notes for `slice/F3` (worktree `../architect-mc-F3`). The contract is docs/CONTRACT.md "Phase 6c slice F3: forms II" (FROZEN), its
"Steward's review" and "Coordinator decisions" subsections win. Delete this file when the gate passes and "F3 as built" is written.

## Setup

- Worktrees: `../architect-mc-F3` (the branch), `../architect-mc-F3-main` (origin/main e755d663, detached: the byte-identity base),
  `../architect-mc-F3-run` (the run worktree for driver-direct runs; `mod/run` cloned from `../architect-mc-6a-run`).
- Ports 8918-8923 (this slice's): 8918/8919 the builder's driver runs, 8920/8921 and 8922/8923 for the sub-lanes or a 3-shard runner.
- Scratch under `scratchpad/f3-build/` (git-excluded locally: `.git/info/exclude`).
- Placeholders: API 1.39.0, mod 0.42.0, kit 0.40.0, catalogue 11. Fixtures v72-v77; slice-local `kit/test/fixtures/plan/f3/`.

## Done (commit 95be73ef "F3-a core")

| Area | Where |
|---|---|
| Generators | `kit/lib/forms/giantTree.mjs` (oak, spruce, birch, jungle, dark_oak, cherry, mangrove, pale_oak, crimson, warped), `giantMushroom.mjs` (brown, red). Ops are the skeleton (<= 32 primitives each); cells evaluated by `rules.mjs formCells`, drift states fixed by `states.mjs fixStates`; always baked (`r.form` with `gen.cells` -> `bakeCells`). |
| Drift states | `kit/lib/forms/states.mjs`: leaf distance (vanilla's BFS from `#minecraft:logs`), mushroom faces (false next to the same block), dripstone thickness (SpeleothemBlock.calculateSpeleothemThickness, read from the 26.3 jar); `lintStates` (lint STATE); `columnRuns` (the mask: flat `[z, x0, x1, ...]`). |
| Placement | `kit/lib/forms/place.mjs` (`forbidden`, `pickSites`), `kit/lib/forms/hooks.mjs` (`f3Resolve` in step 2: locator only, provisional fits; `f3Emit` in step 3 after zones and F1 forms, before walls, farm ponds, H emit and routes). `inside {part: zone}` = the zone's rect less its parts' op footprints and lot boxes + 1, grown by 2. |
| Masks downstream | `program.mjs _routeObstacles` and `connectors/wall.mjs gridOf` read `ir.forms[].columns` (F1 forms keep bounds). |
| Checker | `kit/lib/region/checkForms.mjs` (M18, M19, warnings, appended to RULES); grown forms out of M3:overhang (`GROWN_GENERATORS`) and out of the M5/M6 walk area. |
| Java | `journal/StillOurs` (faces on HugeMushroomBlock, thickness on SpeleothemBlock volatile; coral via `Coral`), `journal/Coral` (deadBlock fields by reflection on the four live coral classes), `WorldJournal.holds` prefilter and `cuEquivalent` (a player's record wins), `PlanChecks.hasCaveForm`, `ApiRules` (plan.forms2 -> formsTrees + formsCave + formsWater). Test `StillOursF3Test` (5). |
| Catalogue | 11: form.giant_tree flipped, form.giant_mushroom/coral/roots/stalactites added (one lean def each, `$defs/preset`), `limits.volume: true` on connector.tunnel, form.roots, form.stalactites (S-F3-3: limits chosen). Catalogue 9 archived `fixtures/plan/catalogue-vocc.json`. |
| Fixtures/tests | valid v72 (grove), v77 (nether); f3/r03, r04, u01 (treeInPond, a fountain's watch), u02 (leafNotPersistent), u03 (mushroomFaces); `forms-f3.test.mjs`, `forms-f3-property.test.mjs`. |

## Decisions to record in the as-built

- Baked always (drift states are a function of the final cells); item 1 judges the skeleton ops.
- Grown forms are placed at emit (after the zones' layouts) so `inside` reads the real open land; resolve answers provisionally.
- M3:overhang leaves grown forms out (canopies, caps, stalactites overhang by design); support (floating) still holds them.
- The walk area (M5/M6) leaves grown forms' cells out (a root's top is no path).
- A soil cell under a written log/root/stem on the ground is written as dirt (a grass block under a solid block dies: item 5).
- `_unsafe.treeInPond` stands the tree in a fountain's watch: a canopy over still water is in none of a pond's 3D sets, and a trunk in a
  pond's water makes the pond refuse itself (LEAK unwritable) first. Unsafe parts are never refused by the backstop (KC's rule): M25:clear
  names it.
- S-F3-3 volume flag: limits; on tunnel, roots, stalactites (entries whose check reads a volume under the ground). H bodies are not
  flagged (their volumes are surface boxes the two-plan flow reads already; farmPond/irrigate are members, not entries): an open
  question for Steward at the RC.
- The compact plan/0 bound is 84,000 (Steward's S-FL-8).

## Done since (commits after 95be73ef)

- F3-b (75a56515): `kit/lib/forms/cave.mjs` (stalactites, roots), `hooks.mjs f3CaveEmit` (volume box, incomplete VOLUME first plan and
  past the 4M cap, NO_FEATURE no ceiling), M3:gravity holds a stalactite by the cell above; v74, v75, f3/r02, r05, r06, u06.
- grove_demo + `scenarios/sites/grove.json` (pinned by the probe, not find-site), `kit/lib/forms/forest.mjs` + `kit/regions/mega_bench_forest.mjs`
  (mega_bench.mjs untouched: its source sha is its IR's programSha; the golden stays), 30.0% cover on the synthetic survey.
- Gate: `tools/gate6cf3.mjs` (unit, ingame, natural, forest, look, golden), `tools/lib/gate6cf3-{game,kit,look}.mjs`, chain `6cf3` + `6cf3-look`,
  impact rule "6c F3", api-compat `--gate6cf3` (v0.40.0 built from its tag into artifacts/gate6c-f3/v0400), apijars over 0.40.0/0.39.1/0.39.0.
- Asks before = after (f3/asks-*.md); byte identity 261/262 (e16 the named exception); compact plan/0 81,064 (bound 84,000, S-FL-8);
  kitVersion goldens re-cut (IR identical but kitVersion); grove_demo_flat golden.
- Site retries: a grown form tries up to 3 other seeds of its species before NO_ROOM (noted).
- In game (change runs, artifacts/gate-runs-F3/): v72, v74, v75, v77 pass items 3, 4, 6, 8 (20261020-205519-change; v72's removal check
  fixed after: dumps before/after compared at the written cells after a stand).

## Left

- F3-c (coral): delegated (lane below); then s01 in game, the coral items, plan-p0 item 9 (form.coral's valid fixture).
- v76 (FL's around): deferred to whichever merges second.
- The natural round (f3-natural) and its golden (F3_WRITE_GOLDEN=1), the look + gallery, the slice tier, the gate-verifier, "F3 as built".

## Lanes

- F3-c (coral) on `slice/F3-c` from 95be73ef (worktree `../architect-mc-F3c`, ports 8922/8923), merged into slice/F3 by the builder.
