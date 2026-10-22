# HANDOFF: 6c close-out A (slice/close-out-a)

State at hand-back (2026-10-22): code complete, contract FROZEN with Steward's review plus the §1 amendment (CONTRACT "Phase 6c close-out
A", §14 and "as built"). No in-game run yet: the coordinator holds them until turbo merges. Nothing is running.

## Done (offline)
- mod unit 862/0 (before the last small Java edits: RealiseKeyTest 3/0, PlanRetentionTest 7/0, RegionWaitTagsTest 2/0 since); kit 745/0;
  sidecar 761/0; lints structure 57/0, look 13/0, water 122/0; release-version --check --lenient consistent.
- coa-unit (offline, `node tools/gate6ccoa.mjs unit`): every check passes (byte identity 305 of 313, the 8 named; asks tables; api-compat
  --gate6ccoa 4/4 with 0.41.0 built from its tag into `architect-mc/artifacts/gate6c-coa/v0410`).

## Left, in order
1. When the coordinator says go (and the box is quiet):
   - the earlier slices' offline unit steps (p0, kc, h, hy, f3, rs, fl, irr, t3b, d, k1a, f1, x, t1, b, pt2, f2 and p3-lint). Their
     asks readers now use the first recordings (asks-8703dbd/), so their tables should hold; fix what doesn't.
   - `node tools/gate-run.mjs slice --since origin/main` on whatever main has then, detached; merge origin/main in first.
     It includes coa-unit, coa-ingame (items 1-3, 5, 8 and S-COA-5's flow) and RS's steps (RegionTargets changed).
   - `gradlew test` in full once.
2. A gate-verifier subagent on the diff plus the run's evidence.
3. Steward's RC, through the coordinator (S-COA-5's flow).
4. Fill the as-built's evidence row, delete this file, report "ready to merge".

## Worktrees this slice made
- `../architect-mc-coA` (the branch), `../architect-mc-coA-kit` (the kit half, merged; can go), `../architect-mc-coA-base` (detached
  origin/main a6a947bc, the byte-identity base: keep), `../architect-mc-coA-v0410` (detached v0.41.0, the api-compat jars: can go).
