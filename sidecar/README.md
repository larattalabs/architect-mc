# Architect sidecar

A local Node helper for the Architect mod. The mod starts it, and it runs Claude building design jobs
with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). It talks to the mod
over a WebSocket on localhost and installs finished designs into the library folder. It is a slim
extraction of the design job from AgentCraft's Foreman (MIT, see `../LICENSE`). The binding interface
is `../docs/CONTRACT.md`: see "Library on disk", "Kit CLI", "Protocol" and "Sidecar process", and for protocol 2
(jobs, blobs, designs v2) "Phase 4a contract: public API".

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
{ "designModel": "claude-opus-5-5", "effort": "high", "maxTurns": 120, "maxBudgetUsd": 5,
  "jobModel": "claude-sonnet-5-5", "jobConcurrency": 4 }
```

`ARCHITECT_DESIGN_MODEL` overrides `designModel`. The defaults are `claude-opus-5-5` at effort `high`.
`ARCHITECT_JOB_MODEL` overrides `jobModel`, the default model of a job. `jobConcurrency` is the number of structured
jobs that run at once. The sim also reads `simStepMs` (ms per fake step) and `simJobStepUsd` (the cost it reports per
job step, default 0.01).

### Files it writes

| file | when | what |
|---|---|---|
| `<data>/client.token` | after the port is bound | A random token (mode 0600), new on every start. Every client must send it in `hello`. It is removed on exit if it is still ours. |
| `<data>/sidecar.json` | after the token | `{ pid, port, version, startedAt }` (startedAt in epoch ms). It is removed on exit if the pid is still ours. |
| `<data>/secrets.json` | on `auth.set` | `{ apiKey?, useClaudeLogin? }` (mode 0600). It is never logged or echoed. |
| `<data>/state.json` | always | Designs, jobs (with their specs, sessions, cost and waiting tool calls), blob records, id counters, SDK sessions, design job progress and the usage-limit hold. It holds no credentials. |
| `<data>/jobs/<j>/` | a job | Its scratch dir (cwd of the job's query), with `blobs/<id>.<ext>`. |
| `<data>/blobs/<id>` | `blob.put`, a big job result | The blob's bytes (`<id>.part` while an upload is open). Kept 7 days. |
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

## Protocol 2 (phase 4a: the public API)

The binding text is `../docs/CONTRACT.md`, "Phase 4a contract", sections "Versioning" and "Jobs (R2): protocol 2". The
schemas live in `src/protocol.ts`. The envelope keeps `"v": 1`; the protocol is negotiated per connection.

- **Negotiation.** `hello { ..., protocols: [1, 2] }` picks the highest protocol both sides speak. The v2 snapshot adds
  `protocol: 2`, `features: ["job.run", "job.tools", "blobs", "budget", "designs.v2"]` and `jobs` (the last 20 plus any
  unfinished one). A hello without `protocols` is protocol 1: it may send only the phase 1-3 messages (v2 ones fail as an
  unknown type, v2 fields of a design request are dropped) and it gets only phase 1-3 messages and fields (no `job.*`,
  no `cost`, no v2 request fields, no `protocol`/`features`/`jobs`). A hello whose `protocols` has nothing in common gets
  an `error` and the socket is closed with code 4002.
- **Client → sidecar (protocol 2)**
  - `job.run { job: JobSpec }` → ack `result: { jobId }`. Refused at once for a bad spec, a listed blob that is not
    there, or Claude unavailable (auth missing or failed).
  - `job.cancel { jobId }`.
  - `job.tool.result { jobId, callId, result?, error? }`. `result` is any JSON of at most 256 KB; a bigger one is refused
    (`ack ok:false`) and the call keeps waiting, so answer with a blob id instead. `error` is a string the agent gets as
    the tool's error. An answer for a call that is not waiting (answered, timed out, cancelled) is refused.
  - `blob.put { blobId?, kind, owner?, ext?, data | chunks, more? }` → ack `result: { blobId, size, complete }`. `data` is
    a whole JSON blob; `chunks` are base64 strings of at most 1 MB each (decoded). A blob of more than one frame (16 MB
    per frame) goes as several `blob.put` frames with the same `blobId` and `more: true` on all but the last; `kind` is
    needed on the first. At most 64 MB. A new put with the id of a finished blob replaces it. `ext` (default `json` for
    data, `bin` for chunks) is the file extension in a job's scratch dir.
  - `blob.delete { blobId }`.
  - `client.paused { paused }`: the game paused or resumed; tool-call clocks of this connection stop while paused.
- **Sidecar → client (protocol 2)**
  - `job.upsert { job: Job }` on every change.
  - `job.event { jobId, kind: "text" | "step" | "tool", data }`: `text {text}` (the agent's text), `step {step}`
    (`job_status`), `tool {phase: call|result|error|timeout, name, callId}`. Not persisted.
  - `job.tool.call { jobId, callId, name, input, owner?, timeoutMs }`, sent to the connection that ran the job, or after a
    reconnect to a connection whose hello `client` name is the same (send a stable name such as `"mod"`).
- `JobSpec = { kind: structured|agent, prompt, system?, model? (default "claude-sonnet-5-5"), effort?, schema?, tools?:
  [{ name, description, inputSchema, timeoutMs? (default 60000), readOnly? }], budgetUsd?, maxTurns?, owner?, tag?, group?,
  ext?, blobs?: [blobId] }`. A structured job needs `schema` and has no tools; tool names are `[A-Za-z0-9_-]{1,64}` and
  `job_status` is the sidecar's own.
- `Job = { id: "j<n>", spec (prompt cut at 2000 chars), status: queued|running|waiting_tool|held|done|failed|cancelled,
  step, result?, resultBlob?, error?, cost: { usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns },
  usageLimitUntil?, createdAt, updatedAt }`. `result` is the validated JSON for a structured job and `{ text, json? }`
  for an agent job; a result over 256 KB is stored as a blob (kind `job.result`) named by `resultBlob`. `error` is
  `"budget"` when the budget stopped the job.
- **Designs** accept `owner`, `ext`, `model`, `budgetUsd`, and the reserved `bible` and `group`, and carry `cost`. The
  request's `ext` is merged into the installed entry's blueprint JSON and kept by variants and by imports of an
  exported entry (its `<id>.blueprint.json` next to the `.nbt`). A design whose budget is spent fails with `"budget"`.

### How a job runs

- Both kinds go through the Agent SDK's `query()` (never the Messages API), with `tools: []`, no setting sources and
  a scratch dir `<data>/jobs/<jobId>/` as cwd, holding `blobs/<id>.<ext>` for the spec's blobs. A structured job uses
  `outputFormat: { type: "json_schema", schema }` and `maxTurns` 4 by default; its answer is the result's
  `structured_output`, checked again by the sidecar (`src/jobs/schema.ts`), with one re-ask in the same session on a
  miss. An agent job gets an in-process MCP server (`architect_job`) with the spec's tools and `job_status`, and
  `maxTurns` 40 by default. Hooks and `canUseTool` refuse everything else (the SDK's own `StructuredOutput` tool aside).
- The tool clock counts only while the connection that has the call is open and not paused. A call whose client
  disconnected waits for a connection with the same `client` name. A call is written to `state.json` before it is
  sent; after a restart the job waits for its answer, then resumes the SDK session with the answer in the prompt.
- Budget: `maxBudgetUsd` is what is left of `budgetUsd` (the SDK counts only the current `query()`), and the sidecar
  refuses to start another query once the job's cumulative cost reached it. The cost is the SDK's estimate
  (`total_cost_usd`, tokens from `modelUsage`). A query cut short by a restart reports nothing, so its spend becomes
  visible only when the resumed session reports its total.
- Structured jobs run up to `jobConcurrency` at once. Agent jobs and designs share one slot. A usage limit holds jobs
  (`held`, `usageLimitUntil`) and designs alike, and both resume their sessions when it resets.
- The sim backend runs jobs without Claude: a structured job returns an object built from the schema, an agent job
  calls each tool once in order and returns `{"results":[{tool, result | error}]}`, and every step reports
  `simJobStepUsd` more, honouring `maxBudgetUsd` as the SDK does.

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
