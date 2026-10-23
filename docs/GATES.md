# Gates: the unattended runner and the risk-tiered policy

`tools/gate-run.mjs` runs gate steps (`tools/gate-chains.json`) against dev clients driven through the DevBridge
(docs/DEVBRIDGE.md), with nobody watching. It costs $0: there are no Claude calls. Every client is a stub or sim sidecar client,
and the runner refuses to start when Claude credentials are in the environment.

```sh
node tools/gate-run.mjs --list                                   # the chains and tiers
node tools/gate-run.mjs change --since origin/main --plan        # what a tier would run, and why; runs nothing
node tools/gate-run.mjs change --since origin/main               # minutes: the unit suites + the steps the diff maps to
node tools/gate-run.mjs slice  --since origin/main                 # units + apijars + the impact steps + the slice's own steps; timing bars recorded;
                                                                  #   over 20 steps the shard count and ports are chosen for the machine (--shards auto)
node tools/gate-run.mjs release --release v0.12.0                  # the candidates whose cache key misses + the canaries; timing bars judged, --quiet-wait on
node tools/gate-run.mjs release --release v0.12.0 --full           # every candidate and every rotation option (automatic on engine/Minecraft/build changes;
                                                                  #   --no-auto-full: the cache's own selection anyway)
node tools/gate-run.mjs slice  --since origin/main --no-cache      # run every selected step (a PASS is still recorded); --no-trace: no trace, no record
node tools/step-inputs.mjs check                                 # CI: every driver's imports inside its recorded input set
node tools/nightly.mjs                                           # the nightly: release --full --no-cache --nightly on origin/main (LaunchAgent at 02:00):
                                                                  #   the judged benches run there, and a release reuses their PASSes ("Benches out of the release path")
node tools/nightly.mjs --megab-full                              # the nightly with megaB's full walk on demand (else weekly)
node tools/gate-run.mjs slice  --since origin/main --shards 3 --ports 8896:8897,8898:8899,8900:8901   # a fixed shard count, as before
node tools/gate-run.mjs quick                                    # a named chain (quick | regress | engine), as before (bars judged)
node tools/gate-run.mjs change --since origin/main --slots 2     # at most 2 gate runs on the machine at once (default slots.max, 4)
node tools/gate-impact.mjs --since origin/main                   # just the change-impact report
```

## Policy update (Noah, 2026-10-12): cut what has only cost time

Evidence from 0a-X: every timing-bar failure on a slice was machine load (0a's three benches, 0b's 4d-all, 0c's three,
X's apijars, v0.16.0's 4d-all A/B against v0.15.0); no slice gate's full regression caught a real bug; the real finds came
from each slice's own focused items, the verifier's code review and Steward's reviews. So, **these win over the tables below**:

1. **Timing bars never block a slice.** In `change` and `slice` a bench step's timing bars (MSPT, own-tick max, cells/s,
   p99, wall, heap, quiet-dependent gaps such as apijars' SITE_PROGRESS gap) are **recorded, not judged**; its functional checks
   (exactness, undo, counts) still judge. Timing bars are judged once per batch at `release`, with `--quiet-wait` (now on by
   default there) and Noah's CI runners paused. *Implemented:* see "Timing bars" below. (Since 2026-10-22 the judged benches'
   timing is judged in the nightly, and a release reuses it: "Benches out of the release path".)
2. **`slice` = `change` + the slice's own focused steps.** The unit suites, apijars/api-compat, the impact map's steps for the
   changed paths, and the slice's own gate steps (found by the impact rule of the slice's driver, e.g. `tools/gate6cw.mjs` ->
   `w-unit`, `w-ingame`, `6cv-scenario-s7`). No `quick` regression suite per slice; the full regression runs once per
   batch at `release` (overnight). *Implemented:* `--plan` prints, under each step, why it runs.
3. **The gate-verifier reviews the diff and the evidence; it does not re-run.** Exception: undo, journal, removal and
   survival-accounting code, where it re-runs those specific items (that is where review found C23's defect).
4. **Release first, Steward checks after.** A slice merges and releases without a pre-release Steward RC check; Steward checks
   the published version and anything found becomes a patch. Exception: a slice changing behaviour Steward relies on (removal,
   world stop, accounting) gets the RC check first.
5. **Batch releases.** Merge 2-3 slices, then one release tier, one tag and one publish. API and mod versions are assigned at
   merge (next free minor), so branches never renumber; builders use a placeholder until the coordinator sets it.
6. **At most 3 gate runs on the machine at once** (a machine-wide slot lock in the runner); more only causes load failures.
   *Implemented:* see "Slot lock" below. (Since raised to `slots.max` 4; a run's shard count now follows the machine's load,
   "Adaptive shards".)
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
  turn it off). Two exceptions (2026-10-22, "Benches out of the release path"), both recorded like `change`/`slice` and never
  isolated:
  - a step whose entry says `"timing": "recorded"` (4e-throughput, 4e-throughput-smoke: their timing is folded into 6a-megaA), in
    every tier and chain. `--judge-timing` judges them;
  - the scenarios `release.benches.nightlyJudged` names (6b-scenario-s1, 6c-scenario-s2, 6c-scenario-s3), at a release that is not
    the nightly. The nightly judges them, isolated.
- A new timing check in a driver must use `bar(...)`, otherwise it blocks slices on machine load.

### Slot lock: at most N gate runs on the machine (`slots.max`, 4)

Every gate run (not `--plan`) takes one of N slot files, `slot-1.json` .. `slot-N.json`, in `<LarattaLabs>/.gate-slots/` before
anything else: pid, worktree, chain and start time, and (since "Adaptive shards") the run's shard count and ports. **One slot per
run, whatever its shard count**: the slot caps how many agents' runs share the box; the shard budget below caps how much they
load it. With none free it logs the wait (the holders, repeated every 5 minutes) and
polls every 15 s. The slot is released on exit, on SIGINT/SIGTERM (also while waiting), and a slot whose pid is dead counts as
free, so a SIGKILLed run does not hold one. `--slots N` / `GATE_SLOTS` overrides the limit (default 3, `slots.max` in
`gate-chains.json`, 4), `--slots-dir` / `GATE_SLOTS_DIR` the directory. Claims are serialised by a short `mkdir` mutex. The slot is
separate from the run's own `--lock`, which still guards one runner's run dir and ports. The plan shows how many slots are in
use; `SUMMARY.md` and `summary.json` (`slot`) record the slot and the wait. Runners started before this change take no slot, so
for the first runs the count is a floor.

## Affected-only releases: the step cache and the nightly (Noah, 2026-10-22)

A release re-ran about 140 steps even when the batch's slices had passed them on the same code; 0.41.0 took about 12 hours end to
end. Now every step's PASS is recorded under a key that names everything that can change its result. A release runs the steps
whose key has no recorded PASS, plus a fixed set of canaries. A nightly full run on origin/main keeps the cache warm and catches
what the input map misses.

### Step inputs (`tools/step-inputs.json`, `tools/step-inputs.mjs`)

A step's input set is the union of four parts:

| part | what | from |
|---|---|---|
| classes | whole trees, by the step's kind (tools/gate-cache.json `classes`). Any game client (`self` too): `jar` (mod/** less mod/src/test, devserver/, apitest/, the client scripts, the kit files the jar copies) + `sidecar` (sidecar/** and the kit it runs: kit/** less kit/test and kit/lint) + `world` (scenarios/**). A gradle cwd, or a driver that runs gradle in the source checkout (`src-gradle.mjs`): `gradle` (mod/**, kit/**, sidecar/**: the Java tests read ../kit and ../sidecar). | its client, cwd, closure |
| closure | the drivers' module closure: the tools/... files its command names (and the test globs it passes to node, kit/test/*.test.mjs), their static imports, literal `import('...')`, `new URL('...', import.meta.url)`, literal repo paths and `path.join(..., 'lit', 'lit')` tails | `step-inputs.mjs build` (static) |
| globs | the directories literal paths name (kit/test/fixtures/plan/**), widened | `build` |
| data | what the step's traced runs read outside the rest, widened to the directory (a file -> its directory/**, a listing -> that directory/**) | `step-inputs.mjs merge <run dir>` |

The JVM (the client, gradle) and a sidecar the runner starts are not traced, which is why the in-game and gradle steps carry whole
trees. A consequence, by design: **a change under mod/src/main, mod/src/client or kit/ outside kit/test and kit/lint invalidates
every in-game step**, because the jar or the sidecar the clients run contains it. A change to one driver, a kit test, a lint, a
fixture or docs invalidates only the steps whose sets hold it. The `gradle` class also holds devserver/ and apitest/, because
mod/settings.gradle includes them and `gradlew build` compiles both.

**The trace** (`tools/lib/step-trace.mjs`). Every step runs with `NODE_OPTIONS=--import=<tracer>`. Each node process of the step
records the files it loads as a module, reads, lists or stats. That covers the driver, `node --test` and vitest, and any node child
that inherits the step's environment. The traced roots are the source checkout and the shard's run worktree, both holding the
commit's tree, and the main checkout's artifacts/. The records go to `<run>/traces/<step>/`. A computed import
(`import(pathToFileURL(path.join(KIT, rel)))`, about 1200 sites) is not resolved statically; the trace records what it loads.

**Run state is not an input**: tools/gate-cache.json `state` (mod/run, logs, sidecar/scratch). **Derived files** (node_modules,
mod/build, .gradle-home) count as the tracked files they come from (`derived`). kit/stamps (gitignored, harvested locally) is
hashed by content (`fingerprint`). Files read under the main checkout's artifacts/ (archived tag builds, apitest jars) are recorded in the
cache entry with their size and mtime, and a lookup re-checks them. Caches keyed by content (plan-cache, lint-cache) and a run's own
evidence are not inputs.

**The check** (CI, `node tools/step-inputs.mjs check`) rebuilds the static part at HEAD and fails when:
- a step's closure reaches a file outside its recorded set (a driver gained an import);
- a step's classes, roots or the environment variables its closure reads differ from the recorded ones;
- a step has no entry.

The fix is `node tools/step-inputs.mjs build` (it keeps the traced data) and a commit. `show <step>` prints a set and its file count
at HEAD; `which <path>` lists the steps whose sets hold a path.

### The key and what is recorded (`tools/lib/step-cache.mjs`)

A step's key is a hash of:
- **inputs**: the git blob id of every tracked file in its set at HEAD, plus the tracked sources of the derived files it read,
  plus the content of its fingerprinted local data;
- **definition**: gate-history's `stepDefinition` (the chain entry, `desc`/`estMin`/`timeoutMin`/`supersededBy` aside, and the
  blob ids of the drivers its shell names), the **resolved** client entry and host (after `--host`), the step's `env`;
- **toolchain**: `node` (process.version), `java -version` of JAVA_HOME, mod/gradle.properties less `mod_version` (the Minecraft,
  loader, Fabric API, loom and lab-ui versions);
- **modes**: every environment variable a module of its closure reads (`process.env.NAME`), every ambient variable with the
  project's prefixes (`ARCHITECT_`, `GATE_`, `G5B_`, ...: the JVM, the sidecar, the client scripts and aliased reads are invisible to
  the scan), plus `GATE_P3`, `GATE_P2_SMOKE`, `CALIBRATION_WRITE`, `ARCHITECT_RELEASE`, `ARCHITECT_TEST_SLOW_TILES`,
  `ARCHITECT_APITEST` and `ARCHITECT_HEADLESS` always; less the per-run plumbing (ports, run and out dirs, tokens).
  A `*_DIR` that redirects an input, such as `ARCHITECT_STAMPS_DIR`, counts as a mode.
  The P2 calibration record and the P3 mode are committed files the trace sees, so they are inputs;
- **flags**: the release context (branch, a v* tag at HEAD) for steps whose closure has `tools/release-context.mjs`; the code trees
  (kit, scenarios, tools, mod, sidecar, devserver, apitest) of origin/main and of the merge base for steps whose closure diffs
  against origin/main (the "unchanged" items); the newest reachable v* tag for closures that run `git describe --tags`
  (release-version's last tag); the whole tree's file list for closures that run `git ls-files`;
- **snapshots**: size and mtime of the level.dat of every world the step restores, and of its client's world, in the snapshot store.

**A source HEAD that moves during a run** (a commit or checkout in the source checkout) stops recording from there on, as does a tree
that turns dirty. **A dirty source tree never looks up and never records** (`git status --porcelain --untracked-files=all` non-empty: the drivers
run from the working tree, and an untracked file can be imported). Keys are git blob ids, so they are computed at a commit. The same
function gives `tools/step-cache.mjs replay` its keys at a past head.

**Recorded** (`<main checkout>/artifacts/step-cache/<step>/<key>.json`: the run dir, the step log, the evidence dir, the head and
time; for unit-kit its JUnit report and kit tree) only when every one of these holds:
- the step ended PASS;
- no timing bar was recorded rather than judged (`timingRecorded` empty). A slice PASS with a bar missed never serves anything;
- it is not a **judged bench** (`tools/gate-cache.json` `release.benches.judged`: 4e-megalite, 6a-megaA, 6a-megaB, 6a-megaB-fast, 6a-heap,
  6b-volume), unless the run is the nightly and the bench ran isolated with its timing judged. That nightly PASS is recorded with
  `nightly: true` and is what a release reuses ("Benches out of the release path"). A contended or recorded-timing PASS of a judged
  bench is never recorded. The scenario steps (S1-S3 included since 2026-10-22, and forms, relief, scatter, route, districts, s7,
  mp-ingame) are ordinary candidates: they cache when they pass with no bar missed;
- it ran traced, and every source path its trace touched is inside its set. Otherwise the run reports an **inputs-map miss**
  (`summary.json` `inputsMisses`, SUMMARY.md, the runner log) and the PASS is not recorded. The fix is
  `node tools/step-inputs.mjs merge <run dir>`, a review of the globs it adds, and a commit; `node tools/step-cache.mjs import <run dir>`
  then records that run's PASSes under the widened map;
- the step is not **uncacheable** (tools/gate-cache.json `uncacheable`): umt-long (fresh clock seeds), apijars and 6b-versionc
  (archived jars run by hand-made clients), the P3 probes (they read other steps' evidence of the same run), p2-calibration, the by-hand pins.

FAIL, TIMEOUT, ERROR and NOISY are never recorded. `--no-cache` turns lookups off and still records. `--no-trace` turns both off.

### Lookups and the release selection

A tier run (`change`, `slice`, `release`) looks up every selected step. It does not when the run is a named chain, `--only`/`--from`
(an explicit list, such as the verifier's re-runs, always runs), `--no-cache` or `release --full`. A step with a recorded PASS for
its key is **CACHED**: it is not run. It is listed in `--plan`, in `summary.json` `cached` (key, PASS time, head, run dir, log) and in
SUMMARY.md, each with a pointer to its evidence.

**The release candidates** are `tiers.release.always`, the rotation, every step an impact rule names (its `change` and `slice`
lists) and the slice tier's `always` list, with the `supersededBy` twins dropped. Today that is 179 steps under `--full`: the old
release tier's 60 plus what a batch's slice run covered (0.41.0's integration slice ran 140). A candidate runs when one of these holds:
1. **its key misses**: no recorded PASS, a dirty tree, an uncacheable step, or an archived input that changed;
2. **it is a canary** (tools/gate-cache.json `release.canaries`), cached or not:
   - the calibration probes p2-calibration, p3-probe-water and p3-probe-ledger;
   - one big scenario, rotating 6b-scenario-s1, 6c-scenario-s2, 6c-scenario-s3, 6cv-scenario-s7 by the release's rotation key;
   - the crash suite the existing rotation picks.

   The judged benches are no longer canaries (2026-10-22): they are not candidates at all, and the bench rule decides them ("Benches
   out of the release path");
3. **it is a full twin whose last PASS is older than the last full nightly**. A full twin is any `supersededBy` target: the -full
   steps and the full ids of the -smoke steps. The nightly's start comes from `artifacts/nightly/latest.json`;
4. **a running step needs it from this run**:
   - its `after` dependency (4e-crash-full needs 4e-orders-full's context on its shard);
   - a `waitFor` target whose evidence it reads (the P3 probes read h-ingame, hy-ingame and h-probe, or y-ingame and cu-survival);
   - unit-mod, for a step that reads `GATE_UNIT_MOD_RUN` (gate6cmp).

   `unit-kit` is the exception: when it is CACHED, its recorded JUnit report for the same kit tree is copied into the run and serves
   the kit-suite readers (kit-reuse.mjs checks the tree).

**Split steps** (turbo, docs/GATES.md "Turbo"): each part `<id>/p<k>` has its own key (its own entry: the section env) over its
parent's input set, and is CACHED or run on its own; a canary or a bench the bench rule runs takes all its parts.

**`--full`** runs every candidate, every rotation option and every judged bench but the nightly-only 6a-heap (megaB's full walk; the
nightly's `--nightly` picks megaB's walk by its schedule and runs heap). It is **the rule, automatically,** when the release range touches one of these:
- mod/build.gradle, mod/settings.gradle, the gradle wrapper, devserver/ or apitest/ build files;
- mod/gradle.properties beyond `mod_version` (the Minecraft version or a dependency);
- a path whose impact rule is tagged `engine`.

`--plan` prints why. Run a manual `release --full` every few weeks as well, and after any toolchain or machine change the key can't
see (a new JDK build is in the key; a changed snapshot world is in the key by its level.dat).

What a CACHED step does not do: it does not re-measure. Its timing bars were recorded with its PASS. The judged benches' timing comes
from the nightly, reused only while nothing they measure changed ("Benches out of the release path").

### The nightly (`tools/nightly.mjs`)

At about 02:00 it:
1. checks that no gate run is active or queued (a live slot holder or queue ticket in the slot dir). If one is, it **exits at once**
   and the night is skipped (`artifacts/nightly/<date>/summary.json` says why). `nightly.idleWaitMin` (0) can make it wait that long
   for an idle machine first, without taking a queue ticket, so it never queues ahead of a run;
2. fetches origin and moves its own worktree (`../architect-mc-nightly`, detached) to origin/main. The main checkout is never
   checked out or pulled. A nightly worktree with local changes skips the night;
3. runs `release --full --no-cache --nightly --turbo` there (`nightly.extraArgs`; `--megab-full` passes on), in its own run dirs (`../architect-mc-nightrun[-s<k>]`)
   and out dir (`artifacts/gate-runs-nightly/`). As a turbo run it holds the whole machine: a run started during the night waits in
   the queue for it (FIFO), and nothing is killed. **The yield guard** (`nightly.yieldAfter`, 05:30 local): past it, with another run
   queued, the nightly sends its runner SIGUSR2. The runner starts no new step, lets its running steps finish, and ends `stopped`
   with `yielded` (the steps not started are SKIPPED, error "yielded"). The nightly then runs those steps as a normal one-slot run
   (`release --no-cache --no-turbo --nightly --only ...`), which queues like any run. The summary records the yield, both runs and
   the combined verdict. `--nightly` makes the judged benches run isolated with their timing judged and records their PASSes for the
   releases ("Benches out of the release path");
4. writes `artifacts/nightly/<date>/SUMMARY.md`, `summary.json` (head, verdict, counts, wall, slot wait, what didn't pass, PASSes
   recorded, the benches it ran and whether each PASS was recorded, megaB's walk and why), `impact-map-misses.json`, `misses-log.md`,
   and `artifacts/nightly/latest.json` when the run finished.

It sends no notification of any kind; the coordinator reads the summary. It never kills anything:
- one nightly at a time: `artifacts/nightly/nightly.lock` holds the pid, and a second nightly exits at once ("already active");
- its gate run takes a slot like any run and waits in the queue;
- SIGTERM to the nightly stops only its own runner.

**An impact-map miss** is a step that the last release skipped as CACHED and that FAILs or TIMEOUTs in the nightly **at the same
key**. Nothing in its set moved since the PASS that served the release, yet it fails, so the map lacks an input (or the step is flaky).
A failing step whose key moved is listed as "explained", not as a miss. Each miss goes to `impact-map-misses.json`, with:
- the fail lines;
- both keys;
- the PASS it was served from;
- the files changed between that PASS's head and the nightly's.

A ready line goes to `misses-log.md`. The nightly never writes to a tree, so **the coordinator pastes that line into the log below
and commits it**, and widens the map.

**Install** (persistent machine config; the coordinator runs it from the main checkout once this is merged):

```sh
node tools/nightly-install.mjs --print      # the filled plist (tools/launchd/dev.larattalabs.architect-nightly.plist), nothing written
node tools/nightly-install.mjs              # writes ~/Library/LaunchAgents/dev.larattalabs.architect-nightly.plist, launchctl bootstrap gui/<uid>
node tools/nightly-install.mjs --uninstall
```

The plist runs `node <checkout>/tools/nightly.mjs` at 02:00. Its environment is PATH (the mise node, Homebrew, system), HOME and
JAVA_HOME, nothing else: no `ANTHROPIC_*`, no `GATE_NOTIFY`. Logs go to `~/Library/Logs/architect-nightly.log`.

### Coverage-based inputs (2026-10-22; code and offline proofs, no in-game run yet)

The whole-tree classes made any mod/src/main or kit/lib change re-run every in-game step. In **coverage mode**
(`tools/lib/step-coverage.mjs`, `gate-cache.json` `coverage`, on by default; `--no-coverage` turns it off) an in-game step's PASS is
keyed by what that run touched. The key covers:
- **Java classes.** Every JVM of the shard logs its class loads (`JAVA_TOOL_OPTIONS=-Xlog:class+load` into
  `<run>/coverage/jvm-<pid>.log`). A step owns the logs of the JVMs alive at its start (a reused client counts with everything it
  loaded before) and of the JVMs written during it. Each class maps to its source file; a class with no file of its own widens to
  its package's files.
  - Loaded is a superset of executed, which is JaCoCo's class level. It needs no agent: JaCoCo isn't in the gradle cache, and adding it
    would mean a download. JaCoCo can replace it later.
- **Node files.** The step's own trace, plus the trace of the client the runner started: the sidecar and its workers.
  - The tracer follows worker threads through a wrapper that also gives the tracer's environment to a worker started with
    `env: {}` (the region pool).
  - The kit tools the sidecar spawns with `minimalEnv` are not traced; their closures are in the safety set.
  - The region CLI runs under Node's permission model, where no tracer can load. A step whose client stats `kit/tools/region.mjs`
    (the sidecar's `runKit`, just before it spawns the CLI) gets the CLI's closure and every region program
    (`coverage.whenTouched`). A kit test guards that contract.
  - It records `mkdirSync` as evidence of a gradle run in the source checkout.
  - The JVM log never rotates (`filecount=0`).
- **The step's static, non-class inputs.** Its drivers' module closure and its traced data. The `gradle` class is kept only when
  the run took the source checkout's gradle lock.
- **The safety set**, always in (`coverage.always` and the closures of `coverage.alwaysRoots`), with the reason for each group in
  `coverage.why`:
  - build files and resources;
  - mixins (applied as bytes, never loaded under their own name);
  - the `*Registry*`, `*Codec*`, `*Serial*` and `*Nbt*` sources, and the fabric.mod.json entrypoints;
  - devserver (its generated hooks);
  - `sidecar/src` (one esbuild bundle);
  - the kit tools the sidecar spawns with a minimal environment (untraced), the kit data it reads, the region worker, and
    kit/lib/region/plan.mjs (the KIT_INFO probe reads its constants);
  - the kit files the jar carries.
- **The runner's own code** (`runnerKey`: gate-run.mjs, hosts, splits, turbo, shard-auto, gate-history, the tracer) is in every
  key, coverage or not. The fail audit below found 8 past FAILs that only a runner change explains.

**The run-level build artifact** (`tools/lib/build-artifact.mjs`, `gate-cache.json` `build`) is the design that makes a Java change
cheap.
- **What it is:** the mod (main, client, test), devserver and apitest classes, compiled once per hash of their inputs (all of
  mod/, devserver/ and apitest/, plus the kit files the build reads and the compiler), offline, in `../architect-mc-buildcache`.
  A manifest of every class file's digest goes to `artifacts/build-cache/<hash>.json`. A build of 1283 classes takes about 40 s
  and is byte-identical across worktrees.
- **What a coverage-mode key holds instead of the build:** the bytecode digests of the classes its run loaded, instead of their
  Java sources. It keeps the `gradle` class only when its run took the source checkout's gradle lock: gradle may serve those
  tests from its cache with no class log, and a `--tests` filter takes new test classes by name.
  - A source edit that compiles to the same bytecode, or a change to a class the step never loaded, leaves the key alone.
  - A constant inlined into a loaded class changes that class's bytecode, so the global constant rule only applies to PASSes
    recorded without an artifact.
- **The guard:** a build that fails, or can't run, gives no coverage key, so every coverage-mode step runs.
  - A compile failure is kept in the manifest cache. A timeout, a lock problem or a dirty cache worktree is not, so the next run
    retries.
  - The build environment drops `LAB_UI_DIR`, `ORG_GRADLE_PROJECT_*` and the gate's tracing variables.
- **Not the whole artifact's hash** in every key. That hash moves on any Java change, which would put the floor back at "every
  step". The per-class digests are that guard at the granularity a step actually consumes.
- **The gradle-cwd steps** (unit-mod, umt, p3-lint) are the build and its whole test suite, so they keep the whole trees.
- **Not yet done:** clients still compile their own run worktree (loom `runClient`). Making them load the shared classes would only
  save time, and needs an in-game run to prove; the keys don't depend on who compiles.
- `--no-build-artifact` keeps coverage keys on sources.

A coverage PASS is looked up by recomputing its key over the set it recorded (`lookupCoverage`, the newest twelve PASSes of the step):
- a changed file in the set re-runs the step, and that run re-records its coverage;
- a changed file outside the set skips it;
- **a constant variable changed in any Java file** invalidates every coverage PASS, because javac inlines constants into the
  classes that use them. A constant variable is a `final` field or local of a primitive or String type with an initialiser, or any
  such field in an interface or annotation. Every one is parsed from both versions of each changed file, across lines and
  concatenations (`constantDecls`).

**Auto `--full`, narrowed (PROPOSED, awaiting approval).** The impact rules' `engine` tag no longer forces `--full`. Instead it is
forced by the Minecraft or dependency versions, the build files, and a named engine list (`release.autoFull.enginePaths`):
- the journal and its store: `journal/**`;
- the block-write queues: `batch/**`, `site/RegionQueue`, `TickDeferral`, `ChunkTickets`;
- the placement and removal core: `site/TemplateWriter`, `PlaceJob`, `RestoreJob`, `InfraJob`, `SiteJournal`, `Sites`, `Groups`,
  `Batches`, `Placement`, `placement/Reconcile` and `region/RegionsImpl`;
- the files the UMT rule names as undo-critical: `site/FluidRearm`, `TileCheck`, `LotMask`;
- placement tracking: `placed/**`;
- the world-update mixins: `mixin/**` and the mixins json.

kit/lib/** and region/RegionFluids.java no longer force it: the coordinator ruled RegionFluids not engine, though the UMT rule lists
it.

**Proofs (offline; the exact counts need the first traced turbo run, which records every step's coverage).**
- **A real JVM** (`./gradlew test --tests *IrRoadExtTest` with the class-load log): 353 `dev.larattalabs` classes, every one mapped
  to its source. The coverage set it gives an in-game entry holds 91 of the 345 mod/src/main files.
- **5 recent commits: the design as built** (`tools/step-cache.mjs coverage-select <commits> --bytecode`). Both sides are compiled
  and the changed class files listed. A coverage-mode step is keyed by:
  - **its drivers' eager closure.** That is the top-level `import`s, which always load. A lazy `import()` counts only when its run
    executed it, because the trace records it.
    - Guard: a driver edit that starts executing a lazy path changes the driver file, which is in the eager set, so the step
      re-runs and is re-traced (kit test "drivers count by their eager imports").
    - The CI check still walks the full static closure (`closure` in the map; `eager` is new).
  - **gradle runs in the source checkout, three cases:**
    - **compile only** (`compileJava` for api-compat): the build artifact compiled the same sources. The class files the driver then
      reads are keyed by their bytecode (`classReads`).
    - **tests with readable filters** (`gateRerunTests` makes the JVM run and log; the runner sets it only for these steps):
      - the test sources the patterns select at each commit (`@tests:<pattern>`; Gradle also matches Class.method, so a wildcard
        selects every test file whose name or text holds its fragments);
      - the repo paths those test sources name (`javaTestRefs`): literal `"../X/..."` and `Path.of("..", "X", ...)` paths for
        any X (kit, sidecar, scenarios, ...), a node module's closure, or a directory's tree. A source that builds a path any other
        way (`Path.of("..", var)`, `Path.of("..")`, `resolve(var)`) makes the whole repository its input;
      - the test resources;
      - the loaded bytecode.
    - **otherwise:** the whole build and test tree. That now applies to 3 steps only: f2-unit, f2-harvest and
      6cf2-scenario-scatter, whose `gradle(args)` wrapper passes a parameter.
  - **gradle runs, as recognised:**
    - A run is any `gradlew` the step's node processes launched: srcGradle's lock, or the tracer's record of the launch (kind
      `x`; `spawnSync('./gradlew', ...)` called directly counts).
    - A call is a test run unless every task it names is compile-only (compileJava, classes, testClasses, jar, headlessLaunch,
      ...). build, check, umtLong and `:x:test` run tests.
    - An `args` variable is resolved to its nearest array literal before the call.
    - A message string that names gradlew is not a call.
  - **kit-reuse** (a driver whose closure loads kit-reuse.mjs, eagerly or through `await import`) delegates its kit tests to unit-kit. Its coverage
    PASS serves only a run that holds unit-kit, which re-runs on any kit change.
  - **`coverage.lazyAlways`** (gate6a-stubs.mjs) lists lazy paths that run state, not code, decides: they stay in.
  - **The 8 drivers that were unreadable:** f1, t1, t2, p0, s2, d and k1a only compile (api-compat), and pt2's
    `*${t.split('.').pop()}` template ranges over literal names, so it is readable. Gradle calls are now read from the code (comments
    stripped), with an `args` variable resolved to its array literal.

  "At least" is what runs whatever the recorded coverage says. Of the 210 cacheable steps:

  | commit | change | class files changed | map mode runs | coverage at least |
  |---|---|---|---|---|
  | e5dafb64 | kit isLeaves (kit/lib/forms/states.mjs) | 0 | 209 | 15 |
  | 0bb0c89e | RS realised provenance (11 files) | 14 | 204 | 15 |
  | f5c73633 | RegionHash (5 files) | 6 | 204 | 9 |
  | 8b4da151 | RS-b farmland (3 files) | 5 | 204 | 10 |
  | 4d891398 | RP verify (1 Java file) | 2 | 204 | 8 |

  - **Who is in the floor:**
    - unit-mod, umt, p3-lint and p3-lint-long (the build and its tests);
    - f2-unit (its filters are unreadable);
    - sch-unit, pt2-unit and rs-unit, whose selected Java tests build repo paths opaquely (ApiP0Test's `Path.of("..", file)`), so
      the whole repo is their input;
    - the steps whose eager drivers or data moved: the RS steps for 0bb0c89e, rsb for 8b4da151;
    - for the kit change: unit-kit, water-lint, the lints and x-unit, which load it eagerly, and mp-unit.
  - **Above the floor**, a step runs only if its run loaded a changed class or a changed node file, a lazily imported driver module
    included (f5c73633 changed `gate6ch-holders.mjs`, which only `gate6ch.mjs holders` loads).
  - **Before:** 157 and 20-30 with the full closure, and 35-50 with the gradle class kept.
- **Why the kit change ran 157 before** (measured): 143 of the 157 held kit/lib/forms/states.mjs only through lazy `import()`s
  in shared drivers that most runs never execute. The main one is `gate6b.mjs base` → `scenarios.mjs` → `kit/lib/region/check.mjs`.
  The eager-closure rule above, approved and built, takes the floor to 15.

  The earlier bound, which kept the gradle class (`--source-gradle`):
- **The same 5 commits, source keys** (`tools/step-cache.mjs coverage-select <commit>...`, against each parent).
  "Coverage at least" is the steps whose drivers, data, runner or safety set moved, which run in any mode; the rest are decided
  by their recorded coverage. Of the 210 cacheable steps:

  | commit | change | map mode runs | coverage at least, worst case | coverage at least, in-game steps without gradle (`--gradle-in-game-off`) |
  |---|---|---|---|---|
  | e5dafb64 | kit isLeaves (1 kit/lib file) | 209 | 169 | 157 |
  | 0bb0c89e | RS realised provenance (11 files: Java, kit, drivers) | 204 | 118 | 40 |
  | f5c73633 | RegionHash (5 files) | 204 | 118 | 50 |
  | 8b4da151 | RS-b farmland (3 files) | 204 | 118 | 37 |
  | 4d891398 | RP verify (1 Java file) | 204 | 118 | 35 |

  - A Java-only change now runs as few as the client-less steps that build the mod in the source checkout, plus whatever touched
    the changed classes.
  - A change to a widely imported kit module (kit/lib/blocks or check) still runs most steps, because the drivers themselves import
    it. Node coverage is at file level, as specified.
- **History** (`tools/step-cache.mjs fail-audit`, every FAIL or TIMEOUT in artifacts/ against the step's last earlier PASS on an
  ancestor commit). 626 records on 2026-10-22; the count grows as runs land:
  - 197 have no earlier PASS on an ancestor;
  - 10 came on the same commit as a PASS: no code change, so a flake, load or environment;
  - 415 had their cause in the step's drivers, data, definition, runner or safety set, so they run in every mode. That count leans
    on the large safety set (devserver and sidecar sources, the Registry/Codec/Serial/Nbt globs);
  - **2 are decided by coverage**, pending its first recording: t3b-ingame after a TileCheck.java change, and sim-jobs after the
    kit/lib/lint changes;
  - 2 have no change in the step's set at all:
    - 6ct2-scenario-route's change was docs only;
    - pt2-ingame failed item 13 (the one known on main) after a change to tools/gate6cpt.mjs, which is not in its set. The audit
      can't tell whether that change caused it.
  - So the coverage half of the proof is still to come: only 2 of 626 records depend on coverage, and none has been recorded
    yet.
  - Before the runner joined the keys, the audit found 10 such holes. The 8 explained by runner changes are why `runnerKey` exists.

### Impact-map misses log

Each line is a nightly's miss: the date, the step, what failed, where it was cached from, and what was done.

| date | step | what | resolution |
|---|---|---|---|

### Measured

Offline, 2026-10-22. The coordinator stopped the first traced warm-up run to keep the machine free for turbo's measurement, so no
real release has run against a warm cache yet.

- **The first traced run** (`artifacts/gate-runs-affected/20261022-161855-release`, `release --full` at 703187d5, 3 shards, stopped
  by SIGINT after 1h50m with 22 steps done):
  - 13 PASSes, each trace inside its set after one `merge`: unit-mod, unit-kit, rs-survival, t3a-look, h-ingame, hy-unit,
    hy-ingame, irr-ingame, k1a-look, 4d-all-full, 4e-orders-full, 5b-chains-full and 6a-crash. They are recorded in the live cache
    (`step-cache.mjs import`), and their sets are marked `verified`;
  - 2 inputs-map misses on the first pass, both widened by `merge`: 5b-chains-full copies kit/ (kit/lint/** was missing), and
    unit-kit stats four bare names at the repo root;
  - fl-unit, f3-unit, voc-unit and vocc-unit failed for two reasons. The source worktree had no `.gradle-home` or
    `sidecar/node_modules` (the drivers run gradle and vitest there; the nightly now clones both). And the slices' "against the
    merge base" items fail on main, where the merge base is HEAD.
- **Selection examples** (`--plan --since <base> --release v0.42.0` on a scratch commit over 8b5e1287; `--assume-warm <base>`
  stands for "a full nightly passed at the base"):

  | the release changes | the rule | the cache alone (`--no-auto-full --assume-warm`) | estimate (rule / cache) |
  |---|---|---|---|
  | one line of docs/PLAN.md | not --full | **18 of 182 run**: the 12 canaries, the probes' evidence (h-probe, y-ingame, cu-survival), 4e-orders-full for the crash suite, and the uncacheable umt-long, apijars and 6b-versionc. 164 CACHED | 2h20m on 2 shards + 2 lanes |
  | one file in kit/lib/forms/ | **--full** (engine) | 164 of 168 run. CACHED: c33-unit and the three lints (their sets are not yet verified: a lint's computed kit imports come in with its first trace) | 5h53m / 5h16m |
  | mod/.../region/RegionFluids.java | **--full** (engine) | 162 of 168 run. CACHED: unit-sidecar, c33-unit, water-lint and the three lints | 5h53m / 5h15m |

  A kit/lib or mod/src/main change re-runs every in-game step, because the jar and the sidecar classes hold it. Docs, a driver, a
  kit test, a lint or a fixture re-run only the steps whose sets hold them.
- **0.41.0's history** (`tools/step-cache.mjs replay --at a6a947bc` over the batch's 34 slice, integration and verify runs, keys
  only): 15 of the 169 steps they ran would have been served at v0.41.0's merge commit. 14 come from the last integration slice
  run at 6d736f80, the batch's final merges having moved kit/lint/shard.mjs, the versions and the merge base under the rest; c33-unit
  comes from aea80cf5. The slices' own branch-head PASSes serve nothing at the merged head. So the saving on a batch release comes
  from the warm nightly at the integration head and from releases that change no jar or kit code, not from the slices' runs.
- **The analysis cache**: `step-cache.mjs import-history --into artifacts/step-cache-history` over every run since the toolchain's
  install (2026-10-21 18:16Z, node 24.22.1) recorded 66 untraced entries for the 13 verified steps (514 older runs skipped). Without
  the verified-set rule it was 435. GATE_STEP_CACHE_DIR points a plan at it; the live cache never takes untraced entries.

## Benches out of the release path (Noah, 2026-10-22)

A release re-judged every bench's timing on the release machine: megaA (11 min), megaB (25 or 85 min), heap, volume, mega-lite,
throughput and the S1-S3 scenarios. Each ran isolated, so nothing else could run beside it. Noah approved four changes on
2026-10-22. Code: `tools/lib/bench-select.mjs` (the rule, pure, tested by `kit/test/gate-benches.test.mjs`); config:
`tools/gate-cache.json` `release.benches`.

1. **The judged benches leave the release path.** The judged list is 4e-megalite, 6a-megaA, 6a-megaB, 6a-megaB-fast, 6a-heap and
   6b-volume (4e-megalite added 2026-10-23, the coordinator: no bar is judged nowhere).
   - They are not release candidates (not in `tiers.release`, dropped from the impact rules' candidates).
   - The nightly (`release --full --nightly`) runs them isolated with their timing judged, and records each PASS in the step cache
     with `nightly: true`. Only those PASSes are recorded for a judged bench. A contended or recorded-timing PASS never serves.
   - A release then decides each bench with **the bench rule** below, and `--plan` prints the decision and the reason.
   - The functional checks (exactness, undo, counts) still run wherever they ran in `change` and `slice`: the impact map still
     names megaA and volume in the region rule and mega-lite in the placement, sites, kit and driver rules, timing recorded, not
     isolated. No check is dropped.
   - The scenarios S1, S2 and S3 (`nightlyJudged`) are ordinary cache candidates at a release, with their timing recorded and not
     isolated. Only the nightly judges their timing.
2. **megaB's full walk (about 85 min)** runs in the nightly once a week (`release.benches.megaB.weeklyDay`, `sun`: the nightly
   that starts Sunday about 02:00), on demand (`node tools/nightly.mjs --megab-full`), the first time, and when a bench-sensitive
   group naming it changed since the last full walk, and again on the next nightly when the last full walk did not PASS. The other
   nightlies run `6a-megaB-fast`. Its two resilience rows run as an
   ordinary step, **`6a-resume`** (below).
3. **4e-megalite and 4e-throughput fold into 6a-megaA** where they overlap (the table below). Both are out of the release tier and
   stay runnable by name (`--only 4e-megalite`, the `regress` chain).
   - **4e-megalite** stays a bench and is a judged bench (decision, 2026-10-23): the nightly judges the three tick bars megaA has
     no equivalent for (one lot's undo, the 1 ms and 10 ms budgets), with its others, and a release reuses that result through the
     bench rule like the other benches (the placement core and block-write queue groups name it). Its functional checks run where the
     impact map picks it in `change` and `slice`, as before.
   - **4e-throughput and 4e-throughput-smoke** run for their functional checks where the impact map picks them, with
     `"timing": "recorded"`: their bars are recorded in every tier and chain, and `--judge-timing` judges them.
4. **6a-heap is nightly only.** A release never runs it. `--plan` shows its last nightly result.

### The bench rule (a release that is not `--full`)

For each judged bench, megaB's two walks counting as one bench:
1. The latest nightly that ran it (`artifacts/nightly/<date>/summary.json` and its runs, finished or stopped) gives its result: the
   step's terminal status (PASS, FAIL, TIMEOUT, NOISY, ERROR; a yielded, pending or running step has none). Only that result
   counts: if it was not a PASS, the release runs the bench. An older PASS is not used.
2. The release runs the bench when any of these holds. Each reason is printed.
   - no nightly has run it yet;
   - its latest nightly result is FAIL, TIMEOUT or NOISY;
   - a path of a bench-sensitive group naming it changed between the nightly's head and HEAD (`git diff <head> HEAD`, two-dot, so a
     commit the nightly had and HEAD lacks counts too);
   - its step-cache entry from that nightly no longer holds at HEAD (`entryStillValid`):
     - a coverage entry (an in-game step, once coverage is recorded) is checked by recomputing its key over the set it recorded
       and the loaded classes' bytecode;
     - a map-mode entry is checked by its key at HEAD.
     Either way the key covers the definition, the toolchain, the runner code and the modes, so a change to any of them re-runs
     the bench;
   - `--no-cache` (nothing is reused).
3. Otherwise the release **reuses** that PASS and runs nothing for the bench.
4. megaB runs its full walk when its sensitive paths changed, and the fast walk otherwise. When megaB (either walk) runs at a
   release, `6a-resume` drops: its `supersededBy` is `["6a-megaB", "6a-megaB-fast"]`, and `supersededBy` now takes a list. The
   nightly keeps 6a-resume beside megaB (about 25 min): a bench's PASS never serves 6a-resume, so its own nightly PASS is what lets a
   release skip it as CACHED.
5. 6a-heap: never run at a release (`nightlyOnly`).

`--plan`, the runner log, `summary.json` (`tier.benches`) and SUMMARY.md ("Benches") list every bench:
- **REUSED**, with the nightly's date, head, run dir and log;
- **RUN**, with the reason and the changed paths;
- **NIGHTLY** (heap), with its last result.

They also show when each scenario's timing was last judged. Under `--full` they list what the run adds:
- the nightly: every judged bench and megaB's walk with its reason;
- any other `--full` (by hand, or the auto rule): every judged bench but heap, and megaB's full walk.

`--nightly-dir DIR` (or `GATE_NIGHTLY_DIR`, plumbing: never in a key) reads the nightly records from another root (the proofs below).

**What else moves a bench's key** (so the release re-runs it although no measured code changed): the runner code (`runnerKey`), the
toolchain, the bench's chain entry and drivers, and its modes, as for every cached step. 6b-volume and the scenarios S1-S3 also hold
`originMain` (their closures diff against origin/main through `plan-cache.mjs` and `gate6chy-core.mjs`): a code change on origin/main
or a new merge base since the nightly moves their keys. megaA, megaB, heap and 6a-resume hold no such flag.

**In `change` and `slice`** a judged bench is now looked up like any step. A nightly PASS for the same key, or the same coverage,
serves it as CACHED there. That PASS ran the same functional checks on the same code, isolated, so no check is lost. Before, a judged
bench was never cached and always ran.

### The bench-sensitive paths (PROPOSED for the coordinator's review)

The coverage, or the input set while coverage is not yet recorded, already re-runs a bench whose measured code changed. This short
list is a guard on top, for the code whose cost the benches exist to measure. `release.benches.sensitive` (paths under
`mod/src/main/java/dev/larattalabs/architect/` unless shown):

| group | paths | re-runs |
|---|---|---|
| placement core | `site/Placement`, `PlaceJob`, `TemplateWriter`, `RestoreJob`, `Groups`, `Batches`, `Sites`, `SiteJournal`, `journal/**` | mega-lite, megaA, megaB (full), heap |
| block-write queue | `batch/**`, `site/RegionQueue`, `RegionItems`, `TickDeferral`, `ChunkTickets`, `region/TicketGate`, `mixin/BlockStateUpdateMixin` | mega-lite, megaA, megaB (full), heap |
| region tiles | `region/RegionsImpl`, `TileStream`, `Packed`, `Ir`, `BlobPut`, `RegionBlobs`, `LiveBlocks`, `Realised`, `RegionStore` | megaA, megaB (full), heap |
| scheduler | `region/PendingTicks`, `mixin/LevelTicksMixin`, `LevelTicksAccessor`, `region/MsptTrace` (the trace the tick bars read) | megaA, megaB (full), heap, volume |
| sidecar tile path | `sidecar/src/regions.ts`, `regionpool.ts`, `region-worker.mjs`, `pool.ts`, `kit/tools/region.mjs` | megaA, megaB (full), heap |
| volume survey | `region/volume/**`, `region/RegionSurvey` | volume |

Heap is listed so the nightly's megaB choice and the plan read the same groups. A release never runs heap.

### `6a-resume`: megaB's resilience rows as an ordinary step

`node tools/gate6a.mjs resume`: the configuration-B walk that `megaB` runs, shared code (`walkB`), on the fast walk (8 s dwell,
then straight to unfinished cells), in its own world (`G6A Resume`) and evidence (`gate6a/resume-B.json`), so it never clobbers a
megaB run. It is not a bench: no `bench` resource, not isolated.
- **Where it runs:** `tiers.release.always` (a cache candidate), and the slice lists of the region, placement-and-batch and
  sidecar-region impact rules.
- **Its rows are megaB's rows**, the same `check` calls with the same thresholds; only the prefix differs. None is a BAR in either
  step:

| megaB row (`megaB: ...`) | 6a-resume row (`resume: ...`) | threshold |
|---|---|---|
| `${state}, N failed items` | the same | PLACED and 0 failed |
| `resumed S s after the player reached a waiting lots-2 item after the relog (item)` | the same | S <= 60 |
| `resumed S s after the sidecar came back, at a waiting ways item (item)` | the same | S <= 30 |
| `REGION_PROGRESS events for every stage with items (...)` | the same | every stage with items seen |
| `per-stage seconds and chunks loaded {...}` | the same | every stage recorded |
| metrics `mode`, `wallSeconds`, `relogResumeSeconds`, `sidecarResumeSeconds` | the same, from `resume-B.json` | recorded |

The relog and sidecar rows are time thresholds, though functional ones (did it resume at all, within a minute). Read them with the
step's load, as for any step. 6a-resume runs them without isolation, beside other steps; a loaded machine could fail them where the
isolated megaB passed. **The rule (the coordinator, 2026-10-23):** 6a-resume stays unisolated; if it ever fails on its relog or
sidecar threshold under load, set `"isolate": true` on it (and the `bench` resource, so the runner isolates it: it then runs alone,
about 25 min).

**Two fixes to the shared walk (2026-10-23).** megaB failed on main for reasons unrelated to what it measures, and 6a-resume would
inherit both:
- **The empty stage.** MEGA's plan now has an empty `lots-4` (0 items). It places nothing, so it has no PLACING event, and the
  REGION_PROGRESS row failed the full walk on 2026-10-22 (`gate-runs-0410/20261022-043748-release`) for that stage alone. The row
  now asks for every stage *with items*. The per-stage record keeps each stage's item count.
- **The mob stall.** A lot waiting OCCUPIED holds a mob in its box (a resting polar bear) and never starts. It stalled the walk's
  final wait for its whole hour (`gate-runs/20261017-232136-slice`, and this branch's first proof run). The walk now clears the mobs
  while it waits, as megaRun has since 6c W.

No other row changed.

### The fold: every metric and assertion, before and after

"Judged" means the release (before) or the nightly (after) judged it. "Recorded" means it is printed and kept, never failing a run.

**4e-megalite** (256x256 pad, lots and roads through the batch queue; stub sidecar, 4e client)

| row | before | after |
|---|---|---|
| check: the pad, lots and 8 roads placed at 4 ms (LOAD_BOUNDED) | every tier | the same (4e-megalite, wherever the impact map picks it in change/slice; the nightly; a release whose change touches it) |
| check: resumed across a relog | every tier | the same |
| check: one lot's undo leaves the pad exact | every tier | the same |
| check: the group undo is exact (hash) | every tier | the same; megaA's E-normal checks the region group undo too |
| check: 1 ms and 10 ms placed everything | every tier | the same |
| BAR: 4 ms Architect's own tick <= 50 | judged at release | judged in the nightly (and at a release that runs it); megaA judges the same at its pinned 4 ms budget |
| BAR: the group undo's own tick | judged at release | judged in the nightly; megaA judges its group undo's own tick too |
| BAR: one lot's undo own tick | judged at release | judged in the nightly (no megaA equivalent) |
| BAR: 1 ms and 10 ms own tick | judged at release | judged in the nightly (no megaA equivalent) |
| metrics cellsPerSecond4ms, groupUndoSeconds, groupUndoOwnMsMax, groupUndoMsptMax, bytesPerCell4ms | recorded | recorded (unchanged) |

**4e-throughput** (village + roads at 4 ms, warm-up + median of 3 or 6) and **4e-throughput-smoke** (one run)

| row | before | after |
|---|---|---|
| check: the measured runs placed everything | release (rotation) and slice | the same (slice placement rule; a release candidate; the nightly) |
| BAR: the measured runs' own tick max <= 50 | judged at release | recorded; **judged in megaA** (own tick at 4 ms) |
| BAR: median >= 15k cells/s at 4 ms | judged at release (placement-touching) | recorded; **judged in megaA**: "realise >= 15k cells/s first tile to last at 4 ms", with a new check that megaA ran at the 4 ms budget (`budgetMs`). The workload differs (megaA realises a 1000x1000 region, throughput a village), so this is the same bar on megaA's workload |
| smoke: check placed everything; BAR own tick | release (rotation), change (driver rule) | the same; the BAR recorded; the smoke drops when 4e-throughput runs too (`supersededBy`) |
| metrics medianCellsPerSecond, spread; smoke cellsPerSecond, mode | recorded | recorded (unchanged) |

**6a-megaA** (unchanged rows, one added)

| row | before | after |
|---|---|---|
| check: PLACED; 0 failed items; no chunk generated during realise; journal <= 1 byte/cell and index <= 8 MB; wire <= 4 bytes/cell; group undo completes; E-normal | every release, region slices | nightly, a release whose change touches what it measures, region slices (unchanged there) |
| BAR: realise >= 15k cells/s; own tick p99 <= 25 and max <= 50; liveness 45 min; held-ticket wait <= 30 s; index commit p99 <= 100 ms; writer starved <= 5%; group undo <= 600 s and its own tick | judged every release | judged in the nightly, and at a release that runs it |
| **new** check: realised at the 4 ms placement budget (`budgetMs`; the driver pins `/architect budget 4`) | - | everywhere megaA runs |
| metrics cellsPerSecond, msptMax, undoMsptMax, wholeTickP99, wholeTickMax, undoSeconds, mismatches; **new** budgetMs | recorded | recorded |

**6a-megaB / -fast, 6a-heap, 6b-volume, the scenarios S1-S3**: no row changes. Where they run:

| step | before | after |
|---|---|---|
| 6a-megaB / 6a-megaB-fast | every release (full on engine releases, else alternating) | nightly (fast daily, full weekly, on demand or on a sensitive change); a release whose change touches them; the resilience rows every release as 6a-resume |
| 6a-heap (check: completes under the capped -Xmx; BAR: heap <= baseline + 1 GB) | every other release | nightly only |
| 6b-volume (BAR: 0 ticks over 50 ms; checks: same sha twice, the file reads back, the five classes) | every release, region slices | nightly, a release whose change touches it, region slices |
| 6b-scenario-s1, 6c-scenario-s2, 6c-scenario-s3 | every release, timing judged, isolated, never cached | release: a cache candidate, timing recorded, not isolated; nightly: judged, isolated |

**Decided (the coordinator, 2026-10-23).**
- 4e-megalite is a judged bench, so every timing bar is judged somewhere: its three bars without a megaA equivalent (one lot's
  undo, the 1 ms and 10 ms own tick) in the nightly.
- The scenario canary keeps rotating S1, S2, S3 and S7, one per release (`release.canaries.scenarioRotation`), timing recorded
  there: cheap functional insurance.
- 6a-resume stays unisolated (the rule above).

### Proofs

No real nightly has run with `--nightly` yet, so the selection proofs fake one.
- **Where:** `artifacts/gate-runs-benches/selection/` holds the outputs, with the two scripts that made them: `fake-nightly.mjs` and
  `proofs-ab.sh`.
- **The fake nightly** (`fake-nightly.mjs <checkout> <out> <date>`) is one finished nightly at the branch head (173dc25d), with every
  bench a PASS.
  - Its step-cache entries are keyed exactly as gate-run keys them there.
  - The in-game judged benches are **coverage entries**: a hand-picked set (the drivers' closure and a few Java sources) and their
    classes' bytecode from the run-level build artifact. They are fake sets, so the reuse goes through the coverage branch of the
    rule (`entryStillValid`).
- **How the plans read it:** `GATE_NIGHTLY_DIR` and `GATE_STEP_CACHE_DIR` point at it. Each plan is
  `release --since 173dc25d --assume-warm 173dc25d --plan` on a throwaway commit over the head, in a throwaway worktree.
  `--assume-warm` makes every other step CACHED, so the plan shows what a warm release would run.

| proof | the change | the benches (`--plan`) | release steps |
|---|---|---|---|
| (a) | one line in docs/GATES.md | **0 to run, 3 reused**: megaA, megaB (its fast walk) and volume REUSED from the nightly of 2026-10-23 (head 173dc25d7), each "its coverage (N set entries) is unchanged", with its run dir and log; heap NIGHTLY (last result PASS); S1-S3 "timing last judged in the nightly of 2026-10-23: PASS" | 11: the canaries, the probes' evidence steps and the uncacheable ones; no bench |
| (b) | a comment in site/Placement.java (placement core) | the auto `--full` rule fires (Placement.java is on the engine list): megaA, megaB's full walk and volume, not heap | 201 (--full) |
| (b), `--no-auto-full` | the same | **2 to run, 1 reused**: megaA RUN and megaB RUN as the **full** walk, both "bench-sensitive code changed since the nightly of 2026-10-23: placement core (site/Placement.java)"; volume REUSED (its coverage holds no Placement code); heap NIGHTLY | 158 |
| (b2) | a comment in region/Heights.java: in megaA's and megaB's coverage, not on the sensitive list, not in volume's coverage | **2 to run, 1 reused**: megaA RUN and megaB RUN as the **fast** walk, "a file its coverage holds changed since 173dc25d7"; volume REUSED | 158 |

The release step counts beyond the benches come from `--assume-warm`'s map-mode keys: a Java change re-keys every in-game step
without recorded coverage.

**(c) The unit tests.** `kit/test/gate-benches.test.mjs` has 8 tests:
- the config (no judged bench left in the release lists);
- the sensitive groups;
- reuse;
- every reason to run;
- megaB's walk at a release and in the nightly (weekly, on demand, first time, after a failed full walk, on a sensitive change);
- heap nightly only;
- a manual `--full`;
- reading the nightly records (a stopped nightly's FAIL wins over an older PASS; yielded, pending and running steps don't count).

`kit/test/step-cache.test.mjs` adds one: a judged bench is recorded only from the nightly, judged and isolated, and
`entryStillValid` holds until its key moves.

**(d) 6a-resume in game, with megaB-fast and megaA** (`artifacts/gate-runs-benches/`, `change --only ...`, timing recorded):

| run | head | step | result | relog / sidecar resume | wall |
|---|---|---|---|---|---|
| `20261023-021405-change` | 46085b32 | 6a-megaA | PASS, 15 ok: "realised at the 4 ms placement budget (budgetMs 4)", realise 51389 cells/s at 4 ms, own tick p99 10.3 / max 36.6 ms, group undo 218 s, E-normal 28 mismatches (cap 1018) | - | 9m38s |
| the same | 46085b32 | 6a-megaB-fast | stopped by hand after 1h03m: the walk was done, but a lot waiting OCCUPIED (a mob) held the final wait. That is the mob stall fixed above | - | - |
| `20261023-045005-change` | 8ffcd670 | 6a-megaB-fast | PASS, 5 ok | 2.0 s / 1.0 s | 39m42s |
| the same | 8ffcd670 | 6a-resume | PASS, 5 ok, `resume-B.json` and the world `G6A Resume` | 1.0 s / 2.0 s | 16m48s |

The two steps' check rows are the same once the prefixes (`megaB:` / `resume:`), numbers and item keys are masked:
`rows-diff-resume-vs-megaB-fast.txt` (made by `rows-diff.sh`, beside it). Both rows include the empty-stage fix ("every stage with
items": ground, ways, lots-1..3). The load average was 12.5 at the start of megaB-fast and 7-9 during 6a-resume.

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
- **`supersededBy`** (step field, "Gate waits" below): the step is dropped when the named step, which runs every assertion it runs, is in the same run.
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
  `tools/lib/kit-reuse.mjs`. These are the whole-kit-suite checks (gate6cv, cw, cx, ct1, ct2, cs2, cd, gate7ak1, gate7ak1b; since "Gate waits" also gate6ch and its H halves, gate6chy, ct3a and ct3b),
  the "goldens that must not move" checks (the same drivers plus cb, cmp, cf1, cf2), and "P0's tests after" (cd, gate7ak1,
  gate7ak1b). Each prints a `kit: reused from this run's unit-kit ...` line.
- A report is reused only when it is complete, this checkout's `kit/` is clean at that tree, and every requested file is in it
  with at least one test and no failure. The only flag allowed is `--test-skip-pattern`.
- A slice's own kit tests always run: a name pattern, a pass-count threshold, the test names, or the diagnostics.
- Without `unit-kit` in the run (`--only`, a named chain, the verifier's re-runs), or when a file failed, the driver runs the files
  itself, exactly as before. So a failing kit file fails the driver's check as before, and `unit-kit` fails too.
- The unit steps that read the report `waitFor` `unit-kit` (13; 18 since "Gate waits" added h-, hy-, t3a-, t3b- and ha-unit).
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

## Release versions: one command at merge (2026-10-20)

Each batch integration used to spend about an hour on the same chores: set the versions in ten places, stamp the slices'
placeholders, re-cut the goldens that record `kitVersion` (crossings_demo_flat's frozen volume by hand), and fix the tests that
hard-coded the last version. `tools/release-version.mjs` does all of it.

**Slices never set a version number.** They leave `ArchitectApi.VERSION`, `mod_version`, `PLAN_API`, the kit versions and the
catalogue golden's header as main has them, and stamp what they add with the placeholder **`NEXT`**:
- a new or changed catalogue entry: `"sinceApi": "NEXT"` in `kit/schemas/plan.json`, then the golden regenerated as usual
  (`JSON.stringify(planCatalogue(), null, 1)`);
- a new API member: `Since NEXT.` (or `since NEXT`, `@since NEXT`) in its javadoc, under `mod/src/main/java` or `mod/src/client/java`.
  Only uppercase `NEXT` right after "since" counts, so prose and constants named `NEXT` are untouched.
- A slice test never pins the API or kit version: it asserts "at least" its floor (`IrStale.semverCompare(ArchitectApi.VERSION,
  "1.37.0") >= 0`, `semverCompare(KIT_VERSION, '0.38.0') >= 0`) or reads the constant. A stamp it checks is `NEXT` on the slice and
  the released number afterwards, so check it as one of the two, or read the archived catalogue once released.
- A slice that changes the catalogue's entries still archives the old golden (`kit/test/fixtures/plan/catalogue-<x>.json`) and
  bumps `catalogueVersion` itself; when two slices did, the coordinator's `--catalogue` sets the batch's number.
- `0.99.0` is the tests' "a newer kit" sentinel (PlanStaleTest, region-format2, gate6b): never use 0.99.x as a release or a dummy.

`NEXT` passes the kit's checks (`tools/catalogue-since-check.mjs`, `kit/test/release-version.test.mjs`) only off a release context
(`tools/release-context.mjs`): `ARCHITECT_RELEASE=1|0` wins; in GitHub Actions a `v*` tag or a push to main is a release, a PR is
one when it comes from `integrate/*` or `release/*`; locally the branches main, `integrate/*` and `release/*` and a HEAD carrying a
`v*` tag are. Slice branches and the runner's detached run worktrees are lenient.

**The coordinator, at merge** (on `integrate/<batch>`, after the slices merged):

```sh
node tools/release-version.mjs --api 1.38.0 --mod 0.41.0 --kit 0.39.0 [--catalogue 10]   # set, stamp, re-cut, verify; prints a summary
node tools/release-version.mjs --check                                                  # what CI and the publish workflow run
```

- **Sets** every version (`ArchitectApi.VERSION`, `PLAN_API`, the golden's `api`; `mod_version`; `KIT_VERSION`, `EVAL_KIT_VERSION`,
  `IrStale.KIT_VERSION`, the golden's `kitVersion`; with `--catalogue`, `catalogueVersion` in plan.json and the golden). Each edit
  replaces one line, anchored on `impact.versionConstants`' patterns (exactly one match per file, or it refuses), so the bump stays
  a version-only diff. A version below the tree's is refused (`--allow-lower`).
- **Stamps** every `NEXT` with the API version, and every legacy semver placeholder: a `sinceApi` or `Since x.y.z` above the last
  `v*` tag's API (an in-flight slice's own guess such as 1.38.0). The summary lists each stamp by file and line.
- **Re-cuts the goldens that track the kit**: every `scenarios/goldens/<id>.json` whose `kitVersion` is at or above the last
  tag's kit (today crossings_demo_flat, links_demo, links_demo_flat; s1, s7 and the others keep the kit they were cut with).
  `--goldens a,b` names them instead. Each is re-planned by `kit/tools/region.mjs plan` in a fresh process (it reads the constants
  just written) over its committed survey, params, seed, claim (with its y), roles and keepOut. Its frozen volumes go in by
  `--volumes`, each copied to a file named by its **ARVX sha** (`ir.volumes[].sha`, crossings_demo_flat's 9a00f18a), not the blob
  sha it is stored under (fb508da2): without them the re-plan silently drops the tunnels.
  The IR also records the planning Node's major (`node`, "24" in game); the re-plan passes the golden's own by `--node` (new on
  `region.mjs plan`), so a coordinator or CI on another Node (CI runs 22) re-cuts and checks it alike.
- **Verifies** each re-cut before writing it: the IR may differ from the committed one in `kitVersion` (and `programSha`, which
  is the program file's sha and is reported when it moves) only, checked by a full JSON walk; the blobs byte for byte; the tile
  shas (`tools/scenarios.mjs` `tileShas`, 1 worker = 4 shuffled) and cells exactly the header's. Only the header's `irSha` and
  `kitVersion` lines are rewritten. Anything else fails loudly with the differing paths, and **every file the run wrote is put
  back**, so a refused run leaves the tree as it was.
- Finally the tree must pass the check below.

**`--check`** writes nothing and fails (exit 1) on: API, kit or catalogue values that differ; the values `--api/--mod/--kit/
--catalogue` when given; a version below the last tag's; any `NEXT` left (`--lenient` allows them: that is what the kit test
does off a release context); a catalogue golden that is not `planCatalogue()`; a `sinceApi` above the API; a tracked golden at
another kit than the tree's; a tracked golden whose committed inputs no longer re-plan to its `ir.json` byte for byte. Wired in:
- `kit/test/release-version.test.mjs` runs it on the tree (part of `unit-kit` and CI's kit tests; strict on a push to main);
- `.github/workflows/publish.yml` runs `--check` on every `v*` tag before publishing;
- the impact rule "release versions" maps the tool, `release-context.mjs` and `catalogue-since-check.mjs` to `unit-kit`.

The kit test also unit-tests the tool on a temp copy of the files it touches: the sets, the `NEXT` and legacy stamps, the re-cut
(only `kitVersion` and `irSha` move), a planner that now plans differently (refused, every file restored byte for byte),
crossings_demo_flat re-planned without its volume (refused: anchors, parts, budget, the volume blob and four tiles differ), the
pure verifier, and the check's failures.

**Measured (2026-10-20, scratch bump on a detached HEAD, never pushed):** `--api 1.37.9 --mod 0.40.9 --kit 0.38.9` over v0.40.0
took **2.9 s** (8 constants, 3 goldens re-cut with their tile shas) and `--check` **1.7 s**. The diff: the 8 constant lines, each
golden header's `irSha` and `kitVersion`, and each `ir.json` equal to the committed one with `"kitVersion":"0.38.9"`. On it the
kit suite passed (670 tests; the tool's own test, which had pinned 0.38.0, was fixed to derive its numbers), sidecar `npm run check`
758/758, mod `./gradlew build --offline` 742 tests, 0 failures. In game, `node tools/gate-run.mjs change --since origin/main
--only t3a-ingame,k1b-ingame --shards 2 --ports 8936:8937,8938:8939 --run-dir ../architect-mc-reltool-run` on the scratch head
(`artifacts/gate-runs-reltool/20261020-222009-change`): **2 PASS in 2m31s**, t3a-ingame 23/0 (item 12: the plan's IR sha and every
tile sha equal the re-cut crossings_demo_flat) and k1b-ingame 17/0 (item 10: the same for links_demo_flat), both planned in game
by kit 0.38.9. (A first run, `20261020-221536-change`, failed k1b-ingame with PLAN_STALE "plan needs kit 0.38.9; this is kit
0.38.0": the source worktree's HEAD was switched back mid-run, and the drivers import the kit from the source checkout, not the
run worktree. Keep the source HEAD still until a run ends.)
The drivers' offline items on the same scratch head (`--only unit-kit,unit-mod,b-unit,t3a-unit,t3b-unit,k1b-unit,k1a-unit,
p0-unit,h-unit,ha-unit,hy-unit,voc-unit,vocc-unit,cu-unit,kc-unit,irr-unit,c37-unit,c38-unit,d-unit,f2-unit,t1-unit,s2-unit,mp-unit`,
3 shards, `artifacts/gate-runs-reltool/20261020-222622-change`, 1h24m at load 60-70): **20 PASS, 3 FAIL, none from the bump**.
h-unit and ha-unit fail H-a's item 10 and vocc-unit VOC-c's item 3, both since VOC-c made `rule.palette` supported: H-a's
committed asks table still has the 7 palette parts unsupported (they are refused NO_FEATURE/TOLERANCE now), and VOC-c's "before"
table is computed at the merge base, which already holds VOC-c. Its "after" table at kit 0.38.9 equals the committed one.

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

## Gate waits (2026-10-20): idle time and duplicates out

Noah approved the cheap speed-ups from docs/FAST-CHECKS.md ("Fixed waits" and phase P0's duplicates). Every check still runs with
the same assertions; only idle time and pure duplication went. The before/after numbers are in "Measured" below.

### Waits that became "wait until done"

- **The look steps' removal stall.** k1a-look and t3a-look left the player at the last camera, inside a site's box, so
  `dev.region.remove` waited out its 10-minute player limit and ended PARTIAL (client log: `a player stayed in c18 for 10 minutes`,
  3 times per k1a-look, twice per t3a-look, in every recent slice). It was not `ApiTimeouts.DESIGN_DEFAULT_MS`. The drivers now
  teleport above the claim first; the removal finishes REMOVED in 1.5-3.6 s and its result is recorded in `look.json` (not judged).
  The look steps stay at the slice tier: Noah judges looks per slice.
- **Region polls.** `waitRegion` (`tools/lib/run6b.mjs`, `tools/gate6a.mjs`) slept 30 s / 60 s between polls, so every realise
  read 30 or 60 s whatever its size. It polls at 1 s, rising by 1 s per 10 s waited to at most 5 s, and logs a line when the state
  changes (else once a minute). Two side effects, both recorded only: a realise's `wallSeconds` and a scenario's MSPT trace window
  no longer include up to 30/60 s of idle after the batch ended, and t3b's falling-block count is sampled more often (stricter).
- **The scenario settle** (`tools/scenarios.mjs`, before the pristine cameras and the snapshot). It was a fixed 90 s per variant.
  It is now `run6b.settleQuiet`: done once every chunk of the claim + 48 is loaded and ticking and **no chunk the server ticks,
  anywhere in the level, holds a scheduled block or fluid tick** for 10 s in a row, capped at the 90 s it always waited. The new
  hook `dev.ticks.pending` (SliceHDev, generated headless; `region/PendingTicks` over each chunk's tick containers, saved ticks
  not yet unpacked included) reads the counts. Anything still flowing (S3's worldgen spring, the cave fluids voc-natural's
  `farfluid` class covers) keeps it waiting to the cap, so the condition can never cut a settle short while fluids move.
  Measured: every **flat** variant is quiet at once and settles in 10 s (saves 80 s each); every **natural** variant (S1, S2,
  S3's relief, S7) still has fluid ticks at 86-89 s and takes the full 90 s, exactly as before. `run.json` records `settle`
  (`reason` quiet|cap, the samples).
- **b-ingame.** A removed brush region answers `{missing: true}`; the `/architect brush undo` wait didn't count that as done and
  ran out its 120 s. It does now.
- **c30-ingame.** `hashLots` settled 3 s before each of six lots after each of 12 removals; it settles once per set and hashes every
  lot, after each removal as before.

**Kept, with the reason:**
- **pt-ingame `hyst` (60 s) and pt2 `states`.** The 60 s wait is `Builds.Rules.demoteGapMs`, the shipped demotion gap that item 6
  asserts ("incidental after the debounce and the 60 s demotion gap"); hyst already polls for it every 5 s. Shortening it tests
  another configuration; an injected tick clock is mod work, not a cheap wait. pt2 `states` already sets the gap to 2 s.
- **0a-tiles' backoff** is the tile time limit and the retry pauses under test (`ARCHITECT_TEST_SLOW_TILES`), and the step ran in
  0 of the 12 baseline slices.
- **The natural scenario settles** stay at 90 s in effect (above): never quiet within the cap.
- **gate6a's in-assertion sleeps** (staged's 90 s "still waits without maxWait", the sidecar-kill pauses) are the assertions'
  own time windows.

### Duplicates (`supersededBy`)

- **6cw-scenario-s7 is gone.** It ran the very same S7 flat + natural pair as 6cv-scenario-s7: `--phase` only names the output
  dir, the scenario's own phase (`6c-v`) drives it, and their 36 normalised check lines are identical (KC and IRR slices). Its one
  unique check, `gate6cw.mjs lampsoff` (the lamps-removed variant over the realised dump), now ends 6cv-scenario-s7; the impact
  rules that named 6cw name 6cv.
- **A step field, `supersededBy`.** A step whose every assertion another step also runs is dropped when that step is in the same
  run, and `--plan` says so in a note. Alone it still runs.
  - `6b-scenario-s1-flat` → `6b-scenario-s1` (the same command, the first half; its 12 check lines equal s1's first 12 in IRR's
    slice). It stays the change tier's cheap scenario step. Release no longer lists it beside s1.
  - `ha-ingame`, `ha-natural`, `ha-cold`, `ha-look` → `h-ingame`, `h-natural`, `h-cold`, `6ch-look` (gate6ch runs the same H-a
    items, `gate6ch-a.mjs` `items`, after H-core's; ha-ingame's 23 check lines are all in h-ingame's in KC's and IRR's slices).
    Chain `6ch-a` still runs them alone.

### The offline unit floor

- **Kit reuse for the H, HY and T3 drivers.** gate6ch, gate6chy, gate6ct3a, gate6ct3b and the H halves re-ran the whole kit suite,
  the goldens and P0's tests next to `unit-kit`; their pass/fail-only kit calls now go through `kit-reuse.mjs` like the other
  drivers', and h-unit, hy-unit, t3a-unit, t3b-unit and ha-unit `waitFor` `unit-kit` (18 readers now).
- **A content-keyed cache for "unchanged against origin/main"** (`tools/lib/plan-cache.mjs`; gate6ch-core and gate6chy-core). Each
  side of the comparison is a pure function of the kit and scenarios trees it runs, the fixture's plan and options and Node's
  version, so it is stored under exactly that key in `<main checkout>/artifacts/plan-cache/` (untracked). Main's side runs once
  per main kit; this checkout's side while its `kit/` and `scenarios/` equal a cached tree. A dirty tree is never cached; a miss
  runs as before. hy's item 12 plans 229 fixtures on both sides (16.5-25 min cold); warm it is seconds.
- **h-unit:** H-a's item 11 takes H-core's per-fixture comparison from the same process (the identical loop and fixtures against
  the same origin/main); its own check and bar are unchanged.
- **h-unit and hy-unit:** the Java tests first, then api-compat in the background (its output to a file) beside the kit items;
  the same check when it ends.

### Measured

Runs on this branch (`artifacts/gate-runs-gatewaits/`), all on a shared box running 6 gate runs at once (the slot limit went to 6
during the work): load average 35-86 at step starts, median 55, peak 148; no swap. "Baseline" is each step's mean over the PASS
samples of every full slice since 2026-10-18 (the 12 FAST-CHECKS slices and later ones; `scratchpad/gatewaits/compare.mjs`, local scratch).

| step | baseline (min) | run 1 `20261021-004231-change` | run 2 `-021416-change` / `-024750-change` | slice `20261021-032653-slice` | check lines |
|---|---|---|---|---|---|
| k1a-look | 34.7 | 7.6 | 4.8 | 5.5 | same 6 |
| t3a-look | 24.8 | 6.7 | 4.2 | (not in range) | same 6 |
| h-unit | 21.7 | 12.8 (cache cold) | 5.9 | 3.8 | same 12 (item 10's FAIL is pre-existing) |
| hy-unit | 24.9 | 32.1 (cache cold, load 60) | 5.8 | 10.3 | same 10 |
| t3a-unit | 14.4 | 5.9 | 4.9 | | same 8 |
| t3b-unit | 13.0 | 0.7 | 0.3 | 0.3 | same 5 |
| 6a-staged | 6.7 | 6.2 | 4.9 | 4.5 | same 10 |
| x-resume | 6.0 | 4.3 | 4.9 | | same 46 |
| c30-ingame | 6.1 | 4.1 | 4.3 | | same 22 |
| b-ingame | 4.5 | 2.4 | 3.8 | 3.5 | same 74 |
| p0-ingame | 2.8 | 1.3 | 2.6 | 1.2 | same 46 |
| cu-ingame | 2.4 | 1.0 | 1.2 | | same 9 |
| t3b-ingame | 4.1 | 4.8 | 3.7 | 3.7 | same 32 |
| 6b-scenario-s1 (+ s1-flat 3.4 dropped) | 8.5 | 6.6 | 6.6 | 6.8 | same 24 |
| 6cv-scenario-s7 (+ 6cw 7.6 dropped) | 8.0 | 7.0 | 6.0 | 6.3 | 36 + lampsoff's 2 |
| 6ct1-scenario-relief | 7.7 | 9.2 | 6.8 | 5.8 | same 33 |
| 6c-scenario-s2 | 9.2 | 8.6 | 9.4 | 9.4 | same 20 |
| w-ingame (region polls) | 13.7 | | | 6.3 | |
| d2-ingame (region polls) | 4.3 | | | 2.3 | |

"Same N" is the set of `ok`/`FAIL` lines with numbers, shas and ids masked, against the newest baseline PASS log. Other
differences were masked values only: E-normal's class list, ids, plan ids.

**The slice** (`slice --range 1c750076...819d1f79`, K1a's range as in "Gate speed", 66 steps today against 53 then; fresh run
dirs, ports 8972-8977): **140 min wall**, 417 step-minutes, 64 PASS. The 2 FAILs are pre-existing and named: h-unit's H-a item
10 (the asks' gap table, as in F3's slice) and pt2-ingame's item 13 (apitest apipt2's version, as in F3's and FL's slices).
4d-all's known "group undo" intermittent failed once in the aborted first slice attempt, not in this one. Against the
131-minute median that is no wall-time gain, and it can't be read as one: it ran at load 35-86 next to five other runs, and the
untouched unit steps ran 2-3x their baseline (kc-unit 28.0 against 10.6, irr-unit 24.6 against 11.1, d-unit 12.9 against 4.5,
t2-unit 12.6 against 4.3, unit-kit 9.6 against 5.5). The steps this branch changed saved 77 step-minutes in it against their
baseline means (k1a-look 29, h-unit 18, hy-unit 15, t3b-unit 13, w-ingame 7, the dropped 6cw and s1-flat 11).

**Replayed at the baseline's load** (`scratchpad/gatewaits/replay.mjs`, local scratch, not committed: the 12 FAST-CHECKS slices' recorded step times, the
changed steps at their measured medians, the superseded steps dropped, packed longest-first on 3 shards as FAST-CHECKS'
"Wall-time model"): median **132 -> 104 min wall** (-21%), **397 -> 311 step-minutes** per slice. The h/hy cache is cold once
after each main kit change (hy-unit about 25 min that once); a slice whose own kit/ differs from every cached tree pays its own
side (about half).

**Under 6 runs:** the slot wait for this branch's runs was 30-47 min each; load averages ran 55 median and 86-148 at peaks
(memory fine: no swap, 0.03-2.7 M free pages). The unit floor slowed most, so 6 concurrent runs look like too many for timing
comparisons; functional results were unaffected (no new failure, no timing bar judged).

## P3: the water and survival ledger lints (2026-10-21)

Noah approved replacing slow in-game checks with instant, repeatable ones wherever that's trustworthy (docs/FAST-CHECKS.md, phase P3).
Branch feat/lint-p3 built the two P3 lints, their calibration probes and the cutover. What each lint proves, the mutation evidence and
the row-by-row cutover are in docs/FAST-CHECKS.md ("4. Water lint" and "5. Survival ledger lint", their "As built", and "P3 cutover").

### Steps and tiers

| step | what | tier |
|---|---|---|
| `water-lint` | `node --test kit/lint/*.lint.mjs`: the fluid corpus (9 shards in parallel), the lint's own rules, the drain cases | slice always; change through the impact rules "P3 water lint" and "P3 cutover"; release |
| `p3-lint` | gradle `LedgerLintTest` + `RegionFluidsLintTest`: the survival ledger lint and the water lint's Java half (the real `RegionFluids.breachTake` and `drain`) | slice always; change through "P3 water lint" and "P3 survival ledger lint"; release |
| `p3-lint-long` | the ledger fuzz over 20000 fresh seeds | release |
| `<step>-smoke` (h-ingame, h-probe, hy-ingame, hy-crash, hy-cold, irr-ingame, kc-ingame, voc-survival, y-ingame, c29-ingame) | the full step with `GATE_P3=smoke` (y and c29: without the subcommands the lint took): the SMOKE remainder | slice and change, through the impact rules (they name the `-smoke` ids) |
| the full ids | everything, as before | release (`tiers.release.always`), named chains, by hand |
| `p3-probe-water` | `tools/p3-probe.mjs water` (waits for the full h-ingame, hy-ingame, h-probe of the same run): h_core_demo's census per body (0 diff), its settles within the bounds, every body's breach in its recorded reach; hy_core_demo's census; the riffle table; the fire-reach posts within M20's FIRE_REACH | release |
| `p3-probe-ledger` | `tools/p3-probe.mjs ledger` (waits for the full y-ingame and cu-survival): the store run's ledger at each event against the model's; weathering charged nothing; the measured refund == the Java model's refund of the same standing blocks (`LedgerProbeTest`) | release |

`supersededBy`: a `-smoke` id is dropped when its full id is in the same run. The smoke drivers log every group they leave out as
`P3 smoke: <what> left to <rule or probe>` (neither an ok nor a FAIL line).

### The rule: a probe mismatch sends the P3 rows back in game

A lint is trusted only while its calibration probe passes on the current Minecraft version. When `p3-probe-water` or
`p3-probe-ledger` fails (at release, or when a Minecraft update runs the probes first):
1. `node tools/p3-mode.mjs ingame`, and commit it: the impact rules name the full ids again, so every P3 row runs in game at the slice
   tier. `node tools/p3-mode.mjs --check` prints the mode.
2. Fix the lint or its model (the failing probe line names the body, the cell or the item), until the probe passes on a release run.
3. `node tools/p3-mode.mjs smoke`, and commit it.

The probe's own FAIL line says so. Only the impact rules' lists change; the release tier always runs the full ids.

### Mutation evidence

`node tools/p3-mutants.mjs [--only id,...]` puts each historical bug back into the production code in a scratch worktree at HEAD and
runs the lint there; every mutant must go red and the baseline green. It writes `artifacts/p3-mutants/<stamp>.json` (untracked). Not a
gate step (a compile per mutant); run it when a lint or the code under it changes.

### Measured

On feat/lint-p3 (2026-10-21, a shared box at load 15-80 with 3-4 other gate runs):
- **The lints:** `water-lint` 2.0 min in the slice (102 tests; about 3 min alone at load 36, 170 s serial planning on a quiet box);
  `p3-lint` 0.2-1.5 min (the ledger fuzz's 400 seeds in about 3 s; 20000 seeds in 46 s). Both within FAST-CHECKS' 2-minute budget.
- **The smoke steps** (slice `artifacts/gate-runs-lintp3/20261021-221111-slice`, 3 shards, before merging main): h-ingame-smoke 12.6 min,
  h-probe-smoke 0.4, hy-ingame-smoke 16.9, hy-crash-smoke 2.1, hy-cold-smoke 5.5, irr-ingame-smoke 26.4, kc-ingame-smoke 1.3,
  voc-survival-smoke 1.5, y-ingame-smoke 5.2, c29-ingame-smoke 5.6; all PASS.
- **The probes** (`artifacts/gate-runs-lintp3-probe/20261021-220925-change`: the full h-ingame 18.2 min, hy-ingame 25.4, h-probe 3.3,
  y-ingame 6.4, cu-survival 0.7): `p3-probe-water` 10/0 (h_core_demo's four bodies diff 0, settled at 5-20 ticks within bounds
  30-80; four breaches in reach; hy_core_demo's four reaches diff 0; the riffle table 20/20; the lava lit 4 posts, farthest side 2,
  above 2, below 1, within FIRE_REACH) and `p3-probe-ledger` 10/0 (the store run's six bills, its delta and revert consumed exactly
  their outstanding; cu-survival's refund of 256 standing blocks equals the Java model's). Their settles are recorded in
  kit/lint/water-calibration.json.
- **The final slice after merging main (dfab398b)** (`artifacts/gate-runs-lintp3/20261022-001736-slice`, `--shards auto` = 3, load
  about 15-40): **94 min wall, 278 step-minutes**, 55 PASS. The smoke steps: h-ingame 10.6, hy-ingame 15.6, irr-ingame 28.8, hy-cold
  5.2, y-ingame 4.5, c29-ingame 4.2, kc-ingame 2.3, hy-crash 1.5, voc-survival 0.6, h-probe 0.5; water-lint 0.7, p3-lint 0.3. The 4
  FAILs are not P3's: pt2-ingame item 13 and h-unit item 10 (pre-existing on main), voc-unit item 1 (docker unavailable), sim-jobs
  (the sidecar was not running: PASS 33/0 re-run alone, `gate-runs-lintp3-simjobs/20261022-015305-change`). The pre-merge slice
  (59 steps, 124 min at load 20-80) had 4d-all's known group-undo intermittent instead; it passed here.
- **Replayed at the baseline's load** (the "Gate waits" replay of the 12 FAST-CHECKS slices, each P3 step at its measured smoke time,
  the two lint steps added to every slice; 3 shards): median **104 -> 94 min wall**, **311 -> 282 step-minutes** per slice. The fluid-heavy
  slices gain most (HYb 88 -> 80, CU 103 -> 94, KC 104 -> 94, IRR 145 -> 136); slices without P3 steps pay the lints' 2 minutes in
  parallel (hk2 67 -> 67). The smoke times were measured at load 20-80, so the replay is conservative.

## Adaptive shards (2026-10-21)

Releases and big slices ran 100+ steps on a fixed 3 shards for 4+ hours, also on an idle machine. `--shards auto` picks the count
for the machine and the plan when the run starts. It is the default for `slice` and `release` plans of more than 20 steps
(`shards.auto.minSteps`); smaller plans, `change` and the named chains keep 1 unless `--shards` says otherwise, and `--shards N`
still fixes it (`shards.max` is now 6). Code: `tools/lib/shard-auto.mjs`; settings: `shards.auto` in `gate-chains.json`.

**N is the smallest of these caps** (`--plan` prints each, the one that bound, and the wall estimate for every N):

| cap | rule | default settings |
|---|---|---|
| plan | the smallest N whose longest-first schedule (the runner's own `estimate`) is within 5% of the best wall up to `max` | `planSlack` 0.05 |
| cpu | `floor((cores x overcommit - max(load1, load5)) / cpuPerShard)`; the 5-minute load guards against a 1-minute dip | `overcommit` 1.5, `cpuPerShard` 3 |
| memory | `floor((free + inactive + purgeable + speculative GB - reserve) / memPerShard)` from `vm_stat` (`os.freemem()` counts free pages only) | `reserveGB` 8, `memPerShardGB` 5 |
| slots | `machineShards` less the shards the other live slot holders recorded (an older runner that recorded none counts as 3), less `reserveShards` while run slots are still free | 12, 3, 2 |
| ports | free port pairs: `shards.auto.portRange` (8980-8999), skipping ports any live slot holder recorded and 8892-8895; or the pairs `--ports` names | |
| max | `shards.max` | 6 |

A **floor of 3** (`shards.auto.floor`) applies when only the load-derived caps (cpu, slots) say less and the plan, memory and ports
allow 3. Decision: auto is never fewer shards than the old documented `--shards 3`. On this box's usual load (40-80) the cpu cap
is always below 1, so without the floor every loaded run would get fewer shards than before; the brief's problem was too few
shards on an idle box, not too many on a busy one. The first proof run below ran with a floor of 2 (it took 2); the floor went to
3 after it.

**When it decides.** `--plan` decides from the machine at that moment and says the run re-decides. The run decides under the slot
mutex, right after it gets its slot (after any slot wait), and writes its shard count and port pairs into its slot file in the same
critical section, so two runs starting together never count the same budget or take the same ports. `summary.json` records
`shardsAuto` (the probe, the caps, what bound, the wall by N, the ports) and `SUMMARY.md` prints the decision.

**The machine (measured 2026-10-21):** 18 cores (`hw.ncpu`: 6 performance + 12 efficiency), 128 GB. A headless server peaks at
3.0-4.7 GB and a sidecar at 0.2 GB ("Headless gates"), so memory allows 14+ shards and never binds first. CPU does: the gate-waits
runs put about 18 shards (6 runs x 3) on the box at a median load of 55, about 3 load units per busy shard, and unit steps ran 2-3x
slower there. So `cpuPerShard` is 3 and the target load is 1.5 x cores = 27: on an idle box (load ~2) the cpu cap is 8 and a
big plan gets 6; at load 20 it gets 2.

**Slots: one per run (decision).** The slot is still taken once per run, not per shard. The rule "at most `slots.max` runs" is what
AGENTS.md and the policy cite, and it is what lets a waiting agent start at all; older runners on other branches take one slot
whatever their shards, and per-shard slots would let one auto run hold most of them. The shards are accounted separately: each
slot file records them, and an auto run counts the others' shards against `machineShards`, so a later run sees the earlier run's
load before that load shows in the load average.

**Proof** (`artifacts/gate-runs-gatefast/`, local):

- **`--plan`, the same 121-step plan (`slice --since v0.39.0`), loaded and idle.** Loaded (the real probe, 2026-10-21 21:20 UTC:
  load 72.7/65.6, 79.9 GB available, one other run of 3 shards): `2 shard(s), bound by floor 2 (cpu said -16)` (the floor was 2
  then; now `3 shard(s), bound by floor 3`), caps max 6, plan 6, slots 7, cpu -16, memory 14, ports 10; estimate 5h45m on 2. Idle (`GATE_AUTO_PROBE='{"load1":1.5,"load5":1.2,"freeGB":110}'`,
  marked INJECTED): `6 shard(s), bound by max, plan`, cpu 8, memory 20; estimate 1h57m. The wall by N from the plan's own
  schedule: 1: 701, 2: 346, 3: 232, 4: 175, 5: 140, 6: 118 min.
- **A real run with auto shards** (`20261021-212419-change`): the 18 steps of the gate-waits branch's first change run
  (`--only unit-kit,b-ingame,...,6a-staged`, the same ids), ports allocated 8980-8983, recorded in the slot file. The box was busy
  (the rel0410 release, the P2/P3 agents' runs): load 58.2/62.3 at the decision, so auto took 2 shards (the floor then). **46.8 min
  wall**, 17 PASS and h-unit's known H-a item 10 FAIL, step loads 17-84 (median 43). The same set on 3 shards from history:
  **48 min** (`gate-runs-gatewaits/20261021-004231-change`, load median 60, hy-unit's cold cache 32 min of it) and 27 min
  (`-021416-change`, load 34, with 3 steps skipped and 4 failing fast). This run's own step times packed longest-first: 97 min
  serial, 48.8 on 2 shards, 32.5 on 3, 24.9 on 4, 16.5 on 6. So under that load the floor of 2 gave up about 15 min of this
  run's wall against 3 shards; that is why the floor is now 3. On an idle box the same set would get 6 shards
  (about 17 min). No idle window came on 2026-10-21 to run that case for real; the first quiet-box release will show it in its
  `SUMMARY.md`.

## Turbo (2026-10-22): one run owns the machine

Noah approved this on 2026-10-22: much faster runs, with the machine pushed hard while one runs. A slice tier (about 107 steps)
took 2h18m on 3 shards (`artifacts/gate-runs-0410/20261022-020720-slice`, 414 step-minutes at load 3-22), while the machine
(M5 Max: 18 cores, 6 performance and 12 efficiency; 128 GB) was mostly idle. Code: `tools/lib/turbo.mjs` (the queue, the
exclusive hold, the shard choice, the sampler), `tools/lib/step-split.mjs` and `tools/lib/gate-part.mjs` (split steps),
`tools/split-proof.mjs` (the union proof); settings: `shards.turbo` in `gate-chains.json`.

### What a turbo run is

- **When.** `--turbo`, or by default any tier run (`change`, `slice`, `release`) of at least 20 steps (`shards.turbo.minSteps`).
  `--no-turbo` makes it a shared run as before. Small `change` runs, `--only` subsets under 20 steps and the named chains stay
  shared.
- **The machine.** It queues, then holds **every** slot file (`slot-1` .. `slot-<n>`, n = max(8, `slots.max`, `--slots`, the
  highest slot file present)), so no other gate run starts while it runs, including runners from before this change (they only
  look at slot files, find none free and print the turbo run as the holder).
- **Shards.** Up to `shards.turbo.max` in-game shards (auto: the smallest N within 3% of the plan's best wall, bounded by
  memory and free port pairs; no cpu or slots cap, the run owns the machine). `--shards N` fixes N (up to `shards.turbo.max`).
  Port pairs come from `shards.turbo.portRange` (8940-8999, 30 pairs), checked by binding.
- **Offline lanes.** The client-less steps (the unit suites, the lints: `client: none`) run on `--lanes N` lanes
  (`shards.turbo.offlineLanes`) beside the in-game shards, each with its own run worktree (`<run dir>-o<j>`: gradle and the kit
  suite write into it) and a port pair it doesn't use. An in-game shard keeps its client and takes a client-less step only once
  no in-game step is pending. `self` steps (apijars, 0a-*) start their own clients, so they stay on in-game shards.
- **Split steps** run as parallel parts ("Split steps" below); `--no-split` keeps them whole.
- **Setup** runs the worktrees' git and seed clones serially, then every shard's sidecar build at once.
- **The sampler** (every run, turbo or not): every 30 s the load, available memory, swap and each shard's and lane's resident
  memory (its run worktree's processes and its running step's process group) to `machine.jsonl`; `summary.machine` and
  `SUMMARY.md` fold it (load p50/p90/max, the least available memory, swap, the largest process per shard).

### The queue: fair, no deadlock, stale state by pid

Every run (not `--plan`) takes a ticket in `<slots dir>/queue/` under the slot mutex, which also sets its enqueue time later than
every live ticket's, so the order is the order of enqueueing.
- A **shared** run takes one slot only when no ticket queued before it is still waiting and no turbo run holds or is reserving
  the machine. It logs whom it waits for ("queued before it: pid ... TURBO slice ...", "the machine: pid ... TURBO ..."), at once,
  on every change and every 5 minutes.
- A **turbo** run, once no ticket queued before it is still waiting, writes its pid into each slot as it frees (state
  `reserving`) and runs when it holds them all. It polls every 5 s (shared runs 15 s).
- **Fairness.** A run queued behind a turbo run starts when that run ends; a turbo run never overtakes an earlier ticket (it
  reserves nothing while one waits), so it can't starve a run that queued first; a later shared run never overtakes an earlier
  one. When a turbo run ends and the head of the queue is another turbo run, it hands its slots straight to it (they become that
  run's reserved slots), so nothing slips in between.
- **No deadlock.** The head of the queue waits only for running holders, which end or die; every other ticket waits only for
  tickets ahead of it, a total order. A dead pid's ticket or slot (a SIGKILLed run) is free, as slots always were.
- **Limits.** A runner from before this change takes no ticket: it can take a slot that frees while a turbo run at the head
  of the queue polls (as the gate-affected release did on 2026-10-22, 45 s after the warm-up run ended), and the turbo run then
  waits for it. Once every branch has merged main this goes away. A turbo run at the head reserves slots while it waits, so
  every later run waits too: queue a turbo run when the machine is about to be free, not behind a long release.
- `kit/test/gate-turbo.test.mjs` covers it with real pids: the waits, the FIFO order, no overtaking either way, stale tickets
  and holds, two turbo runs, the hand-over.

### Split steps

A long step whose driver runs independent sections (worlds, fixtures, seeds, scenario variants, item groups) declares `split` in
`gate-chains.json`: a part's env (its sections, `GATE_PART_SECTIONS`), or its own `shell` (a shell chain split by its commands),
an env every part gets (`${PART}` = p1, p2, ...: each part's own evidence dir) and an estimate.
- **Ids.** The parent keeps its id everywhere a step is named (the impact rules, the tiers, `supersededBy`, `--only`); after the
  selection a splitting run replaces it by `<id>/p1` .. `<id>/pN`. `--only <id>/p2` runs that part alone. A step that `waitFor`s
  the parent waits for every part; `after` a split step is not allowed (the config check refuses it). The history records each
  part under its own id; a part's definition (for history timeouts) is its parent's entry with the part's env.
- **No dropped assertion.** The runner also sets `GATE_PART_ALL`, every part's sections together; the driver
  (`tools/lib/gate-part.mjs`) throws before anything runs unless that equals its own section list, and the config check refuses a
  section named in two parts. A driver without `GATE_PART_SECTIONS` runs every section exactly as before.
- **Evidence.** Each part writes its own evidence dir; `p3-probe.mjs` reads the h/hy evidence from the parts' dirs.
- `summary.json` records `split` (parent -> parts) and `splitResults` (the parent's worst status, its step time and its wall from
  the first part's start to the last's end); `SUMMARY.md` prints them.
- **The union proof:** `node tools/split-proof.mjs --whole <run with the step whole> --parts <run with it split>` compares, per
  parent, the check lines (`ok`, `FAIL`, `rec`, indented ones too) of the whole step with the parts' together, numbers, hex ids,
  paths and times masked. A timing bar that is `ok` on one side and `FAIL` on the other is reported as timing.

### The knee: why `shards.turbo.max` is 9

The same 49 steps (`change --files tools/gate-run.mjs --turbo --no-split --lanes 3 --only ...`: 15 client-less steps (the unit
suites with unit-kit, which their readers wait for, the lints), 25 in-game steps on headless servers, 6 scenarios (5 on hidden
clients) and 3 look steps on clients; each at most about 12 min in history) at 3, 6, 9 and 12 in-game shards, back to back on
2026-10-22 (`artifacts/gate-runs-turbo-knee/`), each a turbo run, after a warm-up run that made the 12+3 run worktrees, built the
mod in each and warmed the h/hy plan cache. No other gate run was active; the background was Spotlight indexing and the
coordinator's agents' editors (load 4.5, 7, 4.8 and 9 at the starts; about 1-3 cores; recorded in each run's notes).

| in-game shards (+3 lanes) | wall | step-minutes | client/server setup | load p50 / p90 / max | least available memory | swap | gate RSS max (largest process) | median step time vs the 3-shard run | vs the history p50 | not passing |
|---|---|---|---|---|---|---|---|---|---|---|
| 3 | **58.8 min** | 235 | 7.7 min | 9 / 27 / 81 | 65.5 GB | 0 | 20.7 GB (4.6) | 1.00 | 0.83 | pt2-ingame item 13 (on main), 6ct1-scenario-relief's P2 realised == virtual (1 of 8 before) |
| 6 | **33.7 min** | 276 | 11.7 min | 29 / 50 / 58 | 57.9 GB | 0 | 29.9 GB (5.4) | 1.16 | 0.95 | pt2-ingame item 13 |
| 9 | **31.3 min** | 339 | 16.5 min | 52 / 77 / 91 | 55.5 GB | 0 | 38.5 GB (4.6) | 1.34 | 1.11 | pt2-ingame item 13 |
| 12 | **36.2 min** | 447 | 28.7 min | 52 / 74 / 95 | 52.8 GB | 0 | 44.2 GB (4.2) | 1.75 | 1.40 | pt2-ingame item 13, and three load failures: unit-sidecar's versions hook timed out (60 s), 6cd-scenario-districts' plan refused after 120 s, 6ct2-scenario-route realised == virtual 1 cell |

- **Where it bends.** 3 to 6 nearly halves the wall; 6 to 9 saves 7%; 12 is slower than 9. The load saturates at a median of
  about 52 from 9 shards on (18 cores), so each shard more only slows every step (1.34x at 9, 1.75x at 12 against the same
  step at 3) and the client and server starts (one per shard, 2-3 min each at 12) grow. 12 also added three failures that were
  load, not code: a flake is a real cost under load.
- **Memory never binds.** A headless server's JVM peaked at 1.7-2.1 GB resident (`-Xmx4G`), a hidden client 4-5.4 GB; the whole
  run at 12 shards took 44 GB with 52 GB still available and no swap. The memory cap (5 GB per shard, 2 per lane) is never the
  bound below 15 shards.
- **The critical path at 9 was a unit step**, not the in-game work: irr-unit took 30.3 min and voc-unit 27.1 (14.3 and 12.8 at
  3 shards), both on lanes, because their byte-identity loops plan every committed fixture on both trees, CPU-bound. Hence the
  unit splits below.
- **Decision:** `shards.turbo.max` 9 and `shards.turbo.offlineLanes` 3 (12 workers): the knee by wall, and the largest count with
  no new failure.

### What is split

Each split step at its measured time, its natural partition, and the union proof (whole against split at the same head:
`artifacts/gate-runs-turbo-proof/20261022-162049-change` whole, `-170841-change` split, 6 shards each, beside the affected-only
release; `node tools/split-proof.mjs --whole <A> --parts <B>`):

| step | measured (min) | parts | partition | union proof (checks whole / parts together) |
|---|---|---|---|---|
| irr-ingame / irr-ingame-smoke | 29.4 / 26.7 | 3 | worlds: v62 live; v62 exact + the breach fix + 5 (a); the lamp path, s01 with its control, v63, d01, irrUnmasked, the pad, the probe | 34/34, 29/29: equal, full masked lines too |
| h-ingame / h-ingame-smoke | 15.5 / 12.3 | 3 / 2 | H-core; H-a flat; H-a exact, farm, H-b flat | 19/19, 16/16: equal |
| hy-ingame / hy-ingame-smoke | 21.7 / 14.7 | 3 / 2 | HY-core; the riffle table, villagers, HY-c's water gate and v58; item 9's kinds | 31/31, 24/24: equal |
| 4d-all / 4d-all-full | 13.1 / 15.3 | 2 | base, then survival; base, then the other nine sub-steps (stages and gap0 with waiting) | 23/23: same checks |
| 5b-chains-full | 31.4 | 3 | the 21 scripts (fixed + 20 seeds), each from its own world; E1 over each part's states | 3 names / 13 lines: equal |
| rs-survival | 23.2 | 3 | items 5; 9; 8 and 10 | 11/11: equal |
| 6cf2-scenario-scatter | 12.2 | 2 | harvest, then scatter_demo flat and natural; harvest, then scatter_cave (a shell split) | see below |
| irr-unit, kc-unit, f3-unit, fl-unit, s3-unit | 14-36 under turbo | 3 | the byte-identity fixture loop in 3 round-robin slices (the first part also runs every other item) | proof below (the turbo slice against the whole runs) |
| voc-unit | 27-34 under turbo | 3 | item 5 (byte identity); item 13 and the census; the rest | proof below |

**Not split, and why (found by the proof):** a scenario's natural run reads its flat run's E-flat from the same evidence dir
(`tools/scenarios.mjs` `latestRun`). Split apart, the natural part printed "E-flat n/a" and failed its exactness bar (S3 and
scatter_demo in `-170841-change`, and S3 again in the turbo slice). So a flat/natural pair stays in one part: 6c-scenario-s3 is
whole again and 6cf2-scenario-scatter splits only off scatter_cave (which has no flat variant). `split-proof.mjs` now flags a
check whose part line lacks a value the whole step has (`n/a`, `none`, `missing`) for review and exits non-zero.

The other status differences in the proof runs are failures known on main, on one side only: 4d's "shared crate" (4 of 98 runs
before), 4d's "stages: undo" (8 of 199), 4d-all-full's "group undo" (22 of 94), S3's safety, scatter_cave's exactness (6 of 42). hy-ingame's item 14 push stand (a mob beyond the grate) failed on both sides at this head (0 of 24 before
today), so it is not a split problem; it is reported to the coordinator.

### Measured: the slice at turbo

The baseline's 110 steps (`artifacts/gate-runs-0410/20261022-020720-slice`: **2h18m** on 3 shards, 414 step-minutes) run as
`slice --files tools/gate-run.mjs --only <the same 110 ids>` at turbo, head c8bc281a (`artifacts/gate-runs-turbo-slice/
20261022-212922-slice`): 9 in-game shards + 3 offline lanes, 130 steps after the splits, **58m08s wall** (2.4x faster),
651 step-minutes. Every worker was busy 53-58 min, so the run is throughput-bound: the step time grows with the load (median
about 1.3-1.5x, load p50 35, p90 71, max 93; 52 GB available at least, no swap, gate processes 38 GB, the largest process 5.2 GB);
the longest single part was 20.6 min (fl-unit's slice 1). The next gain is less work (the step cache, a shared plan cache for the
byte-identity loops), not more shards.

119 PASS, 11 FAIL. Split problems, fixed after this run (and re-proven below): kc-unit/p3 and f3-unit/p1 raced on their merge-base
worktree's checkout (`tools/lib/base-tree.mjs` now locks it and leaves a tree at the base alone); 6cf2-scenario-scatter/p2 and
6c-scenario-s3/p2 lacked their flat run's E-flat (a flat/natural pair now stays in one part). Known on main: pt2-ingame item 13,
h-unit item 10, f3-unit's e16 exception and fl-unit's item 8 (both also in the affected-only release's whole runs of v0.41.0),
sim-jobs' launcher reuse (7 of 93 runs), 4d's shared crate, 6b-scenario-s1's E-normal (2 of 62), S3's checker and structure
(in the 0410 slices too), scatter_cave's realised == virtual (2 of 19).

**Proof of the unit slices and the 6cf2 split** (head 65715bfe, turbo, 3 shards + 3 lanes; whole
`artifacts/gate-runs-turbo-proof/20261022-222818-change`, split `-230320-change`): irr-unit 304/304 checks, f3-unit 311/311, fl-unit
317/317, voc-unit 12/12, 6cf2-scenario-scatter 22/22 (now 2 parts): equal, and the full masked lines too except where noted.
kc-unit 324/324: the same checks; one recorded line ("the watch count: N fixtures ... (none)") lists only its slice's fixtures, as
expected of a recorded count. s3-unit 308/308: the same checks, but asks/redstone_gate.json DIFFERS in part 2 (its first plan's IR):
origin/main moved to 15c54050 during the run, so the parts that started later took the new merge base (65715bfe, this head) and
moved the shared base worktree while another part was planning on it. gate-run now fetches once and fixes the run's merge base
(`GATE_MERGE_BASE`, recorded as `summary.mergeBase`); `tools/lib/base-tree.mjs` uses it and never fetches mid-run. Drivers that
make their base worktree themselves (gate6ch-core, gate6chy-core, gate6ch-a, gate6ct3a, gate7ak1b, gate6chya) still fetch per step;
their steps are not split.

**Server and world reuse: not done.** In the 2h18m baseline slice, client and server starts, world switches and snapshot
restores took 10.0 of 414 step-minutes and the steps' own `gate6b.mjs base` 6.5: 4% together, under the 10% that would pay
for a warm-server-per-shard reset and its proof. Under turbo the starts grow (28.7 of 447 step-minutes at 12 shards, 6%;
16.5 of 339 at 9, 5%), still under 10%; a reset proven clean (world hash, entities, journal) is not worth its risk at that.

## Fast checks P1 (2026-10-21): the undo assertions move to the undo model

Phase P1 of docs/FAST-CHECKS.md: the in-game undo assertions it maps to the undo model (UMT, docs/UMT.md) leave the slice tier.
Nothing is deleted. Each driver takes `--slice` (5b-chains: `G5B_SCRIPTS=2`) and runs only its slice subset; without the flag it
runs every assertion, as before. Each changed step has a `-full` twin with the old definition, which the release tier, the crash
rotation and the named chains (`regress`, `engine`) run instead (`4e-crash-full` is `after` `4e-orders-full`). The slice step is
`supersededBy` its twin, so a run that has both drops the subset. The impact rules are unchanged: they name the slice steps.

The offline proofs run in `unit-mod` (`gradlew build` runs every test) at every slice, and `umt` runs the UMT set on journal changes.

| step | slice keeps | moved to the full step (release) | offline proof |
|---|---|---|---|
| `4e-orders` | the fixture; 2 seam orders (`HXTR`, `TRXH`); the group removal; 1 of the 6 orders with L | the other 22 orders and 5 orders with L | `UmtGateMovesTest.orders4e_*` (all 24 + group + 6 with L: exact, no leak, settled at the next start), `JournalPropertyTest` (every order of up to 4), UMT P1 fuzz |
| `4e-crash` | K3, K7, K8 group, GW, R1q, K3 clean | K1, K2, K4, K5, K6, K8 (single) | `UmtGateMovesTest.crash4e_*` (each point with and without an autosave: the state after the start, then an exact final removal), `UmtPropertiesTest.p2_everyKillPointOfOneScenario`, `JournalStoreTest.openTidiesLeftoversAndKeepsUncommittedEntries` (K8's half-written generations deleted at the start) |
| `4d-all` | everything but: the group undo is checked on the whole village's hash (it covers every lot's box + 7) | the 12 per-lot hashes after the group undo (row 4) and the stage undos s3 then s1 with their exactness (row 13) | `UmtGateMovesTest.stages4d6a_*`, UMT P1 |
| `c30-ingame` | 2 of the 12 staged runs (one autoApprove, one approved stage by stage), the lots hashed once after both removals; C30 2-4 | the 12 runs, hashed after each removal | `UmtGateMovesTest.c30_*` (a staged group placed and removed 12 times: exact and settled each time) |
| `5b-chains` | the fixed script and 2 of the 20 seeded scripts (E1, E2, E3 on those) | the other 18 seeded scripts | `DeltaPropertyTest` (E1-E7 over 150 random chains), UMT's deltas |
| `6a-eflat` | the mega realise, E-flat after the group undo, the player's block kept | lots-3's forced stage undo, one lot's undo (and their two world copies) | `UmtGateMovesTest.stages4d6a_*` (a middle stage under a later one, one lot alone) |
| `6a-staged` | per-stage drift, the maxWait 30 s half, H0 | the control without maxWait (a fresh world, a realise and 102 s of waiting) | `RegionWaitLimitTest` (production `WaitLimit`, which `Batches.waitFor` and `queueRegion` now call) |
| `x-resume` | (a)-(e) | (f) the world-start reconcile (f1 REMOVED, f2 PARTIAL), two realises and restarts | `RegionReconcileTest` (`RegionsImpl.reconcileEnd`, the decision `reconcileRemovals` now calls: every state x group x running x group state) |
| `6a-crash` | (not at the slice tier: release rotation only) | not moved | none claimed: RG2-RG6 are not mapped to UMT points (RG3 is the heights-on-disk point UMT doesn't model); nothing to trim |

**Two production seams**, behaviour unchanged: `batch/WaitLimit` (the region wait limit and the per-recheck count, moved out of
`Batches`, whose static init needs the game's registries) and `RegionsImpl.reconcileEnd` (the reconcile's decision; it asks
`Groups.removalRunning` and the group lookup only for a REMOVING region with a group, as before).

**Every proof goes red with the code it guards broken** (`scratchpad/gf/mutate.py`, local: each mutation applied to production
code, the named tests run, the file restored with `git checkout`):

| mutation (production) | red |
|---|---|
| `Journal.planUndo` hands nothing down (`r = v`) | `UmtGateMovesTest` orders, crash, stages; `JournalPropertyTest` i, iii |
| `JournalStore.tidy` keeps superseded generations | `JournalStoreTest.openTidiesLeftoversAndKeepsUncommittedEntries` (`UmtGateMovesTest` stays green: UMT's faults leave none) |
| `SiteJournal.releaseGroup` releases nothing | `UmtGateMovesTest` orders, crash (K1, K2), stages, c30 |
| `Sites.settleSite` always KEEP | `UmtGateMovesTest` orders, crash, stages, c30 |
| `SiteJournal.reactivate` reactivates nothing | `UmtGateMovesTest` crash (`K6: an entry is not ACTIVE`, H left pending) |
| `Sites.evidence` without F1's later write | `UmtGateMovesTest` orders, crash, stages |
| `WaitLimit.regionTicks` with a 90 s default | `RegionWaitLimitTest` (the control) |
| `RegionsImpl.reconcileEnd`: REMOVED unless the group is ACTIVE | `RegionReconcileTest` (the table) |
| `RegionsImpl.reconcileEnd` ignores a running removal | `RegionReconcileTest` (the table, f1/f2) |
| `DeltaPlanner.deltaSet` keeps removed cells | `DeltaPropertyTest.e1PathIndependenceE2RevertE4MinimalWritesE3Remove` |

**What the model does not show** (why those groups run in full at release):
- K4, K5, K6 and K8's *glue* (which job is saved when) is modelled. `crash4e_*` runs H's removal both ways. Unqueued, as a small
  site's `Sites.remove` is in game, there is no job to resume: K5/K8 leave all four standing with ACTIVE entries, and at K6 the
  start's evidence takes H back (`SiteJournal.reactivate`, production). Queued, as UMT's RestoreJob, the removal resumes and the
  next start settles H. UMT's faults leave no superseded generation of a known entry, so K8's "half-written generations deleted"
  is `JournalStoreTest`'s.
- Shape updates at a seam (fences, panes): the 2 seam orders stay in game.
- `Groups`' production removal order ("sites removed in reverse placement order", 4d row 3): UMT models it, so that check (free:
  it reads the events) stays at the slice tier.
- C30 3 (a 3 s wait limit, TIMED_OUT, stage PARTIAL; 8 s) stays: its parts are unit-tested (`WaitLimit`, `StageRules.finish`), the
  combination is not.

**A finding for the coordinator (not fixed here).** A first version of the orders property put H's and X's boxes into the pad's
cells (a building whose box includes the ground row). Then the order R, H, T, X leaves H pending at every start: its evidence is
"neither restored nor standing" (KEEP). The cause is F1's case, mirrored. H's cells under X were handed down to X, then T (under
them) was removed, handing them down to X again; X's removal wrote T's before there. H's own entry still expects T's after,
because `laterWrite` only reads a later undo by an entry under the cell. gate4e's cabin and gatehouse stand on the pad (box above
it), so the in-game fixture never had this, and the committed property uses that geometry. UMT tags it `[F1]` (checked: the end
reports the record and its entry left, both `[F1]`), so the CI set counts such seeds without failing.

**Measured** (`artifacts/gate-runs-gatefast/`, local):

One validation run, `20261021-214600-change` (auto: 2 shards, the floor then; load 14-87, median 33), ran every slice step and its
`-full` twin side by side at the same load, plus `unit-mod` and `umt` (PASS: the new tests in the build). Every `-full` step's
check-line count equals main's latest PASS of the old step (from `gate-runs-0410`, `gate-runs-lintp3`), so nothing was dropped:

| step | slice (min) | full (min) | slice / full | check lines slice / full (main's last PASS) |
|---|---|---|---|---|
| 4e-orders | 2.1 | 9.5 | 0.22 | 16 / 70 (70) |
| 4e-crash | 6.2 | 11.1 | 0.56 | 30 / 64 (64) |
| 4d-all | 13.6 (rerun `20261021-232345-change`) | 14.9 | 0.91 | 63 / 63 (63) |
| c30-ingame | 2.4 | 3.1 | 0.78 | 22 / 22 (22) |
| 5b-chains | 7.3 | 33.1 | 0.22 | 53 / 329 (329) |
| 6a-eflat | 10.0 | 10.6 | 0.94 | 3 / 5 (5) |
| 6a-staged | 2.5 | 4.9 | 0.52 | 9 / 10 (10) |
| x-resume | 3.6 | 5.7 | 0.63 | 35 / 46 (46) |

The first 4d-all slice attempt failed 5 lines, neither in a part `--slice` changes. Three came from `removeGroup` refusing for a
bee in a site box (`bee at 43, 94, -47`, the known 4d noise N2). Two came from the cancel test: L5 placed before L3, and L3 was the
item mid-placement (32/2223) when the cancel came. L3 was rolled back exactly (its region hash equals the pre-hash), but the check
assumes the batch's first item places first. This had not happened in 95 earlier 4d-all logs and did not reproduce on rerun
(`20261021-232345-change`: PASS, 63 ok).

**The slice, replayed** (`scratchpad/gf/replay-p1.mjs`, local). The 12 FAST-CHECKS baseline slices, with gate-waits' new step
times applied as "before". Each P1 step's recorded time is multiplied by its slice/full ratio above (measured at one load, so the
ratio holds where absolute times don't). The result is packed longest-first:

| | 3 shards | 6 shards (auto, idle box) | step-minutes |
|---|---|---|---|
| before P1 (after gate waits) | 104 min | 52 min | 311 |
| after P1 | **93 min** (-11%) | **48 min** | 278 |

FAST-CHECKS projected 109 -> 97 for P1 against its own P0 baseline. The measured -11 min is the same size, from a smaller set of
moves: the rows inside the P2/P3 drivers are deferred, and 6a-eflat and 4d-all barely shrink (their kept parts dominate).

## Fast checks (P2): the structure and look lints (2026-10-21)

Noah approved P2 of docs/FAST-CHECKS.md: slow in-game re-reads replaced by instant, repeatable checks where that is trustworthy.
Three pieces: a SMOKE row that keeps the lints honest, the two lints at the unit tier, and calibration probes at release. Branch
`feat/lint-p2`.

### The precondition: realised == virtual, per writer kind (SMOKE, slice tier)

`tools/lib/realised-virtual.mjs` diffs the realised dump against the plan's virtual world cell by cell. It counts by writer kind
(`kit/lib/lint/writers.mjs`): ground, relief, street, route, forms, lots, props, scatter, walls, bridges (beam, arch, slab), rope,
tunnels and fluids.
- A differing cell is classed `kept` (the cell holds what it held before the realise), `road` (a 4e road's band on natural ground),
  `plant` (the world's plant broke), `child` (a lot entry's foundation row or its approach path), `grass` (dirt and grass swapped
  by random ticks) or `fluid` (a fluid flowed into a cleared cell). Anything else is `differ`, and the row gates `differ` = 0.
- The 4e street lanterns: the lint's model of `RoadPlan.lanterns` (`kit/lib/lint/roads.mjs`) against the realised light blocks,
  both ways. On S7 and districts_demo, natural and flat, the posts are equal cell for cell.
- Where the row runs: every scenario run (`realisedVirtual` row), t3a-ingame (bridges), t3b-ingame (tunnels), k1b-ingame (rope,
  slab decks) and H-b's wet runs in h-ingame. Walls keep gate7ak1's own row. Fluid bodies and courses belong to the water lint
  (P3).
- Measured on this branch (`artifacts/gate-runs-lintp2/20261021-213356-change`): 0 differing cells in every run. That covers
  forms 14,166, scatter 6,380, route_demo flat 975,790 cells, s2, s1, relief, districts, s7, bridges beam 394 and arch 324,
  tunnels 1,276, rope 727, walls 7,018 and 3,346.

### The lints (unit tier: `lint-structure`, `lint-look`)

`node tools/lint.mjs structure|look|mutations|list`. The rules and what each stands in for are in docs/FAST-CHECKS.md ("P2 as
built"). The inputs are committed fixtures only, never a live seed:
- the natural surveys S1, S2, S3, S7 and tunnel_hill (`kit/test/fixtures/lint/surveys.json`; the loader is
  `kit/lib/lint/vworld-fixtures.mjs`, shared with P3);
- the scenario goldens' inputs, re-planned by the checkout's kit;
- the plan/0 corpus;
- the historical fixtures (`kit/test/fixtures/lint/hist`);
- FL's judged gallery (`kit/test/fixtures/lint/fl`).

Plans are cached per kit content in `<main checkout>/artifacts/lint-cache/` (untracked; a miss only costs the plan).
- **Runtime** on this box at load 40-58: structure 50 s warm, 3.6 min cold (49 cases on 9 jobs); look 2 s; mutations about 10
  min cold.
- **Baseline.** `kit/test/fixtures/lint/baseline.json` lists known findings with their reason and an exact count. A count that
  moves FAILs. Today it holds S1's links under two lot corners and main's pre-FL lamp spacing (S7, districts_demo); the FL
  entries go when FL merges.
- `lint-mutations` runs when the lints or the code they mutate change, and at release.

### What moved out of the slice tier (the -smoke twins)

A `-smoke` step is its full step's slice-tier twin. It has `supersededBy` the full step, the impact rules name it, and release
runs the full step. `tools/lib/p2-trim.mjs` lets a twin skip a group only when both hold:
- `GATE_P2_SMOKE=1` is set;
- the calibration record holds.

| step | skipped at the slice tier | where it is checked instead |
|---|---|---|
| `w-ingame-smoke` | 3 of pathbibles' 4 S7-flat realises. packed_mud stays: its built verge is the one RoadPlan branch (the owner's own foot) that the lint's lantern model must keep honest in game. | lint case `pathbibles`: the four bibles planned by the kit, the lanterns laid, walk M5 0.00%, counts 7 = 7 = 7 = 7. In game, packed_mud's count is checked against the lint's 7. |
| `d2-ingame-smoke` | the crest round (its realise, reload and undo) | lint case `d2:crest`: S3's pinned survey, 43/46 street cells within 4 of the crest, as in game. The outpost, the quay, the biome edge and every refusal stay in game. |

With the crest round, one instance each of d2's #9 (SMOKE) and its KEEP rows #10 (stable across a reload) and #11 (one undo
restores the claim) leave the slice tier. Two instances remain there, the quay's and the biome edge's, and all three run at
release.

The other P2-marked rows in FAST-CHECKS are covered by a lint case but stay in game. They cost about 0 s next to the dumps the
SMOKE row reads, or they are interleaved with a SMOKE or KEEP group. `tools/lint-coverage.json` lists all 53 rows with their
status, lint case and rules.

Measured at the same load (`20261021-224114-change`, all four bibles and the refusals skipped): w-ingame 8.1 min against
w-ingame-smoke 4.1 min, and d2-ingame 3.0 against d2-ingame-smoke 1.6. In the slice run (`20261021-225552-slice`, packed_mud and the refusals
kept), w-ingame-smoke took 2.5 min and d2-ingame-smoke 1.5 min. The baseline medians were 6.3 (w-ingame, after the region-poll
fix) and 2.3 (d2-ingame).

### Calibration (release tier: `p2-calibration`)

`tools/gate-lint.mjs` runs the probes and writes the record. Together they take about 2.5 min.
- **light:** each lamp fixture over grass. The game's block light must equal the kit's in every open cell within 15: 97k cells.
- **t3a-probe:** vanilla villagers across command-built beam and arch decks, a holed deck refused.
- **k1b-probe:** the same across slab decks.
- **voc-registry.**

`record`, run with CALIBRATION_WRITE=1 at release, writes `kit/test/fixtures/lint/calibration.json`: the Minecraft version, each
probe's verdict, the head. Commit it.

**The rule:** when the record names another Minecraft version, or any probe failed, every -smoke twin runs its full in-game rows
and the lint steps print WARN. The P2 rows are back in game until a release run passes the probes again. A Minecraft update must
run `p2-calibration` before any slice relies on the lints. First record: 2026-10-21, 26.3, every probe PASS.

### Slice wall time

The 12 FAST-CHECKS slices, replayed with the gate-waits medians as the before (`scratchpad/replay-p2.mjs`, local, the "Gate
waits" method):
- **Wall time:** the median is 104.0 → 103.7 min with a warm cache, and 104.6 min with a cold one (+0.6).
- **Step-minutes:** 311 → 311.
- **The 11 slices that ran w-ingame or d2-ingame:** 104.0 → 102.9 min wall, 311 → 308 step-minutes.

As FAST-CHECKS projected, P2's slice time is small. Its value is the coverage itself:
- the structure and look rules run on every slice's unit floor, on plans no camera saw;
- the release tier now runs w-ingame and d2-ingame in full.

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
- y-ingame: both failures were the harness's (housekeeping 3). On the client, NOT_ALLOWED came from a survival base the headless
  server had made in the same run dir (its mark now records the host; the other host rebuilds it). Headless, the host opened the
  survival world with its creative launch spec, so the dedicated server's default game type was creative and AUTO placed the
  batch road INSTANT; the host now opens an existing world in its own level.dat game mode (`server-host.mjs` `levelMode`).

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
| `release` | everything, with the duplicate heavy checks rotated (below); timing bars **judged**, `--quiet-wait` on by default; the judged benches reused from the nightly unless what they measure changed ("Benches out of the release path"); then the full independent gate-verifier | once per release batch (or weekly), unattended and overnight | 2-3 h on 3 shards (a 6b-sized release: ~2h20m estimated) |

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
| E-flat | `6a-eflat` every release |

Since 2026-10-22 the bench rotations are gone ("Benches out of the release path"): megaA, megaB, heap and volume run in the nightly
with their timing judged, and a release runs one only when what it measures changed since that nightly (megaB: the full walk when
its bench-sensitive core changed, else `--fast`; heap never). megaA still asserts **E-normal** (the diff after its group undo).
mega-lite is a judged bench like them (nightly; reused at release). throughput is no longer a bench: its timing is folded into
megaA, and it runs for its functional checks where the impact map picks it, timing recorded. megaB's relog and sidecar-kill rows run every release as `6a-resume`.

Always at release: units, sim suites, apijars, 4e-orders, 4d-all, 5b-chains, 5b-village, 6a-resume, 6a-eflat, 6a-forest, 6a-inv3,
6a-staged, and the sim 6b steps (6b-smoke, -ghost, -commands, -nudges, -pathstyle, -versions, -versionc, -scenario-s1,
-scenario-s1-flat). Each is a candidate: it runs when its cache key misses.

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
| `region/**` (engine, placement) | unit-mod, 6a-staged | 6a-megaA, 6a-inv3, 6b-ghost, 6b-volume, 6b-nudges, 6b-versions, 6a-resume |
| `placement/**`, `batch/**` (engine, placement) | unit-mod, 4e-megalite | 4e-orders, 4e-throughput, 4d-all, 5b-chains, 6a-resume |
| `delta/**` (placement) | unit-mod, 5b-village | 5b-chains |
| `site/**` | unit-mod, 4e-megalite | 4e-orders, 4d-all, 5b-village, 6b-pathstyle |
| `api/**`, `apiimpl/**` | unit-mod, apijars | sim-jobs, sim-sets, sim-massing, 4d-all |
| `survival/**` | unit-mod, apijars | 4d-all |
| `sidecar/**` | unit-sidecar, sim-jobs, sim-sets, sim-massing | |
| `sidecar/src/region*` (engine) | unit-sidecar | 6a-staged, 6a-inv3, 6a-resume |
| `kit/**` | unit-kit | sim-sets, sim-massing, 4e-megalite, 6b-smoke, 6b-ghost, 6b-scenario-s1-flat (dropped when 6b-scenario-s1 runs too) |
| `kit/lib/region/**`, `kit/regions/**` (engine) | unit-kit, 6a-inv3 | 6a-staged, 6a-eflat, 6b-versions, 6b-scenario-s1, 6cv-scenario-s7 |
| `scenarios/**` | unit-kit, 6b-scenario-s1-flat | 6b-scenario-s1 (s1-flat then drops), 6cv-scenario-s7 |
| slice V: the village components, `flat_village`, `tools/gate6cv.mjs`, S7 | v-unit | v-ingame, 6cv-scenario-s7 |
| slice W: lamps, fixtures, gravity, FROZEN, the road code, `tools/gate6cw.mjs` | w-unit | w-ingame, 6cv-scenario-s7 (it ends with W's lampsoff) |
| slice B: the brush kernels and program, ARVX v2, `Brushes`/`BrushCommands`, TileCheck, the brush API, `tools/gate6cb.mjs` | b-unit | b-ingame (headless), 4e-crash |
| slice PT: `placed/**`, the tracking mixins, the journal's `pt`, TileCheck, SiteJournal, roads, the build API, the kit's build helpers, `tools/gate6cpt.mjs` | pt-unit | pt-ingame and pt-nomod (headless) |
| `tools/gate6b.mjs`, `tools/lib/run6b.mjs`, `tools/find-site.mjs` | 6b-smoke | the other sim 6b steps |
| `tools/scenarios.mjs`, `tools/lib/scenario-*.mjs` | 6b-scenario-s1-flat | 6b-scenario-s1 (s1-flat then drops) |
| a gate driver (`tools/gate4e.mjs`, ...) | that gate's cheap steps | its longer steps |
| any other `mod/src/main/java/**` | unit-mod | |

Version-constant-only files map to their unit suite only (see "Version-only diffs" above).
Ignored (nothing to run): `docs/**`, `**/*.md`, eval results and briefs, `.github/**`, images, `mod/logs/**`. A path no rule and
no ignore glob covers is **unmapped**: `change` and `slice` fall back to the unit suites (slice: and apijars), and the plan prints it. A changed `tools/gate*.mjs` driver no rule covers is flagged in the plan: add a rule so the slice's own steps are found. Extend the
map when a slice adds a package or a gate step (`node tools/gate-impact.mjs <path>` shows what a path maps to).

### Faster runs

- **mega-lite in routine tiers.** `4e-megalite` (256x256) runs where the impact map picks it (placement, sites, kit, the drivers'
  libs), for its functional checks, timing recorded there; its timing is judged in the nightly (a judged bench). The full 1000x1000 mega_bench
  (megaA) runs in the nightly, at a release whose change touches what it measures, and in slices whose diff touches region code.
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

  A `bench` step (timing or MSPT bars: megaA/B, heap, volume, the scenarios) runs alone only where its timing is judged; elsewhere
  it schedules like any other step. The order is longest first from the step history. See "Gate speed" above.

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
- **Benches are exclusive where timing is judged** (`release`, the named chains, `--judge-timing`, `"isolate": true`; not the
  scenarios at a release that is not the nightly, whose timing is recorded there). There a
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
| `--turbo`, `--no-turbo` | | turbo for a tier run of at least 20 steps (`shards.turbo.minSteps`): the whole machine ("Turbo") |
| `--lanes N` | | turbo: `shards.turbo.offlineLanes` (3) offline lanes for the client-less steps |
| `--split`, `--no-split` | | split steps run as parts in turbo runs; `--split` outside turbo too |
| `--shards N\|auto` | | turbo: auto up to `shards.turbo.max` (9), N at most 9; shared: auto for `slice`/`release` over 20 steps (`shards.auto.minSteps`), else 1; N at most `shards.max` (6) |
| `--ports S:D[,S:D...]` (every shard's sidecar:DevBridge pair) | `GATE_PORTS`; or `ARCHITECT_GATE_SIDECAR_PORT`/`ARCHITECT_GATE_DEV_PORT` for shard 1 and `GATE_SHARD_PORTS` for shards 2.. | auto: free pairs of `shards.auto.portRange` (8980-8999); else shard 1: 8890:8891; shards 2..: **none, name them** |
| | `GATE_AUTO_PROBE` (JSON: `load1`, `load5`, `freeGB`, `cores`) | the machine now; overrides fields of auto's probe (marked INJECTED) |
| `--run-dir DIR` (shard k>1: `DIR-s<k>`) | `GATE_RUN_DIR` | `../architect-mc-gate-run` |
| `--run-dirs A,B,C` (every shard's, explicitly) | `GATE_RUN_DIRS` | |
| `--out DIR` | `GATE_RUNS_OUT` | `<main checkout>/artifacts/gate-runs` |
| `--lock FILE` | `GATE_LOCK` | `<out>/gate-run.lock` |
| `--seed-dir DIR` | `GATE_SEED_DIR` | `../architect-mc-6a-run` |
| `--quiet-wait [N]`, `--no-quiet-wait`, `--quiet-max-min M` | | on at release (N 8), else off (load recorded only); M 30 |
| `--slots N`, `--slots-dir DIR` | `GATE_SLOTS`, `GATE_SLOTS_DIR` | `slots.max` (4); `<LarattaLabs>/.gate-slots/` |
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
`mode: fast|full`. Compare only full-walk numbers with each other. `gate6a.mjs resume` (the step 6a-resume) is the same fast walk
in its own world, `resume-B.json` ("Benches out of the release path").

Since 2026-10-22 throughput carries `"timing": "recorded"`: in these chains too its bars are recorded, not judged, unless the run
passes `--judge-timing`. mega-lite's bars judge here as before.

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
   A turbo run (any tier run of 20+ steps) may first wait in the queue for the machine: its run dir appears only once it has it,
   and its output names whom it waits for. Wait on the runner's pid until then (`kill -0 <pid>`), then on `summary.json`.
4. **Read `SUMMARY.md` once.** Open a step's `<step>.log` or its gate JSON only for the steps that didn't pass.
5. **Never kill processes by name.** To stop a run, `kill -TERM $(cat $R/runner.pid)`. The runner stops its own steps and clients.
6. **Bench steps measure time.** Don't start clients while another run is in a `bench` step (its tick and cells/s bars), and
   read your own bench numbers with their recorded load. On a shared, busy box use `--quiet-wait`.
