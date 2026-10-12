# HANDOFF: slice Y1 (C24 settlement stockpile), paused 2026-10-12 by Noah's stop

Branch `slice/Y1` (worktree `../architect-mc-Y1`), pushed. Versions: placeholder API 1.18.0 / mod 0.21.0. The coordinator assigns the
real numbers at merge, expected 1.17.0 or later. The placeholder appears in `ArchitectApi.VERSION`, `mod_version`, `tools/apitest.mjs`'s
`API_VERSION`, the "Since 1.18.0" javadoc and default-method messages, and Api118Test. Ports 8930-8935. $0.

## Done

- C24 built: `site/Stockpiles`, `site/FeedOrder`, `survival/StockLedger`, the builder purse, refunds credited once, adoption, dissolve,
  API 1.18.0 surface, the screen, the hooks and `tools/gate6cy.mjs`. CONTRACT "Phase 6c slice Y1 as built" records the design and its
  deviations.
- Merged origin/main at v0.18.0 (W, Y2, C23).
  - Y2's `SiteWait`/`ItemCount` are kept; my copies were dropped.
  - The C25 hooks (`SiteWaits.observe`) are in the purse step.
  - The stockpile feeds `SiteWaits.source` (stock - reserved at the target's feed position).
  - `Stockpile.waiting` is filled.
  - A dissolved stockpile's targets report STARVED, so they wait.
- Coordinator constraint done: stockpiles are keyed by their own id (`sp<n>`, `nextId` in `stockpiles.json`) and the owner is an
  attribute.
  - Crates and journal entries carry `stockpile:<id>`.
  - `Sites.stockpile(owner)` still looks up by owner.
  - Dev hooks accept `stockpile:<id>` or `stockpile:<owner>`.
- Evidence at the merged head (2128f6c) on the manual client, 8934/8935:
  - restart a/b/kill/c pass;
  - migrate b passes;
  - dissolve passes, including "reports waiting";
  - api-compat 4/4 against the 0.18.0 and 0.17.0 apitest jars (both built from their tags into `artifacts/gate6c-y1/v0180`, `v0170`), the 0.16.0 jar, and the 0.18.0 surface.
- Slice tier at 2128f6c (`artifacts/gate-runs-Y1/20261012-051529-slice`), stopped at Noah's pause:
  - PASS: unit-mod, unit-kit, sim-jobs/-sets/-massing, apijars, x-ingame 53/0, y-unit, y-ingame 103/0 (with the new C25 checks),
    x-resume 46/0, 4d-all (2 timing bars recorded), 4e-orders, 5b-village, 6b-pathstyle.
  - FAIL unit-sidecar: two timeouts under load (`versions.test.ts` beforeAll 60 s; bundle e2e "exits when the parent pid is gone").
    No sidecar code changed.
  - FAIL 5b-chains: "DevBridge connection closed" at seed4 after 63 ok. Cause not yet read: look at `client-s2.log` and `5b-chains.log`.
  - 4e-megalite was skipped by the stop.
- Earlier, at 49cdcd2 (pre-merge): slice tier green after the sim version fix, and the gate-verifier PASSed, re-running items 4, 5, 7 and 8.

## Left

1. Re-run unit-sidecar, 5b-chains, 4e-megalite, and Y2's y2-unit and y2-ingame (not in the Y1 impact; C25 is now fed by the
   stockpile) at the head: `gate-run change --only ...`, ports 8930:8931, `--run-dir ../architect-mc-Y1-gate`.
2. Optionally re-run the remaining manual steps at the head: migrate a/d (needs `GATE6CY_REF=v0.17.0 start`), order, unloaded,
   refunds, overflow, once and gone. y-ingame covered most of these at 2128f6c.
3. Get a fresh gate-verifier review of the post-merge diff: the C25 wiring and id keying. Re-run accounting items 4, 5, 7 and 8.
4. Update CONTRACT as-built:
   - the id keying;
   - the C25 wiring (Stockpile.waiting, the dissolve wait);
   - the new api-compat baselines;
   - the final tier.
5. Retire this file, push, and report ready to merge. Y1 gets a Steward RC check before release (coordinator).

## Open

- Verifier's minor notes, to Later:
  - `Groups.credit` skips a credit when both dimensions are unloaded;
  - a single road removal credits before its restore (a retry is keyed);
  - a road credited by `beforeRemove` is missing from a group's `RemoveResult.refund`.
- Legacy construction sites keep their chunks loaded forever: the per-tick `getBlockState` renews an UNKNOWN ticket. Only stockpile
  targets were changed; a later slice should decide on the legacy behaviour.
