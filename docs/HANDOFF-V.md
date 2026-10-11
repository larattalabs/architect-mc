# HANDOFF-V: phase 6c slice V, flat village (C10)

Resume notes for `slice/V` (worktree `../architect-mc-V`). API 1.13.0, mod 0.16.0. Contract: docs/CONTRACT.md "Phase 6c slice V"
plus "Changes from Steward's review of 0b, 0c and V" (they win) and the coordinator decisions. Delete this file when the gate passes.

## Setup
- Branch `slice/V` from main f30fc86 (v0.15.0). `.gradle-home` cloned from the main checkout.
- 0.15.0 baseline: detached worktree `../architect-mc-V-v0150` at tag v0.15.0; jars archived to the main checkout's
  `artifacts/gate6c-v/v0150/` (apitest jar, mod jar, tools/apitest.mjs, tools/lib).
- Ports: 8906-8911 only (gate6cv driver 8906/8907; slice shards 8908:8909, 8910:8911).
- Spend: $0 (sim/stub only). `artifacts/gate6c-v/spend.json`.

## Coordinator addition
- C16 extension: road cells pathed on dirt, coarse_dirt, podzol, mycelium and rooted_dirt are free, as grass_block (site/RoadBuilder).

## Decisions and deviations (record in as-built)
- keepOut: the IR records the protected rects it honoured (`keepOut`) only when the program reads `ctx.keepOut` / `keptOutAt`.
  The mod refuses PROTECTED at accept and at realise when an area meeting the claim is not in that honoured set (owner, id,
  exact rect). Other programs keep 0c's whole-claim refusal.

## Progress
- [x] 0.15.0 apitest jar archived (built from v0.15.0 with the sidecar bundle)
- [ ] kit: version bump, lots param type, graph member, keepOut, village/props components, flat_village program, siteplan, villager mover, M22-M24, tests
- [ ] sidecar: keepOut, params.lots passthrough, feature region.keepOut
- [ ] mod: VERSION 1.13.0, mod 0.16.0, features, keepOut fill + refusal rule, LotSpec ext, dev.nav.villager, C16 free surfaces
- [ ] S7: find-site, scenario, bible, entries, runs, golden, gallery
- [ ] gate driver tools/gate6cv.mjs, items 1-7, slice tier, gate-verifier
- [ ] as-built in CONTRACT.md, HANDOFF retired, push
