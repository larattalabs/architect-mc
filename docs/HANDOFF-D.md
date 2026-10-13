# HANDOFF: slice D (districts), D1 then D2

Builder's resume notes (AGENTS.md: keep current; delete when the gate passes). Placeholders: API 1.27.0, mod 0.30.0, kit 0.28.0
(the coordinator assigns at merge). Ports 8912-8917. Worktree `../architect-mc-D`, branch `slice/D1` (then `slice/D2`).
Tag build for apijars/api-compat: `~/Developer/LarattaLabs/architect-mc/artifacts/gate6c-d/v0270` (built from tag v0.27.0 with its
tools/, in the throwaway worktree `../architect-mc-D-v0270`).

## D1 plan (CONTRACT "Phase 6c slice D" §1-§4, S-D-1, S-D-2)

1. Kit: `kit/lib/region/passes/districts.mjs` (pure: bands, candidates, Hungarian + overlap branch and bound, greedy, Kruskal +
   loops), `kit/lib/region/districtsEmit.mjs` (r.pass('districts'): V street layouts per district, dry route costs, MST + loops,
   the beside join, one route pass, link edges, the external join edge, lamps), programs `districts` and `districts_demo`.
   ctx.beside (planRegion `beside`, CLI `--beside`, IR `beside: {id, sha}` only when read).
2. plan/0: `program.districts` and `endpoint.region` reserved -> supported (catalogue, compile in plan_v0, fixtures).
3. Mod: API `RegionPlanRequest.beside`, `RegionView.beside` (trailing), features `districtsPass`, `besideRegion`; the beside claim
   check (seam <= 16, never over the standing lots, roads or paths: OVERLAP), the standing region's data to the sidecar, the
   record, the dangling-join note when the standing region goes first.
4. Sidecar: region.plan `beside` -> beside.json -> `--beside`.
5. Gate: `tools/gate6cd.mjs` (unit, ingame, scenario), gate-chains, golden `scenarios/goldens/districts_demo.json`.

## Status

- [x] tag build v0.27.0 archived
- [x] kit pure pass + emitter + programs; districts_demo plans on S3's golden survey: 3/3 districts in their bands, 2 tree
      edges routed, checker 0 errors, graph connected (~15 s)
- [x] kit tests (kit/test/districts-d.test.mjs: property 300 claims, bands, connectivity, loopiness, determinism, beside, plan/0)
- [x] plan/0 catalogue flip + compile (program.districts, endpoint.region)
- [x] mod API (placeholder) + beside (BesideCheck), dangling note
- [x] sidecar plumbing (beside)
- [x] gate driver tools/gate6cd.mjs, scenario districts_demo + golden; focused change run green but for 2 driver bugs (fixed)
- [x] origin/main v0.28.0 (C33) merged at 266eea2
- [x] origin/main v0.29.0 (PT2) merged at 6217d73, v0.29.1 (C34) at 86f8d0e (renumbered: API 1.27.0, mod 0.30.0)
- [x] slice run 20261013-213856-slice at 6217d73: 30 PASS before the Mac restart killed it (22:40); 4d-all failed once
      (one leaf_litter cell in L2 not restored, load ~50); 6a-eflat realise timed out
- [ ] rerun of the unfinished/failed steps with --only (20261013-224536-slice, fresh run dir ../architect-mc-D-run3)
- [ ] verifier -> as-built gate row (CONTRACT, inserted, uncommitted) -> push slice/D1
- D2: slice run 20261013-215418-slice at e1631ba killed by the restart (21 PASS; w-ingame's DevBridge closed at 22:38);
      rerun with --only on ports 8898-8903, run dir ../architect-mc-D2-run3

D2 is on `slice/D2` in `../architect-mc-D2` (from D1): C27 boundary districts, outposts, the biome grid (C28: 4x4 is enough),
plan/0 flips (zone.outpost, locator.along, feature.biome_edge, feature.ridge). The desert/jungle site must be found and pinned
(`tools/find-site.mjs desert_jungle_site`, a server of seed 2026100906 up) before `gate6cd.mjs boundary`.

## Decisions so far

- Districts placed by V's layoutStreet in the candidate rect (S3 has no flat areas at the contract's example sizes; V's rules
  place lots in 32x32 and 40x40 rects at all three bands, so no loosening of V was needed).
- `near` is placed in phases (a district after the districts it is near; its cost the distance to them): Hungarian is exact per
  phase. Overlapping candidates: best-first branch and bound over the Hungarian solutions (512 nodes, then greedy, recorded).
- Pair costs: dry runs of the pure route pass per pair (the 2x2 street ends, nearest first, capped at 1M expansions each).
