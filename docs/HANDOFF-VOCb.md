# HANDOFF: slice VOC-b (budgets and rules)

Branch `slice/VOC-b` (from `origin/voc/core` 38ae5133), worktree `../architect-mc-VOCb`; its byte-identity base worktree
`../architect-mc-VOCb-base` (the merge base with origin/main). Contract: docs/CONTRACT.md "Phase 6c slice VOC" (FROZEN; Steward's review
and the coordinator decisions win). Placeholders: API 1.35.0, mod 0.38.0, kit 0.36.0, catalogue 7. Ports 8930-8935 (gate runs:
`--ports 8930:8931[,8932:8933,8934:8935]`, `--run-dir ../architect-mc-VOCb-run`, `--out ../architect-mc/artifacts/gate-runs-VOCb`).

## Built

- kit/lib/vocab/budget.mjs (VOC-b's): styleOf (a bible's opt-in, budget, own blocks: roles, palette(), pattern mats, allow),
  measureRarity, rarityWarnings, pair halves, waterlogged, hazards.json reaches (per fire source), driftsWhere (less ice and snow, less
  leaves within 6 of a log).
- check.mjs: `state` and `hazard` errors (imported: warnings), metrics.rarity and metrics.drift always, `rarity:`/`coherence:` warnings
  only with an opted-in style (opts.style; build.mjs and check.mjs take it from --restraint's bible, else --bible).
- bible.mjs: format-2 `rarity` (validateRarity), `warnings` (role fitness).
- region/checkVocab.mjs: M26, M27 (state, convert, role, drift, creative), M20 widened ((a) error, (b) `M20:natural` warning); the compile
  pass (region/plan.mjs): VOCAB/FIRE refusals by planning again with the part refused (ctx.vocabRefuse; compile.mjs answers it before
  resolution); parts with `architect_mc:unsafe` are never refused there (the checker must catch them).
- finish.mjs: cost.rarity (opted-in bible, or a foreign precious block), cost.creativeOnly.
- plan.json: reason code VOCAB.
- village.mjs: the square paints the path role's bible pattern (MP) when the bible names one (v0's generators resolved roles to blocks
  first, so no role pattern reached a plan/0 plan; every plan without a path pattern writes as before).
- Sidecar: BibleRequest.rarity (FIELD_LIMIT via the kit's validateRarity, rarity.ts), copied into the bible (bibles.ts, the sim too),
  carried by revise, BibleInfo.rarity, the plan's bible.json gets rarity (regions.ts), metrics.rarity/drift dropped from agent-readable
  check.json unless opted in (rarity.ts promptMetrics; critic.ts untouched: it is hashed), feature bible.rarity.
- Java: Wire4b writes rarity only when set; feature rarityBudgets; dev.vocab.bibleRequest / dev.vocab.bibleJob (SliceVocbDev, genHooks).
- Fixtures: scenarios/bibles g6cvoc_* (+ _free twins); kit/test/fixtures/vocab/voc-designs.mjs; plan valid/v50, v51; voc/r01-r03, v50n,
  asks-families.txt.
- Tests: kit/test/vocab-rules.test.mjs, sidecar/test/vocb.test.ts, WireVocbTest.

## Decisions to record in "as built"

- Non-terrain written cells (M26's denominator): written, not air, not a fluid, not a common natural block (the contract's "set other
  than terrain" would drop lanterns and props, which sit in terrain-set parts).
- Own blocks exempt from shares, rare families and colours; a `families` cap counts every cell; precious counted everywhere.
- M27:role judges the roles the plan's bible names (the kit's frozen defaults, rubble cobblestone and path gravel, are not judged).
- r02 is a sponge quay deck (VOCAB convert): plan/0 can't write a concrete-powder path by a moat (H's slot rule refuses a gravity
  shell or deck, a rim keeps paths off the water's faces).
- `_unsafe.overRare` (region) is v50 under a budget of 0 (a bible's own blocks are exempt, so rare blocks can't come from its roles).

## Left

- [ ] tools/lib/gate6cvoc-b.mjs: unit (items 6, 7, 13 timing), ingame (item 8), natural (item 9), survival (item 11), look (item 15)
- [ ] "6c VOC" impact rule: voc-ingame, voc-natural, 6cvoc-look in its slice list; my paths
- [ ] DEVBRIDGE.md: dev.vocab.bibleRequest, dev.vocab.bibleJob
- [ ] slice gate run, the gallery artifact, the verifier, "VOC-b as built", retire this file, push
