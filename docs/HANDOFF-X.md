# HANDOFF-X: slice X, region consumer asks C19 and C20 (API 1.15.0, mod 0.18.0)

Contract: docs/CONTRACT.md "Phase 6c slice X" (FROZEN) and its "Changes from Steward's review of X" (plan ext only, NO
`RealiseRequest.lotExt`). Branch `slice/X`, worktree `../architect-mc-X`. Ports 8912-8917 only. Spend $0.
Baseline 0.16.0 built from tag v0.16.0 in `../architect-mc-X-v0160`.

## State

- [x] baseline archived: artifacts/gate6c-x/v0160 (in the main checkout; apitest + mod jar built from tag v0.16.0 in ../architect-mc-X-v0160, tools copied)
- [x] kit: `lots[].ext` (validateLots, village.mjs), tests
- [x] mod: RegionPlanRequest/RealiseRequest opKey, Regions.planByKey/realiseByKey, plan + realise idempotence, lot ext on sites
- [x] API 1.15.0, mod 0.18.0, features, Api115Test
- [x] DevBridge hooks (written; in game untested until x-ingame runs) + tools/gate6cx.mjs + gate-chains + api-compat --gate6cx
- [ ] change tier, slice tier, gate-verifier, as-built, retire this file

## Decisions

- Run worktree `../architect-mc-X-run` (detached; cloned .gradle-home, sidecar/node_modules, mod/run from the seed). Client ports
  8912 (sidecar) / 8913 (DevBridge). `node tools/gate6cx.mjs start|base|lotext|keys|apicompat|stop|report`.
- Site ext gets the caller's keys only (not `architect_mc:village`, which stays on the LotSpec). "Redo" of a region = a new realise
  of the same plan (the engine has no region redo). Unknown-lot FIELD_LIMIT is moot without lotExt.
- No KIT_VERSION bump (IR unchanged for plans without ext); decide at the end whether W's 0.17.0 and this need aligning.
- Registry: PLAN_KEYS (loaded from plans/<id>.key.json at world start), REALISE_KEYS (in flight), RegionRec.opKey/opHash.
- Hold hook `dev.region.holdRealise` keeps a keyed realise future pending after its record is saved (gate item 3).
