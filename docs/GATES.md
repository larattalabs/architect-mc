# Gates: the unattended runner and the risk-tiered policy

`tools/gate-run.mjs` runs gate steps (`tools/gate-chains.json`) against dev clients driven through the DevBridge
(docs/DEVBRIDGE.md), with nobody watching. It costs $0: there are no Claude calls. Every client is a stub or sim sidecar client,
and the runner refuses to start when Claude credentials are in the environment.

```sh
node tools/gate-run.mjs --list                                   # the chains and tiers
node tools/gate-run.mjs change --since origin/main --plan        # what a tier would run, and why; runs nothing
node tools/gate-run.mjs change --since origin/main               # minutes: the unit suites + the steps the diff maps to
node tools/gate-run.mjs slice  --since origin/main --shards 3 --ports 8890:8891,8896:8897,8898:8899   # ~30 min
node tools/gate-run.mjs release --release v0.12.0 --shards 3 --ports ...   # overnight: everything, duplicates rotated
node tools/gate-run.mjs quick                                    # a named chain (quick | regress | engine), as before
node tools/gate-impact.mjs --since origin/main                   # just the change-impact report
```

## The policy (Noah, 2026-10-09; PLAN.md "Process from 6c on")

Gates are tiered by risk. Run the cheapest tier that covers the change, and the expensive checks once per release.

| tier | what runs | when | typical time |
|---|---|---|---|
| `change` | the three unit suites (mod `gradlew build`, kit, sidecar vitest) + the steps the impact map gives the changed paths. A docs-only diff runs nothing. | every commit or small change, while iterating | minutes (a journal change: ~16 min; a driver change: ~7 min) |
| `slice` | `quick` (units, the 4a/4b/4c sim suites, the apitest jars, 4e mega-lite) + the change and slice steps of the impact. A docs-only diff runs nothing. | before a slice merges | about 30 min (a journal slice: ~32 min on one shard) |
| `release` | everything, with the duplicate heavy checks rotated (below); then the full independent gate-verifier | once per release (or weekly), unattended and overnight | 2-3 h on 3 shards (a 6b-sized release: ~2h20m estimated) |

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

Always at release: units, sim suites, apijars, mega-lite, 4e-orders, 4d-all, 5b-chains, 5b-village, 6a-megaA, 6a-eflat, 6a-inv3,
6a-staged.

"Engine-touching" and "placement-touching" are tags on impact rules: the journal, regions, region synthesis and the realise and
placement code are `engine`; regions, placement and deltas are `placement`.

### Change-impact mapping

`impact` in `tools/gate-chains.json` maps path globs to steps (`tools/gate-impact.mjs` applies it to
`git diff --name-only`). Each rule has the steps a `change` run picks (`change`), the extra steps a `slice` run adds (`slice`) and
its tags. Every matching rule counts. The main rules:

| paths | change | slice adds |
|---|---|---|
| `journal/**` (engine) | unit-mod, 4e-orders, 4e-crash, 6a-eflat | |
| `region/**` (engine, placement) | unit-mod, 6a-staged | 6a-megaA, 6a-inv3 |
| `placement/**`, `batch/**` (engine, placement) | unit-mod, 4e-megalite | 4e-orders, 4e-throughput, 4d-all, 5b-chains |
| `delta/**` (placement) | unit-mod, 5b-village | 5b-chains |
| `site/**` | unit-mod, 4e-megalite | 4e-orders, 4d-all, 5b-village |
| `api/**`, `apiimpl/**` | unit-mod, apijars | sim-jobs, sim-sets, sim-massing, 4d-all |
| `survival/**` | unit-mod, apijars | 4d-all |
| `sidecar/**` | unit-sidecar, sim-jobs, sim-sets, sim-massing | |
| `sidecar/src/region*` (engine) | unit-sidecar | 6a-staged, 6a-inv3 |
| `kit/**` | unit-kit | sim-sets, sim-massing, 4e-megalite |
| `kit/lib/region/**`, `kit/regions/**` (engine) | unit-kit, 6a-inv3 | 6a-staged, 6a-eflat |
| `scenarios/**` | unit-kit | sim-massing (the 6b scenario steps join here at the 6b merge) |
| a gate driver (`tools/gate4e.mjs`, ...) | that gate's cheap steps | its longer steps |
| any other `mod/src/main/java/**` | unit-mod | |

Ignored (nothing to run): `docs/**`, `**/*.md`, eval results and briefs, `.github/**`, images, `mod/logs/**`. A path no rule and
no ignore glob covers is **unmapped**: `change` falls back to the unit suites, `slice` to `quick`, and the plan prints it. Extend the
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
   `run-gate4d/4e/5b/6a-client.sh`, which use the stub or the sim sidecar. It refuses a run dir that is this checkout, the main
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
| `quick` | unit tests; the 4a/4b/4c sim suites (jobs, sets, massing); the unchanged apitest jars; 4e mega-lite | 9.5 min serial (measured); see the shard timings below |
| `regress` | `quick` plus 4d (all); 4e orders, crash, throughput; 5b chains and village; 6a megaB `--fast` | about 3 h serial |
| `engine` | `regress` (with the full megaB) plus 6a megaA, megaB, crash, eflat, inv3, staged and heap | about 5 h serial |

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
6. **Bench steps measure time.** Don't start another runner's clients while a run is in a `bench` step (its MSPT and cells/s bars),
   and treat your own bench numbers as noisy when another run is busy.
