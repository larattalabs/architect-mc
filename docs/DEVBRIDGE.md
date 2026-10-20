# DevBridge

The DevBridge is Architect's headless test surface: a WebSocket server inside the dev client that runs commands, drives
the UI, aims the camera and takes screenshots, so every gate runs without touching a real world. It is a **semi-stable**
surface for other mods' tooling (docs/CONTRACT.md phase 4a, R11): changes are recorded in the changelog at the end of this
file, but it is not semver'd. The Java API (`dev.larattalabs.architect.api`) is the stable contract; the DevBridge is for
tests.

Gate chains that drive dev clients through the DevBridge run unattended with `tools/gate-run.mjs`; the chains, the
two-tier mega_bench policy and how agents should wait for a run are in docs/GATES.md.

## Connecting

- **Where:** `ws://127.0.0.1:<port>`, loopback only. The port is `ARCHITECT_DEV_PORT`, default `7891`. The client's sidecar port is `ARCHITECT_PORT` (default `7890`). Run several clients side by side by
  giving each its own pair (the repo's sessions use 7890/7891, 7990/7991, 8090/8091, 8190/8191, 8790/8791 and, for phase 4d, 8890/8891).
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

## Headless

A headless gate server (docs/GATES.md "Headless gates") serves the same protocol, port and token file from a dedicated server.
`tools/run-headless-server.mjs` owns the WebSocket and forwards to the `devserver` mod. `dev.hello` and `dev.state` carry
`headless: true`.

- **Generated hooks.** The hooks in the client's `client/dev/` files `JournalDev`, `RegionDev`, `RegionDev6b`, `DeltaDev`,
  `SliceVDev`, `SliceWDev`, `SliceF2Dev`, `SliceBDev`, `SliceP0Dev`, `SlicePTDev`, `SlicePT2Dev`, `SliceT3Dev` and `StockpileDev` (and `Fields`) run headless as they are: `devserver/build.gradle` `genHooks` compiles copies with
  only the package and imports changed.
  - **Rule for those files:** no reference to client classes (`net.minecraft.client.*`, `dev.larattalabs.architect.client.*`)
    besides `ServerTasks`, `DevBridge` and the handler's `mc` parameter. A new one fails the build, `unit-mod` included.
  - A hook that needs the client goes into a client feature class.
  - A new hook file of that kind goes into `genHooks`'s list.
- **Hand ports.** The server-side hooks of the client feature classes are hand ports in `devserver/.../gen/PortedHooks.java`:
  - PlacementFeature: sites, placement stats, jobs, slow, box hash, capture;
  - SurvivalFeature: survival, site state, crate insert (`exact`, `stockpile:<owner>`), finish, deconstruct, mine, items near, site cells, BOM predict;
  - Slice0aDev;
  - ScreenFeature: launcher and sidecar state.

  When you change one of those hooks on the client, change its port too.
- **The core hooks** are `CoreHooks`: state, command, wait (frames are server ticks), waitChunks (FULL chunks around the bot),
  time, weather, camera (moves the bot), release, and screen (only `pause` and `null`).
- **Client-only hooks** answer `ok: false, error: "client-only: ..."`: screenshots, screens other than pause, keys, typing,
  the HUD, the Architect screen, the placement ghost, the region ghost, the composite preview and the crate screen.
- **Host hooks** (the host's own): `dev.world.open` / `dev.world.leave` switch worlds in one server process; `dev.quit` stops
  it. `dev.host.*` are internal.

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
| `dev.world.leave` | {} - save and leave the world for the title screen (as Save and Quit to Title) -> {left} |
| `dev.world.open` | {name?, mode?: creative\|survival\|hardcore, preset?: flat\|normal, seed?, cheats?: bool} - open (or create) the AutoWorld world again from the title screen; the fields replace `ARCHITECT_AUTOWORLD_*` (another world, e.g. a fresh one per run); then poll `dev.state` until ready |

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

### Ticked placement (phase 4d)

| hook | arguments, result |
|---|---|
| `dev.placement.stats` | {reset?: false} - while placement is active (a job, a running batch or removal, a construction site building): `budgetMs`, `ticks`, `msptMax`/`msptMean` (each tick timed from its start to after the last end-of-tick handler), `ticksOver50ms`, `serverMsptMax` (the server's own tick time, which leaves end-of-tick handlers out), `placementMsMax`/`Mean` (Architect's time per tick), `placementCpuMsMax`/`Mean` (6b: the same ticks in the server thread's CPU time, without descheduling or GC pauses; the MSPT bars judge it), `jobStartMsMax` (checks, snapshot, leaf ring and hold), `convertMsMax` (a construction site's conversion), `cells`, `workSeconds`, `cellsPerSecond`, `active`, `jobs`; reset starts over after the answer |
| `dev.placement.jobs` | {} - the ticked jobs running now: site, kind (place\|rollback\|remove), batch, item, phase, progress, total, held (ticks held back); `slow`, `budgetMs` |
| `dev.placement.slow` | {on: bool} - test hook: jobs write about 16 cells per tick, so a check can act in the middle of an item (cancel, relog) |

### World journal, roads and cell sites (phase 4e)

| hook | arguments, result |
|---|---|
| `dev.journal.state` | {} - the journal: open/unavailable, counters, bytes on disk, every entry's metadata (id, kind, site, group, policy, layer, status, cells, sections, box, files, undo group), legacy names, the last import's notes |
| `dev.journal.at` | {x, y, z, dimension?} - the stack at a cell, bottom first (entry, kind, site, policy, status, layer, before, after) |
| `dev.journal.killAt` | {point: K1..K8, migrate-before-commit, migrate-after-commit or null} - TEST: the next matching step halts the JVM |
| `dev.journal.failNextCommit` | {} - TEST: the next commit fails at its first file write (a full disk) |
| `dev.journal.stackBench` | {box, depth: 4, n} - `Sites.stack()` timed at random cells of that depth: p50/p99/max µs |
| `dev.road.check` / `dev.road.place` | {points, width?, surface?, slab?, lanterns?, shallowDecks?, owner?, force?} - checkRoad / placeRoad |
| `dev.cells.place` | {kind, policy?, cells? \| fill? \| pad?, naturalOnly?, overlap?, owner?, force?, check?} - placeCells (or checkCells) |
| `dev.region.hash` | {box, exclude?: [boxes], cells?} - SHA-256 over states and block-entity NBT, excluded boxes left out |
| `dev.site.verify` | {site, list?, max?} - the site's top-of-stack cells against its entries' after |
| `dev.heap` | {reset?} - heap used and peak since the last reset (MB) |

### Entry versions and delta apply (phase 5b)

| hook | arguments, result |
|---|---|
| `dev.entry.versions` | {entry} - the entry's head version, its lineage and its complete version folders |
| `dev.entry.installVersion` | {entry, dir, by?, summary?} - TEST: installs a hand-written version (the files of `dir`) as the entry's next version in the crash-safe order, delta.json from the mod's TemplateDelta, then reloads the library -> {version} |
| `dev.entry.delta` | {entry, from, to, cells?} - the blueprint delta of two versions (TemplateDelta; the shape of `kit/tools/diff.mjs --json`) |
| `dev.site.delta.check` | {site, version?, playerEdits?, overlap?, owner?, force?, cells?, construction?} - Sites.checkDelta -> {applicable, refusals, from, to, added, removed, changed, parts, kept, overlaps, box, notes, bom?, refund?, ghost?, ms} |
| `dev.site.delta.apply` | {site, version?, playerEdits?, overlap?, owner?, force?, construction?} - Sites.applyDelta (ticked above 50k cells) -> {applied, from, to, written, kept, reshaped, notes, refund?} or {applied: false, refusals} |
| `dev.site.revert` | {site, version, owner?, force?} - Sites.revert: one undo of the deltas above the version in the site's chain, else (and always in survival) a forward delta |
| `dev.site.history` | {site} - the site's version, head version, chain and history |
| `dev.site.delta.preview` | {site, version?, key?} - the delta ghost (ArchitectClientApi.previewDelta: ADDED, REMOVED, CHANGED, KEPT tints) -> the verdict's counts |
| `dev.writes.count` | {box} - TEST: the positions whose block changed in the box since the last call (the first call starts counting) -> {count, cells?} |

`dev.journal.killAt` accepts D1-D8 (the delta sequence). `dev.site.state` adds `version`, `headVersion`, `deviations`,
`deltas`, `deltaRefunds` and `swaps`.

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
| `dev.site.state` | {site} - a construction site: state, queue length, built count, BOM rows, ledger, blocked cells, notes, the last deconstruct's tally; since 6c Y2 also `wait` ({gameTime, waiting, waitingSince, nextNeeded, moreUnits}: C25), `order` (the distinct items of the unbuilt cells in build order, first 12: the gate's cross-check of nextNeeded) and `nextCells` (the first 12 unbuilt cells: x, y, z, block, solid) |
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
| `dev.library.filter` | {reset?, buildingType? (all\|<type>), tag? (all\|<tag>), favorites?, text?, sort?: newest\|name\|size, collection?: all\|bible:<id>\|group:<id>} - set the Library tab's search/filters/sort and the Collection filter (the collection header shows above the grid) |
| `dev.library.reskin` | {collection?: bible:<id>\|group:<id> (default: the Collection filter), bible} - Re-skin… in the collection header (`reskin.request`) -> {reskinId, error, message} |
| `dev.library.import.list` | {} - Import…: opens the dialog and lists the .nbt files (imports/ and this world's structure-block saves) |
| `dev.library.import.pick` | {index? \| path?} - pick a file in the Import… list and press Import (import.request) -> {jobId} |
| `dev.library.export.schem` | {entry?} - (6c SCH) the entry's Export .schem button: `architect/exports/<id>/<id>.schem` (a Sponge schematic, version 3) -> {file, bytes, sha256}. Import… also lists `.schem` files (`dev.library.import.pick` imports them through the mod's reader and the helper's `import-schem` job) |
| `dev.library.remix` | {entry?} - Remix…: the Design tab prefilled from the entry, remix set, notes focused |
| `dev.library.rename` | {entry?, name} - Rename (the inline editor; "" = back to the design's own name) |
| `dev.library.select` | {entry} - select a card |
| `dev.library.state` | {} - the library: query, visible cards, selected (detail), user tags, the Variants form, the import list, the last export, messages |
| `dev.library.tag` | {entry?, tags: [..] \| "a, b"} - Tags (the inline editor; replaces the user tags) |
| `dev.library.variants.open` | {entry?} - Variants… (refused for imported entries and entries without a source) |
| `dev.library.variants.set` | {preset?, wood?, stone?, roof?, accent?, bible?: id\|null (a re-skin with one of your style bibles; a preset or a palette field drops it), values?: {param: value}, steps?: {param: delta}, toggle?: [param], name?} - change the open Variants dialog |
| `dev.library.variants.submit` | {} - Make variant (variant.request) -> {jobId} |
| `dev.library.wait` | {jobId, timeoutMs?: 60000} - wait until a variant/import job is done (and its entry loaded) or failed -> {status, blueprintId, error} |

### Designs and plots

| hook | arguments, result |
|---|---|
| `dev.design.cancel` | {designId} - design.cancel |
| `dev.design.fill` | {reset?, buildingType? (not type: that is the message type; a non-preset one is an open type), openType?, profile?: [rules], bible?: id\|none, style? (chip id or any text), materials?, features?: [..] \| "a,b", size?: S\|M\|L\|custom\|plot, custom?: [x,y,z], remix?, name?, notes?} - set the Design tab's fields |
| `dev.design.place` | {blueprint} - Place on the plot (placement locked on the plot marked for it) |
| `dev.design.state` | {} - the Design form (fields, errors, the request as it would be sent), the sidecar's designs, plots |
| `dev.design.submit` | {fields?} - fill (optional), then press Design it: replies after the ack with sent{designId, error} + the state |
| `dev.plot.cancel` | {} - Esc while marking |
| `dev.plot.corner` | {x, y, z, front?, confirm?: true} - a plot corner (y = the surface); the second confirmed corner returns to the Design tab with the size filled |
| `dev.plot.start` | {height?} - Mark a plot… (closes the screen; corners with dev.plot.corner) |
| `dev.plot.state` | {} - plot marking |

### Sets, bibles and groups (phase 4b)

| hook | arguments, result |
|---|---|
| `dev.set.open` | {} - Design tab, Design a set… (the dialog takes the tab's body) -> the dialog's state |
| `dev.set.fill` | {name?, bible?: id \| "new", prompt?, items?: [{type, name?, role?: landmark\|ordinary, notes?}], concurrency?: 1-6, budgetUsd?: number\|null} - set the open dialog's fields (`items` replace the rows) |
| `dev.set.draft` | {} - Draft bible (`bible.request` with the prompt; the new bible is picked when its job is done) -> {jobId, error} + the state |
| `dev.set.submit` | {} - Design the set (`design.group`) -> {groupId, error} + the state; the screen shows the set in the Designs tab |
| `dev.set.close` | {} - Cancel the dialog |
| `dev.set.state` | {} - the dialog: fields, errors, the live estimate (`design.estimate`, debounced), the request as it would be sent, the screen state |
| `dev.group.action` | {group, action: cancel\|resume\|extend, budgetUsd? (extend)} - the Designs tab's set buttons (`group.cancel`, `group.resume`, `group.extend`) -> {ok, error, message} |
| `dev.bibles` | {} - the bibles the UI lists (installed, then built in) and the bible jobs |

Controls (`dev.ui.click`): `design_set`, `design:bible`, `design:profile`, `type:other`; in the dialog `set:bible`,
`set:draft_bible`, `set:type_pick:<row>`, `set:role:<row>`, `set:remove:<row>`, `set:add`, `set:concurrency±`,
`set:budget±`, `set:submit`, `set:cancel`, and the fields `field:set_name`, `field:set_prompt`, `field:set_type:<row>`,
`field:set_iname:<row>`, `field:set_notes:<row>` (`dev.ui.focus {field: "set_iname:2"}`); in the Designs tab
`group:resume`, `group:extend`, `group:cancel`, `group:library`, `bible:cancel`, `bible:use`; in the Library
`filter:collection`, `collection:reskin`, `collection:clear`, `sort` (when the sort chips fold into one), and in the
Variants dialog `bible:<id>`.

### Massings and the composite preview (phase 4c)

| hook | arguments, result |
|---|---|
| `dev.massing.state` | {} - the massing review (massing, version, title, origin, turns, onPlot), the massing jobs it waits for (`pending`), the set shown in a row (`shownSet`, `shownItems` left to right), the status line, the bar's rect (`barRect`, GUI px), the open screen (and the Redirect… dialog's notes), plus `composite` (= `dev.composite.state`) |
| `dev.massing.review` | {massing} - Review massing: its latest version as a massing ghost (on the plot it was made for, else in front of the player) with the Approve / Redirect… / Cancel bar; fails for a set's massing |
| `dev.massing.key` | {key: enter\|r\|backspace\|escape} - press a review-bar key through the keyboard's own path (no screen open): Enter approves (the detail pass of the reviewed version), R opens Redirect…, Backspace/Esc cancels -> {consumed} + the state. (`dev.key` with no screen open clicks key mappings and never reaches the bar.) |
| `dev.massing.redirect` | {notes, submit?: true} - in the open Redirect… dialog: type the notes and press Redirect (`massing.redirect`); the new version opens the review again when it is installed |
| `dev.massing.showSet` | {group} - Show massings: a set's massings (not yet detailed) in a row in front of the player, entrances facing them |
| `dev.massing.hideSet` | {} - hide that row |
| `dev.composite.state` | {reset?: false} - every composite key: its generation, `built`, `buildMs`, `cells` (drawn, within the cap), `quads`, and per layer `source`, `origin`, `turns`, `style`, `onlyCells` (count, -1 = all), `cells`, `quads`, `size`, `overCap`, `mode` (`cells` \| `outline:cap` \| `outline:distance` \| `building` \| `error`), `error`; `maxCells` (200000), `fullDistance` (160); `lastFrame` {quads, outlines, ms, maxMs, frames}. `reset` clears maxMs (after the answer is built) |
| `dev.composite.clear` | {key?} - clear one composite key, or all |

`dev.design.fill` takes `massingFirst: true|false|null` (null = the default: on for L and plot); `dev.set.fill` takes
`massingFirst`, `maxRedirects` (0-10) and `context`; `dev.ui.focus` takes `set_context` and `redirect` (the Designs
tab's redirect notes for a set item). `dev.sidecar.state` adds `massings` (the latest version of each: id, version,
versions, designId, type, name, itemKey, owner, group, size, nbt, redirect, detail, createdAt).

Controls (`dev.ui.click`): on the Design tab `design:massing_first`; in the set dialog `set:massing_first`,
`set:redirects-`, `set:redirects+` (and the field `field:set_context`); in the Designs tab, on a set waiting for
approval (approvalUi architect) `group:item_approve:<itemKey>`, `group:item_redirect:<itemKey>` (then type into the
`redirect` field), `group:item_cancel:<itemKey>`, `group:redirect_send`, `group:approve_all`, `group:show_massings`; on a
finished massing design `design:review_massing`. A set approved by its owner (approvalUi owner) has none of these, and no
`group:cancel` either.

The composite preview's Java API is `ArchitectClientApi.previewComposite` (apitest drives it with `/apitest composite`);
there is no DevBridge hook to make layers, so tests go through the API as another mod would.

### Sidecar and launcher

| hook | arguments, result |
|---|---|
| `dev.launcher.restart` | {} - Restart helper (Status tab) |
| `dev.launcher.state` | {} - the launcher: state, detail, source, node, pid, reuse, log tail |
| `dev.sidecar.state` | {} - the sidecar link and state: status (no key), designs, variants, jobs (id, status, step, error, resultBlob), groups, bibleJobs (without the request), reskins, bibleIndex (id, name, version, builtin, sheetPath), massings (4c), protocol, features |

### Regions (phase 6a)

| hook | arguments, result |
|---|---|
| `dev.region.plan` | {program, params?, claim: [x0,z0,x1,z1], seed?, surveyLoad?: loaded\|generated:<n>\|bounded:<n>, owner?} - Regions.plan -> the RegionPlan, `claimY` (the IR's y range) and `ms`, or `{refused}` |
| `dev.region.prepare` | {planId, inFlight?, wait?: false} - Regions.prepare; with wait the answer comes when it is done: the PrepareView and the governor's `stats` (ticks, MSPT max, ticks over 50/100 ms, chunks/s) |
| `dev.region.prepare.state` | {planId} - the prepare's view and governor numbers |
| `dev.region.cancelPrepare` | {planId} - Regions.cancelPrepare |
| `dev.region.realise` | {planId, lots?: {lotId: entry}, lotEntries?: [entry...], fitLots?: false, load?: generated:<n>\|loaded\|bounded:<n>, autoApprove?: true, stages?, force?, maxWait?: seconds} - Regions.realise -> {region} or {refused}; `lotEntries` fills every lot round robin, with `fitLots` the first entry that fits each lot; `maxWait` (0 = no limit) is `RealiseRequest.maxWaitSeconds` |
| `dev.region.holdRealise` | {on?: true} - 6c X: the next `dev.region.realise` / `Regions.realise` with an opKey keeps its future pending after its region record is saved (it fails WORLD_STOPPED at a stop; the region is found by `Regions.realiseByKey` after the next load). `dev.region.plan` and `dev.region.realise` take `opKey` (6c X) |
| `dev.region.state` | {region} - the RegionView, the record, item counts and waits, `unfinished` (up to 40 items: key, stage, status, reason, x, z), failed items, writer starvation, the longest wait holding tickets and waits over 10 s with chunk statuses, tile streaming and generation counters |
| `dev.region.list` | {} - every region |
| `dev.region.remove` | {region, covered?: keep\|cascade\|refuse, force?} - Regions.remove (the group undo) -> RemoveResult + seconds |
| `dev.region.hash` | {box \| region (claim + margin, default 8), ySpan?, exclude?, mode?: hash\|snap\|diff, file?} - sliced over ticks per 64x64 tile, chunks by short-lived tickets: `hash` (sha256 + per-tile hashes), `snap` (every cell to a gzip file), `diff` (against a snap: mismatches with the pre-region cell's class gravity\|unsupported\|none). A box up to 8M cells without region/mode answers at once as in 4e |
| `dev.region.logs` | {box} - logs with neither a log nor solid ground under them (floating), logs, persistent and natural leaves |
| `dev.undo.mark` / `dev.undo.check` | {sites} / {} - remember what the sites' entries give back on undo; then the world against it (mismatches) |
| `dev.chunks.generated` | {} - chunks this session: `terrain` (terrain generated, any status), `full`, `whileHeld` (while a region item held tickets), `loads` |
| `dev.chunks.status` | {box: [x0,z0,x1,z1]} - chunks of the box fully generated, read without loading them (ChunkGen), and the cost per chunk |
| `dev.mspt.trace` | {start \| stop: true} - every tick's full time and Architect's write time; stop answers max/p50/p99/over 50 for all ticks, ticks with writes and ticks without (lighting and chunk sending). (6c 0a) Also `own` (wall) and `ownCpu` (the server thread's CPU time, what `Placement` measures): Architect's own time per tick, each `{ticks, p50, p99, max, mean}` over the ticks with Architect work; `ownCpu` is absent when the JVM can't measure thread CPU. The tick bars judge `ownCpu` (megaA: p99 <= 25 ms, max <= 50 ms); the full tick is recorded |
| `dev.batch.skipSave` | {batchId} - (6c 0a) skip the queue save right after that batch's BATCH_DONE (fire, mark fired, [save]); kill the client JVM then, and BATCH_DONE fires once on the next load (the catch-up) |
| `dev.api.dropAck` | {msgType} - (6c 0a) the mod drops the next helper ack of that message type (`bible.request`, `design.group`, ...): the request reaches the helper, the API future never completes; restart and adopt by opKey |
| `dev.api.pending` | {} - (6c 0a) how many API futures are pending (WORLD_STOPPED fails them at SERVER_STOPPING) |
| `dev.heap.gc` | {} - used heap after a forced GC, and the max |
| `dev.tiles.stats` | {reset?} - tiles received, wire bytes, cells, bytes per cell, request-to-receive latency p50/p99 |

`dev.journal.killAt` takes RG1-RG6; `dev.journal.state` adds `indexBytes` and the index commit times (p50, p99, max).

### Regions (phase 6b)

| hook | arguments, result |
|---|---|
| `dev.region.plan` | (6a, extended) also `check?: true`: false sends `ext["architect_mc:check"] = false` (no checker, no previews, the mega_bench gate runs). The answer adds `report` (CheckReport as JSON), `summary` (one line), `previews` ({paths: {view: [path]}, sitePlan}), `irFormat`, `requires`, `kitVersion`, `blobs` (side blob shas), `needVolumes`/`volumes` (the two-plan flow), `checkMs`, `renderMs`, `progress` (the phases). A plan whose IR is stale answers `{refused: "PLAN_STALE: plan needs ..."}` |
| `dev.region.check` | {planId} - Regions.check (`region.check`) -> {report, summary, ms}; fires REGION_CHECKED |
| `dev.region.preview` | {planId, views?: [top\|section\|iso\|siteplan], axes?: [[[x,y,z]...]...] (at most 4)} - Regions.previews (`region.preview`) -> {paths, sitePlan, ms} |
| `dev.region.design` | {brief, card?: {site?, purpose?, style?, text?}, claim: [x0,z0,x1,z1], bible?, mustPass?, model?, budgetUsd?, requireFit?, owner?, wait?: true} - Regions.design; with wait the answer comes once the design ended and, for a fit, the mod's plan of the pick was accepted or failed -> {designId, status, kind, error?, result: {outcome, fits, program, params, reason, cost, tries, planId?, planError?}, costUsd, ms} |
| `dev.region.nudge` | {region, action: MOVE_CLOSER\|PREPARE\|START_SIDECAR\|APPROVE_STAGE\|REPLAN\|RETRY (6c 0a: TILE_SLOW)} - Regions.nudge -> {done, message, actions (offered before the nudge)}. PREPARE is two calls: the first answers the estimate (done false), a second within 5 minutes starts the prepare |
| `dev.region.state` | (6a, extended) adds `actions` (the WaitActions as JSON; also inside `view`) and `stale` (the PLAN_STALE message when the region's IR is stale) |
| `dev.region.progress` | {planId} - the phases a plan went through: planning, checking, rendering (the helper's `region.progress`), accepted (or failed) |
| `dev.survey.volume` | {box: [x0,y0,z0,x1,y1,z1], load?: loaded\|generated:<n>\|bounded:<n>} - Survey.volume -> {sha, blobId, counts (per VoxelClass), missingColumns, stats {surfaceColumns, meanSlope, steepFraction, overhangFraction, treeCells, caveCells, trees, caves}, cells, ms (wall), ticks, maxTickMs (the longest sampling slice), sampleMs, cellsPerSecond (over sampleMs), bytes (the frozen gzip file), bytesPerCell, file, chunksLoaded, maxCells (the per-call/per-region limit)} or {refused: "REGION_LIMIT: ..."} |
| `dev.region.ghost` | {planId, stage?} \| {off: true} \| {} - the region ghost on (`previewRegion`), off, or its state -> {on, planId, stage, tiles, tilesRequested, tilesShown, cellsShown, verdict, errors}. The tiles near the player arrive over the next seconds; poll `{}` until `tilesShown` stops growing, then `dev.screenshot` |
| `dev.scenario.cams` | {scenario: <id> (scenarios/<id>.json under $ARCHITECT_REPO, else the checkout above mod/run) \| path \| cams: {name: [x,y,z,yaw,pitch]}, cam?: name} - time 6000 and clear weather; with `cam` the camera goes there as a spectator (as `dev.camera`) -> {cams: [names], at?, camera?}. Then `dev.screenshot` |
| `dev.region.drop` | {planId, after: <tiles written>} \| {off: true} - gate 10(a): once the plan's region has written that many tiles, deletes the helper's plan dir (`<data>/regions/plans/<planId>`) and its cached side blobs (`<data>/regions/blobs/<sha>.bin`), and sends `region.release {planId, evict: true}` (the helper drops its cached IR, even one another plan shares) -> {armed}; `dev.region.drop.state` -> {dropped, at, deleted} |
| `dev.tiles.resends` | {reset?} - tile re-requests by reason: `ir` (ir_unknown), `blob` (blob_unknown) |
| `dev.region.dump` | {box: [x0,y0,z0,x1,y1,z1], light?: true, file (absolute, or relative to the game dir)} - the ARWD dump (kit/REGIONS.md "Realised-world dumps"), one chunk column per 3 ms slice, written off the server thread -> {file, cells, bytes, rawBytes, sha (of the uncompressed bytes), palette, light, unloadedChunks (read as air), ms, ticks, maxTickMs}. At most 64M cells |
| `dev.region.planStale` | {at: accept\|realise\|resume, planId? (realise), region? (resume), format?, kitVersion?, requires?: [kind]} (default `format: 3`) - gate 10(b): doctors an IR so the PLAN_STALE gate fires. `accept`: the next accepted plan's IR (then `dev.region.plan` must answer `refused: PLAN_STALE`); `realise`: the held plan's IR, memory and plan file (then `dev.region.realise` must refuse); `resume`: the region's IR in memory and its `ir.json` (its items wait PLAN_STALE at once and after a relog; `dev.region.state` shows `stale`; `dev.region.hash` must not change) -> {doctored, stale} |

### Stamps (phase 6c slice F2)

| hook | arguments, result |
|---|---|
| `dev.feature.stamp` | {feature: `minecraft:oak` (a configured feature of `Registries.FEATURE`), seeds: [1..64 integers], ground?: `grass_block` (any block: the template's top) \| `stone` \| `cave`, dir?} - harvest stamps (CONTRACT F2 §4): in a **superflat** world only (it rewrites a 41x41 box at the fixed spot (8, 8); any other world is refused), per seed: reset the box to the ground template, snapshot it, place the feature with `RandomSource.create(seed)` at the spot, diff, reset again, all in one server task (no tick between, so a re-harvest gives the same bytes). Writes `<dir>/<feature path>/<seed>.bin` (gzip, pinned header, of ARSP: kit/lib/region/stamps.mjs); `dir` defaults to the game's `architect/stamps` (**local-only**, Noah's N-F2-1: never the repo or the jar). Block-entity cells (a bee nest) and the feature's own air writes are left out -> {feature, ground, dir, minecraft, stamps: [{seed, placed, cells, size, root (the spot in the stamp's local cells), palette, sha (of the ARSP bytes), file, blockEntities, edge (cells on the box's edge: the box was too small)}]}. `tools/harvest-stamps.mjs` harvests the first library (huge mushrooms, dripstone clusters, fossils, 5 tree species; 8 seeds each) |

Chat commands (6b, N7: no Terrain tab): `/architect region plan <program> <x0> <z0> <x1> <z1> [JSON | k=v ... | nocheck]`,
`check [planId]`, `preview [planId]`, `prepare [planId]`, `realise [planId] [fill]`, `remove [regionId]`, `state [regionId]`,
`design <brief>` (a 200x200 claim around the player), `nudge <action> [regionId]`. Ids default to the player's last plan and
region. Previews print as file links (with a [copy] link).

## Changelog

Semi-stable: a hook may change or go, and every such change is listed here, newest first.

- **2026-10-20 (6c slice VOC-c):** new (`SliceVoccDev`, generated headless too) `dev.vocc.checkPalette {sha, lotEntries?: {lot: entry}}`
  (`Regions.checkPalette`: the artifact's palette rules measured with these lot entries over its own -> `{paletteOk, rules: [{rule, required,
  family, share, cells, familyCells, measured, fits, worstLot, lots: {lot: {entry, cells, familyCells}}, pendingLots}]}` or `{missing}`),
  `dev.vocc.histogram {entry}` (the block histogram of the template a realise places for the entry: what a check's `lotBlocks` and the
  realise measure -> `{entry, blocks}` or `{missing}`), `dev.vocc.regionPalette {region}` (the region record's ext `architect_mc:palette`:
  the realise's rows -> `{region, palette}`) and `dev.vocc.delta {site, version?: 0, owner?, apply?: false}` (`Sites.checkDelta`, or
  `applyDelta` with `apply`, through the public API, so a region lot's delta is judged against its palette rules -> `{verdictOk, refusals:
  [{reason, message}], notes}` or `{applied, written, refusals, notes}`; `dev.site.delta.check` and `.apply` call SiteDeltas directly and
  skip that judgement).

- **2026-10-19 (6c slice HY-core):** `dev.journal.killAt` takes FL4 (an ordered region: one wave of reaches written and forced, more to
  come: downstream written, upstream not) and FL5 (a removal: the head drained, the rest of the course not yet), each also with `+save`.
  `dev.fluid.state {region}` gains `ordered`, `order` (the write order), and per body `writtenAt` (game time; -1: forced with the stage)
  and `held` (never written: upstream of a body that failed). `dev.entity.damage` already records every damage type: `{type: "fall"}`
  reads fall damage (HY item 18 (b)).
- **2026-10-19 (6c slice VOC-b):** new (`SliceVocbDev`, generated headless too) `dev.vocab.bibleRequest {prompt, name?, owner?, scope?,
  seedPreset?, rarity?: {...}, opKey?}` (Bibles.request with `BibleRequest.Rarity`, the typed record built from the JSON -> `{jobId, bibleId,
  version, status, step, request, wire}` (`wire`: Wire4b's request JSON) or `{wire, refused, code?, detail?}`: a malformed budget is refused
  `FIELD_LIMIT` with detail `rarity` before any job) and `dev.vocab.bibleJob {jobId}` (Bibles.job -> `{jobId, bibleId, version, status,
  step, error?, request}` or `{missing}`).
- **2026-10-19 (the H batch):** `dev.fluid.state {region}` gains `removalNote` (a removal whose settle wait hit its cap, 2 x the settle
  bound after the drain); for a removed region it answers `{removed: true, removalNote}` when its removal was capped (else "no live
  region", as before). A region's view ext carries `architect_mc:fluidsRemoval {state: capped, note, ticks}` in that case.

- **2026-10-18 (6c slice H-core):** new (`SliceHDev`, generated headless too): `dev.fluid.census {box: [x0,y0,z0,x1,y1,z1]}` (every fluid
  or ice cell of the box with its state, and every scheduled fluid tick there -> `{fluids: [[x,y,z,state]], ticks: [[x,y,z]]}`);
  `dev.fluid.tick {cells, fluid?: water|lava, delay?: 1}` (one scheduled fluid tick at each cell); `dev.entity.damage {since: epoch ms,
  type?: drown|lava|...}` (living entities' damage and deaths since then, from a ring of the last 2,000 events -> `{events, damage,
  deaths}`); `dev.fluid.state {region}` (the region's fluids record: phase, removal, per body state, reason, settle); TEST
  `dev.fluid.bypass {on}` (the fluids stage's containment check is not run: gate item 2's negative control) and
  `dev.fluid.beforeGate {protect?: [x0,z0,x1,z1], owner?, setblock?: [[x,y,z,state]]}` (once, at the next fluids gate, right before its
  check). `dev.journal.killAt` takes FL1 (the fluids gate checked, no source written), FL2 (the sources written and ticked, settling)
  and FL3 (a removal's drain done, before the solids), each also with `+save`. A region's view ext carries `architect_mc:fluids`.

- **2026-10-17 (6c slice T3a):** new (`SliceT3Dev`, generated headless too) `dev.t3.boat {at: [x,y,z] (a settled boat within 4), dir:
  [dx,dz], distance, step?: 0.1}`: the player rides the boat nearest `at`, which moves `distance` along `dir` by vanilla's
  `Entity.move(MoverType.SELF, ...)` in `step` steps, the rider positioned after each -> `{moved, blocked, blockedAt?, inWall (steps with
  the rider's eyes in a block), riderHit (steps with the rider's box in a block), boatY, eyeY, maxEyeY, steps, end}`; the rider is
  dismounted and the boat discarded (CONTRACT T3 item 1's boat probe, N-T3-2).
- **2026-10-17 (6c slice T3b):** `dev.region.checkPlan` takes `load: "loaded" | "generate"` (PlanRequest.load: "generate" is
  `LoadPolicy.LOAD_BOUNDED` over the claim's chunks plus the survey margin, so the survey and the tunnels' volume pass load and
  generate their chunks) and answers `volumePass` (the check's two-plan flow: `{asked, cells, sampleMs, firstPlanMs, load, read,
  secondPlanMs | why}`; null for a plan that planned once). No hook added.

- **2026-10-14 (7a slice K1a):** `dev.nav.villager` takes `cells: true` and then returns the path's nodes as `cells: [[x,y,z]]`
  (K1a's item 2: a villager's path meets a wall only at its gate cells). No hook added.
- **2026-10-13 (6c slice D1):** `dev.region.plan` takes `beside` (a standing region's id: RegionPlanRequest.beside); the region
  view (`dev.region.state`) carries `beside` and, in its ext, `architect_mc:beside` `{region, dangling, since?}`. No hook added.
- **2026-10-13 (6c slice P0):** new (`SliceP0Dev`, generated headless too) `dev.region.checkPlan {plan, claim: [x0,z0,x1,z1], anchors?:
  {name: [x,y,z]}, owner?, bible?, bibleVersion?, budget?, opKey?, cancelAfterMs?}` (Regions.checkPlan -> `{check, ms}` or `{refused,
  reason}`), `dev.region.cancelCheck {owner?, opKey}`, `dev.region.checkByKey {owner?, opKey}`, `dev.region.planImages {checkId, views?}`,
  `dev.region.artifact {sha, body?}`, `dev.region.pinArtifact {sha, owner, on?}`, `dev.region.realiseApproved {sha, lotEntries?, fill?,
  opKey?}`, `dev.region.realiseByKey {owner?, opKey}` and `dev.region.tileShas {region}` (the sha of every tile a realise received, from
  `TileStream.TILE_SHAS`).
- **2026-10-14 (C38):** new `dev.plan.catalogue {}` (SliceP0Dev, generated headless too): `Regions.planCatalogue()` read on the bridge thread, not the server thread -> `{catalogue, hasFeature ("planCatalogueView"), ms, thread, copy (a second call is equal and a different object, and changing the first leaves the next call unchanged), regions (Regions.list(null).size() on the server thread, after the read)}`. `dev.region.checkPlan` takes `withCatalogue: true` and then adds the answer's whole `check.catalogue`.
- **2026-10-14 (C37b):** new `dev.library.cells {ids?}` (SliceP0Dev, generated headless too): per library entry `{id, entryCells (Library.Entry.cells()), planCells (PlanChecks.cells), partSum, parts, size}`.
- **2026-10-13 (6c slice PT):** new `dev.pt.*` hooks (SlicePTDev, generated headless too). `dev.pt.uses {ops: [{item, at, on?, face?,
  use?: on|item, placer?: <name>|bot, yaw?, pitch?}]}`: item uses through a named fake player's (Fabric `FakePlayer`, an offline
  UUID per name) or the bot's `ServerPlayerGameMode.useItemOn` / `useItem`, never `setBlock` -> per op `{tracked, placer, build,
  state, result}`; `dev.pt.breaks {at: [[x,y,z]...], placer?}` (`destroyBlock`); `dev.pt.cells {box, list?}` (the tracked cells:
  count, incidental, a SHA-256 over position, placer and build, the list); `dev.pt.keptHash {box}` (a SHA-256 over the kept build
  cells' position, state and record); `dev.pt.at {at}`; `dev.pt.builds {box?, drain?}` (`Sites.builds`, after running every
  classifier job due; `drain` ignores the debounce); `dev.pt.build {build}` (an alias resolves; answers `buildId`, never `id`);
  `dev.pt.box {box}` (`Sites.playerPlaced(dim, box)`); `dev.pt.claim {box, actor?: bot|console|<name>}`; `dev.pt.release {build,
  actor?}`; `dev.pt.uuid {name}`; `dev.pt.rule {name?, value?}` (the world rules: `playerTracking`, `promote`, `graceMs`, ...);
  `dev.pt.stats {box?, bench?, reset?}` (item 15's cost: NBT and heap bytes, the hook's ns, the classifier's tick and phase maxima);
  `dev.pt.expecting {}`. `dev.brush` gains `consent: [build ids]` and `consentActor`, and its view `buildHits`; `dev.road.place`
  gains `partial` and answers the skipped spans; road and cell refusals carry their `builds`. apitest `apipt`, `ptat`, `ptbox`,
  `ptbuilds`, `ptbuild`, `ptclaim`, `ptrelease`, `ptplace` (a pending result), `ptcheck` (`ApiTestPT`).

- **2026-10-12 (6c slice B):** new `dev.brush {kind, at: [x,y,z], radius?, strength?, shape?, mask?, pattern?, destruction?, owner?,
  actor?: me|none|<uuid>, console?, seed?, dimension?}`: one brush stroke (`Regions.brush`; `console: true` takes the command's
  console path) -> the region's view once realised `{region, planId, irSha, state, brush, cellsWritten, cellsSkipped, claim, ms}` or
  `{refused, reason}`; `dev.brush.stats {}`: every stroke's latency marks. Both run headless (SliceBDev is generated). apitest
  `apib`, `brush`, `brushundo`.
- **2026-10-12 (6c slice F2):** new `dev.feature.stamp` (the stamp harvester, section "Stamps"), generated headless too
  (`SliceF2Dev` joins `genHooks`).

- **2026-10-12 (headless gates):** the DevBridge also runs headless on a dedicated server (section "Headless"); `dev.hello`
  and `dev.state` there carry `headless: true`, and client-only hooks answer `client-only: ...`. No hook changed on the client.
- **2026-10-11 (6c slice W):** new `dev.region.survey {claim: [x0,z0,x1,z1], surveyLoad?: bounded:256, file?}`: the region plan
  survey (ARSV) a plan of the claim would send -> `{sha, resolution, columns, missing, water, frozen, frozenSample}` (`file`: the
  bytes written there). apitest `heights` adds a 7th column per sample, `frozen` (`Sample.frozen`).
- **2026-10-11 (6c slice V):** new `dev.nav.villager {from: [x,y,z] (feet), to: [x,y,z] (feet), range?: 256, accuracy?: 0}`: a
  no-AI villager (never added to the world) on `from`, `FOLLOW_RANGE` = range (16-2048), doors openable, vanilla
  `PathNavigation.createPath(to, accuracy)` -> `{path, canReach, nodes, end: [x,y,z], followRange, ms}`; the villager is discarded.
  New `dev.site.anchors {site}`: a placed site's anchors in world coordinates (the blueprint's entrance, spawn, ... through its
  placement) -> `{site, anchors: {name: {x, y, z, yaw, pitch}}, box}`. `dev.region.plan` takes `bible` (a bible id: the plan's
  roles; RegionPlanRequest.bible).
- **2026-10-10 (6c slice 0a, 2):** new `dev.batch.skipSave`, `dev.api.dropAck` and `dev.api.pending`; apitest `/apitest opbible|opgroup|jobbykey|groupbykey|batchbykey|canceljob|pin|unpin|pinowners|estmix|fitmassing|group0a|api110` (API 1.10.0), and `bqueue` takes `opKey`.
- **2026-10-10 (6c slice 0a):** `dev.mspt.trace`'s stop adds `own` and `ownCpu` (Architect's own time per tick, wall and CPU,
  `{ticks, p50, p99, max, mean}` over the ticks with Architect work); `tools/lib/tickbar.mjs` judges them when present. Sidecar
  test hook (env, not a DevBridge call): `ARCHITECT_TEST_SLOW_TILES=<n>` makes the first n evaluations of each region tile
  overrun its limit (the slow-tile path: `region.tile.error code: "timeout"`, the item waits TILE_SLOW, `dev.region.nudge {action: RETRY}` or apitest `rnudge <region> RETRY`).
- **2026-10-10 (phase 6b):** `dev.placement.stats` adds `placementCpuMsMax` and `placementCpuMsMean`: the placement ticks
  (batches, groups, jobs) in the server thread's CPU time. On a busy machine the wall-time `placementMsMax`, `msptMax` and
  `serverMsptMax` take descheduling and GC pauses; the gates' MSPT bars judge the CPU figure and record the rest.

- **2026-10-09 (6b addition: region lot entrances):** apitest `place` / `check` take `pathStyle=<block id>` (after the rotation
  argument, which is then required): the request goes out with `PlaceRequest.pathStyle` (API 1.9.0), so its entrance approach is
  that road surface and joins a road it meets (taking the road's block). The gate's plain lot next to a 4e road:
  `dev.road.place {points: [[10,67,0],[80,67,0]], width: 3}`, then
  `/apitest place cabin 28 67 -19 INSTANT unowned noactor 0 pathStyle=minecraft:stone_bricks` (through `dev.command`); without
  the token the placement is unchanged. Region lots style their approach on their own (the region's `path` / `foundation` roles).

- **2026-10-09 (phase 6b, mod side):** new `dev.region.check|preview|design|nudge|progress|ghost|drop|drop.state|dump|planStale`,
  `dev.survey.volume`, `dev.scenario.cams` and `dev.tiles.resends` (see "Regions (phase 6b)"). `dev.region.plan` takes `check`
  and answers report, summary, previews, irFormat, requires, kitVersion, blobs, needVolumes and progress; its timeout is 15
  minutes (the checker and renders). `dev.region.state` adds `actions` and `stale`. Chat commands `/architect region ...`.
  apitest steps `api19` and `rnudge <region> <action>`. `tools/api-compat.mjs --gate6b` checks the 1.8.0, 1.7.0 and 1.6.0
  apitest jars and the 0.11.0 mod jar's surface in one run.

- **2026-10-08 (phase 6a):** new `dev.region.plan|prepare|prepare.state|cancelPrepare|realise|state|list|remove|logs`,
  `dev.undo.mark|check`, `dev.chunks.generated|status`, `dev.mspt.trace`, `dev.heap.gc` and `dev.tiles.stats` (see "Regions").
  `dev.region.hash` moved to the regions hooks and takes `region`, `margin`, `ySpan` and `mode` (hash, snap, diff), sliced over
  ticks; a small box without them answers at once as before. `dev.journal.killAt` takes RG1-RG6; `dev.journal.state` adds the
  index size and commit times. apitest steps `api18, rplan, rprepare, rrealise, rget, rlist, rremove, revents`. `tools/gate6a.mjs`
  drives the phase 6a gate (`tools/run-gate6a-client.sh`: the real sidecar with the sim backend, DevBridge 8893, sidecar 8892;
  `ARCHITECT_XMX` caps the dev client's heap). `dev.region.hash` diff classes: gravity, unsupported, live, growth (random-tick
  growth and grass spread), none. With `ARCHITECT_TRACE_JOBS` set, placement ticks over 25 ms are logged by part and generated
  chunks by position.

- **2026-10-08 (phase 5b):** new `dev.entry.versions|installVersion|delta`, `dev.site.delta.check|apply|preview`,
  `dev.site.revert`, `dev.site.history` and `dev.writes.count` (see "Entry versions and delta apply"). `dev.journal.killAt`
  takes D1-D8; `dev.site.state` adds the version fields, the deltas, the delta refunds and the queued swaps. `CompositeMesh`
  has a KEPT style. apitest steps `checkdelta, applydelta, srevert, shistory, outdated, eversions, edelta, erevert, polish,
  polishest, polishget, api17`, batch `delta` items, and the version fields in site views. `tools/gate5b.mjs` drives the
  phase 5b gate (`tools/run-gate5b-client.sh`, DevBridge 8891, sidecar 8890); `tools/eval.mjs` adds `import-round0`,
  `verify-round0`, `run --arm polish --from` and `polish-dev`. A local build without `sidecar/dist/main.mjs` is versioned
  `+nosidecar` and the Status tab says so in red.

- **2026-10-08 (phase 5a):** `tools/p5a-ui.mjs` walks the critique UI submit paths on the sim (Design tab, set dialog, massing
  first plus critique: no critique on the massing, critique on the detail pass); the Status tab has a `critique_default` control
  (N1: "Critique and revise new designs by default", `config/architect_mc_ui.json`). `tools/gate4e.mjs api15jar` runs the
  unchanged 1.5.0 apitest jar against this build; `gate4e` accepts an API version >= 1.5.0.
- **2026-10-06 (phase 5a, Java):** `dev.design.fill` and `dev.set.fill` take `critique` (bool) and `maxRevisions` (1|2); their
  state replies show them, the critique spec as sent and (Design tab) the live estimate line with critique. apitest steps
  `critspec, critreq, critget, critentry, critreport, critestimate, critgroupestimate, critgroup, critgroupget, sheetbible,
  bibleadmin, biblearchive, bibledelete, imagejob, imagejobrefused` (`tools/apitest.mjs critique`, `critique-real`).
- **2026-10-05 (phase 4e):** new `dev.journal.state|at|killAt|failNextCommit|stackBench`, `dev.road.check|place`,
  `dev.cells.place` (cells, a fill or a pad generator), `dev.region.hash` (with excluded boxes), `dev.site.verify` (a
  site's owned cells against its journal `after`; with `list` the world values, for the any-order no-leak check) and
  `dev.heap`. `dev.site.state` adds the site's journal entries, covers and coveredBy. Snapshots are gone: a site's
  terrain lives in the world journal. DevBridge rebinds its port at once after a halted client (`SO_REUSEADDR`).
  `ARCHITECT_TRACE_JOBS=1` (dev env, not a hook) logs each placement, restore and road job step with its tick and
  milliseconds. apitest steps `road, roadcheck, cells (pad generator too), cellscheck, stack, sundo2, reasons, api15,
  heights`, plus `place ... layer`, `remove <site> - <force|noforce> [keep|cascade|refuse]` and batch `overlap`/road/
  cells items. `tools/gate4e.mjs` drives the phase 4e gate.
- **2026-10-05 (phase 4d):** new `dev.placement.stats|jobs|slow`. `dev.box.hash` is unchanged; snapshots now carry an
  `architect_leafRing` int array (ignored by vanilla). apitest steps `bqueue, batch(es), bcancel, sgroups, sgroup,
  sgremove, sapprove, sskip, sreorder, sundo, stock, fit, margin` (and `place ... [force]`), driven by `tools/gate4d.mjs`
  against `tools/run-gate4d-client.sh` (DevBridge 8891, sidecar 8890).

- **2026-10-05 (phase 4c, mod side):** new `dev.massing.state|review|key|redirect|showSet|hideSet` and
  `dev.composite.state|clear`. `dev.design.fill` takes `massingFirst`, `dev.set.fill` takes `massingFirst`,
  `maxRedirects` and `context`, `dev.ui.focus` takes `set_context` and `redirect`. `dev.sidecar.state` adds `massings`.
  The Designs tab lists massing jobs (kind MASSING) and detail passes (kind DETAIL); a set's rows carry the approval
  controls listed above. `tools/apitest.mjs massing` (and `composite`) drives the 4c API (apitest `/apitest massingreq,
  massingget, massings, redirect, massingdelete, detail, designget, approve, composite, compositeclear`);
  `tools/p4c-ui.mjs` walks the 4c screens with screenshots.

- **2026-10-05 (phase 4b, mod side):** new `dev.set.open|fill|draft|submit|close|state`, `dev.library.reskin`,
  `dev.group.action`, `dev.bibles`. `dev.library.filter` takes `collection`, `dev.library.variants.set` takes `bible`,
  `dev.design.fill` takes `openType`, `profile` and `bible`, `dev.world.open` takes `{name, mode, preset, seed, cheats}`,
  `dev.ui.focus` takes `set_*` fields (with `:<row>` for an item row). `dev.sidecar.state` adds `groups`, `bibleJobs`,
  `reskins` and `bibleIndex`. The Designs tab lists sets (kind SET) and bible jobs (kind BIBLE); a set's item designs
  are no longer rows of their own (they show in the set). `tools/apitest.mjs sets` drives the 4b API (apitest
  `/apitest bible|group|estimate|reskin|opentype|survival ...`).

- **2026-10-05 (phase 4a, jobs):** new `dev.world.leave` and `dev.world.open` (leave a world and load it again in the same
  game, for "finished while no world was loaded" checks). `dev.sidecar.state` also lists the sidecar's `jobs`. The
  launcher passes `--backend sim|claude` to a sidecar it starts when `ARCHITECT_SIDECAR_BACKEND` says so (dev/test switch,
  not a hook; `tools/run-apitest-client.sh --sim`).
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
- **2026-10-13 (6c slice PT2):** new `dev.pt2.*` hooks (SlicePT2Dev, generated headless too). `dev.pt2.entry {entry}`: an entry read
  back (its blueprint JSON, folder, head version and version folders, template cells, block entities and the inventory items they
  hold, whether its `.mjs` is there); `dev.pt2.compare {site, version?: 1}`: the site's entry version against the world over its box
  (rotation none): matched and mismatched cells (state, block-entity data without inventories or position), the void cells of the box,
  the world's containers with their items and what the entry holds there; `dev.pt2.journal {site}`: the site's journal entries (any
  status: id, kind, status, policy, cells) with each file's version on disk. `dev.pt.builds` and apitest `ptbuild` carry `siteId` for
  an adopted build. apitest (`ApiTestPT2`): `apipt2` (the surface), `adopt <key> <build> <owner|-> <b64 consent|-> [b64 ext]`
  (`Sites.adopt`, pending `adopt:<key>`; consent `{builds, actor: <uuid>|player}`), `adoptedsite <build>`, `pt2checkdelta <site>
  <version> <owner|-> <b64 consent|->` (checkDelta KEEP with a consent); `checkdelta` and `eversions` print `capturedChanged` and
  `capturedTotal`.
