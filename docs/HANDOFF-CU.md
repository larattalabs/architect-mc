# HANDOFF: slice CU (copper weathering and undo)

Resume notes for `slice/CU` (worktree `../architect-mc-CU`). Contract: `docs/CONTRACT.md` "Phase 6c slice CU" (on
`origin/docs/batch-kc` until the batch docs land). Placeholders: API 1.37.0, mod 0.40.0, kit unchanged.

## Ports, dirs

- Runner ports 8960-8965 (`--ports 8960:8961,8962:8963,8964:8965`), run dirs `../architect-mc-CU-run[-s2,-s3]`,
  out `../architect-mc/artifacts/gate-runs-CU`, lock there.
- Driver: `tools/gate6ccu.mjs` (steps unit, measure, ingame, survival); chain steps cu-unit, cu-measure, cu-ingame, cu-survival.
- Evidence: `artifacts/gate6c-cu/` under each run's out dir; scratch under `scratchpad/cu/`.

## State

1. Commit A (tooling, no fix): `kit/regions/cu_demo.mjs`, `SliceCuDev` (`dev.copper.use`), the driver and chain steps, and
   VOC's drift probe now saving its cell list (`vocb-v50n-drift-remove.json`). Item 1 is measured on this commit.
2. Next: the fix (`journal/Copper.java`, `StillOurs`, `WorldJournal.holds`, `Builder.Run.matches` and the refund, `RoadBuilder`,
   `Sites.evidence`, farmland), `CopperTest`, `ApiCuTest`, API 1.37.0 + `weatheringOurs`, then the slice tier.
