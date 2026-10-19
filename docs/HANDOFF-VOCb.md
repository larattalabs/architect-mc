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

## Pre-existing on voc/core (VOC-a's, fixed on VOC-a's local branch, not yet pushed)

- voc-unit "items 1, 3, 4 (kit)": its bar wants 12 kit VOC tests, vocab.test.mjs has 11 (VOC-a's c6ea7fac).
- voc-unit item 14: `tools/api-compat.mjs --gate6cvoc` isn't on voc/core (VOC-a's 023e19cb).
- kit h-foundation "catalogue 7" (`sinceApi` 1.34.0 vs 1.35.0; VOC-a's c8d445c5).

## Findings so far (gate run `artifacts/gate-runs-VOCb/20261019-212938-slice`)

- In game: v50/v50c/v51/v50r realise and remove E-flat 0; the realised world equals the virtual one; M20/M26/M27 equal on it; the
  bible's rarity reaches meta.vocab; cost.creativeOnly in an approved artifact (v50c: 6 light blocks); r01 VOCAB and r03 FIRE in game;
  FIELD_LIMIT in game. v51's lots have no entries, so its region ends PARTIAL with every item placed.
- cost.bom (K1's wall, H's fountain) is the bill of what a part emits; cells a later part overwrites (the wall's gate cut, 11 nether
  bricks; the fountain's coping) stand under the other part. Item 8's bom bar compares the standing items realised against planned.
- Drift probe (S3): 157 of 157 unwaxed copper cells of the hall weathered under dev.vocab.tick; after Regions.remove the diff classes
  157 cells `growth` (the undo keeps them): the queued §10 item's evidence.
- E-normal on S3: 1 mismatch, a bee nest's live NBT (`live`), 0 unclassified.

## Left

- [x] the look's gallery: https://claude.ai/artifact/1LivzSh3AWrvQwEKemei5j (run `artifacts/gate-runs-VOCb2/20261019-215638-slice`, 6cvoc-look PASS 17/0)
- [ ] re-run voc-ingame, voc-natural, voc-survival on the fixed driver (run 2, in progress)
- [ ] slice gate run (3 shards, ~2h20m), the verifier, "VOC-b as built" (draft ready), retire this file, push
