# HANDOFF: slice KC (parts keep clear of fluid bodies), patch v0.39.1

Branch `slice/KC`, worktree `../architect-mc-KC`, over main 773eae51 plus `fix/relief-flow` (merged in). Ports 8912-8917, run dirs
`../architect-mc-KC-run[-s2|-s3]`, gate out `../architect-mc/artifacts/gate-runs-KC/`, KC evidence `artifacts/gate6c-kc/`. Scratch in
`scratchpad/kc-build/` (git-excluded). $0.

## Done (committed)

- `M25:clear` (`checkFluids.mjs` `clearScan`, `clearExempt`), `shellCheck`'s owner unknown, `metrics.M25.clear`.
- The plan-time backstop (`region/plan.mjs`, `ctx.clearRefuse`, compile.mjs refuses before resolve): a plan part writing a body's cells
  is refused OVERLAP {kind: body}; a wall in a course's sets refuses the course UNREACHABLE {kind: wall}.
- The registry `kit/lib/fluids/keep.mjs`; `footprint(res)` on pond, fountain (with its apron), waterfall, moat, quay, ditch; compile.mjs
  reserves at resolve, registers at emit, releases on rollback or refusal, rides checkpoint/rollback.
- Writers: walls (`OB.BODY`, `bodyBlame`, wouldFit), farm ponds (walls, props, footprints), lamps (`keptSkipped`), tunnels (buffer),
  routes (H bodies' spill as shell), courses (backstop), the broken variants (`wallThroughBody`, `lampOnRim`, `slabInWatch`,
  `ownerUnknown`).
- Fixtures `kc/` k01-k08, k07b, v61, u01-u04, asks-before/after.md; v51's ring repaired to [4, 17]. `kit/test/kc.test.mjs` 16/0.
- Byte identity: every committed fixture identical to the merge base but v51; watch count 1 (v51). Kit suite 632/0, mod 713/0,
  sidecar check pass. api-compat --gate6ckc 4/4 (v0.39.0 jars built into `artifacts/gate6c-kc/v0390`).
- Versions: mod 0.39.1, kit 0.37.1, goldens re-cut.

## Next

1. `kc-ingame` alone (`--only kc-ingame`), then the slice tier on 3 shards.
2. gate-verifier over origin/main..HEAD, re-running kc-ingame (items 4 and 5) and the clear/undo items.
3. Write "KC as built" in CONTRACT.md, delete this file, push.
