# Steward's first recordings of 12 strange asks

These 12 files are Steward's plans as first recorded (steward-mc 8703dbd, copied whole, never edited). Steward re-recorded them at
0c8f4a8, and `../asks/` now holds the new recordings (6c close-out A, docs/CONTRACT.md "Phase 6c close-out A" §6).

The slices before close-out A wrote their tests and committed asks tables against these plans. They still read them, so their
expectations keep holding:

- kit tests, through `plan-helpers.mjs` `asksFirstPath`: `plan-k1a` (item 7), `plan-k1b`, `plan-t3a` (§9), `plan-t3b` (§9) and
  `vocc` (item 1);
- gate asks readers, through `tools/lib/asks-first.mjs` `firstAsk`: `gate6ch-a` (H-a item 10), `gate6ch-b`, `gate6cvoc-a`,
  `gate6cvoc-b`, `gate6cvoc-c` (item 3), `gate6cfl-kit` and `gate6crs-kit`;
- `tools/lib/gate6chy-b.mjs` `asksGap` reads them unless called with `{current: true}`. KC, F3, S3 and RS use it that way.

Close-out A's own item 6 reads `../asks/` (`asksGap(kit, {current: true})`).

Retire this directory once those slices' tables are re-cut to the new recordings (docs/PLAN.md, "Queued from close-out A").
