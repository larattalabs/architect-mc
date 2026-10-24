# One Style, one design editor: the model

Paths are relative to `architect-mc/` (main `defa6f52`). ⚠ marks where the proposal is wrong or awkward.

**In short.** The 10 presets already are the built-in bibles (kit/lib/bible.mjs:41-63): `palette({bible:n})` equals `palette({preset:n})`, and a sample of 3,848 four-input mixes all round-trip through `rolesOfPalette` (kit/lib/kit.mjs:301). What's split is the UI and two wire fields.

## 1. A Style is a bible plus a few optional fields
| kept (bible.json, api/Bible.java:32) | new, optional |
|---|---|
| `id name version scope format owner archived` · `roles`: 11 core roles (kit.mjs:277), plus the macro roles and extra roles · shape hints `proportions roofLanguage silhouette motifs restraint` (bible.mjs:5-11, 38) · the role-pointing slots `fluids connectors patterns tiers` (:200-235) · `prose components sheet` | `tags[]` · `suggestedFeatures[]` (DesignSpec.FEATURES ids, max 6: DesignSpec.java:100) · `blurb` · `basedOn {id,version}` · `origin builtin\|claude\|hand`. Favourites and recents live on the client, beside library-meta.json (LibraryFeature.java:99). Built-ins have no sheet (Bible.java:12-13), so their preview is drawn from the roles (RolesSwatch.java:21). |

**Four inputs to roles.** Wood fills wall, frame and floor; stone fills foundation and trim; roof and accent fill one each; wall_alt, light, glass and path are fixed (kit.mjs:244-254). ⚠ The reverse is lossy.
- **Proposed:** `editMain(roles, field, value)` re-derives only roles still in the old wood or stone family (kit.mjs:161, 171). A per-role provenance tag (`style`, `follows wood/stone`, `hand`) drives the "from X" and "custom mix" markers.
- ⚠ The mod has no node (Palettes.java is fed by tools/gen-palettes.mjs), so the fan-out lives in JS and Java and needs a parity test.
- ⚠ A roof needs stairs and a slab (kit.mjs:368). Slots name roles, so a referenced role can't be removed. The test house rejects a light that gives no light (bible.mjs:158-166).

## 2. What the generator receives
`DesignRequest` (sidecar/src/protocol.ts:74-84, 288-289): type, size, features, `profile` (open types only: DesignSpec.java:268), `style` text (required) and the Style.
- ⚠ `bible` turns on set mode: required components and "follow it over your own taste" (sidecar/src/claude/brief.ts:278-289), plus restraint (sidecar.ts:960). Built-ins get **rustic's** components (sidecar/src/bibles.ts:128-133), so designs would look alike.
- **Proposed:** a materials-only `DesignRequest.palette`, with `PaletteSpec` widened to `{bible:{id,version,roles}}` (the kit accepts it: kit.mjs:436-437; brief.ts:329). Custom mixes go inline. `bible` stays for Claude-made Styles and sets.

## 3. Variants
- WHAT is fixed (it's in the `.mjs`); only `params` change shape (`width`/`depth` in mod/run/architect/library/gen_gate_two_house_birch). A Style swap re-skins materials only; the design keeps its components (protocol.ts:1038). Imports: Style disabled.
- Today a preset or field edit drops the bible (VariantForm.java:242, 251). **Fix:** `palette:{bible:{…roles}}` (`makeVariant` takes a `JsonElement`: api/Library.java:32).
- ⚠ `PaletteSpec`'s `z.object` isn't strict (protocol.ts:365): an older helper drops `bible` and quietly builds the default palette. Gate on a new `FEATURES` entry (protocol.ts:20).

## 4. What is stored where
- **Kit:** `PALETTE_PRESETS` (kit.mjs:410) plus a metadata table; kit/test/fixtures/vocab/palettes-v0370.json stays equal.
- **User and Claude Styles:** `<gameDir>/architect/bibles/<id>/versions/<v>/` (api/Bible.java:11); every edit is a new version. Hand-made ones need a **new free op `bible.save`**: today every bible is a Claude job and `revise` refuses built-ins (api/Bibles.java:24-33).
- **Designs:** the entry's `palette` plus its `bible` pin (LibraryCard.java:45-54). **Favourites:** client `style-meta.json`.

## 5. Migration
Nothing is rewritten. Presets keep their ids; drop the stale 6-preset `Palettes.FALLBACK` (Palettes.java:96-105). Bibles read as tagless Styles. Entries show `presetMatching` (Palettes.java:197), "custom mix · based on X", or their pin. Chips rustic and desert map to presets; ⚠ the other six have no materials (DesignSpec.java:41-49).

## 6. Steward
**Sections touched (docs/CONTRACT.md):** "Style bible (A1)" :892, "4b review folded in" items 5-7 :997, "Variants without Claude" :301, "Protocol" DesignRequest :140; read-only: frozen H fluid slots :13434, VOC role fitness :14454.

**plan/0: no schema change.** Every `style` is a `bibleRef` (kit/schemas/plan.json:70, 219-235; CONTRACT:11221). `rules[].palette` (VOC-c :16805, kit/lib/plan/palette.mjs) is a separate idea; its `swapChain` only reads roles (:277). Steward pins `BibleRef(id, version, styleVersion)` (steward-mc/…/model/Settlement.java:347) and always asks Claude for a fresh bible with `seedPreset` null (SettlementRunner.java:1436; Pipeline.java:284, 341). Its 11 style templates map to nothing here; site and purpose stay Steward's (steward-mc/prompts/concept-card.md:13-19). Macro roles default (kit/lib/region/program.mjs:64-67), so building Styles work for settlements.

**Steward would need to agree to:**
1. the additive `Bible` fields and `Bibles.save`;
2. Styles it owns being Duplicate-only in Architect's UI;
3. edits always making a new version;
4. optionally, mapping its templates to built-ins through `seedPreset`, or "use an existing Style" (free, no bible job).

## 7. Open questions for Noah
1. Should built-in and hand-made Styles be **materials-only** (my recommendation) or full bible mode?
2. Should a custom mix on a new design be sent inline (my recommendation) or auto-saved as a draft Style?
3. Should the six chips with no materials become authored built-ins, or stay free text?
4. Should the four rows stay **Wood / Stone / Roof / Accent** with "drives…" shown (my recommendation), or become Wall / Roof / Frame / Foundation?

## 8. Slices
These slices **reshape UI-2a** (docs/PLAN.md:1160); don't build it first and then rebuild it.
- **U0 kit (S):** built-in metadata, `editMain` and provenance, a golden test that the presets are unchanged, and the shared family table.
- **U1 wire (M):** `DesignRequest.palette`, the wider `PaletteSpec`, `bible.save`, the Bible fields, a `FEATURES` flag, contract text, and Steward's review.
- **U2 model (M):** `StyleForm` (New and Variant modes) replaces VariantForm's palette half, with a Java parity test.
- **U3 UI (L):** the editor, the Style browser (New, Duplicate, Edit, favourite) and the Style editor, built on lab-ui (UI-1).
- **U4 gate (S):** the same 6 requests in materials-only and bible mode, judged by `design-critic`. This settles question 1.
