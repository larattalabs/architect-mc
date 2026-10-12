# HANDOFF: headless gates (branch `tools/headless-gates`, worktree `../architect-mc-headless`)

Resume notes for the headless gate mode. Delete this file when the work merges. **Paused by Noah 2026-10-12 ~05:55Z. Not
ready to merge:** the 3x comparison is partial, `docs/GATES.md` has no headless section yet, and no gate-verifier review has run.

## What exists

- **EULA:** Noah created `~/Developer/_infra/minecraft-server/eula.txt` (`eula=true`) himself. The host refuses to start
  without it and copies it into the run dir.
- **`devserver/`:** a dev-only Gradle subproject like `apitest/`. It never ships and makes no API or mod change. It loads only
  on `runServer` with `ARCHITECT_HEADLESS=1`. It contains:
  - **The line bridge** (`LineBridge`): a Unix socket, so it binds no TCP port.
  - **The bot** (`Bot`): a real `ServerPlayer` joined through vanilla's `PrepareSpawnTask`, with the client's name, so its
    UUID and site ownership match.
    - View distance 16.
    - Each tick it confirms teleports and moves its chunk tracking (a client's move packets do this), ticks its connection
      and answers keep-alives.
    - It does not fall: a server never simulates player gravity. No gate relies on falling.
  - **The hooks:** generated at build time by `genHooks` from the client's `JournalDev`, `RegionDev`, `RegionDev6b`,
    `DeltaDev`, `SliceVDev` and `Fields` (package and import rewrite; headless stand-ins for `RegionGhost`, `Sidecar` and
    `DevCommands.camera`). A client-only reference in those files fails the build. No in-flight branch trips this (checked
    Y1, Y2, MP, F1, W and C23).
    - Hand ports: `PortedHooks` (placement, survival, slice 0a, launcher and sidecar) and `CoreHooks` (state, command, wait,
      waitChunks, camera = move the bot, pause).
    - Rendering and UI hooks answer "client-only".
  - **The sidecar** (`ServerSidecar`): the client's launcher and link logic. The helper's parent pid is the host, so it
    survives world switches. The link stays up on the "title screen".
  - **World switches in one process** (`ServerOpen` + `KeepExecutorsMixin`): 3-5 s per switch, against 35-60 s for a fresh
    server start.
  - **Mixins:** `NoTcpListenerMixin` opens no game port. `PauseMixin` makes `dev.screen {open:"pause"}` skip server ticks,
    as a paused integrated server does.
- **The host:** `tools/run-headless-server.mjs` with `tools/lib/server-host.mjs` and `tools/lib/wsserver.mjs`. It owns the
  DevBridge port and token, and handles world open, leave and quit. The drivers are unchanged.
- **The runner:** `--host auto|client|server` / `GATE_HOST` (`tools/lib/hosts.mjs`), driven by each step's `host` and
  `hostWhy`. Each client gets a `<key>@server` twin. `gate6a.mjs` and `lib/run6b.mjs` take `GATE6A_CLIENT_SCRIPT` /
  `GATE6B_CLIENT_SCRIPT`.
- **Ports:** each headless server binds only its DevBridge and sidecar ports, so 8942-8953 fits 6 servers. Runs still take
  machine slots.
- **Steps marked so far:** only apijars, as `host: client`. No step is marked `host: server` yet: do that from the evidence
  below.

## Results (evidence in `architect-mc/artifacts/gate-runs-headless/`)

### Pass headless, all functional checks

| step | headless | client, same code | notes |
|---|---|---|---|
| 6a-megaA | 14/0 in 11m42s (load 39-46) | 14/0 in 13m15s (load 16-44) | 23 mismatches on both, identical to every past client run; realise CPU max 38.0 vs 46.5 ms |
| 4d-all | 61 ok / 2 FAIL in 15m01s | 62 ok / 1 FAIL in 15m10s; 2nd run stopped at 46/0 | see below |
| x-resume (C23, on scratch merge `scratch/headless-c23`, not pushed) | 46/0 in 8m18s | 46/0 in 10m08s | |
| 4e-megalite | 11/0 | | |
| 4e-orders | 39/0 | | |
| 5b-village | 24/0 | | |
| 6a-eflat | 5/0 | | |
| 6a-forest | 4/0 | | |
| 6a-inv3 | 1/0 | | |
| 6a-staged | 10/0 | | |
| 6b-smoke | 7/0 | | |
| 6b-commands | 2/0 | | |
| x-ingame | 53/0 | | removal included |
| sim-jobs | 33/0 | | after the pause fix |
| sim-sets | 37/0 | | after the title-screen link fix |
| 6b-pathstyle | 2/0 | | after porting RegionDev6b |

- **4d-all headless:** both FAILs are one timing bar (own-tick CPU 50.36 ms against 50), counted twice. Under the slice tier it
  is recorded only.
- **4d-all client:** its FAIL was **functional**: "group undo: every lot region ... back exactly". Headless passed that check.
  This is one run each; it needs the remaining rounds before calling it a client flake.
- **Rows without client figures** come from 3-shard headless sweeps. Their timings are not comparable.

### Fail headless, and why

- **sim-massing** (26 ok, then a timeout): the composite-preview check needs the client renderer
  (`composite:apitest:plan`). Keep it on the client, or split the composite part out.
- **apijars** (10 ok per jar, then the script aborts at `dev.build.start`): the archived scripts drive the placement UI, the
  Library UI and `ArchitectClientApi.preview`. It stays on the client (`host: client`). The client passes 45 ok per jar.
- **6b-ghost:** takes a screenshot of the ghost, so it stays on the client.
- **6b-nudges, 6b-versions, 6b-versionc and v-ingame:** their last run was cut short. A setup error in the 3-shard run
  aborted it: `spawn .../architect-mc-hlsw-s3/tools/run-headless-server.mjs ENOENT`, probably the shard worktree checked out
  before the file existed; look at it. They failed earlier only on the then-missing RegionDev6b hooks. Re-run.
- **Not tried:** 6b-volume, 6b-scenario-s1(-flat), 6cv-scenario-s7, 5b-chains, 4e-crash, 6a-crash, 6a-megaB, 6a-heap, 0a-*,
  0b-*.

### Stay on the client

- apijars, 6b-ghost, and the screenshot and gallery parts of the scenario steps.
- sim-massing's composite check (above).
- Anything with `dev.screenshot`, `dev.ui.*`, `dev.build.*` or `dev.library.*` as checks, not just as `catch`-ed shots.

### Memory, peak RSS

| | headless | client |
|---|---|---|
| JVM | 2.0-3.8 GB | 3.3-5.2 GB |
| sidecar | 0.11-0.18 GB | 0.17-0.23 GB |

The headless figures come from 3 servers running at once in one slot.

## What's left

1. **Finish the comparison.** Rounds 2-3 of 4d-all, 6a-megaA and x-resume, headless and client, interleaved, then compare
   ok/FAIL sets and timing-bar spread. The script is in the scratchpad (`compare.sh`); give each sequence its own `--lock`
   (the first launch collided on the shared lock and ran nothing).
2. Re-run the cut-short steps headless (6b-nudges, -versions, -versionc, v-ingame) and look at the ENOENT setup error.
3. Mark `host: server` per step from the evidence; mark client-only steps with `hostWhy`.
4. Write the headless section of `docs/GATES.md`: usage, the per-step table, the comparison, memory, ports. Add the
   generated-hooks rule to `docs/DEVBRIDGE.md`.
5. Get a gate-verifier review of the diff and the evidence. Merge `origin/main` again first.
6. **Cleanup:** the run worktrees `../architect-mc-hl-run`, `-hlc-run`, `-hlx-run`, `-hlxc-run` and `-hlsw(-s2,-s3)`, the
   scratch worktree `../architect-mc-hlc23` and its local branch `scratch/headless-c23`, never pushed.
