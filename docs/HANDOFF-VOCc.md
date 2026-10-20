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
6. **One Java measure** (`PlanChecks.paletteCheck`) for the pre-check call (`Regions.checkPalette(sha, lotEntries)`), the
   `realiseApproved` refusal (`PALETTE`) and the `versionOf`/delta re-judge (checkDelta finding or refusal, applyDelta refusal for a
   required rule). It measures the template that will be placed (the named version), not the head.
7. **`lotBlocks`** mirrors `biomes`: Java `extra`, the sidecar's caps regex and a file, `region.mjs --lot-blocks`, `planRegion`. Sent
   only for a plan with a palette rule and lots whose entry the plan names. The check's key body is unchanged.
8. `vocab-1.json` is generated: `groups` and `compact.palette` come from `vocab-derive.mjs` (`gen-vocab --check` stays clean).

## State

- [ ] kit: def, groups, measure, answers, re-plan, artifact rows, lotBlocks, vocab/1, catalogue 9, fixtures
- [ ] Java: Reason.PALETTE, lotBlocks, checkPalette, realiseApproved refusal, delta re-judge, versions, tests
- [ ] sidecar: lotBlocks plumbing
- [ ] gate: tools/lib/gate6cvoc-c.mjs, gate-chains steps, impact rule
- [ ] slice run, verifier, as-built, push
