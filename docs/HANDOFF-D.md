# HANDOFF: slice D (districts), D1 then D2

Builder's resume notes (AGENTS.md: keep current; delete when the gate passes). Placeholders: API 1.26.0, mod 0.29.0, kit 0.28.0
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
- [ ] kit tests (property, bands, connectivity, loopiness, determinism, beside join)
- [ ] plan/0 catalogue flip + compile
- [ ] mod API + beside
- [ ] sidecar plumbing
- [ ] gate driver, scenario, golden; slice run; verifier; as-built; push

## Decisions so far

- Districts placed by V's layoutStreet in the candidate rect (S3 has no flat areas at the contract's example sizes; V's rules
  place lots in 32x32 and 40x40 rects at all three bands, so no loosening of V was needed).
- `near` is placed in phases (a district after the districts it is near; its cost the distance to them): Hungarian is exact per
  phase. Overlapping candidates: best-first branch and bound over the Hungarian solutions (512 nodes, then greedy, recorded).
- Pair costs: dry runs of the pure route pass per pair (the 2x2 street ends, nearest first, capped at 1M expansions each).
