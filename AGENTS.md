# Architect: agent guide

Architect is a public Fabric mod (Minecraft 26.3, Java 25) that designs buildings with Claude and places them exactly and
undoably. It has three parts:
- `mod/`: Java. Placement, the journal, sites, regions, and the public API in `dev.larattalabs.architect.api`.
- `sidecar/`: Node/TypeScript, using the Claude Agent SDK. Jobs, designs, groups, bibles, critique and eval.
- `kit/`: plain ESM JS. The blueprint kit, checker, renderer and region programs.

Steward (`../steward-mc`) is the main consumer of the API.

## Where things are decided

- `docs/PLAN.md`: status per phase, decisions, queued asks, process. Read its latest sections first.
- `docs/CONTRACT.md`: the binding contract per phase. Each has a "Changes from Steward's review" section, which wins over the
  text above it, and an "as built" section.
- `docs/SETTLEMENTS.md`: the roadmap after 6a (6b, 6c slices, 7a, 6d, 7b, 7c).
- `docs/GATES.md`: how to test. `docs/DEVBRIDGE.md`: in-game test hooks.
- `docs/HANDOFF-<phase>.md` (on phase branches): resume notes. Keep it current; delete it when the gate passes.

## Process

- **Work in slices** of a few hours. Each has a short contract that Steward reviews, a focused gate and a minor release.
- **Scope is frozen per slice.** New ideas go into the next slice unless they block the current one.
- **Branches:** work on `phase/<x>` in a worktree (`../architect-mc-<x>`). Never commit to main directly. The coordinator
  merges, tags and publishes; tag `vX.Y.Z` must equal `mod_version`, and CI publishes to GitHub Packages.
- **Keep the API binary compatible:** keep old record constructors, add new methods as defaults that throw, and append enum
  values at the end. Check with `tools/api-compat.mjs` against the archived apitest jars.

## Build and test

- **Java:** `export JAVA_HOME=/opt/homebrew/opt/openjdk@25 GRADLE_USER_HOME=$PWD/.gradle-home`. In a new worktree, first run
  `cp -c -R ~/Developer/LarattaLabs/architect-mc/.gradle-home .` (an APFS clone, cheap). Then
  `cd mod && ./gradlew build --offline`.
- **Kit:** `node --test kit/test/*.test.mjs`. **Sidecar:** `cd sidecar && npm ci && npm run check` (tests, plus the
  `dist/main.mjs` bundle). A release build fails without the bundle.
- **In-game gates:** `node tools/gate-run.mjs <change|slice|release> --since origin/main --plan`, then run it detached.
  - Tiers: `change` while iterating; `slice` before a slice merges; `release` (all steps, overnight) plus the full
    gate-verifier once per release.
  - Commit first, because clients run HEAD.
  - Wait with ONE long until-loop on the run's `summary.json`, then read `SUMMARY.md` once. Never poll every few minutes:
    each wake costs Noah's subscription.
- Set `enableVsync:false` in `mod/run/options.txt`, or a hidden client stalls at the loading screen.
- **Tick bars judge Architect's own per-tick time.** The vanilla tick and GC are recorded, not judged.

## Ports (don't collide with other sessions)

- Architect gate runner: 8890-8895 by default; extra runners pass `--ports/--run-dir/--out/--lock`.
- Steward dev client: 8490/8491. AgentCraft Foreman: 7880 and 7890-7909.
- Ad-hoc agent runs: ask the coordinator, or use a free pair of 8896-8905 and say which in your report.

## Hard rules

- **No Anthropic API key, ever.** Paid runs use Noah's claude login (the sidecar's opt-in claude-login mode), only within a
  stated spend cap, tracked in `artifacts/<gate>/spend.json`. Gates are sim/stub ($0) unless a contract says otherwise.
- **No Discord notifications** (the runner's notify is off; never pass `--notify`).
- **Kill only processes you started, by PID.** Never `pkill`/`killall` by pattern: other sessions run Minecraft clients.
- Never commit secrets, logs (`mod/logs/` is ignored) or `artifacts/` (local evidence only).
- **Byte-compared outputs must be platform-independent.** CI runs Linux; the kit pins the gzip OS byte.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR descriptions carry no "Generated
  with Claude Code" footer.
- No `rm -rf` outside build/temp dirs, no `git reset --hard`, no force-push.
- Don't tune prompts against the eval briefs. A failed quality gate is reported as "not shown", with the data.
