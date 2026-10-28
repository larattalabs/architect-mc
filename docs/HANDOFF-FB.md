# HANDOFF FB (7a slice FB: flood behaviour, M16)

Branch `slice/FB`, worktree `../_work/architect-mc-FB`. Kit only, $0, no Minecraft.

## State
- [x] M16 in `kit/lib/region/checkFluids.mjs` (`floodRule`, `floodMessage`, `FLOOD`), wired in `check.mjs` (appended to RULES, a warning,
  only on a plan with a fluid op; `metrics.M16`).
- [x] `kit/test/fb.test.mjs` (gate item 1).
- [x] the count over every committed fixture and the 59 asks (item 2): `tools/gate7afb.mjs count`.
- [x] byte identity (item 3): `tools/gate7afb.mjs unchanged` (gate7a-kit, base `../architect-mc-FB-main`).
- [x] `fb-unit` in gate-chains + impact; step-inputs rebuilt and checked.
- [x] kit suite (963/963), instant lints (run 20261028-172238-change; see the contract's as-built)
- [ ] gate-verifier review, push.

## Decisions
- Barrier = a non-air fluid-stopping cell (P.fs, M25's notion): doors, panes, bars, grates, fences count 1; air/torch/grass 0; a
  fluid cell is never crossed.
- Reach: a target counts within 3 steps (6-connected) of the body's water, i.e. within 2 of its shell (the contract's sunk-body
  clause). Unbounded, a raised spout (v43 w_fount_spout, level 69) reached 38k plaza walk cells through open air: not a basin.
- Targets: the player graph's feet cells plus the feet over walk-marked floors, and lot box cells (reached, never crossed), at
  y < level, not a cell of any body's sets. A walk cell that is itself a barrier (a doorway) counts its own block.
- No `floodCheck` feature string (a Java change): the coordinator's call at the release.
