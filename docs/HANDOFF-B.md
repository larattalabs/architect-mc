# HANDOFF: slice B (terrain brushes as journal-backed region ops)

Resume notes for `slice/B` (worktree `../architect-mc-B`). Delete this file when the slice gate passes.

- **Contract:** docs/CONTRACT.md "Phase 6c slice B" (frozen by "Changes from Steward's review of the batch": S-B-1 one region
  per stroke, S-B-2 owner `*` areas deferred, N-B-1 `PLAYER_BLOCKS` at permission 2). PLAN "6c slice MP: coordinator rulings":
  the `block` mask term becomes real here (a frozen volume with block ids). PLAN "Keep open: zones": no id from an owner string.
- **Versions (placeholders):** API 1.21.0, mod 0.24.0, kit 0.23.0.
- **Ports:** 8930-8935. Run dir `../architect-mc-B-run`, out `../architect-mc/artifacts/gate-runs-B`.
- **Baseline:** v0.21.0 built from its tag into `artifacts/gate6c-b/v0210/` (jars + tools/apitest.mjs + tools/lib). apijars and
  api-compat run against 0.21.0, 0.20.0 and 0.19.0 (SCH's sets for the last two).

## Decisions (record in as-built)

- Destruction is a per-stroke flag on the region record, read by TileCheck (not a cell condition: ARTL's 2 cond bits are full).
  `PLAYER_BLOCKS` also passes block entities (journaled with their NBT; drops cleared).
- Layering: a stroke layers over the **same owner's earlier strokes** only (their tile entries count as "ours"); every other
  owned cell (sites, roads, deltas, crates, other regions, other owners) is skipped as before (K5). Strokes write `ALWAYS_OURS`.
- Permission: `actor` must be an online player with permission level 2; null or anyone else refuses `PERMISSION`. The server
  console reaches `PLAYER_BLOCKS` only through the command path (an internal flag), so no API caller can claim the console.
- Brush ops are `columns` ops (masks and patterns apply), not `relief` ops; non-local work (means, worms, exposure) at plan time.
- ARVX v2: v1 + a block-id palette with per-column runs; `requires` kind `volume:blocks`; a `block` mask over v1 or no volume
  still refuses MASK_NEEDS_VOLUME.

## Status

- [x] worktree, baseline jars, apijars pointed at 0.21.0/0.20.0/0.19.0
- [ ] RAISE end to end (API, stroke path, overlapping strokes undo in any order, another owner's road)
- [ ] destruction, permission, commands
- [ ] ARVX v2 + block mask
- [ ] the other kinds (kit kernels + property tests)
- [ ] gate6cb.mjs, chain steps, impact rule, apitest `apib`, api-compat `--gate6cb`
- [ ] slice tier, gate-verifier, as-built, push
