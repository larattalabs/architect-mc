# HANDOFF-X: slice X, region consumer asks C19 and C20 (API 1.15.0, mod 0.18.0)

Contract: docs/CONTRACT.md "Phase 6c slice X" (FROZEN) and its "Changes from Steward's review of X" (plan ext only, NO
`RealiseRequest.lotExt`). Branch `slice/X`, worktree `../architect-mc-X`. Ports 8912-8917 only. Spend $0.
Baseline 0.16.0 built from tag v0.16.0 in `../architect-mc-X-v0160`.

## State

- [ ] baseline archived: artifacts/gate6c-x/v0160 (in the main checkout)
- [ ] kit: `lots[].ext` (validateLots, village.mjs), tests
- [ ] mod: RegionPlanRequest/RealiseRequest opKey, Regions.planByKey/realiseByKey, plan + realise idempotence, lot ext on sites
- [ ] API 1.15.0, mod 0.18.0, features, Api115Test
- [ ] DevBridge hooks + tools/gate6cx.mjs + gate-chains + api-compat --gate6cx
- [ ] change tier, slice tier, gate-verifier, as-built, retire this file

## Decisions
