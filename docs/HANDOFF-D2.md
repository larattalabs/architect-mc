# HANDOFF: slice D2 (C27 boundary districts, outposts, C28)

Builder's resume notes (AGENTS.md: keep current; delete when the gate passes). D1 shipped as v0.30.0 (API 1.27.0, kit 0.28.0).
Placeholders here: API 1.28.0, mod 0.31.0, kit 0.29.0 (the coordinator assigns at merge). Worktree `../architect-mc-D2`, branch
`slice/D2`. Ports 8898-8903 (ad hoc range).

## Status

- [x] C28 biome grid (4x4), C27 boundary.mjs + followEmit.mjs, outposts + corridor, plan/0 flips (catalogue 3), kit tests
- [x] in-game fixes: an outpost with no candidate refuses NO_ROOM; the follow street keeps within 2 of its line (route `within`),
      Chebyshev normal, smoothed line, up to 4 windows; the street corridor clears its trees; natural rounds judge E-normal; the
      oasis on the pinned site follows the jungle side
- [x] origin/main v0.30.0 (D1) merged; renumbered
- [ ] slice run (artifacts/gate-runs-D2/*-slice) -> gate-verifier -> as-built (draft in the builder's scratchpad) -> push

Open: a plan/0 `along` zone does not try a second window (Limits).
