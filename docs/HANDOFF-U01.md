# U01 (Style unification U0 + U1): RC note for Steward

Branch `slice/U01`. The binding text is in docs/CONTRACT.md "Style unification U0+U1 contract" (end of the file); this note
lists what Steward is asked to accept. API: additive only, a minor bump at merge (`Since NEXT`).

## What changes for Steward

1. **`DesignRequest.palette`** (new last record component, a `JsonElement`): materials only. A preset name, inputs, or a Style's
   roles inline `{bible: {id, version, roles}}` (`DesignRequest.withStyle(Bible)` builds it). It is never bible set mode: no shared
   components, no restraint. It excludes `bible`. The mod sends it only to a helper whose features list `palette.roles`, and fails
   the future otherwise (an older helper would drop it silently). The entry records the palette, and with roles inline it pins
   `{id, version}` as its `bible`. Designed again (polish, versionOf, a report critique), such an entry keeps its palette and never
   turns into set mode.
2. **Binary compatibility (your condition c).** Every earlier canonical constructor of `DesignRequest` stays: your 14-argument
   1.1.0 one (LotBrief.java:46, ChangeRequests.java:154), and those of 1.2.0, 1.3.0, 1.6.0, 1.11.0 and 1.37.0. `Bible` keeps its
   1.2.0 (12) and 1.6.0 (16) constructors. `ApiStyleU1Test` checks each by reflection, and api-compat passes against the 0.42.0 and
   0.41.0 apitest jars and the 0.42.0 surface. The contract now says that any future change to an API record you construct keeps
   all of the old constructors.
3. **Bible fields** (optional, additive): `tags`, `suggestedFeatures` (DesignSpec.FEATURES ids, at most 6), `blurb`,
   `basedOn {id, version}`, `origin` (`builtin` | `claude` | `hand`), plus `Bible.editable()`. Bibles from before U1 read as
   `origin: claude` with no tags; nothing is rewritten. Bible jobs now stamp `origin: claude`.
4. **`Bibles.save(bibleId, style, owner)`** (`bible.save`, feature `bible.save`): a hand-made Style with no Claude call and no
   cost. Every save is a new version folder, created exclusively. It is refused for a built-in id, an id held by a running bible
   job, another owner's Style, and roles that fail the kit's test house.
5. **Version permanence (your condition a).** A version that anything pins is never rewritten or removed, by a save, a duplicate
   or a clean-up:
   - saves only add versions;
   - `bible.delete` still refuses while anything pins a version;
   - the version GC no longer touches a mod-owned or hand-made Style at all, because their pins can live outside Architect, for
     example in your settlement `BibleRef`;
   - a unit test hashes every existing version folder before and after each save and refusal.
6. **Ownership (your condition b).**
   - `owner` absent: the player's, editable in Architect's UI.
   - Any other owner: Duplicate-only there, and only that owner can save new versions of it.
   - Your bible jobs set it through **`BibleRequest.owner`**, the third record component (`new BibleRequest(prompt, name, owner,
     ...)`), sent as `bible.request.request.owner`. The job copies it into `bible.json` `owner`, and `Bible.owner()` reads it
     back. Please use `"steward_mc:<settlementId>"`.
7. **Free reads (your item d):**
   - `Bibles.get(id)` returns the head version, `Bibles.get(id, v)` one version, and `Bibles.list(owner)` works as before. All are
     local, with no helper call.
   - New: `Bibles.usable(owner)` lists the built-in Styles, the player's own and that owner's, without archived ones.
   - With `DesignRequest.withStyle(bible)`, "use an existing Style" needs no bible job and no new API.
8. **Built-in Styles: 16 now.** The ten presets, unchanged byte for byte (both golden fixtures held), plus medieval, nordic,
   japanese, cozy, fantasy and modern. `seedPreset` accepts the new ids too, so you can map your style templates onto them if
   you want to.
9. **Feature names** in `ArchitectApi.features()`: `palette.roles`, `bible.save`.

## Questions for Steward

- Do you pin a **player's** Claude-made Style version outside Architect anywhere today? The 5a GC still removes such a version
  after 30 days when it is not the latest and nothing Architect knows pins it (an entry, group, design or massing). Your own
  bibles (owner set) and every hand-made Style are now exempt. If you do pin player bibles externally, we can extend the
  exemption to every Style (U2), or you can design with the roles inline, which never depends on the version existing.
- Is `Bibles.usable(owner)`'s filter (built-ins + the player's + that owner's, no archived ones) the list you want for "use an
  existing Style"?

## Evidence (DEV MODE)

- **Units (on the tree merged with main e00af4ab):** kit, the whole suite 865/865 (delta-fixtures included); sidecar `tsc` and
  vitest, all pass (`styles-u1.test.ts`: the materials-only design, variants with roles, `bible.save`, version permanence, GC,
  `setModePin`); Java `./gradlew build --offline`, 901 tests and 0 failures (`StyleRolesTest` for JS/Java parity,
  `ApiStyleU1Test`, `VariantFormTest`, the Wire tests, `FieldLimitsTest`); `release-version.mjs --check --lenient` consistent.
- **Lints:** structure (59 cases), look (13) and water (123), all 0 FAIL.
- **Other checks:** `step-inputs check` and api-compat (0.42.0, 0.41.0 and the 0.42.0 surface).
- **In game:** `u1-ingame` (`tools/gateu1.mjs ingame`, headless, sim, $0): **PASS**, 29/29 checks, on the tree merged with main
  e00af4ab (v0.43.0). Evidence: `artifacts/gate-runs-U01/20261024-054804-change/` (`gate6b/u1-ingame.json`).
- **After the merge with main:** `./gradlew build --offline` (901 tests, 0 failures); sidecar `tsc` and vitest (766/766, with the
  bundle built); api-compat against the 0.43.0 apitest jar and the 0.43.0 surface.
