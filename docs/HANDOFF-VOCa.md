# HANDOFF: slice VOC-a (the vocabulary)

Branch `slice/VOC-a`, worktree `../architect-mc-VOCa`; the shared interface is pushed as `voc/core`. Contract: docs/CONTRACT.md
"Phase 6c slice VOC" (FROZEN, Steward reviewed). Placeholders: API 1.35.0, mod 0.38.0, kit 0.36.0, catalogue 7 unchanged.
Ports 8912-8917 (the driver defaults to 8914/8915; gate runner shards from 8912).

## The frozen interface (voc/core), for VOC-b

- Fields in kit/lib/blocks.mjs (generated `v(...)` section; `info(name)` returns them): `fam`, `col`, `t` (absent = common;
  uncommon|rare|precious), `sv` (craft|drop|silk|loot|cost|none), `rt`, `wx {next?, waxed?}`, `be`, `ft`, `ff`.
- Helpers in **kit/lib/vocab.mjs** (not blocks.mjs: blocks.mjs already exports a `familyOf` for the Java family):
  `familyOf`, `colourOf`, `tierOf`, `survivalOf`, `isFitting`, `drifts(state)` (takes a state: leaves drift only with
  persistent=false), `weatheringOf`, `hasBlockEntity`, `randomTicks`, `featuresOf`, `fitsRole(role, block) -> {ok, failed}`,
  `hazardOf(kind)`, `hazardBlocks(row)`, `ROLES`, `HAZARDS`, `TIERS_TABLE`, `TIERS`, `SURVIVAL_CLASSES`, `DYES`, `ROLE_CHECKS`.
- kit/lib/vocab/survival.mjs (generated): `CREATIVE_ONLY` (Set), `COSTS`. check.mjs re-exports `SURVIVAL_CREATIVE_ONLY`, bom.mjs `COSTS`.
- kit/lib/vocab/rarity.mjs: `RARITY_DEFAULTS`, `RARITY_LIMITS`, `RARITY_KEYS`, `validateRarity(r, path) -> {errors, rarity}`, `allowedBlocks`.
- validateBible's `warnings` (VOC-b builds it): `{ok, errors, warnings: string[], bible}`, a role warning reading
  `roles.<role>: <block> fails <check>[, <check>] (kit/vocab/roles.json)`.
- Tables kit/vocab/: tiers.json, roles.json, survival.json, hazards.json, modifiers.json (every row with a `why`).
- Java: `BibleRequest.Rarity` (nested record, every member nullable, `toJson()`, `defaults()`), BibleRequest's trailing `rarity`,
  `withRarity`; the 1.10.0 constructor kept; `withOpKey`/`withSheetCritique` carry it. Not yet on the wire (Wire4b) or in the sidecar:
  VOC-b wires both (omit `rarity` when null so opKey body hashes don't move).
- systemRef `vocab/1` and `vocab/1#compact` (sidecar SYSTEM_REF_DOCS, kit/schemas/vocab-1.json); sidecar feature `vocab` -> Java
  feature `vocabulary`. `rarityBudgets` / `bible.rarity` are VOC-b's.
- Gate: tools/gate6cvoc.mjs steps unit|registry|probe|survival|ingame|natural|look -> voc-unit, voc-registry, voc-probe,
  voc-survival, voc-ingame, voc-natural, 6cvoc-look (tools/gate-chains.json). VOC-b's items go in tools/lib/gate6cvoc-b.mjs; it adds
  voc-ingame, voc-natural, 6cvoc-look to the "6c VOC" impact rule's slice list.

## Status

- [x] gen-vocab.mjs (jar and no-jar, --check), VocabDump.java, edges.json, the tables, the one source, blocks.mjs fields
- [x] vocab.test.mjs (drift test, items 1, 3, 4 kit), versions, goldens re-cut (crossings_demo_flat, links_demo, links_demo_flat)
- [x] DevBridge hooks dev.vocab.registry / tick / probe (compiled), systemRef vocab/1
- [ ] in-game items in tools/lib/gate6cvoc-a.mjs: registry (item 2), probe (item 10), survival (item 4)
- [ ] v0.37.0 apitest jar archived (artifacts/gate6c-voc/v0370), api-compat --gate6cvoc, apijars runs
- [ ] slice gate run, verifier, "VOC-a as built"

## Findings to record in as-built

- 26.3 has a stonecutter recipe stone -> cobblestone: the generated `stone` family holds the hand `cobblestone` family.
- No 26.3 creative-only additions: the generated list equals the 35.
- Families are named by the shortest stem among full-cube members (contract: lexically smallest), so ice's family is `ice`.
