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

- [x] worktree, baseline jars, apijars pointed at 0.21.0/0.20.0/0.19.0 (baseline apijars PASS on unchanged code:
  `artifacts/gate-runs-B/20261012-211407-change`)
- [x] API 1.21.0 (BrushRequest/Kind/Shape, Destruction, Regions.brush, RegionView.brush, Reason.PERMISSION, Limits.BRUSH_*), the
  `brushes` feature (sidecar `region.brush`)
- [x] stroke path `region/Brushes.java` (survey res 1 + volume, one plan, realise at once, future at PLACED), RegionRec.brush,
  TileCheck PLAYER_BLOCKS + same-owner stroke layering + never unbreakable blocks
- [x] commands `region/BrushCommands.java`; DevBridge `dev.brush`, `dev.brush.stats` (SliceBDev, generated headless)
- [x] ARVX v2 (Java + kit), `r.needVolume(box, {blocks})`, `volume:blocks` kind, `blockTags`, the block mask term real
- [x] kit kernels `kit/lib/region/brush.mjs`, program `kit/regions/brush.mjs`, `json` param type; kit tests brush-b (11 pass)
- [x] gate driver `tools/gate6cb.mjs` (unit, stale, apicompat, ingame = flat-owned/flat-undo/flat-permission/flat-misc, natural),
  chain steps b-unit, b-ingame (host server), impact rule; apitest `apib`
- [ ] first in-game run: `artifacts/gate-runs-B/20261012-214530-change` (b-unit, b-ingame)
- [ ] slice tier, gate-verifier (re-runs items 3, 4, 5: `node tools/gate6cb.mjs flat-owned|flat-permission|flat-undo`), as-built,
  docs (REGIONS.md ARVX v2 + brush, DEVBRIDGE hooks, GATES impact row), push

## Deviations so far (for as-built)

- SMOOTH's property: the largest step between inside columns never rises and drops unless the pinned edge holds it (88 lowered,
  5 held, 7 already flat of 100 seeds); the roughness falls on 99. Strict lowering is impossible where outside columns pin both
  sides of an inside column (edges pinned, §3).
- A brush's surface kinds move the columns whose ground lies inside the shape; water and lava columns keep their surface.
- MELT and CAVE_CARVE emit cell lists (absolute `columns` runs), CAVE_CARVE is not a `capsuleChain` shape: the worm is resolved
  against the frozen volume at plan time (it stops short of fluids, floating bits are carved too).
