# U2 (Style unification: the StyleForm model): handoff

Branch `slice/U2`, off `origin/slice/U01` (merged up to its RC fix b49c449f: `Bible.modOwned()` / `isModOwner()`). The binding text is
docs/CONTRACT.md "Style unification U2" (end of the file). No API change: no Steward RC needed (DEV MODE). Not merged to main.

## What changed

- **`StyleForm`** (`mod/src/main/java/dev/larattalabs/architect/library/StyleForm.java`, pure) and its JS twin in `kit/lib/styles.mjs`
  (`formNew`, `formApply`, `formView`, `formRequest`, `formSaveRequest`, `presetStyle`, `formStyle`). NEW and VARIANT modes; picked
  Style, roles, the four main rows and per-role provenance STORED; custom mix with revert; the feature swap rules; the request and
  the Save-as-style request.
- **`editMainFrom`** (kit and `StyleRoles`): editMain's core with the old row value and the following roles given. `editMain` now
  delegates to it (U1's parity cases unchanged, byte for byte).
- **Parity:** `tools/gen-palettes.mjs --parity` writes `formStyles` and `forms` (24 sequences, 182 ops, 11 refusals) into
  `kit/test/fixtures/style-parity.json`; `StyleFormTest` replays them.
- **`VariantForm`**: the palette half is a VARIANT `StyleForm`; public methods kept as delegates, plus `chooseStyle`, `summary`.
- **Design tab** (`DesignForm`, `DesignFeature`, `ArchitectScreen`, `ScreenFeature`): chips pick built-in Styles, text = no Style, the
  Style bible list routes Claude-made to set mode and the rest to materials only; a Wood/Stone/Roof/Accent dropdown row; "custom mix ·
  based on X" with Revert and Save as style…; ✦ on suggested features; the palette sent (helpers with `palette.roles`); the palette
  kept off a massing and added to its detail pass (`MassingReview`); a remix of a materials-only entry picks its Style.
- **Fixed on the way (a U1 bug):** the Variants footer (`LibraryTab.summary`) read every palette value as a string and threw on
  `{bible: {...}}`; it is `VariantForm.summary` now, with a test.
- **`sidecar/src/claude/contract.ts`** lists the 16 built-in Styles; `variants.test.ts` holds it equal to the kit's presets.
- **DevBridge:** `dev.design.fill {styleOps}`, `dev.design.saveStyle {name?}`, `styleForm` in the Design state, `style` in the
  Variants state (docs/DEVBRIDGE.md).
- **Gate step** `u2-ingame` (`tools/gateu2.mjs ingame`; client host, sim, $0) and its impact entry; `tools/step-inputs.json` rebuilt.

## Decisions taken (worth a look)

- **Free text = no Style.** The existing widgets keep their meaning: typing words unhighlights the chip and sends words only (no
  palette); a chip picks the Style again (features kept). The mock's "words alongside a Style" is for U3.
- **Unticked features stay off** through Style swaps ("the player touched it"). Construction and reset never add suggestions, so
  the default form is still rustic + `[porch]`; picking a chip that is already the Style changes no features.
- **Hand-made Styles in the Design tab are materials only; Claude-made stay set mode** (the Style bible list routes by `origin`).
- **Variant requests stay the smallest that builds it** (contract U1 §3): preset name, inputs, `bible: id`, else roles inline. A preset
  with extras edited now goes inline (U1 sent inputs and lost desert's plaster). VariantFormTest's U1 cases hold unchanged.
- **Save as style… always makes a new Style** (`bible.save` without `bibleId`, basedOn the picked Style), so ownership never blocks
  it; `Style.editable` / `modOwned` (from `Bible.editable()` / `modOwned()`) are carried for U3's Edit-vs-Duplicate. Name default
  "<Style> mix" (or "copy"); U3 adds a name field.
- **An older helper** (no `palette.roles`): an unedited Style is sent as its words only (the pre-U2 behaviour, so stub-sidecar
  gates are unaffected); a custom mix is a form error.

## Notes for U3

- Bind the editor to `StyleForm.view()` (it already carries main + mainProvenance for the "custom" / "from X" / "follows Wood"
  markers, featureProvenance for ✦, `mix`, `request`, `save`). `setRole` exists for "More roles"; nothing in U2's UI calls it.
- The Design tab's row of four dropdowns and the Revert / Save buttons sit in `ArchitectScreen.drawStyleRows`; replace, don't extend.
- The Variants dialog still shows preset chips + bible chips + the four "Advanced" dropdowns (reading `inputs()` = the stored rows).
- `StyleForm.Style.of(Bible)` falls back to the kit metadata for a built-in from an older helper.
- `dev.design.fill {styleOps}` drives every StyleForm op for screenshots.

## Note for U4 (recorded, not fixed)

The kit's example designs and the sim's copies of them build walls from the wood set (`p.planks`), not the `wall` role, so a
wall-defined Style (medieval's white_terracotta, japanese's, modern's concrete) only partly re-skins them: frame, floor, roof, trim
and foundation change, the walls don't. u2-ingame therefore judges the frame/foundation materials, as gateu1 does. U4's A/B (and
U3's previews) should expect it.

## Evidence (DEV MODE)

Run `artifacts/gate-runs-U2/20261024-064303-change/` (main checkout), `gate-run change --only` at 8b5d4f9a, ports 8904/8905, its own
run dir (`../architect-mc-U2-run`) and lock; the machine at load ~30 throughout.
- **u2-ingame: PASS, 27/27** (client, sim, $0; `gate6b/u2-ingame.json`): designs d85 (medieval) and the birch mix done and built of
  their materials; `bib_u2_birch_daub` v1 saved (hand, basedOn medieval v1); variant `gen_u2_daub_cabin_u2_birch_daub` built of it.
- **unit-mod** PASS (908 tests, 0 failures: `StyleFormTest` replays all 24 form sequences, `StyleRolesTest`, `VariantFormTest`).
- **unit-kit** PASS (870/870; `styles.test.mjs` with the form tests and the fixture-freshness check).
- **Lints:** lint-structure (155), lint-look (14), water-lint (123), p3-lint (16): all PASS.
- **unit-sidecar:** 768/769; the one failure is `eval.e2e.test.ts` "compare of two runs says no regression", which compares two sim
  runs' wall times ("regressed (mean time +45.24%)" at load ~30). Unrelated to U2 (no eval code touched); re-run alone it passes 4/4.
  `variants.test.ts` (the 16 Styles in contract.ts) passes.
- `node tools/step-inputs.mjs check`: 239 steps, every closure inside its set.
