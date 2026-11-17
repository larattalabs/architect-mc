# Process history: superseded rule text

Moved here from AGENTS.md and docs/GATES.md on 2026-11-16 (slice DOCS), when the speed rules were consolidated into one current
set (docs/GATES.md "Speed rules"). Nothing here is in force: where it differs from AGENTS.md or docs/GATES.md, those win. It is
kept so that old references, Noah's dated decisions and the reasoning behind them can still be read. The text below is as it stood
at b6338876 (release/v0.76.0), unedited, with one note: rules 17-24 there say "2026-11-17"; Noah decided them on 2026-11-16.

## 1. GATES.md "Speed rules (Noah, 2026-11-13)": the dated list of rules 1-24

Noah via parent session, 2026-11-13 20:30 MST: "yes, apply all of those". They apply to running slices and new ones, on both mods,
and replace stricter habits where they differ (the DEV MODE section below still holds otherwise).

1. **Risk tiers.** *Strict:* save data and persistence, billing, refunds and stock, undo and revert, crash recovery and reconcile,
   anything that can mint or lose items: the strict gate-verifier (re-runs on its own ports) and, where the rules ask, the GPT review.
   *Light:* everything else (UI, wording, tooling and gate infra, docs, fixtures, $0 prompts): units plus one targeted in-game flow,
   no independent verifier, no GPT review; a design-critic look only for new screens. The coordinator picks the tier in the brief.
2. **Failing steps only.** After a gate failure, fix and re-run only the failing steps (`--only`); the full gate runs once at the
   end, before the report. At most 3 full runs per slice; a 4th needs the coordinator's decision.
3. **Batched merges.** The coordinator merges 2-4 ready slices together and runs the merge suite once on the combined result; if it
   fails, bisect by slice.
4. **Module re-certification** (Steward's measured modules) at an Architect pin only when the module's code changes or the Architect
   build, billing or realise paths it uses change; a plain version bump gets a smoke check (one field round plus the billing check).
5. **Gate capacity.** 4 concurrent in-game gate runs (`slots.max` 4); unit suites (kit, sidecar, Gradle) under `nice -n 10`; no two
   in-game runs start within 5 minutes of each other (`slots.load.settleSec` 300); docs, kit-only and unit-only work takes no slot.
   The nightly blackout and nightly rules are unchanged.
7. **Short as-builts.** A slice's as-built and its report are 10-15 lines: what changed, what ran and passed, the leftovers. The
   detail stays in the commits.
8. **Scoped unit suites per slice** (Noah via parent session, 2026-11-13: "yes, send that to both managers/add to agent/claude
   docs"). A slice runs only the kit, sidecar and Java tests for the files it touched plus their direct dependents; the full kit,
   sidecar and Gradle suites run once, at the batch merge. A slice that touches shared core (the checker core, the journal or
   ledger, the build pipeline) runs the full suite. *Tooling:* `node tools/unit-scope.mjs --run` ("Scoped unit suites" below).
9. **Timing benches are report-only** (same decision). Benches such as the forms-island evaluation cost move out of the pass/fail
   suites into a report step that records the number and the load; past its bound a bench flags, it does not fail the slice. The
   nightly keeps tracking them (`tools/lib/bench-report.mjs`, below).
10. **Load-gate bounds** (Noah via parent session, 2026-11-13: "lets ensure that is 15 min max from now on, with high at least 72
   cap"). `slots.load.maxWaitMin` stays at 15 or less and `slots.load.max1` at 72 or more (0, `--no-load-wait`, stays allowed).
   Raising max1 or shortening the wait is fine; anything outside needs Noah. `loadConfig` (tools/lib/turbo.mjs) clamps a config or
   env override (`GATE_LOAD_MAX`, `GATE_LOAD_WAIT_MAX_MIN`) outside the bounds, with a warning; the nightly runs through gate-run, so
   the same bounds hold there.
11. **Deferred verification** (Noah via parent session, 2026-11-15: "Yes, apply all"). Overrides rules 1-4 where they conflict.
   1. **Light tier: no in-game run per slice.** Compile, the scoped unit tests (rule 8) and gitleaks; the slice joins the next batch,
      whose in-game run covers it.
   2. **Strict tier: targeted scenario only.** Only the in-game scenarios for the risk the slice touches (its item-loss, billing,
      refund, undo or crash case); no full gate of its own; the batch merge runs the full gate.
   3. **Bigger batches.** The coordinator merges 4-6 ready slices together with one full merge suite on the combined result; on a
      failure, bisect by slice.
   4. **Fewer releases.** A release every 2 batches, with one full release gate and the gate-verifier (`--no-cache`).
   5. **Verifier and GPT review per release.** The strict gate-verifier and the GPT review run once per release over all the strict
      diffs it contains, not once per slice.
   6. **Steward pins skip versions.** The Architect pin moves every other release; at the others, a smoke check (one field round plus
      billing), unless the module's own code or Architect's realise or billing paths changed.
   Unchanged: the targeted strict scenario on every strict slice, scoped units, gitleaks, the 3-full-runs cap, $0 without Noah's
   approval, slices never merge or push main. Nightlies stay skipped until Noah says otherwise.

12. **Gate capacity, raised** (Noah via parent session, 2026-11-15: "More gate slots + ports"). `slots.max` 6 and
   `slots.load.settleSec` 120 (`gate-chains.json`; rule 5's 4 and 300 are replaced); rule 10's load bounds stay. A second slice port
   range **9000-9099** in 6-port blocks (base, base+2, base+4) beside 8896-8939; **9100-9149 is Steward's**. The turbo range and
   the infra ports are unchanged. The coordinator still assigns every block (Ports, below).
13. **Standing approvals** (same decision, "Standing approvals"). Go ahead and send the parent session a one-line note: a paid step
   under $1 inside an already-approved budget (with its cost); a product question with a confident recommendation. Still ask Noah
   first: anything irreversible, anything that changes what a player loses or pays, a new public surface, new budgets or raised
   caps, any step over $1.
14. **More parallel slices** (same decision). Keep 6-8 slices in progress at once as files and ports allow, and pre-brief the next
   ones so a free slot never sits empty. Rule 11's once-per-release strict verifier and GPT review are unchanged.

15. **Review per strict slice** (Noah via parent session, 2026-11-16: "Review per strict slice"; he did not pick auto-dropping a
   failed slice). As soon as a strict slice is built and its targeted strict scenarios pass, the coordinator runs that slice's own GPT
   review in the background, on its diff only (`codex exec ... -s read-only`, the second-opinion skill's framing), while other work
   goes on. Its P1 findings are fixed (one fix-verification pass) before the slice joins a batch. Rule 11's per-release GPT review
   stays: this adds a check and removes none. Light slices get none.
16. (Overnight delegation, 2026-11-16: ended with Noah's wrap-up.)
17. **Persist before mutate** (Noah via parent session, 2026-11-17, rules 17-24). No world, stockpile or in-memory change that
   affects items, billing or refunds happens before a durable, *confirmed* record of it. Executor completion or a queued save is not
   persistence. Once TXN lands, use the transaction layer (docs/TXN-DESIGN.md).
18. **Crash points and conservation in every strict slice.** Inject a crash at each save point of the operation and assert
   conservation (stockpile + world + ledger balance; items in == items out) after every strict scenario, failing-first. Once TXN's
   harness exists, use it.
19. **Verify review premises in code.** Before recommending a design built on a reviewer's framing (e.g. "legacy crates"), check
   the claim against the code.
20. **The review-round guard.** After a NOT SAFE GPT review: one fix round, then one final GPT pass. If that still finds a P1, the
   slice goes to Noah via the parent: no further rounds, and no dropping it from a release without his OK.
21. (Spending: pending Noah's direct confirmation; until then the spend rules above stand.)
22. **Review sheets for Noah are one self-contained HTML file**, images inlined as data URIs (JPEG if large;
   `tools/sheet-inline.mjs`).
23. **Each slice keeps its run scripts and temp files in its own worktree**, never a shared scratchpad path.
24. **Gate build caches are refreshed** in every gate worktree whenever lab-ui or a pinned dependency changes.

(Rule 6, stall checks every ~25 minutes, is the parent session's.) Unchanged: the strict tier for survival billing and crash safety,

## 2. GATES.md "DEV MODE (Noah, 2026-10-24)" before the consolidation

These override the tier, verifier and RC rules below for as long as dev mode is on.

**A slice merges when these pass:**
- unit tests;
- the instant lints (lint-structure, lint-look, water-lint, p3-lint; since slice SP p3-lint's two classes run inside unit-mod, which supersedes it);
- the slice's OWN in-game steps.
No regression suite, impact steps or before/after comparison runs per slice. Use `gate-run change --only <the slice's own steps>`.

**The gate-verifier is review only.** It reads the diff and the evidence. It re-runs checks only when the slice touches undo,
the journal, removal, crash recovery or survival accounting. Those stay strict, because they lose a player's work.

**A Steward RC runs on every release** (practice since v0.60; its areas follow what changed, so a release that leaves the API Steward
calls alone gets a smaller set). Steward's pin and smoke rules decide its depth (speed rule 4).

**Galleries only for slices whose point is the look.** Noah glances; the merge doesn't wait. Look fixes are follow-ups.

**Releases are cheap tags,** cut whenever Steward needs something or every day or two. No release-tier run before a tag.

**The full set runs nightly** (tools/nightly.mjs). Whatever it finds is fixed forward the next morning.

**Test-tooling slices are allowed** (GX, TS, SP and the load-aware start were all such slices) when they save more wall time than
they cost; the coordinator briefs them and picks the tier (tooling is light, speed rule 1).

**Keep the machine for product:**
- at most 4 gate runs on the machine at once (`slots.max` 4, below; the one number every doc and brief uses; Noah's speed rules, 2026-11-13);
- no duplicate before/after runs: compare against recorded history instead;
- commit before running (the runner tests a frozen snapshot).

**To return to release mode:** Noah says so. Then the full tiers and verifier re-runs come back (Steward RCs already run every release).

## 3. GATES.md "Policy update (Noah, 2026-10-12)": items 3-6 before the consolidation

3. **The gate-verifier reviews the diff and the evidence; it does not re-run.** Exception: undo, journal, removal and
   survival-accounting code, where it re-runs those specific items (that is where review found C23's defect).
4. **Release first, Steward checks after.** A slice merges and releases without a pre-release Steward RC check; Steward checks
   the published version and anything found becomes a patch. Exception: a slice changing behaviour Steward relies on (removal,
   world stop, accounting) gets the RC check first.
5. **Batch releases.** Merge 2-3 slices, then one release tier, one tag and one publish. API and mod versions are assigned at
   merge (next free minor), so branches never renumber; builders use a placeholder until the coordinator sets it.
6. **At most 3 gate runs on the machine at once** (a machine-wide slot lock in the runner); more only causes load failures.
   *Implemented:* see "Slot lock" below. (Raised to 4 on 10-17, set back to `slots.max` 3 on 2026-11-13 so the tool, AGENTS.md and every brief agree, then raised to 4 by Noah's speed rules the same evening; a run's shard count now follows the machine's load,
   "Adaptive shards".)

## 4. GATES.md "Lighter verification (gate-verifier guidance)" before the consolidation

The runner never calls Claude. The independent gate-verifier is launched by the agent, after the run, on its evidence.

- **Per change:** no verifier. The `change` run's SUMMARY.md is the record.
- **Per slice:** the gate-verifier **reviews**, it does not reproduce:
  1. the diff (`git diff <base>...HEAD`) against the slice contract;
  2. the runner's `SUMMARY.md`, `summary.json` (tier, impact, unmapped paths, every step's status and key numbers) and the evidence
     of the steps that matter (gate JSONs under `gate4e/`, `gate6a/`, ...), checking that the run's head is the slice head and
     that the selection covered the diff;
  3. then it **re-runs only the risky steps**: anything touching the journal, the undo or survival, plus the steps for whatever the
     diff touches that the verifier judges risky (`node tools/gate-run.mjs change --only <steps> --no-cache ...` on its own ports: `--no-cache`, since an explicit list looks up
     its steps from slice GX on, and a re-run must run).
- **Per release:** full reproduction. The `release` run, then the full independent gate-verifier, which reproduces the gates
  itself (every bar, every step, not only the runner's word).


## 5. AGENTS.md: the DEV MODE summary and the dated process bullets before the consolidation


**DEV MODE is on (Noah, 2026-10-24).** Gates are lighter until Noah says otherwise. Read docs/GATES.md "DEV MODE" before you
gate anything:
- a slice merges on its unit tests, the instant lints and its own in-game steps;
- the verifier only reviews, except for undo, the journal, crash recovery and survival accounting;
- **speed rules (Noah, 2026-11-13; docs/GATES.md "Speed rules"):** strict vs light tier, re-run only failing steps, 3 full runs
  per slice, batched merges, 4 gate runs, `nice -n 10` unit suites, 5 min between in-game starts, 10-15 line as-builts;
  scoped unit suites per slice (files touched + direct dependents; full suites at the batch merge, or when touching shared core:
  the checker core, the journal or ledger, the build pipeline); timing benches report-only (they flag, never fail a slice);
  the load gate keeps max1 >= 72 and maxWaitMin <= 15 (rule 10; the runner clamps overrides);
- **rules 17-20, 22-24 (Noah, 2026-11-17; docs/GATES.md "Speed rules"):** persist before mutate (a confirmed durable record before
  any item, billing or refund change; executor completion is not persistence; TXN once it lands); crash points at each save plus a
  conservation assertion after every strict scenario, failing-first; verify review premises in code; review guard (one fix round,
  one final GPT pass, then Noah; no auto-drop); self-contained HTML review sheets; run scripts and temp files in the slice's own
  worktree; refresh gate build caches when lab-ui or a pinned dependency changes;
- a Steward RC runs on every release (its areas follow what changed);
- test-tooling slices (GX, TS) are allowed when they save more wall time than they cost; the coordinator briefs them;

  Slices may run **in parallel** on separate worktrees and ports; merge `origin/main` into your branch when another slice lands.
- **Gate policy (Noah, 2026-10-12; docs/GATES.md "Policy update"):** timing bars never block a slice (recorded; judged once
  per batch at release); `slice` is the units, api-compat, the impact steps and the slice's own items, not the full regression;
  the verifier reviews and re-runs only undo, journal, removal or accounting items (with `--no-cache`: since slice GX an `--only`
  list reuses unchanged PASSes, docs/GATES.md "Slice GX as built"); at most 6 gate runs at once (`slots.max` 6, speed rule 12; ports 8896-8939 and 9000-9099 by the coordinator; docs/GATES.md "Slot lock", "Speed rules").

- **CI runners and benches:** release-tier benches may ask the coordinator to pause Noah's CI runners (the LaunchAgents
  `com.laratta.ci-container-autoscale` and `com.laratta.tart-yardpaint-runner`). Noah allowed this when needed. Never pause
  them yourself.
- **Keep the API binary compatible:** keep old record constructors, add new methods as defaults that throw, and append enum
  values at the end. Check with `node tools/api-compat.mjs --baselines` (main's latest three releases from `tools/api-baselines.json`,
  the newest mod jar's surface and Steward's real jar; docs/GATES.md "API compatibility baselines").

## Build and test

## 6. CLAUDE.md: the verifier and speed-rule bullets before the consolidation

- Gate checks are verified by an independent `gate-verifier` agent, never by the builder itself. Per slice it reviews the
  diff plus the runner's evidence and re-runs only the risky steps (`gate-run.mjs change --only <steps> --no-cache`: an explicit
  list looks up the cache since slice GX, and a re-run must run); at release it reproduces everything.
- Speed rules (Noah, 2026-11-13; docs/GATES.md "Speed rules"): pick the tier the brief names; re-run only failing steps; run
  only the unit tests for the files you touched plus their direct dependents (full suites at the batch merge, or when you touch
  the checker core, journal/ledger or build pipeline); timing benches flag, they don't fail; as-builts 10-15 lines.
