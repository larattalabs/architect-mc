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
| 6c | x-ingame (removal included), x-resume (C23), v-ingame |

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
  - The worst whole-tick wall maxima were 171 ms headless against 319 ms on the client.
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
| `tools/gate6b.mjs`, `tools/lib/run6b.mjs`, `tools/find-site.mjs` | 6b-smoke | the other sim 6b steps |
| `tools/scenarios.mjs`, `tools/lib/scenario-*.mjs` | 6b-scenario-s1-flat | 6b-scenario-s1 |
| a gate driver (`tools/gate4e.mjs`, ...) | that gate's cheap steps | its longer steps |
| any other `mod/src/main/java/**` | unit-mod | |

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
  (`<run>/s<k>/`). Steps declare what they need: steps sharing a `resources` entry never overlap; a `bench` step (timing or MSPT
  bars: mega-lite, throughput, megaA/B, heap) waits until everything else has started and drained, then runs alone; a step with
  `after` (4e-crash after 4e-orders) runs on its dependency's shard; a `stopOnFail` step (unit-mod) is a barrier.

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
- **Benches are exclusive** within a run: a bench step starts only when no other step is running on any shard, nothing else
  starts while it runs, and the other shards' idle clients are stopped first. Across runners on the same machine there is no
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
   apijars does). Each step runs in its own process group, with the timeout from the config.
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
  throughput median, megaA cells/s and MSPT p99, megaB resume times). Rewritten after every step.
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
