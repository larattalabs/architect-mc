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

## Left
1. Read each run's SUMMARY.md (expected: pre FAILs holders and R2q; pre2 FAILs irr-holders; post all pass).
2. gate-verifier on `git diff origin/main...fix/drain-holders` plus a re-run of h-holders, h-rmcrash (and irr-holders).
3. Report ready to release or failures; remove the scratch worktrees (../architect-mc-drain-pre, -pre2, run dirs).
Single-site removal's R2-vs-queue ordering is part A's (F4), building on d63a5ded.
