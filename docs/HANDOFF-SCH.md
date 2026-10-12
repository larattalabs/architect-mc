# HANDOFF: slice SCH (Sponge `.schem` import and export)

Resume notes for `slice/SCH` (worktree `../architect-mc-SCH`, branched from origin/main c4418fb). Delete this file when the gate
passes. Contract: docs/CONTRACT.md "Phase 6c slice SCH" (frozen with the batch's Steward changes). Placeholders: API 1.20.0,
mod 0.23.0 (the coordinator sets the real numbers at merge). Ports for ad-hoc clients: 8936-8941. Spend: $0.

## State

- Built: kit codec (`kit/lib/schem.mjs`, `kit/import.mjs` takes `.schem`, `--ground-y`, `--tag`), spec fixtures
  (`kit/test/fixtures/schem/`, made by `make.mjs`), goldens (`goldens.json`: `kit` and `mod` sha256 of the exports).
- Mod: `library/Schematic.java` (pure v2/v3 read, v3 write, sorted-key NBT, gzip level 9), `library/Schematics.java` (vanilla
  STRUCTURE data fixers, unknown blocks / `architect_mc:unknownAs`, staging in `<gameDir>/architect/schem-staging/`, export of
  templates and captured boxes), `library/SchematicCommands.java`; API in `LibraryImpl`/`SitesImpl`; Library screen buttons
  (Export .nbt / Export .schem, Import… lists `.schem`); DevBridge `dev.library.export.schem`.
- Sidecar: `import.request {path, name?, schem?}` -> variant kind `import-schem` (feature `import.schem`).
- Gate driver `tools/gate6csch.mjs` (steps unit, linux, roundtrip, versions, refusals, placement, sites, ui, apicompat,
  report); runner steps `sch-unit`, `sch-roundtrip`, `sch-refusals`, `sch-placement`, `sch-ingame`; impact rule "6c SCH".
- All driver steps passed against an ad-hoc sim client (8936/8937) before the slice run.

## Decisions to record in "as built"

- Import is read, upgraded and checked in the mod (Java), then staged as a structure `.nbt` for the helper's `import-schem` job.
  The kit codec is the twin for tests, the CLI and the gate's cross-reads.
- Export is written by the mod (no helper needed). The JDK's bundled zlib gives the same bytes on macOS and Linux: checked with
  eclipse-temurin:25 on linux/amd64 (the `linux` step).
- 26.3 structure palettes are `{id, properties}` from DataVersion 5006 (BlockStateFieldNamesFix); older files get
  `{Name, Properties}` so the fixers see their own version's form.
- Cells a template does not write are `structure_void` in an export and not written on import; air is air.
- groundY = -Offset.y when it is 1..height-1, else 1. Export Offset = [0, -groundY, 0].
- The contract's `architect/import/` is the existing `architect/imports/`. `importSchematic(Path, String, JsonObject)` is an
  added overload: the contract's `ext["architect_mc:unknownAs"]` had no way in.
- `tools/p2-library-check.mjs` is stale on main (expects a `floors` param the bundled cabin lost) and not in the runner; the
  `ui` step covers the Library's import and export paths instead.
- KIT_VERSION not bumped: SCH adds no op kind or IR member, so no IR sha or tile golden moves.

## Next

1. `node tools/gate-run.mjs slice --since origin/main --plan` (ports 8938:8939, own run dir/out/lock), then the run.
2. gate-verifier (re-runs items 1, 4, 5: `--only sch-roundtrip,sch-refusals,sch-placement`).
3. CONTRACT "as built", retire this file, push, report "ready to merge".
