# DevBridge

The DevBridge is Architect's headless test surface: a WebSocket server inside the dev client that runs commands, drives
the UI, aims the camera and takes screenshots, so every gate runs without touching a real world. It is a **semi-stable**
surface for other mods' tooling (docs/CONTRACT.md phase 4a, R11): changes are recorded in the changelog at the end of this
file, but it is not semver'd. The Java API (`dev.larattalabs.architect.api`) is the stable contract; the DevBridge is for
tests.

## Connecting

- **Where:** `ws://127.0.0.1:<port>`, loopback only. The port is `ARCHITECT_DEV_PORT`, default `7891`. The client's sidecar port is `ARCHITECT_PORT` (default `7890`). Run several clients side by side by
  giving each its own pair (the repo's sessions use 7890/7891, 7990/7991, 8090/8091 and 8190/8191).
- **When:** dev runs only (`gradlew runClient`, or any client with `ARCHITECT_DEV_PORT` set). It starts when the client
  has started, before a world loads.
- **Token:** every connection needs the shared secret, as `?token=<token>` on the URL or `Authorization: Bearer <token>`.
  The client writes a fresh random token to `<gameDir>/architect/devbridge.token` (mode 0600) on every start, or uses
  `ARCHITECT_DEV_TOKEN` when set. The dev client's game dir is `mod/run`.
- **Messages:** one JSON object per text frame. The server greets with `{"type":"dev.hello", ...}`. A request is
  `{"type":"dev.<hook>", "id":"<any>", ...arguments}`; the answer carries the same `id` and `type`, `"ok": true` plus the
  result fields, or `"ok": false, "error": "<why>"`. The field `id` is always the request id, so hooks never take an
  argument named `id` (they use `site`, `entry`, `control`, ...).
- **Hardcore:** hooks that would cheat refuse in a Hardcore world unless the client runs with `ARCHITECT_DEV_HARDCORE=1`.

## Using it from another mod's tooling

`tools/lib/devclient.mjs` has no dependencies (Node 22+ has `WebSocket`) and is importable by path from any checkout:

```js
import { DevClient } from '/path/to/architect-mc/tools/lib/devclient.mjs';

// the port: opts.port, else ARCHITECT_DEV_PORT, else 7891
// the token: opts.token, else ARCHITECT_DEV_TOKEN, else <ARCHITECT_GAME_DIR (default <architect checkout>/mod/run)>/architect/devbridge.token
const dev = await DevClient.connect({ port: 8191, timeoutMs: 120_000 });
await dev.waitInWorld();
const st = await dev.call('dev.state');                       // throws DevError when ok is false
const r = await dev.call('dev.command', { cmd: '/time set 6000' });
const shot = await dev.call('dev.screenshot', { name: 'hello' }, { timeoutMs: 120_000 });
dev.close();
```

- A mod running its own dev client points `ARCHITECT_GAME_DIR` at that client's game dir (the token lives there) and sets
  `ARCHITECT_DEV_PORT` to the port its client was started with.
- `dev.request()` returns the raw answer; `dev.call()` throws on `ok: false`. `dev.health()` / `dev.assertNotHung()` tell a
  hung game from a slow one (`dev.ping` is answered on the socket thread).
- `node tools/devcli.mjs <command>` is the same client as a CLI (`wait`, `state`, `shot`, `cmd`, `raw '<json>'`, `quit`...),
  honouring the same environment variables.
- Another mod's own checks go through its own commands (`dev.command` runs any command and returns its chat output as
  `messages[]`), as Architect's `apitest` mod does (`/apitest ...`, driven by `tools/apitest.mjs`).

## Hooks

The list below is what `dev.help` returns (`{commands: {name: description}, screens}`), grouped. Arguments are in braces
(`?` = optional, with the default), results after `->`.

### World and view

| hook | arguments, result |
|---|---|
| `dev.camera` | {x,y,z, yaw,pitch \| lookAt:{x,y,z} \| anchor:name, fov?:30-110 (default: the player's FOV option), mode?:spectator\|creative\|keep, feet?:false, hideHud?, closePause?:true} - put the camera (eye) exactly there; fails if it can't. anchor fills x/y/z/yaw/pitch from dev.anchors (cam_* = eye, others = feet) |
| `dev.click` | {x, y, button?: 0} - a mouse click at GUI coordinates on the open screen |
| `dev.command` | {cmd, asPlayer?: false} - run a command as the player with full permissions (asPlayer: with the player's own permissions, as if typed; refused in a Hardcore world unless asPlayer) -> {messages[], success, result} |
| `dev.help` | {} -> {commands, screens} |
| `dev.hud` | {hidden: bool} - hide/show the HUD (like F1) |
| `dev.key` | {key:'escape'\|'key.keyboard.f3', modifiers?} or {mapping:'key.chat'} - press a key (to the open screen, else key mappings) |
| `dev.ping` | {} -> {pong, frame, msSinceLastFrame, stalled, quitting}. Answered on the socket thread, so it works while the game loads or hangs; stalled:true means the render thread has not finished a frame for 5 s |
| `dev.quit` | {forceAfterMs?:15000} - save and quit. If the render thread is hung and never runs the stop, the world is saved on the server thread and the JVM is halted (exit code 3) after forceAfterMs |
| `dev.release` | {mode?:creative\|keep} - give the view back to the player: clears the FOV pin, shows the HUD, spectator -> creative (flying) |
| `dev.screen` | {open: name\|null} - open a screen (title\|pause\|chat\|inventory\|options\|<registered>) or close it |
| `dev.screenshot` | {name, hideHud?:true, frames?:3 (1-600), waitChunks?:true, chunkRadius?:renderDistance-1, chunkTimeoutMs?:30000} -> {path,width,height,stats} |
| `dev.state` | {} -> {inWorld, ready, paused, player, camera, screen, fps, window, fov, ...} |
| `dev.time` | {ticks: 0..2147483647} - set the day time (6000 noon, 12000 golden hour, 18000 night, 23300 sunrise) |
| `dev.type` | {text} - type text into the focused widget of the open screen |
| `dev.wait` | {frames?:0-36000, ms?:0-600000} - wait for rendered frames and/or wall time |
| `dev.waitChunks` | {timeoutMs?:30000, radius?:renderDistance-1} - block until chunks around the camera are loaded+built |
| `dev.weather` | {clear?:true} or {weather: clear\|rain\|thunder} |

### Placement (the ghost)

| hook | arguments, result |
|---|---|
| `dev.build.cancel` | {} - leave placement mode (Esc) |
| `dev.build.confirm` | {force?: bool} - place it (Enter; force = Shift+Enter, only after a block-entity refusal); replies when the server answered: {placed, siteId, message} + state |
| `dev.build.lock` | {on?: bool (default: toggle)} - lock the ghost where it is / follow the look again |
| `dev.build.nudge` | {forward?, right?, up?} - move the ghost (blocks, relative to where the player faces) |
| `dev.build.rotate` | {turns?: 1} - rotate the ghost by quarter turns (clockwise; negative = back) |
| `dev.build.start` | {blueprint, origin?: [x,y,z] (rotated box minimum; locks the ghost there), ground?: false (origin's y replaced by the footprint's median surface), turns?: 0-3 \| rotation name, move?: siteId} - enter placement mode |
| `dev.build.state` | {} - placement mode: blueprint, origin, rotation, box, conflicts {obstructed, blockEntities, refusals, wouldPlace, approach, site}, serverVerdict, ready, render stats, last result |

### Sites

| hook | arguments, result |
|---|---|
| `dev.box.hash` | {min: [x,y,z], max: [x,y,z], cells?: false} - SHA-256 over every block state and block-entity NBT in the box (the player's dimension, loads chunks): before/after a place + remove proves the terrain came back exactly |
| `dev.capture` | {min: [x,y,z], max: [x,y,z], name} - save the box as a structure template (as a structure block would) to <gameDir>/architect/captures/<name>.nbt (authoring library designs by hand) |
| `dev.sites.failNextMove` | {} - test hook: the next move fails restoring the old site and rolls back |
| `dev.sites.remove` | {site, force?: false} - Remove (restores the terrain) as the Library's Remove does |
| `dev.sites.state` | {} - the placed sites of this world, the sites taken down (pending until the next world start settles them, with snapshotExists), the world-start reports and snapshot files no site names |

### Survival

| hook | arguments, result |
|---|---|
| `dev.crate.insert` | {site, items?: {item: count}, inventory?: true} - book items into the crate as a hopper would (counting equivalents), or move the player's needed items in (Insert from inventory) -> what went in |
| `dev.crate.open` | {site} - open the crate screen of a site (as a right-click on its crate does) |
| `dev.crate.press` | {control: insert\|pause\|deconstruct\|close} - press a crate screen button |
| `dev.crate.state` | {} - the open crate screen: controls, flash, the site state it shows |
| `dev.ghosts.state` | {} - the construction-site ghosts this client holds (cells, built, remaining, HUD line) |
| `dev.items.near` | {pos: [x,y,z], radius?: 8} - dropped item entities near a point: stacks and items per id; and the player's inventory per id (refund checks) |
| `dev.site.deconstruct` | {site, force?: false} - Deconstruct (as the crate screen / Library Remove): refunds, the player's blocks and the crate's stock drop at the crate; the terrain comes back -> the tally |
| `dev.site.finish` | {site} - /architect site finish (dev hook: no permission check): the remaining cells, free |
| `dev.site.mine` | {pos: [x,y,z], pickup?: true} - the player mines a block as in survival (vanilla drops), then picks up its drops |
| `dev.site.state` | {site} - a construction site: state, queue length, built count, BOM rows, ledger, blocked cells, notes, the last deconstruct's tally |
| `dev.survival.set` | {on: bool} - set the survival toggle (dev hook: bypasses the permission rule; the Status tab and /architect survival enforce it) |
| `dev.survival.state` | {} - this world's survival toggle, blocksPerTick, and whether the player may change it |

### Architect screen

| hook | arguments, result |
|---|---|
| `dev.ui.click` | {control} - press a control of the Architect screen by id (the field is not 'id': that is the request id) (see dev.ui.state controls) |
| `dev.ui.focus` | {field: style\|materials\|name\|notes\|key\|none} - focus a text field (then dev.type) |
| `dev.ui.open` | {tab?: design\|library\|designs\|status} - open the Architect screen |
| `dev.ui.state` | {} - the open Architect screen: tab, focus, controls [{id, label, state, x, y}] (GUI px) |

### Library

| hook | arguments, result |
|---|---|
| `dev.library.delete` | {entry?} - Delete (to architect/library-trash; bundled entries refuse) and reload |
| `dev.library.export` | {entry?} - Export: architect/exports/<id>/ + the world's generated/architect_mc/structure/<id>.nbt -> {dir, files, worldFile, structureId, structureLoads, structureSize} |
| `dev.library.favorite` | {entry?, on? (default: toggle)} - the star |
| `dev.library.filter` | {reset?, buildingType? (all\|<type>), tag? (all\|<tag>), favorites?, text?, sort?: newest\|name\|size} - set the Library tab's search/filters/sort |
| `dev.library.import.list` | {} - Import…: opens the dialog and lists the .nbt files (imports/ and this world's structure-block saves) |
| `dev.library.import.pick` | {index? \| path?} - pick a file in the Import… list and press Import (import.request) -> {jobId} |
| `dev.library.remix` | {entry?} - Remix…: the Design tab prefilled from the entry, remix set, notes focused |
| `dev.library.rename` | {entry?, name} - Rename (the inline editor; "" = back to the design's own name) |
| `dev.library.select` | {entry} - select a card |
| `dev.library.state` | {} - the library: query, visible cards, selected (detail), user tags, the Variants form, the import list, the last export, messages |
| `dev.library.tag` | {entry?, tags: [..] \| "a, b"} - Tags (the inline editor; replaces the user tags) |
| `dev.library.variants.open` | {entry?} - Variants… (refused for imported entries and entries without a source) |
| `dev.library.variants.set` | {preset?, wood?, stone?, roof?, accent?, values?: {param: value}, steps?: {param: delta}, toggle?: [param], name?} - change the open Variants dialog |
| `dev.library.variants.submit` | {} - Make variant (variant.request) -> {jobId} |
| `dev.library.wait` | {jobId, timeoutMs?: 60000} - wait until a variant/import job is done (and its entry loaded) or failed -> {status, blueprintId, error} |

### Designs and plots

| hook | arguments, result |
|---|---|
| `dev.design.cancel` | {designId} - design.cancel |
| `dev.design.fill` | {reset?, buildingType? (not type: that is the message type), style? (chip id or any text), materials?, features?: [..] \| "a,b", size?: S\|M\|L\|custom\|plot, custom?: [x,y,z], remix?, name?, notes?} - set the Design tab's fields |
| `dev.design.place` | {blueprint} - Place on the plot (placement locked on the plot marked for it) |
| `dev.design.state` | {} - the Design form (fields, errors, the request as it would be sent), the sidecar's designs, plots |
| `dev.design.submit` | {fields?} - fill (optional), then press Design it: replies after the ack with sent{designId, error} + the state |
| `dev.plot.cancel` | {} - Esc while marking |
| `dev.plot.corner` | {x, y, z, front?, confirm?: true} - a plot corner (y = the surface); the second confirmed corner returns to the Design tab with the size filled |
| `dev.plot.start` | {height?} - Mark a plot… (closes the screen; corners with dev.plot.corner) |
| `dev.plot.state` | {} - plot marking |

### Sidecar and launcher

| hook | arguments, result |
|---|---|
| `dev.launcher.restart` | {} - Restart helper (Status tab) |
| `dev.launcher.state` | {} - the launcher: state, detail, source, node, pid, reuse, log tail |
| `dev.sidecar.state` | {} - the sidecar link and state: status (no key), designs |

## Changelog

Semi-stable: a hook may change or go, and every such change is listed here, newest first.

- **2026-10-05 (phase 4a):** this document. No hook was added or removed. `dev.sidecar.state` also reports the sidecar's
  `protocol` (1 when its snapshot names none) and `features`; the Placed view's site rows show "owned by <mod>";
  its Remove control (`dev.ui.click {control: "remove"}`) asks once more for a site another mod owns (the first click
  only sets the message). New dev-only test mod `apitest` (not a hook): `/apitest <step>` through `dev.command`.
- **Phase 3:** `dev.survival.set`, `dev.survival.state`, `dev.site.state`, `dev.site.finish`, `dev.site.deconstruct`,
  `dev.site.mine`, `dev.crate.insert`, `dev.crate.open`, `dev.crate.press`, `dev.crate.state`, `dev.items.near`,
  `dev.ghosts.state`; `dev.command {asPlayer}`. Site hooks take `{site}`.
- **Phase 2:** the `dev.library.*` hooks (filters, rename, tags, favourite, delete, export, import, variants, remix, wait).
- **Phase 1:** the world/view hooks, `dev.build.*`, `dev.plot.*`, `dev.design.*`, `dev.ui.*`, `dev.sites.*`,
  `dev.box.hash`, `dev.capture`, `dev.launcher.*`, `dev.sidecar.state`.
