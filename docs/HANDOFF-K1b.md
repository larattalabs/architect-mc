# HANDOFF K1b: rope bridges and `connector.auto` (slice/K1b)

Contract: docs/CONTRACT.md "Phase 7a slice K1" (FROZEN; Steward's review and the coordinator decisions win). K1a (walls,
gates and the shared foundation) builds in parallel on `slice/K1a`; its foundation lands as `k1/foundation`.

- Worktree `../architect-mc-K1b`, branch `slice/K1b` off main 7f9dba35 (v0.32.0 / API 1.29.0 / kit 0.30.0 / catalogue 3).
- Placeholders: API 1.30.0, mod 0.33.0, kit 0.31.0 (the coordinator sets the real ones at merge).
- Ports 8918-8923. Run worktree `../architect-mc-K1b-run`.

## State

- [ ] villager half-slab probe in game (vanilla `dev.nav.villager`)
- [ ] rope geometry (`kit/lib/connectors/rope.mjs`): profile, gap, anchors, headroom, cells
- [ ] kit villager mover: half-slab steps
- [ ] `M10:rope`
- [ ] rope move in `route.mjs` (K1a's stub row)
- [ ] explicit `rope_bridge` connectors, `auto` connectors, `links` stage emission
- [ ] fixtures (v33, v34, refusals), `links_demo`, §9 rope rows
- [ ] gate driver, slice run, gate-verifier, look step, as-built

## Shared-file hooks (for the coordinator's merge)

(none yet)

## Asks for the coordinator (catalogue, schema, reason codes are K1a's)

(none yet)
