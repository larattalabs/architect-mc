# HANDOFF: Phase 6c slice VOC-c (`rule.palette` measured)

Branch `slice/VOC-c`, worktree `../architect-mc-VOCc`, from main 773eae51 (v0.39.0: API 1.36.0, kit 0.37.0, catalogue 8).
Contract: docs/CONTRACT.md "Phase 6c slice VOC-c" (FROZEN; Steward's review and the coordinator decisions override it).
Placeholders: API 1.39.0, mod 0.42.0, kit 0.40.0 (the brief's, over the contract's 0.39.0), catalogue 9. Ports 8918-8923.
Scratch: `scratchpad/vocc/` (git-excluded). $0.

## Decisions (made before writing)

1. **Strict def from the recorded data.** The 7 asks' palette rules carry `label`, `notes`, `params` (with `gradient`), top-level
   `family`/`exempt`; e05 carries `{family, share, exempt: [terrain]}`, e16 a bare `{id, kind}`. The def allows `label`, `notes`,
   `params` (any object) and the three members; none of the recorded parts may be malformed (bar: 0 malformed).
2. **Exemption follows the writer (the IR part), never the block.** `vw.eachWritten` gives the IR part index only, so the
   compile records which IR parts are terrain or support (`meta.planCheck.paletteRoles`, outside irSha). Mixed parts are decided
   by name and recorded in the as-built.
3. **"No wood" swaps where every state enters an op** (the Region's material resolution and the cells/columns ops' literal states),
   active only when `ctx.paletteExclude` is set, so a plan without a palette rule is byte-identical. VOC-a has no material chain
   (plan/0 has no slot chain): VOC-c defines one (role -> structure -> foundation -> rock -> stone_bricks/cobblestone, shapes via
   `variant()`, non-cube wood shapes by a fixed table) and names it a deviation.
4. **The re-plan shares VOC-b's pass counter** (at most 3 passes in all). The scan and `vocabCells` are forced only when the plan holds
   a `rule.palette`; `finish.mjs`'s cost members must not appear where they did not before.
5. **The artifact's `palette` rows carry the parts' counts** (`partsCells`, `partsFamily`) and the check-time lot counts, so Java
   recomputes without a vocabulary. `natural` lists every block the kit's measured predicate drops (fluids, common naturals).
6. **One Java measure** (`PaletteRules.measure`) for the pre-check call (`Regions.checkPalette(sha, lotEntries)`), the
   `realiseApproved` refusal (`PALETTE`) and the `versionOf`/delta re-judge (checkDelta finding or refusal, applyDelta and revert
   refusal for a required rule). It measures the template that will be placed: a realise places an entry's current template (lotItem
   drops `@version`, as lotProblem reads it); a delta its target version; the other lots their standing version.
7. **`lotBlocks`** mirrors `biomes`: Java `extra`, the sidecar's caps regex and a file, `region.mjs --lot-blocks`, `planRegion`. Sent
   only for a plan with a palette rule and lots whose entry the plan names. The check's key body is unchanged.
8. `vocab-1.json` is generated: `groups` and `compact.palette` come from `vocab-derive.mjs` (`gen-vocab --check` stays clean).

## State (2026-10-20)

- [x] kit: def (plan.json, strict + kindError for min > max), groups (`kit/lib/vocab/groups.mjs`), measure, answers, the no-X re-plan
      (`kit/lib/plan/palette.mjs`; wired in compile.mjs's placeholders and region/plan.mjs's vocab pass), artifact rows (finish.mjs),
      `--lot-blocks`, vocab/1 groups + compact.palette (generated), catalogue 9 (catalogue-hy.json archived), versions (API 1.39.0,
      mod 0.42.0, kit 0.40.0)
- [x] fixtures: valid/v64_vocc_copper, valid/v65_vocc_nowood, vocc/r01-r04, vocc/asks-before.txt and asks-after.txt;
      vocc-designs.mjs (vocc_copper_cabin, vocc_oak_cabin); bibles g6cvocc_copper, g6cvocc_spruce; e05 now a rule.shape, e16 lost
      r_palette's expectation
- [x] Java: Reason.PALETTE, PaletteCheck + Regions.checkPalette, RegionRefused(reason, msg, detail), PaletteRules (lotBlocks, measure,
      refusal, ext rows, delta re-judge), realiseApproved hook, SitesImpl checkDelta/applyDelta/revert hooks, feature rulePalette,
      SliceVoccDev hooks, PaletteRulesTest
- [x] sidecar: lotBlocks (protocol, caps, file, flag), feature plan.rules, test/vocc.test.ts
- [x] gate: tools/lib/gate6cvoc-c.mjs (cunit/cingame in gate6cvoc.mjs), gate-chains vocc-unit/vocc-ingame + impact rule; the named
      exceptions added to HY's item 12 and VOC-a's item 5; HY-b's asks item ignores the palette lines; api-compat --gate6cvocc
- [ ] full kit suite, mod build, sidecar check green; goldens re-cut if needed
- [ ] slice run (ports 8918-8923, run dir ../architect-mc-VOCc-run, out ../architect-mc/artifacts/gate-runs-VOCc)
- [ ] verifier, as-built, retire this file, push
