# HANDOFF-V: phase 6c slice V, flat village (C10)

Resume notes for `slice/V` (worktree `../architect-mc-V`). API 1.13.0, mod 0.16.0, kit 0.16.0. Contract: docs/CONTRACT.md "Phase 6c
slice V" plus "Changes from Steward's review of 0b, 0c and V" (they win) and the coordinator decisions. Delete this file when the
gate passes.

## Setup
- Branch `slice/V` from main f30fc86 (v0.15.0). `.gradle-home` cloned from the main checkout.
- 0.15.0 baseline: `../architect-mc-V-v0150` (detached at v0.15.0); jars in the main checkout's `artifacts/gate6c-v/v0150/`.
- Run worktrees (mine): `../architect-mc-V-run` (8906/8907, gate6cv's default), `../architect-mc-V-run2` (8908/8909),
  `../architect-mc-V-run3` (8910/8911). Only ports 8906-8911.
- Evidence: main checkout `artifacts/gate6c-v/` (step JSONs, REPORT.md, spend.json $0, api-compat.txt, findsite/).

## Coordinator addition (done)
- C16: road cells pathed on dirt, coarse_dirt, podzol, mycelium and rooted_dirt are free, as grass_block (`RoadBuilder.freeCell`,
  `RoadFreeCellTest`, gate6cv `survroad`).

## Decisions and deviations (record in as-built)
- keepOut: the IR records the rects the program honoured (`keepOut`) only when it reads `ctx.keepOut` / `keptOutAt`. The mod sends the
  owner's areas meeting the claim and refuses PROTECTED at accept and at realise for any area meeting the claim not in that set
  (exact rect). Programs that read none keep 0c's refusal, now at accept instead of before the survey.
- Kit version 0.16.0 (aligned with the mod). Golden tests pin kitVersion 0.12.0 (tiles unchanged; IR shas change with kitVersion).
- Lots stand on the street (VillageLayout's geometry: front edge on the verge), so a lane is the entrance's cells on the verge or
  the square's edge row, levelled at the lot's pad top: one row long. A lot with no lane is caught by M2 on the IR graph.
- Lot size = [alongStreet, deep] (Steward's sizeX/sizeZ on its east-west street). Pads cut/fill <= 2; floor at the entrance's y.
- The square is levelled (cut/fill <= 2) so the bell area is one y. Square lots: trading hall, landmark, central first; farms are
  moved within 2 of water where a street slot allows.
- Props: placement order bell, well, benches (2 on squares up to 11, 4 above), planters, lamps (corners or nearest edge cell); each
  keeps one walk neighbour. Square 9 holds no well (no room); planters as room allows.
- The `well` shared space is a 7x7 green (grass, walk) with the bell area at its middle; no well prop on it (the dry well stands in
  squares). The street is one road along it.
- Trading-hall variant: off the square it lands at ~13 (> 12), not 20; M23 still catches it.
- Item 6 uses `/apitest opgroup` (0a's sim group), `fit`, DevBridge realise and remove.

## Progress
- [x] 0.15.0 apitest jar archived
- [x] kit: version, lots type, graph, keepOut, village/props, flat_village, siteplan, villager mover, M22-M24, tests (243 pass)
- [x] sidecar: keepOut (`--keep-out`, feature region.keepOut), tests
- [x] mod: VERSION 1.13.0, mod 0.16.0, features, keepOut fill + honoured refusal, LotSpec ext, dev.nav.villager, dev.site.anchors,
      dev.region.plan bible, C16 free surfaces; `gradlew build` passes; api-compat clean vs 0.15.0/0.14.0/0.13.0 + 0.15.0 surface
- [x] gate driver `tools/gate6cv.mjs`, S7 scenario + bars (`tools/lib/scenario-village.mjs`), chain steps v-unit/v-ingame/6cv-scenario-s7
- [x] S7: strict search found no site (coordinator's second-seed case; findsite/summary.json); provisional fixture
      [1480,-3128,1591,-3017] pinned; flat + natural runs pass bars 1-13; golden s7; gallery https://claude.ai/artifact/AHUxAGLT42pfRy5YUHdojG
- [x] slice tier 20261011-093554-slice: 26 PASS, S1 golden failed on IR sha (kitVersion) -> fixed (tiles), re-run 20261011-103647-slice PASS
- [ ] (old note) S7 fixture: find-site running split 3 ways (`artifacts/gate6c-v/findsite/run-p*.out`, results `result-p*.json`). The search
      rewrites the scenario file only through FINDSITE_RESULT; merge the fixture into `scenarios/s7_flat_village.json` (a full copy of
      the scenario was kept before the search). Then `scenarios.mjs pin s7`, the flat and natural runs, `golden s7 <run>`, the gallery.
- [ ] gate6cv items in game (nav, protect, steward, survroad), slice tier, gate-verifier
- [ ] as-built in CONTRACT.md, HANDOFF retired, push
