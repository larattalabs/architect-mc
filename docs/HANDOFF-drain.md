# HANDOFF: fix/drain-holders (mod 0.40.1, API unchanged)

Delete this file when the gate passes.

## Commits (branch fix/drain-holders, pushed)
- 2bc15b9c TEST: h-holders, h-rmcrash, kill point R2q, killAt +save on K/RG, journal.at group, apitest block states
- 04f56d9c FIX: removal drain is holder-aware (RegionFluids.Holders)
- d63a5ded FIX: group removal R2-vs-queue-save window (Removal.planned, resumeCommitted)
- 9a6426fb mod_version 0.40.1
- b04368a0 TEST: irr-holders (drainLot on an irrigated lot)
- 1170398a FIX: drainLot holder-aware

## Gate runs (ports 8896-8903: 8936-8941 were held by the rp session's runs)
Evidence under `scratchpad/drain/` (git-ignored), runner pids in `*-fix.pid`, logs `*-fix-runner.out`:
- pre  (fails-before, source ../architect-mc-drain-pre @2bc15b9c): h-holders, h-rmcrash on 8900:8901 -> runs-pre/
- pre2 (fails-before, source ../architect-mc-drain-pre2 @b04368a0): irr-holders on 8902:8903 -> runs-pre2/
- post (branch head): chain drain-holders (h-holders, h-rmcrash, irr-holders, h-ingame, hy-ingame, irr-ingame, hy-crash) on
  8896:8897, 8898:8899 -> runs-post/
All with GATE_SLOTS=6.

## Results so far
- pre (runs-pre/20261021-000459-*): FAIL as expected. The stair is lost (FL3, K6 and the plain case). R2q ends PARTIAL with "nothing of group g1
  is in the world journal". RG6+save never halted: it is K7+save from ba59c7af on.
- post (runs-post/20261021-001318-*, head 5ca2bdf4) h-rmcrash: with the fix the stair is kept and waterlogged, the only fluid left; R2q ends
  REMOVED. Two test defects remain, fixed in 3b75ed6e:
  - The stair site's removal was refused ("c3 is owned by test:h ... pass force"): its E-flat 1 was the stair still standing. The step
    now uses force.
  - E-flat 18 outside the stair cell, the same 18 cells before and after the fix: 4 columns shifted by one, away from the bodies. The
    step now uses h_core_demo's lava variant, as h-crash does (E-flat 0 on main). The artifact itself is not explained.
  The rest of the post chain is still running (h-ingame, hy-ingame, irr-ingame, hy-crash; irr-holders also needs force, so re-run it).
- post2 (runs-post2/, head 3b75ed6e, 8904:8905): h-holders, h-rmcrash, irr-holders. This is the run that counts for the holder steps.
- pre2 (runs-pre2/, irr-holders @b04368a0): fails-before for drainLot. Its last check fails on the force defect regardless.

## Left
1. Read each run's SUMMARY.md (expected: pre FAILs holders and R2q; pre2 FAILs irr-holders; post all pass).
2. gate-verifier on `git diff origin/main...fix/drain-holders` plus a re-run of h-holders, h-rmcrash (and irr-holders).
3. Report ready to release or failures; remove the scratch worktrees (../architect-mc-drain-pre, -pre2, run dirs).
Single-site removal's R2-vs-queue ordering is part A's (F4), building on d63a5ded.
