# Phase 6c slice 0a: working notes (handoff)

Spec: docs/CONTRACT.md "Phase 6c slice 0a: consumer support (FROZEN after Steward review)", with "Coordinator decisions
(2026-10-10)" and "Changes from Steward's review of 0a" winning. Branches (the coordinator's naming, not the contract's
`phase/6c-0a`): `slice/0a-stub` (C4, v0.12.2, API 1.9.0) in `../architect-mc-0a-stub`, then `slice/0a` (the rest, v0.13.0 /
API 1.10.0) in `../architect-mc-0a`, built on the stub. Ports 8900-8905 (0b has 8906-8911, 0c 8912-8917). Note: during the
stub work another session's integration gate held 8900/8901, so the stub runs used 8902/8903 (and 8904 for a bundle probe).
Merge (AGENTS.md from 2026-10-10): after the gate and a gate-verifier review, the builder merges `--no-ff` and checks CI;
the coordinator tags.

## State

| Build step (§14) | State |
|---|---|
| 1. 0.12.0 apitest jar archived | done (below) |
| 2. 0.12.2: C4, client script, gate item 1 | gate passed; gate-verifier PASS (re-ran npm run check 661/661, mod tests 437/437, stub 18/18); merged to main |
| 3-6. Sidecar, kit, mod, gate for 0.13.0 | not started (on `slice/0a`) |

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
