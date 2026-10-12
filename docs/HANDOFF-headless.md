# HANDOFF: headless gates (branch `tools/headless-gates`, worktree `../architect-mc-headless`)

Resume notes for the headless gate mode (docs/GATES.md "Next: headless gates"). Delete this file when the work merges.

## State (2026-10-11)

**Blocked on the Minecraft EULA.** A dedicated server only starts when `eula.txt` in its run dir says `eula=true`, and writing
that file accepts Mojang's EULA on Noah's behalf. Agents don't do that without Noah's explicit yes.

- Spike done: `ARCHITECT_APITEST=1 ./gradlew --offline --no-daemon :runServer --args=--nogui` on main's code (1c962bf) loads
  Architect and apitest on a dedicated 26.3 server (`apitest: Architect API 1.14.0`, `Architect common init done`). The
  server then stops at the EULA check (it wrote `mod/run/server/eula.txt` with `eula=false`). 3m22s, including the first compile.
- Nothing else is built yet.

**Proposed ask to Noah:** create one file, `~/Developer/_infra/minecraft-server/eula.txt`, containing `eula=true`. The
headless harness then refuses to start a server unless that file exists, and copies it into each server's run dir. The
acceptance stays Noah's own action and covers every agent's headless gate server.

## Findings that shape the design

- **The whole DevBridge is client-side.** All 151 hooks, `ServerTasks.callAsPlayer`, and `ApiClientBridge`, `Sidecar`,
  `SidecarLink` and `Launcher` live in `mod/src/client/java`. Java-WebSocket is `clientImplementation`. On a dedicated server
  `ApiImpl.bridge()` is null, so regions, jobs, sets and massing refuse, not only the player checks.
- `SidecarLink`, `SidecarState` and `LinkStatus` have no Minecraft imports. `LauncherPlan` is already in main.
- The client's integrated server uses view distance 16 and simulation distance 10 (`run-template/options.txt`). A bot's
  `ClientInformation` must ask for 16: the default asks for 2, which would shrink LOADED_ONLY to radius 2.

## Plan

1. **A `devserver/` Gradle subproject**, dev-only like `apitest/` and never in the shipped jar. It is loaded only on
   `runServer` with `ARCHITECT_HEADLESS=1`. It holds:
   - a server-side DevBridge: same protocol, token file and loopback-only rules;
   - a carpet-style bot, a real `ServerPlayer` placed through `PlayerList.placeNewPlayer` with a dummy `Connection`, named like
     the client's player so that the offline UUID and site ownership match;
   - server ports of the hooks the converted drivers use;
   - a server `ClientBridge` built on the sidecar link classes, so regions and sims work.
2. **`tools/lib/server-host.mjs`, a supervisor that owns the drivers' DevBridge port.**
   - It proxies to the JVM's bridge.
   - `dev.world.leave` stops the server, which saves the world.
   - `dev.world.open` writes `server.properties` and starts the JVM on `--universe <gameDir>/saves --world <name>`.
   - `dev.state` and `dev.ping` are answered while the JVM is down.
   - The drivers keep their GAME_DIR and SAVES paths, and the socket survives restarts.
3. **Runner:** a per-step host (`server|client`) in new modules, with minimal edits to `gate-run.mjs`. The `tools/gate-policy`
   branch is changing that file too.
4. **Comparison and concurrency:** the steps 4d-all, 6a-megaA, x-resume and apijars, headless against client, 3 runs each.
   Ports 8942-8953 only.
