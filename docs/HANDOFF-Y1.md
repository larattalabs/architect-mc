# HANDOFF: slice Y1 (C24 settlement stockpile)

Branch `slice/Y1`, worktree `../architect-mc-Y1`. API 1.18.0 / mod 0.21.0 (provisional: next free minor at merge). Ports 8930-8935.
Contract: docs/CONTRACT.md "Phase 6c slice Y" (FROZEN), its Steward changes and coordinator decisions win. Y2 (C25, C26) is parallel.

## State

- [x] 0.17.0 baseline from tag v0.17.0: `artifacts/gate6c-y1/v0170/` (mod + apitest jars).
- [x] Pure: `survival/StockLedger` (identity, capacity in stacks, credit once per key, adopt), `site/FeedOrder` (default order,
      setFront, reservations); `StockpileTest` 9, `FeedOrderTest` 6.
- [x] `site/Stockpiles`: registry, `stockpiles.json` (BEFORE_SAVE + crate/order changes), crates with own journal entries,
      owner feed loop, accept, withdraw, adopt, dissolve, removeCrate, credit once.
- [x] Builder/RoadBuilder: purse, fed targets skipped by the legacy ticks, stockpile conversion, deconstruct/road/delta refunds
      credited with keys; Groups persists `credit` per member and credits after the member's restore.
- [x] API 1.18.0: Stockpile, StockpileRequest, SiteWait, ItemCount (Y2's types, as frozen; `waiting` empty), Sites methods,
      STOCKPILE_CHANGED, Limits.STOCKPILE_CRATES, feature `stockpile`.
- [x] DevBridge hooks, `/architect stockpile`, crate screen take buttons, apitest commands.
- [x] `tools/gate6cy.mjs` + gate-chains steps (y-unit, y-ingame) + impact rule (adds 5b-chains, x-ingame).
- [x] Focused items all pass on the manual client (8930/8931): unit, store, order, unloaded, refunds, overflow, once, restart a/b/kill/c,
      gone, dissolve, migrate a-d, apicompat 4/4. 0c survroad on this build passes (`artifacts/gate6c-y1/c0c/`).
- [x] Merged origin/main d68e756 (gate policy tooling); as-built drafted in CONTRACT.
- [ ] gate3 survival + hardcore on a p3 client (8934/8935) - running.
- [ ] Slice tier (`artifacts/gate-runs-Y1/`, 2 shards 8930-8933, waits for a machine slot) - launched.
- [ ] gate-verifier (re-runs items 4, 5, 7, 8 itself), finalize as-built, retire this file, push.

## Decisions (record in as-built)

- Stockpile target = a construction (site or road) whose owner has a stockpile and whose `Construction.crate` is null. No new
  record field; a downgrade sees "crate missing".
- Credit keys: `site:<id>@<placedAt>` (any removal path), `road:<id>@<placedAt>`, `delta:<entry>:<site>`. The contract's
  "(removal id, site id)": there is no removal id for a single remove; the placement is unique and survives C22/C23 resumes.
- Adoption books the crate's delivered into `delivered` and its placed into `consumed` (stock grows by exactly the crate's
  stock); overflow is booked `dropped`. Reading §5 literally (`returned` + delivered added) breaks the identity.
- blocksPerTick stays per target; the shared 4d budget is the placement time budget, spent in feed order.
- The dissolve gate item's "reports waiting" is C25 (Y2): Y1 asserts building, not paused, no stockpile, nothing placed.
