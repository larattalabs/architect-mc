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
   **Item 1 measured** (run `artifacts/gate-runs-CU/20261020-054332-change` at c25c11cc, lists copied to `scratchpad/cu/item1/`):
   - voc-natural's drift probe: 157/157 unwaxed hall cells weathered; after `Regions.remove` 147 cells differ from the snapshot,
     **0 of them inside the hall's lot box** (BOX entry: restored exactly). 124 grass_block->dirt, 5 dirt->grass, 8 small
     amethyst buds (all `growth`), 5 water + 4 lava flowed into air (`none`), 1 bee nest (`live`). The probe's "kept 137" was
     `inHall.length || growth`: inHall was 0, so it printed the growth count. Not copper.
   - cu_demo (CELL tiles): 55 copper cells, 28 unwaxed all ticked to oxidized; after `Regions.remove` kept 29 = the 28 weathered
     cells + the door's upper half, E-flat 29 (`none`). This is the real exposure.
   - voc-natural's first check failed on main's code too: E-normal 10 (9 air->water/lava `none`, 1 live), not CU's.
2. Next: the fix (`journal/Copper.java`, `StillOurs`, `WorldJournal.holds`, `Builder.Run.matches` and the refund, `RoadBuilder`,
   `Sites.evidence`, farmland), `CopperTest`, `ApiCuTest`, API 1.37.0 + `weatheringOurs`, then the slice tier.
