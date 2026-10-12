# HANDOFF: headless gates (branch `tools/headless-gates`, worktree `../architect-mc-headless`)

Resume notes for the headless gate mode (docs/GATES.md "Headless gates"). Delete this file when the work merges.

## State (2026-10-12 02:30)

- **EULA:** Noah created `~/Developer/_infra/minecraft-server/eula.txt` himself. The host refuses to start without it and
  copies it into the run dir.
- **Built and working on a smoke world:**
  - **`devserver/`**, a dev-only Gradle subproject that never ships:
    - the line bridge on a Unix socket;
    - the bot (a real `ServerPlayer` through vanilla's PrepareSpawnTask; it confirms teleports and moves its chunk tracking
      each tick; view distance 16);
    - the hooks: generated from the client's `JournalDev`, `RegionDev`, `DeltaDev`, `SliceVDev` and `Fields`, plus hand ports
      in `PortedHooks` and `CoreHooks`;
    - the sidecar launcher, link and `ClientBridge` (`ServerSidecar`);
    - in-process world switches (`ServerOpen`, `KeepExecutorsMixin`);
    - no game port (`NoTcpListenerMixin`).
  - **The host:** `tools/run-headless-server.mjs` and `tools/lib/server-host.mjs`, with the WebSocket in `tools/lib/wsserver.mjs`.
  - **The runner:** `--host auto|client|server` (`tools/lib/hosts.mjs`), with each step's `host` and `hostWhy` in
    `gate-chains.json`.
- **Measured on the smoke world (load ~50):**

  | | time |
  |---|---|
  | first start | 35-60 s (gradle `headlessLaunch` ~5-50 s on top) |
  | world switch (leave + open) | 3-5 s |
  | far teleport, chunks ready | 13 s for radius 15 |
- **Not yet:** the conversion runs, the comparison against clients, concurrency, and docs/GATES.md.

## Ports

Each headless server binds only its DevBridge and sidecar ports. Agent runs use 8942-8953.

## Decisions

- **apijars stays on the client.** The archived `apitest.mjs` survival scripts drive the UI and `ArchitectClientApi.preview`,
  and abort headless. The comparison reports it check by check.
- **Bot gravity:** a server never simulates a player's gravity (the client does), so the bot does not fall. No gate relies on
  that.
- **x-resume lives on `fix/c23-resumed-removal`, not main.** Compare it on a local scratch merge of this branch and C23,
  never pushed.
