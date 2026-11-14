# Shape promotion: candidates

The pipeline a generator goes through to become a kit form module that other programs call (docs/CONTRACT.md "Phase 7c" §3 row 14,
SETTLEMENTS §13). The tool is `tools/promote.mjs` (steps in `tools/lib/promote.mjs`); each candidate's record, the golden included, is
the JSON beside its module (`<module>.promotion.json`), and its block below is written by the tool. $0 and offline throughout.

1. **Lint.** The module's source under AU's lint (`kit/lib/plan/authored.mjs` `lintAuthored`: no trig or other approximated Math, no
   `**`, no Date, no Math.random, no clocks, I/O, dynamic code or regular expressions), with the candidate's own closed import list.
2. **Determinism.** 20 seeded param sets (the sheet's): per seed the sha of the generator's `{ops, bounds}` and of its tiles' payload
   shas, planned and evaluated. The golden is this Node's; equal over 3 runs, the other Node major (`mise exec node@22|24`) and Linux
   (OrbStack: `node:22` linux/amd64 and `node:24-slim`, throwaway containers `pm-determinism-*`, no network, read-only mounts).
3. **Properties.** 40 param sets (everything varies; a valley under some): every cell inside the declared bounds; per-tile
   evaluation equal to a whole (tile-free) evaluation; the checker clean of M3 (support and the ledge rule) and of every error; S-THEME
   clean; canonical states; the roles resolving under the default roles and two bibles. Eval cost per cell against an existing
   generator (`crater`, the same op kind): report-only, a bench that flags past 2x (docs/GATES.md "Speed rules" 9).
4. **Variety.** The 20 sheet seeds' side silhouettes in one shared frame (never rescaled to a form's own bounds): pairwise IoU under
   0.8 for at least 80% of the 190 pairs. The contact sheet (5 x 4 iso renders over their silhouettes) goes to the main checkout's
   `artifacts/promote/<candidate>/sheet.png` (never committed); its sha is recorded.
5. **Noah's approval** of that sheet (N-7c-6), through the coordinator and the parent session. `promote.mjs approve` refuses a sheet
   whose sha is not the recorded one, and records who, when and the sheet's sha (a no records its reasons).
6. **Output.** Every step passed: the module's `VERSION` stamped with its semver. The module was already the kit's (programs call it
   as `r.<method>`); older IRs that embedded its form (its ops, or the baked voxels) evaluate unchanged
   (`kit/test/pm-promote.test.mjs`, fixtures `kit/test/fixtures/promote/`).

`node tools/promote.mjs <candidate> check` re-runs steps 1-4 against the record and writes nothing (the gate step `pm-promote`).

## Candidates

<!-- promote:archSpan -->
**archSpan** (`kit/lib/forms/archSpan.mjs`, record `kit/lib/forms/archSpan.promotion.json`): archSpan: a masonry arcade carrying a deck across a gap (1-2 tiers; round, segmental, pointed or elliptical arches; wall, crenel, rail or no parapet), a span for AQ.

| Step | Result |
|---|---|
| lint | PASS: 0 findings |
| determinism | PASS: 6/6 legs equal (run 1 (this Node); run 2 (this Node); run 3 (this Node); node@22 (mise); linux node:22 --platform linux/amd64; linux node:24-slim); 20 seeds, all c956de6a255a |
| properties | PASS: 40 param sets (M3 on 40), 0 failed; materials under default, sandstone, deepslate; eval 232 ns/cell, 0.95x crater |
| variety | PASS: 190/190 pairs under IoU 0.8 (100%; median 0.306, max 0.717); sheet ac9b3ab3e2ba |
| approval | open |
| output | open |
<!-- /promote:archSpan -->
