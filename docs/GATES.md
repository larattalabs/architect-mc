# Gates: the unattended runner

`tools/gate-run.mjs` runs a named chain of gate steps (`tools/gate-chains.json`) against dev clients driven through the
DevBridge (docs/DEVBRIDGE.md), with nobody watching. It costs $0: there are no Claude calls. Every client is a stub or sim
sidecar client, and the runner refuses to start when Claude credentials are in the environment.

```sh
node tools/gate-run.mjs --list                      # the chains
node tools/gate-run.mjs regress --plan              # what it would do: steps, clients, timeouts, setup, ports; runs nothing
node tools/gate-run.mjs quick                       # run it (see "For agents" for how to launch it)
node tools/gate-run.mjs quick --notify-dry-run      # print the Discord message instead of sending it (also GATE_NOTIFY=dry|off)
node tools/gate-run.mjs regress --only 4e-orders,4e-crash   # a subset, in chain order; --from <step> resumes a chain
```

## Chains and the two-tier policy

| chain | steps | typical time |
|---|---|---|
| `quick` | unit tests (mod `gradlew build`, kit, sidecar vitest); the 4a/4b/4c sim suites (jobs, sets, massing); the unchanged 1.7.0/1.6.0/1.5.0 apitest jars; 4e mega-lite | about 30 min |
| `regress` | `quick` plus the 4d gate (all); 4e orders, crash and the village/roads throughput at 4 ms; 5b chains and village; 6a mega_bench B with the **fast** walk | about 3 h |
| `engine` | `regress` (with mega_bench B on the **full** walk instead of the fast one) plus 6a megaA, megaB, crash, eflat, inv3, staged and heap | about 5 h |

**Policy.** A phase that touches realise, the journal or streaming (region realise, tickets, the writer, journal format or
index, tile streaming, the undo) runs `engine` before it merges. That includes the full mega_bench, both configurations, on the
full 30 s walk. Every other phase runs `regress`. Use `quick` while iterating.

`gate6a.mjs megaB --fast` (or `GATE6A_MEGAB_FAST=1`) is the regression tier of mega_bench B. It dwells 8 s per waypoint instead of 30 s.
After a stage's first lap it teleports only to the 3x3-tile cells that still hold an unfinished item. The relog, the
sidecar kill and every bar stay the same, and `megabench-B.json` records `mode: fast|full`. The fast walk shows whether B still works,
not how long the full walk takes. Compare only full-walk numbers with each other.

## What a run does

1. **Guards.** It refuses to start if any of these is set: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`
   or `AWS_BEARER_TOKEN_BEDROCK`. Every child process gets an environment without any `ANTHROPIC_*` or `CLAUDE*` variable. It
   refuses steps that look paid (`*-real`, `--tier smoke|full`, `--backend claude`) and client scripts other than
   `run-gate4d/4e/5b/6a-client.sh`, which use the stub or the sim sidecar. It also refuses a run dir that is this checkout, the main
   checkout or the seed.
2. **Lock.** It holds `artifacts/gate-runs/gate-run.lock` (pid, chain), so a second run refuses to start. A lock whose pid has died is
   stale and is taken over.
3. **Preflight.** It refuses if any process already uses the run worktree, or if the two ports are taken. Everything it later kills is
   therefore its own.
4. **Setup.** The clients run from the runner's own worktree, `../architect-mc-gate-run` (`GATE_RUN_DIR`). That worktree is created with
   `git worktree add --detach` and checked out at this checkout's HEAD for every run. On its first run, `.gradle-home`,
   `sidecar/node_modules` and `mod/run` (the gate worlds, the prepared mega worlds and the library) are APFS-cloned from
   `../architect-mc-6a-run` (`GATE_SEED_DIR`). That copy is read-only, nothing is written back to it, and the clone takes seconds and
   almost no disk. The sidecar is then built.
   **The clients run the committed HEAD. The drivers (`tools/*.mjs`) run from this checkout's working tree.** `--plan`
   warns when the tree is dirty.
5. **Steps.** The steps run in chain order. Each step names its client: one of `cfg.clients` (started in its world unless it is
   already up), `none` (no client, as for unit tests), or `self` (the step starts its own clients, as apijars does). Each
   step runs in its own process group, with the timeout from the config.
   - **TIMEOUT.** The step's group gets SIGTERM, then SIGKILL. After that, every process whose command line names the run
     worktree is stopped: gradle, the client JVM and the sidecar. Stray apitest jars are removed from `mods/`.
   - **After any step that doesn't pass**, the client is stopped. The next step starts a fresh one.
   - **Verdicts.** PASS means exit 0, no `FAIL` lines, and at least one `ok` line. Unit tests use parsed counts instead of
     `ok` lines.
   - **Failures.** The run continues past a failure, unless the step is `stopOnFail` (`unit-mod`: no point running gates on a
     build that fails). A step with `after` is skipped if that step didn't pass (4e crash needs 4e orders' context).
6. **Ports.** The game client uses `ARCHITECT_GATE_SIDECAR_PORT` / `ARCHITECT_GATE_DEV_PORT`, default 8890/8891. The gates'
   old-version clients use 8892/8893 and eval sidecars 8894/8895. Run nothing else on 8890-8895 during a run.
7. **End.** It writes `summary.json` and `SUMMARY.md` and sends one notify through `~/Developer/_infra/discord-notify.sh`. A
   pass is routine (silent). A fail, timeout, stopOnFail stop or abort is `--critical`. The message has the chain, the
   pass/fail/timeout counts, the duration, the head and the SUMMARY.md path. It carries no secrets.
   SIGINT/SIGTERM abort cleanly, with the same summary and notify. SIGHUP is ignored.

**Output.** Everything goes to `artifacts/gate-runs/<YYYYMMDD-HHMMSS>-<chain>/` in the main checkout (`GATE_RUNS_OUT` overrides):

- `summary.json`:
  - `state` is `running` | `done` | `stopped` | `aborted`, and `verdict` is `PASS` | `FAIL`.
  - Each step has its status, seconds, ok/FAIL counts, the first FAIL lines and key numbers. Examples of key numbers:
    unit test counts, mega-lite cells/s, throughput median, megaA cells/s and MSPT p99, megaB resume times.
  - The file is rewritten after every step.
- `SUMMARY.md`
- `runner.pid`, `runner.log`, `setup.log`, `client.log`, `notify.json`
- `<step>.log`
- The gates' evidence: `gate4d/`, `gate4e/`, `gate5b/`, `gate6a/` (shared by that gate's steps, so context carries over) and `sim-*/`.

## For agents: launch, then wait once

Gate chains run for hours. Polling them from an agent session burns the subscription for nothing. Do this instead:

1. **Launch it detached** and note the run dir:

   ```sh
   nohup node tools/gate-run.mjs regress > /tmp/gate-run.out 2>&1 &
   sleep 30; R=$(ls -td ../architect-mc/artifacts/gate-runs/*-regress | head -1); echo $R
   ```

2. **Wait, don't poll.** Either end your turn and let the Discord notify reach Noah, or run **one** long until-loop in the
   background. The loop ends when the state is terminal or when the runner's pid is gone, so a crashed runner can't hang it:

   ```sh
   until grep -qE '"state": "(done|stopped|aborted)"' $R/summary.json || ! kill -0 $(cat $R/runner.pid) 2>/dev/null; do sleep 300; done
   ```

   Never check every few minutes from the conversation. At most one background wait at a time, with a timeout longer than
   the chain's (`--plan` prints the worst case).
3. **Read `SUMMARY.md` once.** Open a step's `<step>.log` or its gate JSON only for the steps that didn't pass.
4. **Never kill processes by name.** If a run must stop, `kill -TERM $(cat $R/runner.pid)`. The runner stops its own steps
   and clients.
