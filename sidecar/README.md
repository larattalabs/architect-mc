# Architect sidecar

A local Node helper for the Architect mod. The mod starts it, and it runs Claude building design jobs
with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). It talks to the mod
over a WebSocket on localhost and installs finished designs into the library folder. It is a slim
extraction of the design job from AgentCraft's Foreman (MIT, see `../LICENSE`). The binding interface
is `../docs/CONTRACT.md`: see "Library on disk", "Kit CLI", "Protocol" and "Sidecar process".

## Running it

```
node dist/main.mjs --port 7890 --data <gameDir>/architect/sidecar-data \
                   --library <gameDir>/architect/library --kit <kitDir> \
                   [--use-claude-login] [--parent-pid <pid>] [--backend claude|sim] [--debug]
```

| flag | meaning |
|---|---|
| `--port <n>` | WebSocket port on `127.0.0.1`. The default is 7890, or `ARCHITECT_PORT`; `0` picks any free port, and `sidecar.json` records which. |
| `--data <dir>` | Sidecar data: `state.json`, `client.token`, `sidecar.json`, `secrets.json`, `logs/`, `designs/<designId>/` (scratch dirs). Optional `config.json` (below). |
| `--library <dir>` | The design library. Finished designs are installed as `<library>/<id>/`. |
| `--kit <dir>` | The blueprint kit (`build.mjs`, `render.mjs`, `lib/`, `designs/`). Each job works on a fresh copy of it. |
| `--use-claude-login` | Use your local `claude` login instead of an API key. Personal use only, see "Auth". |
| `--parent-pid <pid>` | Exit when this process is gone (checked every 5 s), so a crashed game doesn't leave the sidecar running. |
| `--backend claude\|sim` | `claude` (the default) runs real design jobs. `sim` uses no Claude: after a few fake progress steps it installs a kit example (`kit/designs/<type>.mjs`, else `cabin.mjs`) under a new id, built and checked through the real kit CLI. It is meant for tests and offline UI work. |

Exit codes: `0` for a normal shutdown, `2` for bad flags, `3` when the port is already in use (the running
sidecar's files are left alone), and `1` for anything else.

`<data>/config.json` is optional and edited by hand:

```json
{ "designModel": "claude-opus-5-5", "effort": "high", "maxTurns": 120, "maxBudgetUsd": 5 }
```

`ARCHITECT_DESIGN_MODEL` overrides `designModel`. The defaults are `claude-opus-5-5` at effort `high`.

### Files it writes

| file | when | what |
|---|---|---|
| `<data>/client.token` | after the port is bound | A random token (mode 0600), new on every start. Every client must send it in `hello`. It is removed on exit if it is still ours. |
| `<data>/sidecar.json` | after the token | `{ pid, port, version, startedAt }` (startedAt in epoch ms). It is removed on exit if the pid is still ours. |
| `<data>/secrets.json` | on `auth.set` | `{ apiKey?, useClaudeLogin? }` (mode 0600). It is never logged or echoed. |
| `<data>/state.json` | always | Designs, id counters, SDK sessions, job progress and the usage-limit hold. It holds no credentials. |
| `<data>/logs/sidecar.log` | always | The log, which is also written to stdout/stderr. |
| `<data>/variants/<v>/` | a variant / import job | Its scratch dir: a fresh `kit/`, `check/`, `previews/`, `in/` (the import copy). |
| `<library>/<id>/` | a design finished | `<id>.nbt`, `<id>.blueprint.json` (with `source`, `createdAt` and `request` added), `<id>.mjs` and the `<id>.preview-*.png` files. An existing folder is never overwritten: ids go `gen_<slug>`, then `gen_<slug>_2`, and so on. |

### For the launcher

- Reuse: read `<data>/sidecar.json`, connect to its port and send `hello` with the token from
  `<data>/client.token`. If the snapshot's `version` matches, reuse that sidecar. Otherwise, if the
  launcher started it, send `shutdown` (or kill the pid), then start a new one.
- Start-up is complete once `sidecar.json` exists, because it is written after the port is bound and
  after the token.
- The SDK is optional at start. Without `node_modules` the sidecar still serves status with
  `sdk: "missing"`, and the Claude designer looks for the SDK again every 30 s. Install it in the
  sidecar dir with `npm ci --omit=dev`; the platform package pulls a native `claude` binary of about
  200 MB.
- Minecraft starts the sidecar with a minimal PATH, so the sidecar puts `dirname(process.execPath)`
  first on PATH for the design agent's CLI and for every kit child process.

## Protocol (summary)

The connection is `ws://127.0.0.1:<port>`, with one JSON object per text frame:
`{ "v": 1, "type", "id"?, ...payload }`. The sidecar rejects any `Origin` header and any non-loopback
`Host`. The schemas live in `src/protocol.ts`.

- **Client → sidecar**
  - `hello { client?, version?, token }`: must come first. A missing or wrong token gets an `error`, and
    the socket is closed with code 4001. Anything sent before a valid hello is refused.
  - `design.request { request: DesignRequest }` is acked with `result: { designId }`.
  - `design.cancel { designId }`.
  - `auth.set { apiKey?: string | null, useClaudeLogin?: boolean }`: a string sets the key, `null` clears
    it, and an absent field keeps it.
  - `shutdown {}`.
  - `variant.request { from, palette?, values?, name? }` is acked with `result: { variantId }` (phase 2, see
    "Variants and imports"). `from` is a library id; `palette` a preset name or `{ preset?, wood?, stone?, roof?,
    accent? }`; `values` `{ name: int | bool | string }`; `name` (<= 40) the new entry's displayName.
  - `import.request { path }` is acked with `result: { variantId }`.
- **Sidecar → client**
  - `snapshot { version, status, designs, variants, palettes? }` in reply to a valid hello. `variants`: the last 20
    variant/import jobs plus any unfinished one. `palettes` (an addition): `{ presets: { <name>: { wood, stone, roof,
    accent } }, woods, stones, roofs }` from `kit/tools/describe.mjs --palettes`, for the palette picker.
  - `status { status }` whenever the status changes.
  - `design.upsert { design }`, to be replaced by `design.id`.
  - `variant.upsert { variant }`, to be replaced by `variant.id`. Imports report on this same channel.
  - `ack { re, ok, error?, result? }`, for every client message that carries an `id`.
  - `error { message, re? }`.
- `Status`: `{ auth: ok|missing|failed|checking, authSource?, useClaudeLogin, sdk: ready|missing, designing?,
  queued, usageLimitUntil?, backend?, message? }`. `backend` and `message` are additions to the contract.
- `DesignRequest`: `{ type, style, materials?, features[], maxSize{x,y,z}, plot?, remix?, name?, notes? }`.
  - `type` is one of the contract's 11 types.
  - `style` is any text up to 40 characters.
  - `features` holds up to 6 `[a-z_]` words. Known ones get a guide line in the brief; others pass through.
  - `maxSize` x/z is 7 to 96 and y is 6 to 64.
  - `plot` is `{ dx, dz, height?, front?, minX?, y?, minZ?, dimension? }`.
- `Design.status` moves `queued → designing → checking → rendering → done`, or ends at `failed` or
  `cancelled`. Final states never change. When a design is `done`, its files are already in
  `<library>/<blueprintId>/`, and `previews` holds their absolute paths.

## Variants and imports

Neither uses Claude, and they run one at a time on their own queue, so a variant never waits behind a design.

`Variant = { id: "v<n>", kind: "variant" | "import", from, status: queued|building|done|failed, step, palette?,
values?, name?, blueprintId?, size?, previews?, error?, createdAt, updatedAt }`. `kind`, `palette`, `values`, `name`
and `previews` are additions to the contract. For an import, `from` is the absolute `.nbt` path. `done` and `failed` are
final; `error` keeps the kit's lines (one per line). When a job is done, `name` is the new entry's displayName (a
variant) or name (an import).

**A variant** of `from`:
- The source is `<library>/<from>/<from>.mjs`. For a bundled example, which lives in the mod's jar and not in the
  library, it is the kit's `designs/<from>.mjs` (else `examples/<from>/<from>.mjs`), with `kit/examples/<from>/` for
  its sidecar.
- `variant.request` is refused at once (`ack ok:false`) when there is no such entry, when the entry is `imported`, or
  when it has no source.
- The job works in `<data>/variants/<v>/`, which holds a fresh copy of the kit. It copies the source to
  `kit/designs/<newId>.mjs`, rewrites its `export const id`, and points any relative `…/lib/<x>.mjs` import at
  `../lib/<x>.mjs`. That covers library sources, which import `../lib/kit.mjs` from `<library>/<id>/`.
- Then it runs `kit/build.mjs <newId> --type <entry type> --palette … --values … --json` in a child process with the
  minimal environment, against the pristine kit. There is no `--max`, so a variant may grow.
- A palette preset is used as given. Palette inputs are merged over the entry's recorded `palette`, and values over
  its `values`. An entry with no recorded palette first builds once to learn the design's default.
- It renders the previews and installs the result, never overwriting. The id is `<from>_<preset or wood>`, then `_2`
  and so on; without a palette it is `<from>_v2`, `_v3`, and so on.
- The sidecar JSON gets `variantOf: from`, the entry's `name`, `description` and `request`, and
  `displayName = name ?? "<entry name> (<palette>, floors 2, no porch)"`, which lists only the values that changed.
  The build also writes `palette`, `params` and `values`. `favorite` and `userTags` are never written.

**An import** (`import.request { path }`):
- The path must be absolute and end in `.nbt`, and its real path (links resolved) must be under one of these folders,
  all derived from `--library` (`<gameDir>/architect/library`):
  - `<gameDir>/architect/imports/`
  - `<gameDir>/architect/exports/` (so an export can be imported in another world)
  - `<gameDir>/saves/<world>/generated/<namespace>/structure/` (26.3 structure-block saves) or `.../structures/`
- Anything else is refused at once with the reason.
- The job copies the file into the scratch dir and runs `kit/import.mjs <copy> --id imp_<slug> --out check --json`.
  That writes the template (first palette, entities dropped) and a sidecar: type `custom`, groundY 1, front south,
  entrance at the front centre, spawn 2 out, `imported: true`, and a name from the file name.
- The kit checks the result with the custom profile in import mode:
  - These are warnings: the anchor, door and light rules, and an extent mismatch.
  - These stay errors: palette validity, the format, the sidecar, and the 96x64x96 size cap.
  - Non-vanilla or unknown blocks fail the job with one line listing every id and its count.
- It renders the previews and installs `imp_<slug>` (then `_2`, …) with no `.mjs`, so the entry can have no variants.

## Auth

An Anthropic API key is the supported path. The sidecar looks in this order:

1. `ANTHROPIC_API_KEY` in the environment.
2. The key from the in-game Status tab (`auth.set`, stored in `<data>/secrets.json`).
3. A cloud-provider switch (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_ANTHROPIC_AWS`).

Without one of these, `auth` is `missing`, and the design request is refused with a message saying how
to set it. The check at start-up (and after every `auth.set`) asks the CLI for its account info.

`--use-claude-login` (or the in-game toggle, `useClaudeLogin` in `secrets.json`) uses your local
`claude` CLI login instead. It is **off by default and for your own personal use only**. From the Agent
SDK overview: *"Unless previously approved, Anthropic does not allow third party developers to offer
claude.ai login or rate limits for their products"*
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)). Under the login, the API key
variables are removed from the design agent's environment. In API mode the login token
(`CLAUDE_CODE_OAUTH_TOKEN`) is removed. This environment scrubbing is copied from AgentCraft.

## What a design job may do

Each job gets `<data>/designs/<designId>/`, which contains `kit/` (a fresh copy of `--kit`), `BRIEF.md`,
`CONTRACT.md` and `remix/` (optional). The agent works in `kit/designs/<id>.mjs`.

- **The turn.** It uses the `claude_code` preset with `cwd` set to the scratch dir and no setting
  sources. It gets the tools `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash` and `TodoWrite`, and no
  subagents, web tools or skills. Its one MCP tool is `design_status`. Its env puts this node first on
  PATH and sets `GIT_CEILING_DIRECTORIES` to the scratch dir's parent.
- **Hooks.** These run before every tool call, including the ones the CLI would allow by itself:
  - Only the sidecar's own MCP server is allowed.
  - The sidecar's own files are off limits: token, secrets, state and logs, plus its port.
  - File edits may only target `kit/designs/<id>.mjs`.
  - No git.
- **Everything else** goes through AgentCraft's worker policy (`src/policy.ts`). Nobody can answer a
  prompt, so whatever it would ask about is refused: network, installs, anything outside the scratch
  dir.
- **What Bash can still write.** Bash commands may still write inside the scratch dir, because
  `build.mjs` writes `kit/out/` and the renderer writes `previews/`. The sidecar re-checks the design
  with a **pristine** kit copy in a child process with a minimal environment, so changes the agent makes
  to its own copy of the kit don't count.
- **Rounds.** There are up to 4 rounds: a failed check goes back to the same session. Then come the
  previews and the install.
- **Interruptions.** A usage limit holds the queue and resumes the session when the limit resets. A
  restart resumes the session too.

## Development

```
npm install
npm run check      # tsc --noEmit + vitest (includes an end-to-end test of the built bundle)
npm run build      # dist/main.mjs (esbuild; @anthropic-ai/claude-agent-sdk stays external)
npm start -- --data /tmp/arch/data --library /tmp/arch/lib --kit ../kit --backend sim
```

The tests use a small fixture kit (`test/fixtures/kit/`) that implements the kit CLI, so they don't
depend on the real kit.
