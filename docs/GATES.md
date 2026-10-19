# Gates: the unattended runner and the risk-tiered policy

`tools/gate-run.mjs` runs gate steps (`tools/gate-chains.json`) against dev clients driven through the DevBridge
(docs/DEVBRIDGE.md), with nobody watching. It costs $0: there are no Claude calls. Every client is a stub or sim sidecar client,
and the runner refuses to start when Claude credentials are in the environment.

```sh
node tools/gate-run.mjs --list                                   # the chains and tiers
node tools/gate-run.mjs change --since origin/main --plan        # what a tier would run, and why; runs nothing
node tools/gate-run.mjs change --since origin/main               # minutes: the unit suites + the steps the diff maps to
node tools/gate-run.mjs slice  --since origin/main --ports 8896:8897   # units + apijars + the impact steps + the slice's own steps; timing bars recorded
node tools/gate-run.mjs release --release v0.12.0 --shards 3 --ports ...   # overnight: everything, duplicates rotated; timing bars judged, --quiet-wait on
node tools/gate-run.mjs quick                                    # a named chain (quick | regress | engine), as before (bars judged)
node tools/gate-run.mjs change --since origin/main --slots 2     # at most 2 gate runs on the machine at once (default 3)
node tools/gate-impact.mjs --since origin/main                   # just the change-impact report
```

## Policy update (Noah, 2026-10-12): cut what has only cost time

Evidence from 0a-X: every timing-bar failure on a slice was machine load (0a's three benches, 0b's 4d-all, 0c's three,
X's apijars, v0.16.0's 4d-all A/B against v0.15.0); no slice gate's full regression caught a real bug; the real finds came
from each slice's own focused items, the verifier's code review and Steward's reviews. So, **these win over the tables below**:

1. **Timing bars never block a slice.** In `change` and `slice` a bench step's timing bars (MSPT, own-tick max, cells/s,
   p99, wall, heap, quiet-dependent gaps such as apijars' SITE_PROGRESS gap) are **recorded, not judged**; its functional checks
   (exactness, undo, counts) still judge. Timing bars are judged once per batch at `release`, with `--quiet-wait` (now on by
   default there) and Noah's CI runners paused. *Implemented:* see "Timing bars" below.
2. **`slice` = `change` + the slice's own focused steps.** The unit suites, apijars/api-compat, the impact map's steps for the
   changed paths, and the slice's own gate steps (found by the impact rule of the slice's driver, e.g. `tools/gate6cw.mjs` ->
   `w-unit`, `w-ingame`, `6cw-scenario-s7`). No `quick` regression suite per slice; the full regression runs once per
   batch at `release` (overnight). *Implemented:* `--plan` prints, under each step, why it runs.
3. **The gate-verifier reviews the diff and the evidence; it does not re-run.** Exception: undo, journal, removal and
   survival-accounting code, where it re-runs those specific items (that is where review found C23's defect).
4. **Release first, Steward checks after.** A slice merges and releases without a pre-release Steward RC check; Steward checks
   the published version and anything found becomes a patch. Exception: a slice changing behaviour Steward relies on (removal,
   world stop, accounting) gets the RC check first.
5. **Batch releases.** Merge 2-3 slices, then one release tier, one tag and one publish. API and mod versions are assigned at
   merge (next free minor), so branches never renumber; builders use a placeholder until the coordinator sets it.
6. **At most 3 gate runs on the machine at once** (a machine-wide slot lock in the runner); more only causes load failures.
   *Implemented:* see "Slot lock" below.
7. **Bench isolation only where timing is judged (Noah, 2026-10-17).** A bench step runs alone only at `release`, in the named
   chains and with `--judge-timing`. In `change` and `slice` it schedules like any other step (same client, host and
   resources) and its timing is recorded as **contended**. No check is dropped. *Implemented:* see "Gate speed" below.

**Headless gates (Noah, 2026-10-12): implemented**, see "Headless gates" below. Steps marked `"host": "server"` run on a
dedicated server with the DevBridge and a bot player, not a client. The client stays for screenshots, galleries, the UI and the
client API.

### Timing bars: recorded in `change` and `slice`, judged at `release`

The gate drivers mark every timing bar with a `BAR` prefix on its check line: `ok   BAR ...` when it holds, `FAIL BAR ...` when it
misses (the `bar(ok, msg, data)` helper next to each driver's `check`; `tools/scenarios.mjs` prints its `mspt` row the same way).
A timing bar is MSPT, Architect's own tick (or CPU) max, cells/s, p99, wall time or liveness time, heap, and a quiet-dependent gap
(apijars' SITE_PROGRESS at most 1/s). A functional check (exactness, undo, counts, status, the compat of a jar) is never a `BAR`.
A driver whose check mixes both is split into a functional `check` and a `bar`.
  The `apijars` step runs each *archived* tag's own `tools/apitest.mjs`, which has no `BAR` prefix: gate6a classifies its
  `FAIL SITE_PROGRESS Nx, at most 1/s (min gap G ms)` line (N >= 2, G < 950) as the timing bar. That old line also folds in
  `built <= queued`, so such a failure is recorded too; the current `apitest.mjs` splits them.

- **`change` / `slice`:** a step whose only failures are `FAIL BAR` lines ends `PASS`, with the misses in the step's
  `timingRecorded` list (`summary.json`, also the run-level `timingRecorded`, the runner log, and a **"Timing bars recorded, not
  judged"** section of `SUMMARY.md` with the load average). Guards: every `FAIL` line must be a `BAR`, the driver's own
  failure total (`N FAILURE(S)`, `FAILED (N)`, `N failure(s)`, summed over a `&&` chain) must be printed and equal its FAIL lines
  (so a timing miss followed by an early exit still FAILs), there must be no stack trace in the log and no parsed failure count.
  `--quiet-wait` still waits in these tiers but never turns a step NOISY, so a functional FAIL is never swallowed. Any
  functional `FAIL` makes the step FAIL as before. `--judge-timing` judges the bars in these tiers.
- **`release` and the named chains:** bars judge as before, and `--quiet-wait` (load < 8) is on by default (`--no-quiet-wait` to
  turn it off).
- A new timing check in a driver must use `bar(...)`, otherwise it blocks slices on machine load.

### Slot lock: at most 3 gate runs on the machine

Every gate run (not `--plan`) takes one of N slot files, `slot-1.json` .. `slot-N.json`, in `<LarattaLabs>/.gate-slots/` before
anything else: pid, worktree, chain and start time. With none free it logs the wait (the holders, repeated every 5 minutes) and
polls every 15 s. The slot is released on exit, on SIGINT/SIGTERM (also while waiting), and a slot whose pid is dead counts as
free, so a SIGKILLed run does not hold one. `--slots N` / `GATE_SLOTS` overrides the limit (default 3, `slots.max` in
`gate-chains.json`), `--slots-dir` / `GATE_SLOTS_DIR` the directory. Claims are serialised by a short `mkdir` mutex. The slot is
separate from the run's own `--lock`, which still guards one runner's run dir and ports. The plan shows how many slots are in
use; `SUMMARY.md` and `summary.json` (`slot`) record the slot and the wait. Runners started before this change take no slot, so
for the first runs the count is a floor.

## Gate speed (2026-10-17): scheduling, timeouts, one kit suite

Evidence: K1a's slice run (`artifacts/gate-runs-K1a/20261014-084850-slice`) took 193 min for 325 min of steps on 3 shards.
Shard 2 took 190 min because it got every bench step, which the runner held until everything else had started and then ran one
at a time; 6cv-scenario-s7 burned its whole 60-minute timeout on a horse standing in a lot. Each of nine slice unit steps re-ran
the whole kit suite (about 190 s and 950 CPU-s each) next to `unit-kit`. The changes below keep every check; measurements are in
"Measured" at the end of this section.

### Scheduling and timeouts

- **Benches.** An *isolated* bench step (release, named chains, `--judge-timing`, or a step marked `"isolate": true`: megaB,
  whose resume-time checks are not `BAR` lines) behaves as before: it waits until every other step has started and drained,
  runs alone, the other shards' idle clients are stopped, and `--quiet-wait` applies. In `change`/`slice` a bench step is an
  ordinary step. Its result records `ranWith` (the steps that overlapped it) and `contended: true|false`. Its timing bars stay
  recorded, not judged, and its functional checks judge as before.
- **Longest first.** Sharded, a free shard takes the ready step with the highest priority: the step's estimate plus the longest
  chain of steps waiting on it (`after`, `waitFor`), less the cost of getting its client there (0 if it is up, 0.15 min for a
  world switch in the family, 0.6 min for a start or for stopping the client before a no-client step). One shard still runs
  the order exactly. The rules are unchanged: `resources` never overlap, `after` runs on its dependency's shard, and a
  `stopOnFail` step is a barrier.
- **`waitFor`** (new step field): the step starts only after those steps have ended (any status, any shard). It is never skipped,
  unlike `after`. The kit-suite readers wait for `unit-kit` this way.
- **Estimates from history.** `tools/lib/gate-history.mjs` rebuilds `artifacts/gate-step-history.json` (in the main checkout) at
  every run and `--plan` from all past `summary.json` files. A sample is a PASS or FAIL step's seconds minus its client
  setup; the newest 30 per step are kept. The file is written atomically, and a missing or corrupt one is simply rebuilt.
  - **Estimate:** the history p50, else `estMin`, else a third of `timeoutMin`.
  - **Effective timeout:** `max(2 x p90, 10 min)`, capped by the configured `timeoutMin`, once the step has at least 5 samples
    *of its current definition*. A step's definition is a hash of its chain entry (less `desc`, `estMin`, `timeoutMin`; `host`
    counts) and the git blob ids of the driver files its shell names (`tools/*.mjs|sh`). Each sample is dated by its run's `head`:
    the definition at that commit comes from `git ls-tree` (cached per head). A sample with no head, an unknown head or another
    definition doesn't count, so a changed step keeps its configured timeout until it has 5 runs of its own (2026-10-18: history
    had put t3a-ingame at 10 min). The estimate still uses every sample.
    A contended bench step whose history has no contended sample gets 3 x p90. A `stopOnFail` barrier always keeps its
    configured timeout, and so does a step whose `waitFor` target is not in the run (a kit-suite reader without `unit-kit`, e.g.
    the verifier's `--only d-unit`, re-runs the whole suite: its fast history doesn't apply).
  - `summary.json` records `estimateMin`, `effectiveTimeoutMin` and `timeoutSource` per step.
  - `--no-history-timeouts` keeps the configured timeouts; `--no-history` also ignores the history for the order.
- **`--plan`** shows `~estimate / effective(configured) min`, the shard each step lands on, per-shard busy time and
  whether benches are isolated. `--verbose` adds each step's estimate source, timeout source and priority.

### Kit suite once per run

- `unit-kit` runs the whole kit suite. When the runner sets `GATE_KIT_RESULTS` (only if `unit-kit` is in the run), it also
  writes a JUnit report there, and `GATE_KIT_TREE` is `HEAD:kit`.
- The drivers' kit calls whose checks are pass/fail only take their files' results from that report through
  `tools/lib/kit-reuse.mjs`. These are the whole-kit-suite checks (gate6cv, cw, cx, ct1, ct2, cs2, cd, gate7ak1, gate7ak1b),
  the "goldens that must not move" checks (the same drivers plus cb, cmp, cf1, cf2), and "P0's tests after" (cd, gate7ak1,
  gate7ak1b). Each prints a `kit: reused from this run's unit-kit ...` line.
- A report is reused only when it is complete, this checkout's `kit/` is clean at that tree, and every requested file is in it
  with at least one test and no failure. The only flag allowed is `--test-skip-pattern`.
- A slice's own kit tests always run: a name pattern, a pass-count threshold, the test names, or the diagnostics.
- Without `unit-kit` in the run (`--only`, a named chain, the verifier's re-runs), or when a file failed, the driver runs the files
  itself, exactly as before. So a failing kit file fails the driver's check as before, and `unit-kit` fails too.
- The 13 unit steps that read the report `waitFor` `unit-kit`.
- Within the suite, `--test-concurrency` doesn't help. The suite's wall time (about 190 s on a loaded box) is set by single
  files run serially in one process: `plan-p0.test.mjs` (187 s of tests), `plan-k1a` (150 s), `village` (147 s; one test of
  500 seeded claims takes 138 s). Splitting those tests is kit work, not runner work.
- *Housekeeping 2 (2026-10-18):* plan-p0 is now plan-p0, -valid, -det-1..3 and -asks (37-61 s each), and the 500 claims are
  village-layout-1..4 (17-23 s each). The suite went from 214/267 s to 139/145 s (A/B/A/B, load 3-10). A driver that names
  plan-p0 or village lists the split files too.

### Gradle in the source checkout

The drivers' unit and apicompat steps run `./gradlew test --tests ...` or `compileJava` in this checkout's `mod/`. Two of
those at once fight over one project dir. K1a's b-unit and pt-unit started 5 s apart, and both ended `gradlew` exit 1 with
every test passing.

- `tools/lib/src-gradle.mjs` wraps the 18 call sites in a cross-process lock, `mod/.gradle/gate-gradle.lock`. A lock whose pid
  has died is taken over, and the lock gives up waiting after 45 min.
- gate6cmp's stale and apicompat checks read the classes of the run worktree where unit-mod built this head
  (`GATE_UNIT_MOD_RUN`). Sharded, the step's own worktree may still hold an older head's classes, which caused K1b's mp-unit
  "kit 0.31.0" failure.

### Mobs in scenario lots

`tools/scenarios.mjs` now clears entities before every placement, not only for T2/D/S2: `/kill` of every non-player entity,
then a second later the loot it dropped. It clears again whenever an item waits `OCCUPIED`, and on `PLAYER_IN_BOX` it moves
the player 32 blocks up. This touches entities only, never blocks, so the snapshot and the exactness are unchanged.
`run.json` records `mobs`.

### Version-only diffs

`impact.versionConstants` lists the lines a version bump touches:
- `mod_version`, `ArchitectApi.VERSION` and `IrStale.KIT_VERSION`;
- `KIT_VERSION`, `EVAL_KIT_VERSION` and `PLAN_API`;
- the catalogue golden's `api` and `kitVersion`.

A listed file whose every changed line (`git diff -U0` over the range) matches its patterns maps only to `unit-mod` or
`unit-kit`, under the rule "version constants only (no in-game steps)". The slice tier's units and apijars still run. Any other
changed line maps as usual, and so does `--files`, which has no hunks. On a throwaway commit bumping all seven, the slice went
from 45 steps to 4.

### Measured

Before and after, both measured on a shared, busy box:
- **Before:** K1a, `artifacts/gate-runs-K1a/20261014-084850-slice`, old runner, 50 steps, run alongside K1b.
- **After:** `artifacts/gate-runs-gatespeed/20261017-215441-slice`, this branch on main, `--range 1c750076...819d1f79`, which is K1a's
  50 steps plus k1b's three. It ran alongside the two T3 slice runs (old runner), on 3 fresh run worktrees.

| | K1a (before) | after |
|---|---|---|
| wall | 193 min | **81.5 min** |
| sum of step times | 325 min | 239 min |
| per-shard busy | 71 / 191 / 64 min | 80 / 79 / 80 min |
| load average at step starts/ends, median / max | 11.8 / 69 | 9.2 / 24.9 |
| the 10 unit steps K1a shares, summed | 67 min | 25 min (k1a-unit 11.2 -> 3.6, d-unit 11.5 -> 3.5, v-unit 7.4 -> 1.6) |
| 6cv-scenario-s7 | TIMEOUT 60.3 min | PASS 7.6 min, timeout now 25 min |

- **Verdicts.** Every step K1a passed passed again. pt-nomod failed the same way:
  `no mod/build/headless-launch*.json`, because it read this checkout's `mod/build`. That was pre-existing; since housekeeping 2
  it reads the run worktree's (`tools/lib/nomod-server.mjs` `launchFile`, built there when missing).
- **K1a non-passes that passed this time:**
  - b-unit and pt-unit (the gradle overlap; the lock never had to wait in this run);
  - 6cv-scenario-s7 (no mob was in a lot this time);
  - 4d-all's "group undo ... back exactly", the known intermittent failure.
- **Benches.** The 8 bench steps ran contended. They passed their functional checks, and their timings matched isolated
  history: the scenario steps took 7.6-9.1 min against p50s of 7.5-8.2. One timing bar was recorded rather than judged:
  pt-ingame's classifier CPU at 1.02 ms against its 1 ms budget.
- **Kit reuse.** The suite's report served 20 calls: 8 whole-suite calls and 12 goldens or P0 calls.
- **Scheduler alone, replayed on recorded durations with no contention model:**
  - K1a 196 -> 118 min with s7's timeout as recorded, 144 -> 93 min with s7 at its p50;
  - K1b 160 -> 89 min.

## Headless gates

A gate step can run on a **headless server** instead of a dev client. The server is a dedicated Minecraft 26.3 server with
Architect, apitest and the dev-only `devserver` mod. It serves the same DevBridge protocol on the same port and token file, so
the drivers (`tools/gate*.mjs`, `apitest.mjs`, `scenarios.mjs`) run unchanged.

```sh
node tools/gate-run.mjs slice --since origin/main --plan            # the plan's "hosts:" line: which steps run headless
node tools/gate-run.mjs slice --since origin/main --host client      # every step on a client, as before
ARCHITECT_DEV_PORT=8943 ARCHITECT_PORT=8942 HEADLESS_SIDECAR=sim ARCHITECT_AUTOWORLD_NAME="G6A Flat Base" \
  tools/run-headless-server.mjs                                    # one by hand (sim | stub sidecar)
```

### Where a step runs

`--host` (`GATE_HOST`) picks the hosts; `tools/lib/hosts.mjs` holds the logic.

| `--host` | effect |
|---|---|
| `auto` (default) | steps marked `"host": "server"` in `gate-chains.json` run headless; the rest run on clients |
| `client` | every step runs on a client, as before |
| `server` | every step not marked `"host": "client"` runs headless; use it to try a step out |

- Each client entry of `gate-chains.json` gets a `<key>@server` twin: the same world, its own family, and the stub or sim
  sidecar from the family.
- A driver that starts its own client starts the headless server instead (`GATE6A_CLIENT_SCRIPT`, `GATE6B_CLIENT_SCRIPT`).
- Headless runs take machine slots like any other run.

### What the server does

- **The world.** Worlds live in `mod/run/saves`, as a client's do.
  - `dev.world.leave` saves and stops the world; the process stays up, the client's title screen. Restore worlds then.
  - `dev.world.open` opens a world in the same process (`devserver` `ServerOpen`). A switch takes **3-5 s**; the first start
    takes 35-60 s under load, plus `gradlew headlessLaunch` (~5-50 s), which compiles the run worktree's HEAD.
  - A server process that dies (a crash test's halt) is started again by the next `dev.world.open`.
  - The server takes the client's integrated-server settings:

    | setting | value |
    |---|---|
    | view distance | 16 |
    | simulation distance | 10 |
    | `sync-chunk-writes` | off |
    | `pause-when-empty-seconds` | 0 |
    | watchdog (`max-tick-time`) | off: a long hook, such as megaA's hash, runs on the server thread |
- **The player** is a bot: a real `ServerPlayer` joined through vanilla's spawn task.
  - It has the client's name (`ARCHITECT_PLAYER`, else the OS user), so its UUID and site ownership match.
  - It stands in boxes (occupancy, the PLAYER blocker), loads and tickets chunks as it moves (LOADED_ONLY, `dev.waitChunks`),
    and runs `@s` commands.
  - It confirms teleports at once. A server never simulates a player's gravity, so the bot does not fall.
- **The hooks.**
  - Most are generated at build time from the client's own hook sources; see docs/DEVBRIDGE.md "Headless".
  - `dev.camera` moves the bot.
  - `dev.screen {open: "pause"}` pauses the game as a singleplayer pause does: no server ticks, and the helper hears
    `client.paused`.
  - Screenshots, screens, the UI, the placement ghost, the region ghost and the composite preview answer
    `client-only: ...`.
- **The sidecar.** The server launches the stub or sim helper as a client does. It survives world switches and stays linked
  while no world is loaded.
- **Ports.** No game port and no TCP bridge port (a Unix socket). A headless server binds only its DevBridge and sidecar
  ports.
- **The EULA.** The host refuses to start without Noah's own acceptance file,
  `~/Developer/_infra/minecraft-server/eula.txt` (`eula=true`; `ARCHITECT_SERVER_EULA` overrides), and copies it into the run
  dir. Agents never write one.

### Which steps run headless (evidence: `artifacts/gate-runs-headless/`, 2026-10-12)

**Headless (`"host": "server"`):** these pass every functional check headless.

| group | steps |
|---|---|
| sim suites | sim-jobs, sim-sets |
| 4d, 4e, 5b | 4d-all, 4e-megalite, 4e-orders, 5b-village |
| 6a | 6a-megaA, 6a-eflat, 6a-forest, 6a-inv3, 6a-staged |
| 6b | 6b-smoke, 6b-volume, 6b-commands, 6b-nudges, 6b-pathstyle, 6b-versions |
| 6c | x-ingame (removal included), x-resume (C23), v-ingame, b-ingame (6c B), pt-ingame and pt-nomod (6c PT), pt2-ingame and pt2-survival (6c PT2) |
| housekeeping 2 | t1-ingame (6c T1): its 3 check lines equal the client's at the same head (c2b094ea) |

**On the client (`"host": "client"`, `hostWhy` says why):**

| step | why |
|---|---|
| apijars | The archived `apitest.mjs survival` scripts drive the placement UI, the Library Remove UI and `ArchitectClientApi.preview`. Headless they abort after 10 of 45 checks per jar. |
| sim-massing | Its composite-preview check renders. |
| 6b-ghost | Screenshots of the ghost. |
| 6b-versionc | It runs the v0.11.0 release, which has no headless server. |
| the scenario steps (6b-scenario-s1, -s1-flat, 6cv-scenario-s7) | The gallery's cameras and shots. |

**Not tried yet (still client):** the crash suites, 6a-megaB/-heap, 4e-throughput, 5b-chains, 0a-*, 0b-* and the Y2 steps.
Try one with `--host server --only <step>`, then mark it.

**Tried and kept on the client (housekeeping 2, 2026-10-18, both hosts at c2b094ea):**
- mp-ingame: its scenarios shoot cameras (`run it on a client`).
- sch-ingame: the `ui` part calls `dev.library.export.schem`, which has no headless twin.
- y2-ingame: `dev.crate.open` is client-only.
- w-ingame: S1's pinned survey needs a base world the client made. A headless server's base (its level.dat records the data
  packs and allowCommands 0) reads S1 as 572271bdae83 against the golden's 3e5bd5b77e40, in a fresh run dir too; a client that
  reused it in the same run dir failed the same way, which is why both hosts failed in housekeeping 2. Since housekeeping 3 the
  base stamp's recipe names its host (`tools/lib/basestamp.mjs` `gateHost`), so a base the other host made is moved aside and
  rebuilt. The frozen site's count (item 6, recorded) varies from run to run on one host too (5904 on both hosts on
  2026-10-19), as do the S2/S3 survey shas (recorded, not judged). It stays on the client.
- y-ingame: headless fails `store`'s feed order (5 of 6 targets); on the client `store` fails NOT_ALLOWED (the INSTANT twins
  need permission level 2). Neither matches, so it stays.

### Headless against client (same commit, 3 rounds each, interleaved, other slices' runs on the box)

**Functional agreement.**
- 6a-megaA: the same 23 cell mismatches on every run, both hosts (the known value).
- x-resume: 46/0 on all six runs.
- 4d-all: every functional check passed on all 3 headless runs. 2 of 3 client runs failed "group undo: every lot region ...
  back exactly". That points to a client-side flake; not investigated here.

| step | wall: headless | wall: client | own-tick CPU max: headless | own-tick CPU max: client |
|---|---|---|---|---|
| 4d-all | 15m01, 16m10, 15m39 | 15m10, 16m41, 17m14 | 50.4, 47.4, 49.3 ms | 30.8, 57.1, 52.5 ms |
| 6a-megaA | 11m42, 12m35*, 11m50 | 13m15, 12m59, 19m17 | 38.0, 41.3*, 41.7 ms | 46.5, 50.9, 44.4 ms |
| x-resume | 8m18, 6m42, 6m20 | 10m08, 7m43, 6m29 | - | - |

- **Headless is faster.**
  - megaA's wall time was 11m42-12m35 headless against 12m59-19m17 on the client.
  - x-resume and 4d-all were faster or level in every round.
- **Headless is steadier.**
  - 4d-all's own-tick CPU max spread was 3 ms headless against 26 ms on the client.
  - The worst own-tick wall maxima were 171 ms headless against 319 ms on the client.
- **The 50 ms timing bar is borderline on both hosts under load.** Headless missed it once (50.4 ms); the client missed it
  twice. Timing bars are recorded, not judged, in slices.
- **The second headless megaA run** crashed on the server watchdog (a 60 s hash on the server thread). The watchdog is now
  off (above); the re-run, marked *, passed 14/0.

### Concurrency and memory

- **Several servers side by side.** `--shards 3` with 3 headless servers ran 17 steps in 30m46s (serial estimate 77 min). All
  within one slot, on ports 8946-8951.
- **Ports.** Each server binds 2 ports, so 8942-8953 fits six. The 3-slot lock still caps runs.

| peak RSS | headless | client |
|---|---|---|
| JVM, 4d-all and megaA (`-Xmx4G`) | 4.7 GB | 5.3 GB |
| JVM, x-resume | 3.0 GB | 3.3 GB |
| JVM, sweep servers | 3.3-3.8 GB each | - |
| sidecar | 0.15-0.22 GB | 0.17-0.24 GB |

## The policy (Noah, 2026-10-09; PLAN.md "Process from 6c on")

Gates are tiered by risk. Run the cheapest tier that covers the change, and the expensive checks once per release.

| tier | what runs | when | typical time |
|---|---|---|---|
| `change` | the three unit suites (mod `gradlew build`, kit, sidecar vitest) + the steps the impact map gives the changed paths. Timing bars recorded, not judged. A docs-only diff runs nothing. | every commit or small change, while iterating | minutes (a journal change: ~16 min; a driver change: ~7 min) |
| `slice` | the unit suites + `apijars` (api-compat) + the change and slice steps of the impact, i.e. the slice's own gate steps. **No `quick`.** Timing bars recorded, not judged. A docs-only diff runs nothing. | before a slice merges | a journal slice: ~28 min on one shard; a driver-only slice: its own steps + ~5 min |
| `release` | everything, with the duplicate heavy checks rotated (below); timing bars **judged**, `--quiet-wait` on by default; then the full independent gate-verifier | once per release batch (or weekly), unattended and overnight | 2-3 h on 3 shards (a 6b-sized release: ~2h20m estimated) |

Pick the range with `--since <ref>` (the diff `<ref>...HEAD`, from the merge base), `--range A...B`, or `--files a,b`.
`release` with no range uses the last tag reachable from HEAD; with no tag at all it counts as engine- and placement-touching.

### Rotation at release

The rotation key is deterministic: with `--release <tag>` it is that tag's index among the version-sorted `v*` tags (a tag not
made yet counts where it would sort); without it, the ISO week. The same release always rotates the same way. `--plan`, the
runner log, `summary.json` (`tier.rotation`) and `SUMMARY.md` all list what ran, what was **skipped**, and when the skipped
step runs next.

| check | rule |
|---|---|
| crash suite | one per release: `4e-crash` and `6a-crash` alternate |
| mega_bench A | `6a-megaA` every release. It also asserts **E-normal** (the diff after its group undo), so E-normal needs no step of its own |
| mega_bench B | full walk (`6a-megaB`) on engine-touching releases; otherwise full and `--fast` alternate |
| E-flat | `6a-eflat` every release |
| heap | `6a-heap` every other release, opposite the full megaB |
| throughput | warm-up + median of 3 (`4e-throughput`) only when realise/placement changed (the `placement` tag); otherwise one smoke run (`4e-throughput-smoke`: recorded, not judged) |

Always at release: units, sim suites, apijars, mega-lite, 4e-orders, 4d-all, 5b-chains, 5b-village, 6a-megaA, 6a-eflat, 6a-forest,
6a-inv3, 6a-staged, and the sim 6b steps (6b-smoke, -ghost, -volume, -commands, -nudges, -pathstyle, -versions, -versionc,
-scenario-s1, -scenario-s1-flat).

The 6b steps run `tools/gate6b.mjs` and `tools/scenarios.mjs` on the `6b` client (`tools/run-gate6b-client.sh`, always the sim
backend), each after `gate6b.mjs base` (idempotent: it creates the pinned-seed G6B worlds in the run dir the first time). The
paid 6b steps (crater, craterab, rift, picks: the claude login) and the one-off pins (findsite, playerblock011, the scenario
pin/golden/gallery/calibrate) are not in any tier; they run by hand under a contract's spend cap. A scenario step fails when a
gated run bar fails (`scenarios.mjs run` exits 1); the gallery approval stays a person's.

"Engine-touching" and "placement-touching" are tags on impact rules: the journal, regions, region synthesis and the realise and
placement code are `engine`; regions, placement and deltas are `placement`.

### Change-impact mapping

`impact` in `tools/gate-chains.json` maps path globs to steps (`tools/gate-impact.mjs` applies it to
`git diff --name-only`). Each rule has the steps a `change` run picks (`change`), the extra steps a `slice` run adds (`slice`) and
its tags. Every matching rule counts. The main rules:

| paths | change | slice adds |
|---|---|---|
| `journal/**` (engine) | unit-mod, 4e-orders, 4e-crash, 6a-eflat | |
| `region/**` (engine, placement) | unit-mod, 6a-staged | 6a-megaA, 6a-inv3, 6b-ghost, 6b-volume, 6b-nudges, 6b-versions |
| `placement/**`, `batch/**` (engine, placement) | unit-mod, 4e-megalite | 4e-orders, 4e-throughput, 4d-all, 5b-chains |
| `delta/**` (placement) | unit-mod, 5b-village | 5b-chains |
| `site/**` | unit-mod, 4e-megalite | 4e-orders, 4d-all, 5b-village, 6b-pathstyle |
| `api/**`, `apiimpl/**` | unit-mod, apijars | sim-jobs, sim-sets, sim-massing, 4d-all |
| `survival/**` | unit-mod, apijars | 4d-all |
| `sidecar/**` | unit-sidecar, sim-jobs, sim-sets, sim-massing | |
| `sidecar/src/region*` (engine) | unit-sidecar | 6a-staged, 6a-inv3 |
| `kit/**` | unit-kit | sim-sets, sim-massing, 4e-megalite, 6b-smoke, 6b-ghost, 6b-scenario-s1-flat |
| `kit/lib/region/**`, `kit/regions/**` (engine) | unit-kit, 6a-inv3 | 6a-staged, 6a-eflat, 6b-versions, 6b-scenario-s1, 6cv-scenario-s7 |
| `scenarios/**` | unit-kit, 6b-scenario-s1-flat | 6b-scenario-s1, 6cv-scenario-s7 |
| slice V: the village components, `flat_village`, `tools/gate6cv.mjs`, S7 | v-unit | v-ingame, 6cv-scenario-s7 |
| slice W: lamps, fixtures, gravity, FROZEN, the road code, `tools/gate6cw.mjs` | w-unit | w-ingame, 6cw-scenario-s7 |
| slice B: the brush kernels and program, ARVX v2, `Brushes`/`BrushCommands`, TileCheck, the brush API, `tools/gate6cb.mjs` | b-unit | b-ingame (headless), 4e-crash |
| slice PT: `placed/**`, the tracking mixins, the journal's `pt`, TileCheck, SiteJournal, roads, the build API, the kit's build helpers, `tools/gate6cpt.mjs` | pt-unit | pt-ingame and pt-nomod (headless) |
| `tools/gate6b.mjs`, `tools/lib/run6b.mjs`, `tools/find-site.mjs` | 6b-smoke | the other sim 6b steps |
| `tools/scenarios.mjs`, `tools/lib/scenario-*.mjs` | 6b-scenario-s1-flat | 6b-scenario-s1 |
| a gate driver (`tools/gate4e.mjs`, ...) | that gate's cheap steps | its longer steps |
| any other `mod/src/main/java/**` | unit-mod | |

Version-constant-only files map to their unit suite only (see "Version-only diffs" above).
Ignored (nothing to run): `docs/**`, `**/*.md`, eval results and briefs, `.github/**`, images, `mod/logs/**`. A path no rule and
no ignore glob covers is **unmapped**: `change` and `slice` fall back to the unit suites (slice: and apijars), and the plan prints it. A changed `tools/gate*.mjs` driver no rule covers is flagged in the plan: add a rule so the slice's own steps are found. Extend the
map when a slice adds a package or a gate step (`node tools/gate-impact.mjs <path>` shows what a path maps to).

### Faster runs

- **mega-lite in routine tiers.** `4e-megalite` (256x256) is in every tier. The full 1000x1000 mega_bench runs at release, and megaA
  also in slices whose diff touches region code.
- **Prepared worlds are restored, not regenerated.** A step's `restore` worlds are APFS-cloned (`cp -c -R`, seconds, no disk) from
  the snapshot store (the seed's `mod/run/saves`, `GATE_SNAPSHOT_DIR`) before it runs. That also undoes whatever an earlier
  step left in them.
- **A client stays up between compatible steps.** Steps on the same client reuse it; steps on another client of the same family
  (same sidecar kind and mods: `stub` = 4d/4e/5b, `sim` = sim/6a) switch worlds in the same process instead of restarting.
- **Parallel shards.** `--shards N` (2-3) runs N clients at once, each with its own run worktree, port pair and evidence dir
  (`<run>/s<k>/`). Steps declare what they need:
  - steps sharing a `resources` entry never overlap;
  - a step with `after` (4e-crash after 4e-orders) runs on its dependency's shard;
  - `waitFor` waits for steps on any shard;
  - a `stopOnFail` step (unit-mod) is a barrier.

  A `bench` step (timing or MSPT bars: mega-lite, throughput, megaA/B, heap, the scenarios) runs alone only where timing is
  judged; elsewhere it schedules like any other step. The order is longest first from the step history. See "Gate speed" above.

### Bench steps: tick bars, load, exclusivity

- **MSPT bars judge Architect's own per-tick time: `placementCpuMsMax` <= 50 ms; whole tick, placement wall time,
  `serverMsptMax` and GC are recorded, not judged; bench steps run under whatever load there is.** (Coordinator decision from the
  6b engine-chain investigation, 2026-10-10, verified in 6b's release check: the megalite and megaA MSPT failures were the vanilla
  server tick and G1 pauses, the same in v0.11.2; judged as wall time the placement ticks still failed under load, so the judged
  figure is their server-thread CPU time.) `placementCpuMsMax` comes from `dev.placement.stats` (batches, group undo, jobs: all
  of Architect's end-of-tick work, in the server thread's CPU time). The bar keeps its number: at most 50 ms (roads at 4 ms and
  the 5b village at 4 ms: 25 ms). `tools/lib/tickbar.mjs` holds the rule; every bar uses it or the same field: gate4d (batch
  ticks, throughput, survival), gate4e (megalite, throughput, roads, sizecap), gate5b (village, sizecap), gate6a (megaA realise
  and group undo), and the scenario MSPT row (`tools/lib/scenario-metrics.mjs`). A build without the CPU field (an old version)
  falls back to the wall time, then to the whole tick, and the check line says which. `dev.mspt.trace` has no CPU figure (its
  `writeMsMax` is wall time); its whole-tick max, p99 and over-50 count are recorded next to the result. In
  `gate-chains.json` the megaA `msptMax` metric is the realise CPU figure (`undoMsptMax` the undo's); `wholeTickP99` and
  `wholeTickMax` are recorded.
  - **p99 is record-only:** megaA's realise bar `p99 <= 25 ms` was a whole-tick percentile, and there is no percentile of
    Architect's own time yet. Slice 0a adds own-time percentiles (`MsptTrace.stop()` / `dev.placement.stats`); the driver judges
    them when present.
  - **Still judging the whole tick:** gate6a `prepare` (max <= 100 ms, <= 1% of ticks over 50 ms): prepare's work is the
    server's own chunk generation, which has no Architect/vanilla split. gate6b `volume` (0 ticks over 50 ms while sampling; its
    own sampling slice is recorded as wall time). gate4d's "full tick >= the server's own tick" is a measurement sanity check,
    not a bar.
  - The CPU figure is not load-free either: on Apple's mixed P/E cores a tick descheduled to an E core costs more CPU time for
    the same work (6b's three c717804 megaA runs: realise CPU max 37.1, 42.3, 51.5 ms; accepted by the coordinator with that
    caveat). `--quiet-wait` is on by default at release and opt-in elsewhere.
- **Load is recorded.** Every step records the 1-minute load average at its start and end (`load1` in summary.json, SUMMARY.md);
  every tick-bar result records it too. Read a bench number together with its load.
- **`--quiet-wait [N]`** (on by default at `release` with N 8, `--no-quiet-wait` turns it off; opt-in elsewhere): before each bench step, wait until the 1-minute load average is below N (default 8), at most
  `--quiet-max-min` minutes (default 30). If it never drops, the step runs marked noisy and ends **NOISY**: inconclusive, neither
  pass nor fail (its outcome and fail lines are kept, so a functional failure still shows). A run whose only non-PASS steps are
  NOISY has the verdict `INCONCLUSIVE`; re-run those steps on a quiet box.
- **Benches are exclusive where timing is judged** (`release`, the named chains, `--judge-timing`, `"isolate": true`). There a
  bench step starts only when no other step is running on any shard, nothing else starts while it runs, and the other shards'
  idle clients are stopped first. In `change`/`slice` it runs next to other steps and records `contended` and `ranWith`;
  `--quiet-wait` then waits only before isolated benches. Across runners on the same machine there is no
  lock: check that no other run is in a bench step (its summary.json; `pgrep -f <its run worktree>`) before starting clients.

### Lighter verification (gate-verifier guidance)

The runner never calls Claude. The independent gate-verifier is launched by the agent, after the run, on its evidence.

- **Per change:** no verifier. The `change` run's SUMMARY.md is the record.
- **Per slice:** the gate-verifier **reviews**, it does not reproduce:
  1. the diff (`git diff <base>...HEAD`) against the slice contract;
  2. the runner's `SUMMARY.md`, `summary.json` (tier, impact, unmapped paths, every step's status and key numbers) and the evidence
     of the steps that matter (gate JSONs under `gate4e/`, `gate6a/`, ...), checking that the run's head is the slice head and
     that the selection covered the diff;
  3. then it **re-runs only the risky steps**: anything touching the journal, the undo or survival, plus the steps for whatever the
     diff touches that the verifier judges risky (`node tools/gate-run.mjs change --only <steps> ...` on its own ports).
- **Per release:** full reproduction. The `release` run, then the full independent gate-verifier, which reproduces the gates
  itself (every bar, every step, not only the runner's word).

## What a run does

1. **Guards.** It refuses to start if any of these is set: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`
   or `AWS_BEARER_TOKEN_BEDROCK`. Every child process gets an environment without any `ANTHROPIC_*` or `CLAUDE*` variable. It
   refuses steps that look paid (`*-real`, `--tier smoke|full`, `--backend claude`) and client scripts other than
   `run-gate4d/4e/5b/6a/6b/6c0a-client.sh` and the headless `run-headless-server.mjs`, which use the stub or the sim sidecar. It refuses a run dir that is this checkout, the main
   checkout or the seed, and a run dir whose name ends with a sibling's (the drivers find their client with an unanchored `pgrep`).
2. **Lock.** It holds the lock (`<out>/gate-run.lock`, or `--lock`) with its pid, chain, run dirs and ports, so a second run on the
   same lock refuses to start. A lock whose pid has died is stale and is taken over.
3. **Preflight.** It refuses if any process already uses a run worktree, or if a shard's ports are taken. Everything it later kills
   is therefore its own.
4. **Setup.** The clients run from the runner's own worktrees. Each is created with `git worktree add --detach` and checked out at
   this checkout's HEAD for every run. On a worktree's first run, `.gradle-home`, `sidecar/node_modules` and `mod/run` (the gate
   worlds, the prepared mega worlds and the library) are APFS-cloned from the seed (`../architect-mc-6a-run`). The seed is
   read-only; nothing is written back to it. The sidecar is then built.
   **The clients run the committed HEAD. The drivers (`tools/*.mjs`) run from this checkout's working tree.** `--plan` warns
   when the tree is dirty, so commit before a run.
5. **Steps.** Each step names its client: one of `cfg.clients`, `none` (unit tests) or `self` (the step starts its own clients, as
   apijars does). Each step runs in its own process group, with its effective timeout: from the step history (max(2 x p90,
   10 min), at most the configured `timeoutMin`, with at least 5 samples) or the configured one (see "Gate speed").
   - **TIMEOUT.** The step's group gets SIGTERM, then SIGKILL. After that, the shard's run-worktree processes are stopped (gradle
     and its daemon/workers, the client JVM, the sidecar, vitest, the client scripts, matched by their paths in that worktree).
     Nothing else is touched. Stray apitest jars are removed from `mods/`.
   - **After any step that doesn't pass**, that shard's client is stopped. Its next step starts a fresh one.
   - **Verdicts.** PASS means exit 0, no `FAIL` lines, and at least one `ok` line. Unit tests use parsed counts instead.
   - **Failures.** The run continues past a failure, unless the step is `stopOnFail`. A step with `after` is skipped if that
     step didn't pass.
6. **End.** It writes `summary.json` and `SUMMARY.md`. **No Discord notify by default** (Noah, 2026-10-09: no Discord pings).
   Only `--notify` (or `GATE_NOTIFY=send`) sends one; leave it off. SIGINT/SIGTERM abort cleanly, with the same summary.
   SIGHUP is ignored.

### Where it runs: ports, worktrees, lock, output

Several agents and runners share this machine, so everything is configurable. A flag wins over the environment.

| flag | environment | default |
|---|---|---|
| `--ports S:D[,S:D...]` (every shard's sidecar:DevBridge pair) | `GATE_PORTS`; or `ARCHITECT_GATE_SIDECAR_PORT`/`ARCHITECT_GATE_DEV_PORT` for shard 1 and `GATE_SHARD_PORTS` for shards 2.. | shard 1: 8890:8891; shards 2..: **none, name them** |
| `--run-dir DIR` (shard k>1: `DIR-s<k>`) | `GATE_RUN_DIR` | `../architect-mc-gate-run` |
| `--run-dirs A,B,C` (every shard's, explicitly) | `GATE_RUN_DIRS` | |
| `--out DIR` | `GATE_RUNS_OUT` | `<main checkout>/artifacts/gate-runs` |
| `--lock FILE` | `GATE_LOCK` | `<out>/gate-run.lock` |
| `--seed-dir DIR` | `GATE_SEED_DIR` | `../architect-mc-6a-run` |
| `--quiet-wait [N]`, `--no-quiet-wait`, `--quiet-max-min M` | | on at release (N 8), else off (load recorded only); M 30 |
| `--slots N`, `--slots-dir DIR` | `GATE_SLOTS`, `GATE_SLOTS_DIR` | 3; `<LarattaLabs>/.gate-slots/` |
| `--judge-timing` | | change/slice record timing bars; this judges them as at release |
| | `GATE_SNAPSHOT_DIR` | the seed's `mod/run/saves` |
| | `ARCHITECT_GATE_OLD_SIDECAR_PORT`/`_DEV_PORT` (gate4e/gate5b's old-version client, migration/downgrade steps only) | 8892/8893 |

8892-8895 are never a shard's: the old-version clients default to 8892/8893, and eval sidecars to 8894/8895 (the runner gives
its children `ARCHITECT_EVAL_PORT=0`, an ephemeral port). A second runner next to the default one uses its own ports, run dir(s)
and out dir (its own lock follows), for example:

```sh
node tools/gate-run.mjs quick --shards 3 --ports 8900:8901,8902:8903,8904:8905 \
  --run-dir ../architect-mc-gate-run2 --out ../architect-mc/artifacts/gate-runs-tiers
```

### Output

Everything goes to `<out>/<YYYYMMDD-HHMMSS>-<chain or tier>/`:

- `summary.json`: `state` is `running` | `done` | `stopped` | `aborted`, and `verdict` is `PASS` | `FAIL`. `tier` holds the range,
  the impact (files, rules, unmapped), the engine/placement tags, the rotation key and the rotation (ran, skipped, next). Each step
  has its status, shard, seconds, ok/FAIL counts, the first FAIL lines and key numbers (unit test counts, mega-lite cells/s,
  throughput median, megaA cells/s and MSPT p99, megaB resume times), its `estimateMin`, `effectiveTimeoutMin` and
  `timeoutSource`, and `ranWith` (the steps that overlapped it; a bench step also gets `contended`). `schedule` records the
  order, the history size and whether benches were isolated. Rewritten after every step.
- `SUMMARY.md`: the verdict, the tier and rotation, a step table and the steps that didn't pass.
- `runner.pid`, `runner.log`, `setup[-s<k>].log`, `client[-s<k>].log`, `<step>.log`.
- The gates' evidence: `[s<k>/]gate4d/`, `gate4e/`, `gate5b/`, `gate6a/` (shared by a gate's steps on that shard, so context
  carries over) and `sim-*/`.

## Chains

The named chains still exist (`node tools/gate-run.mjs <chain>`):

| chain | steps | typical time |
|---|---|---|
| `quick` | unit tests; the 4a/4b/4c sim suites (jobs, sets, massing); the unchanged 0.11.0/0.10.0/0.9.0 apitest jars (API 1.8.0/1.7.0/1.6.0); 4e mega-lite | 9.5 min serial on a quiet box; ~10 min on 3 shards on a loaded box (below) |
| `regress` | `quick` plus 4d (all); 4e orders, crash, throughput; 5b chains and village; 6a megaB `--fast` | about 3 h serial |
| `engine` | `regress` (with the full megaB) plus 6a megaA, megaB, crash, eflat, forest, inv3, staged and heap | about 5 h serial |

**Measured (2026-10-10, a shared box at load average 12-36: the 6b engine chain, rust builds, other clients).** Serial quick on a
quiet box: 9m30s. On the loaded box: serial quick ran 10m12s up to the end of apijars (megalite not reached); `quick --shards 3`
ran 10m06s and 10m24s (the latter including the first setup of two new run worktrees, 25 s). Sharding quick saves only the unit
and sim suites: its critical path is unit-mod (a barrier), then apijars (3-7 min, it starts its own clients), then mega-lite (a
bench step, alone), so expect about 6 min on a quiet box. Sharding pays off in `slice` and `release`, where the long steps
(4d-all, 5b-chains, 4e-orders, the 6a suites) run side by side: the plan's estimate for a 6b-sized slice is 1h48m serial,
59 min on 3 shards; for a release, 3h10m serial, 2h23m on 3 shards. A `change` run for a driver change (6 steps) took 8m03s.

`gate6a.mjs megaB --fast` dwells 8 s per waypoint instead of 30 s and, after a stage's first lap, teleports only to the cells
that still hold an unfinished item. The relog, the sidecar kill and every bar stay the same, and `megabench-B.json` records
`mode: fast|full`. Compare only full-walk numbers with each other.

## For agents: launch, then wait once

1. **Plan first.** `node tools/gate-run.mjs <tier> --since origin/main --plan` (plus your ports and dirs). Check the selection,
   the unmapped paths and the estimate. Commit first: the clients run HEAD.
2. **Launch it detached** and note the run dir:

   ```sh
   nohup node tools/gate-run.mjs slice --since origin/main > /tmp/gate-run.out 2>&1 &
   sleep 30; R=$(ls -td ../architect-mc/artifacts/gate-runs/*-slice | head -1); echo $R
   ```

3. **Wait, don't poll.** Run **one** long until-loop in the background. It ends when the state is terminal or when the runner's
   pid is gone, so a crashed runner can't hang it:

   ```sh
   until grep -qE '"state": "(done|stopped|aborted)"' $R/summary.json || ! kill -0 $(cat $R/runner.pid) 2>/dev/null; do sleep 120; done
   ```

   At most one background wait at a time, with a timeout longer than the run's (`--plan` prints the worst case).
4. **Read `SUMMARY.md` once.** Open a step's `<step>.log` or its gate JSON only for the steps that didn't pass.
5. **Never kill processes by name.** To stop a run, `kill -TERM $(cat $R/runner.pid)`. The runner stops its own steps and clients.
6. **Bench steps measure time.** Don't start clients while another run is in a `bench` step (its tick and cells/s bars), and
   read your own bench numbers with their recorded load. On a shared, busy box use `--quiet-wait`.
