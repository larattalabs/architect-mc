# Phase 6c slice 0a: working notes (handoff)

Spec: docs/CONTRACT.md "Phase 6c slice 0a: consumer support (FROZEN after Steward review)", with "Coordinator decisions
(2026-10-10)" and "Changes from Steward's review of 0a" winning. Branches (the coordinator's naming, not the contract's
`phase/6c-0a`): `slice/0a-stub` (C4, v0.12.2, API 1.9.0) in `../architect-mc-0a-stub`, then `slice/0a` (the rest, v0.13.0 /
API 1.10.0) in `../architect-mc-0a`, built on the stub. Ports 8900-8905 (0b has 8906-8911, 0c 8912-8917). Note: during the
stub work another session's integration gate held 8900/8901, so the stub runs used 8902/8903 (and 8904 for a bundle probe).
Merge (AGENTS.md, corrected): agents can't push to main; after the slice tier and a gate-verifier review, push the branch and
report "ready to merge"; the coordinator merges, tags and publishes.

## State

| Build step (§14) | State |
|---|---|
| 1. 0.12.0 apitest jar archived | done (below) |
| 2. 0.12.2: C4, client script, gate item 1 | gate passed, verifier PASS; merged and published as v0.12.2 by the coordinator |
| 3-6. Sidecar, kit, mod, gate for 0.13.0 | started on `slice/0a`: the 1.10.0 API surface only (below); no implementation yet |

## The 0.12.0 jars (build step 1)

Built from tag `v0.12.0` (e6691f1, merge commit ba6d02d) in a temporary worktree (sidecar bundled, `gradlew build -x test`),
removed afterwards. In the main checkout (gitignored `artifacts/`):

- `artifacts/gate6c0a/v0120/architect_apitest-0.12.0.jar` sha256 `e83512739870eb4c706299188ac95d8ba6e165432d662ee88390d5c8743de862`
- `artifacts/gate6c0a/v0120/architect_mc-0.12.0.jar` sha256 `13dbd4b5992d126f8ed784583472600d66c194c34e966f404b7a7c1e1d8bd520`
- `artifacts/gate6c0a/v0120/src/` (`git archive v0.12.0`) and `tools/` (`apitest.mjs`, `lib/`), as 6b's `v0110`.

## C4 (0.12.2) as built

- **Does sim need `npm ci`?** No. Checked on the 0.12.0 jar's bundle, extracted with no `node_modules`: `dist/main.mjs` imports
  only `node:` built-ins (ws and zod are bundled; the Agent SDK is loaded dynamically and reported `sdk: missing`), the kit
  and `region-worker.mjs` likewise. A bible, a massingFirst group with a redirect and approval, 3 details and a job ran to
  the end in 6 s. So the launcher skips the install under the sim: `LauncherPlan.needsInstall(backend)`, used in
  `Launcher.install()`. **Deviation:** this is a (non-API) mod change in a release the contract calls "sidecar and docs
  only"; §2 asks for the skip, and it can only live in the launcher.
- **simCosts:** config `simCosts` or env `ARCHITECT_SIM_COSTS` (env wins, as ARCHITECT_DESIGN_MODEL does); parsed only with
  `--backend sim`; a bad value is a ConfigError (the helper refuses to start) rather than a silent $0. Unset / "zero" keeps
  the old `simDesignUsd` / `simJobStepUsd` path unchanged. With costs: a massing round 1 costs `massing`, a detail pass or
  single design `detail` (spread over the 3 sim steps; `DesignWork.sim` {round, charged, repaired} makes a re-run step add
  nothing, so a usage limit or restart does not inflate cost); a bible `bible` (half at the draft, the rest at the
  components pass; `BibleWork.simCharged`); every critic call (design report/loop, bible sheet) `critique` (a per-job
  `simStepUsd` on the sim job driver); a repair round and a loop revision `repair`. `sim: true` labelling, kept minimal:
  the start log line, the group-final and bible-ready log lines, and every `design.estimate` / `bible.estimate` basis.
  Estimates still come from the seeds and samples (no sim samples are recorded).
- **Faults:** `sim:fail` (fails after step 1), `sim:repair` (round 1's check "fails", one repair round; logged as
  `design <id>: round 1's check failed (simulated, sim:repair)`; state in `DesignWork.sim.round` for 0.13.0's REPAIR stage),
  `sim:usage_limit`; from notes (token-bounded, so `sim:critique=`/`sim:polish=` are not faults) or `ext["architect:sim"]`.
  A fault in a group item applies to each of its designs (massings and detail).
- **simAnswer:** checked against the schema in `JobRunner.run` (unwrapping `simLimitMs`, skipping `simFail`); a mismatch fails
  the job right after the ack, with no re-ask. Internal critic/judge answers are not re-checked.
- README "Testing against Architect".

## Gate for 0.12.2 (coordinator: sidecar tests plus a sim end-to-end run)

- `cd sidecar && npm run check`: 661/661 (new `test/simcosts.test.ts`, 8 tests, incl. the Steward-sized flow at simStepMs 400).
  One full run earlier had 2 failures in `test/jobs.test.ts` (an agent job waiting on a design slot, and a cancel while
  waiting for a tool); 3 isolated runs and the next full run passed. Timing-sensitive under load; recorded, not chased.
- `cd mod && ./gradlew build --offline`: passes (LauncherPlanTest covers `needsInstall`).
- `node tools/gate6c0a.mjs stub --port 8902`: 18/18 on the packed `architect_mc-0.12.2.jar`'s bundle (no node_modules,
  `ARCHITECT_SIM_COSTS=measured`): card, mismatching card fails, bible $1.35, estimate basis `sim: true`, 3 massings, owner-only
  approval, redirect, helper restart while awaiting (group re-read unchanged), 3 details, group cost $10.96 = 4x0.19 + 3x3.40,
  8.6 s; sim:fail / sim:repair / sim:usage_limit.
- In game (`tools/run-gate6c0a-client.sh`, the dev client with the sidecar dir unset, so the launcher takes the bundled
  helper): `node tools/gate6c0a.mjs launcher` 5/5 (source bundled, no node_modules or .installed, sdk missing, the log line).
  The three sim suites against that client with `ARCHITECT_SIM_COSTS=zero`: sets 37/37, massing 35/35, jobs 32/33; the one
  FAIL asserts `launcher.source === 'dev'` (this client is bundled by design), not a regression.
- Restart re-fire: `GROUP_AWAITING_APPROVAL` dedupe is persisted (api-awaiting.json), so it does not re-fire after a client
  restart; GROUP_UPDATED's ledger is in memory, so it fires once after a restart. 0.13.0's `seq` addresses that.
- Not run for the stub: apijars (no API change), the in-game Steward flow with batch + undo (§13 item 1's full form; it goes
  into the 0a slice gate with the packed-jar client).

Verifier notes (low): in the zero-cost path a restart mid-`sim:repair` re-adds `simDesignUsd` for the repair round (only the
simCosts path is idempotent); `simWork()` creates a `work[id]` entry for every sim design.

## 0.13.0 progress (`slice/0a`)

Built (all pushed on `slice/0a`; API 1.10.0, mod 0.13.0):
- **Sidecar:** C5 estimates by kind (`design.estimate {mix}`, `byKind` lines that sum to the totals; seeds re-based on Steward's
  phase 1: a detail with report critique $2.5-4.6 / 8-15 min for Opus and Sonnet alike, massing $0.12-0.30, bible $1.16-1.55,
  repair/adapted $0.3-0.9; measured samples still win, and then the report critique is added on top); C9 opKeys (`opkeys.ts`:
  canonical-JSON sha256 without the key, `adopted` acks, `op_key_conflict:` errors, `bible.byKey` / `group.byKey`, the key flushed
  to state.json before the ack, records with keys kept 30 days after final); C7 (`breakdown.ts`: seq/lastAction on the
  transition signature only, the per-stage breakdown with the bible line claimed by the owner's first group, QUEUED/USAGE_HOLD
  time attributed per refresh, the `group <id> breakdown {json}` log line on entering awaiting approval and at the end);
  `bible.cancel` acks with the job. Features `estimate.kinds`, `opKeys`, `group.breakdown`.
- **Tiles + own time** (subagent, merged from `slice/0a-tiles`): 4 evaluations (limits 2/4/8/16 s, pauses 1/2/4 s; the
  contract's "up to 3 times" read as 3 retries), `region.tile.error {code, attempts}`, `ARCHITECT_TEST_SLOW_TILES`; TileStream
  WAITING with TILE_SLOW and the 30 s / 60 s / 120 s / 5 min re-asks, RETRY nudge; `MsptTrace` `own`/`ownCpu`, megaA judged on
  `ownCpu.p99 <= 25`, `max <= 50`; `tools/lib/tickbar.mjs` copied from integrate/tiers-labui plus additions (expect a small
  conflict when that lands: keep these lines).
- **C6** (subagent, merged from `slice/0a-c6`): kit conformance (front = error, entrance column > 1 off = issue),
  `fitMassingToLot` (via a `Sites.checkSite` overload taking an entry; touches `site/Sites.java`), `MassingPredictionTest` (48
  cases, all equal rotation, |dx| = |dz| = dy = 0; `artifacts/gate6c0a/c6.json`). Open: the example pairs are dimensionally
  identical, so the evidence is trivially 0; within conformance tolerances a 180-degree case can reach |dx| = 3 (a detail 2
  wider with its entrance 1 off), and approach length / groundY are not conformance-checked. For Steward / the coordinator.
- **Mod:** the 1.10.0 surface; wire (opKey, breakdown, seq, lastAction, byKind, mix); OP_KEY_CONFLICT from the ack prefix;
  `groupByKey` / `jobByKey` (SIDECAR_UNAVAILABLE when not connected); `cancelJob`; GROUP_UPDATED only on seq growth (the last
  fired seq persisted in api-awaiting.json "seq"), nothing fired while approve/extend/resume is in flight against an old helper;
  durable batches (`QBatch.fired`, fire -> mark -> save, `catchUpDone` on world load, 256 / 30-day retention, region batches never
  pruned); batch opKeys (`BatchKeys`: the Batch record's persisted form, level = dimension id, actor = UUID); caller pins
  (`CallerPins`, caller-pins.json, merged into entry.pins and `EntryVersion.pinned`); WORLD_STOPPED (`StopSweep`: the API objects
  are interface proxies whose futures are tracked and failed at SERVER_STOPPING; Sites/Regions/Survey calls fail at once with no
  world); DevBridge `dev.batch.skipSave`, `dev.api.dropAck`, `dev.api.pending`; apitest 0a steps.
- **Compat:** `node tools/api-compat.mjs --gate6c0a`: 4/4 clean (0.12.0/0.11.0/0.10.0 apitest jars, 0.12.0 surface;
  RegionRefused re-parented under ArchitectRefused passed without teaching the tool anything). apijars moved to 1.9/1.8/1.7.
- **Gate driver:** `tools/gate6c0a.mjs flow|budget|fit|batches|keys|cancel|pins|stopped|tiles` against a run worktree
  `../architect-mc-0a-run` (seeded from ../architect-mc-6a-run like the runner), ports 8902/8903 (8900/8901 are held by the
  coordinator's integration gate).

Known: `JournalIndexBenchTest` (commit p99 bar) fails under the machine's load (load average 50-70 from parallel sessions);
unrelated to 0a; re-run when quiet. The slice tier needs the tiers runner (not on main yet); the old runner's migration steps
hard-code 8892/8893, which is the other agent's range.

## Gate state (2026-10-10, late)

- In game, `tools/gate6c0a.mjs` against `../architect-mc-0a-run` (8902/8903), all passing: flow 15/15 (items 1, 2, 6, 7 incl. the
  restart while awaiting approval), budget 3/3 (the $5 live-run case, simStepMs 2500 for that step), fit 6/6 (C6 in game), batches
  3/3 (item 4), keys 10/10 (item 5, incl. SIDECAR_UNAVAILABLE), cancel 2/2 (item 8), pins 6/6 (item 9, forced-age GC on the seeded
  g5b_cap), stopped 3/3 (item 10: the volume and the unacked group failed WORLD_STOPPED; the realise and cancelBatch had completed
  before the stop), tiles 4/4 (item 11: SLOW_TILES=4 PLACED with the unhooked sha, TILE_SLOW + RETRY; =2 inside the retries).
  Evidence `artifacts/gate6c0a/*.json`. Not in game: a kit-error tile (sidecar unit test covers `code: "error"`).
- Regression: the tiers runner is not on main, so the old runner's `regress` chain (which has 6a-megaB-fast) runs on 8904/8905
  with run dir `../architect-mc-0a-gate`, out `artifacts/gate-runs-0a/`; then `engine --only 6a-megaA,6a-inv3,6a-staged` for the
  region rows of the impact map. Machine load is 50-85 (parallel sessions): bench verdicts may be NOISY.
- Still to do before "ready to merge": those runs, the gate-verifier, the RC jar for Steward's consumer check.
- Steward's S-lot bug (the sim's cabin massing over max 11x24x9): fixed in `sim.ts` (`simFit`, `withDefaults`, `standInMassing`)
  with `test/sim-fit.test.ts`; also on `slice/0a-simfit` (origin/main + the two commits, mod 0.12.3) for a patch release.
