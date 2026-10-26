# Jobs & spend panel: design (read-only pass, 2026-10-25)

Line references are in the Evidence appendix at the end. Mock: `jobs-mock.html`, in the same folder.

## Data model
`JobEntry { id, mod, kind, title, parentId?, state, needsYou, needsWhat?, spentUsd, budgetUsd?, budgetKind, heldUntil, heldReason?, link, actions, createdAt, updatedAt, endedAt? }`
- `kind` is one of `design | massing | detail | set | bible | variant | import | settlement_build | talk | part_offer | change | update | proposal`.
- `state` is one of `queued | running | needs_you | held | paused_budget | done | failed | cancelled`.
- `budgetKind` is `job | set | build | allowance`.
- `heldUntil` is epoch ms, and 0 when nothing holds the job.
- `link` is `{mod, screen, ref}`.
- `actions` are `{open | approve | cancel | raise | retry, label, Runnable}`, supplied by the mod that published the row. The panel never decides anything itself. It shows the next publish, as Steward's `ClientInbox` already does. This matters because owner-approved groups refuse Architect's approve, so a settlement is approved through Steward's packet.
- **Rows and spend are separate.**
  - Rows: a job owned by `steward_mc:settlement/<id>` sits under that settlement's build row while a build runs. Otherwise talk, part offers and change requests are their own Steward rows.
  - Spend: Architect also publishes a cost ledger, one `{objectId, owner, usd}` per distinct sidecar object (group, ungrouped design, bible job, protocol-2 job).
  - Totals are summed from the ledger, split by owner namespace. Row figures only attribute cost, so nothing counts twice or goes missing.

## Where it lives: a lab-ui client registry, no API between the mods (recommended)
- **lab-ui 0.4.0** adds `client.jobs.JobBoard`:
  - `publish(mod, rows)` and `publishLedger(...)`;
  - `JobsScreen`, a shared needs-you pill in the `TOP_LEFT` HUD zone;
  - a pure `JobBoardModel` (grouping, filters, totals) with tests;
  - an idempotent `install()` that registers the key once when both mods call it, like `Toasts.install()`.
- **Architect** publishes from a `SidecarState` listener through a new `JobFeed`, extracted from `ArchitectScreen.jobs()`.
- **Steward** publishes from `ClientInbox.set`.
- **Why this option:**
  - Both truths are already on the host's client. Architect's sidecar runs there, and there are no jobs on a dedicated server. Steward's inbox arrives there, and only the host may direct the steward.
  - An Architect API for jobs would make Architect interpret Steward's pipeline. It would also add a hop that the client-side jobs don't need.
  - Doing both would give two paths that can disagree.
- `ArchitectApi` stays at 1.42.0.

## One source for "needs you" and spend
- Steward adds a pure, server-side `Attention.of(settlementId)` that returns `{needsYou, needsWhat, held, heldUntil, spentUsd, budgetUsd, line}`. It covers the pipeline, updates, proposals and offers, and it stays in Steward, because a server path should not depend on a client library. Three things embed it:
  - `InboxModel.entry`, which reaches the client inbox and then the panel;
  - `StewardStatus`, which reaches the nameplate through entity data every second;
  - `SettlementView`, which reaches the board through `SettlementSync` every 2 s when it changes.
- J2 also sends `SettlementNear` at once when `Attention` changes, so the board doesn't lag an approve by up to 2 s.
- `heldUntil` comes as a long from `usageLimitUntil`. It replaces the `HELD_LINE` prefix test.
- **Gate:** a unit test runs pipeline fixtures through `Attention` and asserts that the inbox, nameplate and board strings agree.
- Today they disagree. The board says "Being built" while massings wait, the nameplate ignores proposals and holds, and the HUD counts proposals. See the Evidence appendix.

## Panel UI
- **Opening it:**
  - **K**, which appears free in vanilla and in both mods (B/J and Y/I/U); confirm in the 26.3 defaults;
  - a "Jobs" button in Architect's header and in Steward's inbox and settlement screens;
  - "All jobs…" on the U3 strip;
  - from a toast: the hint reads `[K] see it`, and K opens the panel on that row. This needs an optional `ref` on `Toasts.Spec`.
- **Layout:**
  - **Header:** the ledger total ("estimate", or "plan usage" under claude login), the per-mod split and the allowance meter.
  - **Banner:** one account-wide usage-limit banner.
  - **Filters:** a `ChipRow` of All / Needs you / Running / Held / Ended, plus a group-by toggle (State or Mod).
  - **List:** a `ScrollList` with `CollapsibleSection` group heads, Needs you first. Each row shows a dot, the kind, the title, the step and spend against budget.
  - **Detail pane:** children, times and the error. Actions are Open, Approve, Raise, and Cancel through `Confirm`.
  - **Ended rows** move to a collapsed group after the inbox's `ENDED_ROW_MS`.
- **Architect's Designs tab is unchanged** (it was approved in U3). Only the panel feed applies the owner rule. The tab may tag such rows "owned by steward".

## Multiplayer and server versus client
- **Singleplayer or LAN host:** the panel is complete.
- **LAN guests and dedicated servers:** they have no sidecar, so the panel shows "Claude work runs in the host's game". Guests still see the nameplate and board. Both are computed on the server from `Attention`, so they agree with the host's panel.

## Changes, contract and versioning
- **lab-ui 0.4.0 (additive):** the classes above, plus `Toasts.Spec.ref`. Both mods move to `>=0.4.0 <0.5.0`. Steward is still on `<0.3.0`, so it skips a minor.
- **Architect:**
  - `JobFeed` and the ledger;
  - the header button and the strip link;
  - toast hints that say K.
  - CONTRACT.md gains a "Jobs panel" note: a spec's `owner` `<modid>:<thing>` decides which row a job sits under. There is no API bump.
- **Steward:**
  - `Attention`, and rewiring the inbox, `StewardStatus`, `SettlementView` and the board to read it;
  - `StewardHud` gives way to the shared pill;
  - talk, offer and change rows plus the allowance in `StewardNet.Inbox`, with a codec bump;
  - "Jobs" buttons, with Y kept as the deep inbox.

## Slices
- **J1 (M): lab-ui 0.4.0.** `JobBoard`, `JobsScreen`, the pill, the model and its tests, and `Toasts.Spec.ref`.
- **J2 (M): Steward `Attention`.** The agreement test and the immediate board resend. It runs in parallel with J1.
- **J3 (S): Architect.** `JobFeed`, the ledger, the button and the strip link.
- **J4 (S): Steward publishes.** Its rows and the allowance, and the move to lab-ui 0.4.
- **J5 (S): toast refs and gallery.** Toast refs in both mods, and nightly gallery shots of the panel states.

## Open questions for Noah
1. Should the panel sit beside Steward's Y inbox (my recommendation: Y stays the deep decision screen and K is the overview), or replace it?
2. Is K right for the panel key?
3. What should the spend total cover: this session, today, or the past 7 days (like the allowance)? Under claude login, should it show dollar estimates or "plan usage"?
4. Should a steward's proposal light the nameplate "!", or only the panel and HUD, so that "!" always means "blocked on you"?

---
## Evidence appendix
Paths: A = `architect-mc/mod/src`, S = `steward-mc/mod/src`, L = lab-ui at tag `v0.3.0` (local main is 9 behind).
- **Architect jobs.** Jobs live client-side in `A/client/.../sidecar/SidecarState.java:214-218`, with `Status.usageLimitUntil` at `:51-61`. "No sidecar link on a dedicated server": `A/main/.../apiimpl/JobsImpl.java:117-119`. Statuses include `held`: `api/Job.java:11`. Cost is an estimate, notional under claude login: `api/Cost.java:5`.
- **The Designs list and the U3 strip.** `ArchitectScreen.jobs()` (`A/client/.../screen/ArchitectScreen.java:1757-1814`) has no owner filter, so Steward's sets show there too. The strip is `JobStrip.java:23-75`. The held line and per-set spend are at `ArchitectScreen.java:2065-2072`. There is no session or day total anywhere.
- **Toasts and launcher.** Toasts carry a key hint only: `A/client/.../design/DesignFeature.java:319-357`, and `L/.../client/hud/Toasts.java` `Spec`. The launcher states are in `A/main/.../launcher/LauncherPlan.java:390`. Owner approval is described in CONTRACT.md around lines 1149 and 1182.
- **Steward's inbox entry.** `S/main/.../inbox/InboxModel.java:31-61` (the entry) and `:77-94` (how it is built). The held check is a string prefix: `HELD_LINE` at `:58-64`. `heldNote` is a formatted `Date`: `service/SettlementRunner.java:1706`. `sendInbox` is at `:1397-1408` and `busy` at `:172-176`.
- **Steward client.** `ClientInbox.set` is at `S/client/.../screen/ClientInbox.java:22-28`. The toasts are `inbox/InboxToasts.java:22-41`.
- **Disagreement today.** The HUD uses `Entry.waiting()`, which counts PROPOSAL and UPDATE rows: `client/hud/StewardHud.java:22`. The nameplate counts updates but neither proposals nor holds: `service/StewardStatus.java:16-40`, then `entity/StewardEntity.java:256-260` every 20 ticks. The board shows "Being built: see the inbox (Y)" whenever the settlement is busy: `client/world/BoardRenderer.java:93-96`. Its view is re-sent every 40 ticks, only when it changes: `service/SettlementSync.java:24-34`.
- **Spend outside a build's `spentUsd`.** Talk (`$0.05`): `gateway/TalkJob.java:21`, with the owner set at `service/Talk.java:102`. Part offers (`$1.00`): `service/PendingOffers.java:38,341`. Change requests: `service/ChangeRequests.java:155`. The weekly allowance: `model/Settlement.java:285-309`. The owner string: `model/Settlement.java:377`. Host-only direction: `service/Actions.java:78-84`.
- **Versions.** Steward's lab_ui range is `S/main/resources/fabric.mod.json:20` (`>=0.1.0 <0.3.0`). Architect's is `>=0.2.0 <0.4.0`, at API 1.42.0. The keys are Architect B/J (`A/client/.../hud/Keys.java:33-35`) and Steward Y/I/U (`S/client/.../hud/Keys.java:33-35`).
