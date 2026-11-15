# U3 (Style unification: the unified editor, the Style browser and editor, the Library screen): handoff

Branch `slice/U3`, off `origin/slice/U2` (48536442), with `origin/main` (v0.44.0, 39ebf034) merged in. The binding text is
docs/CONTRACT.md "Style unification U3 … (as built)" (end of the file). No API change: no Steward RC needed (DEV MODE). Not merged to
main. Versions untouched (no NEXT stamps were needed: no API members were added).

## What changed

- **The unified design editor** (`client/screen/DesignEditor.java`): the Design tab is its NEW mode and the Library's Variants dialog
  its VARIANT mode, both bound to `StyleForm.view()`. It replaces `ArchitectScreen.drawDesign`'s form, U2's `drawStyleRows` and
  `LibraryTab.drawVariants`. Sections What / Style / Materials / Features / Rules / Parameters (lab-ui `CollapsibleSection`), a scrolling
  body with a draggable bar, a pinned footer (Generate or Make variant, Save draft). Materials rows are lab-ui `CompactPicker`s with
  a full-screen `PickerScreen` of swatches by family; More roles (folded) uses `setRole`; the custom-mix bar has Revert and Save as
  style… with a name field. VARIANT locks What / Features / Rules (a lock bar with Remix…).
- **Words alongside a Style** (`design/StyleNote`): sent first in the notes as `Style: <words>`; the style and palette stay the Style.
  "Own words" (or typing in the style field) is U2's free text: no Style, no palette.
- **The Style browser** (`StyleBrowserScreen`, a subclass of lab-ui's `PickerScreen` in CARDS mode) over `library/StyleCatalog`; cards
  and the detail pane draw `library/StyleSheet` from the roles; Duplicate / Edit / Favourite; "+ New style ▾" and "Tags ▾" use lab-ui's
  Compare and Tags hooks. **The Style editor** (`StyleEditorScreen`, model `library/StyleDraft`) and **Describe a style**
  (`DescribeStyleScreen`), on a small shared frame (`U3Screen`).
- **Sidecar `bible.check`** (feature appended last): the test-house check without saving; `bible.save` shares its code.
- **The Library**: shorter cards, Place / Edit / ⋯ (Delete in ⋯ behind a lab-ui `Confirm`), a jobs strip (`JobStrip`, with Approve /
  Redirect… / Put aside for a massing on review), empty states with actions (Library, Placed here, Designs tab), Import search.
- **Pop-ups** in the Architect screen are one searchable lab-ui `ScrollList` (Type, Tag, Collection, profile, sort, re-skin, the type
  list). lab-ui controls are registered in the screen's hit list (`ArchitectScreen.control`), so dev.ui.state / dev.ui.click see them; a
  control in a closed section or the closed ⋯ menu stays clickable for the DevBridge (zero size).
- **Look data**: `tools/gen-palettes.mjs` adds `colors` (block → the side face's average colour, kit/lib/colors.mjs) to
  `palettes-fallback.json`; `library/Swatches` reads it (families, a main row's block). The kit's freshness test covers it.
- **Save draft** (`client/design/Drafts`): `<gameDir>/architect/drafts/design.json` and `variant-<entry>.json`; the editor offers
  Restore / Discard, never restores by itself; a sent design drops its draft.
- **DevBridge** `dev.u3.*` (docs/DEVBRIDGE.md "The Style screens"), `dev.design.fill {styleNote, ownWords}`, `dev.u3.park` (shots draw
  as if the mouse were away).
- **Gate** `u3-ingame` (`tools/gateu3.mjs ingame`; client, sim, $0) and its impact entry; the nightly gallery (`tools/gateui2b.mjs
  gallery`) has the U3 states (design sections, style note, own words, custom mix, more roles, save as style, type pop-up, the wood /
  roof / role pickers, the Style browser's grid / detail / menus / describe, the Style editor's duplicate and failing check, the
  Library's ⋯ menu and empty search). `tools/step-inputs.json` rebuilt.

## Decisions taken (worth a look)

- **The style note travels in `notes`**, not a new wire field: `style` is capped at 40 characters and is what an entry's provenance
  shows, and a new field would need a FEATURES flag and an older helper would drop it silently. A remix reads the note back.
- **Favourites live in lab-ui's PickerStore** (`config/lab_ui/pickers.json`, id `architect_mc.styles`), the browser's ★ Favourites
  chip, not a rail group (each card has one rail) and not STYLE-UNIFY's `style-meta.json`.
- **A single click on a Style card selects it; double click, Enter or Use this style uses it.** lab-ui's grid picks on a click, so
  the browser keeps the recents and the current choice as they were after a select-click. Material and role pickers pick on a click.
- **"+ New style" sits on lab-ui's Compare chip and "Tags ▾" on its Tags chip** (lab-ui 0.2's hooks); Duplicate / Edit are drawn in
  the detail pane above Use this style (on a line boundary of the pane's lines; stacked in a narrow pane). At GUI scale 4 that leaves
  no room for the detail lines (origin, tags, suggests, used by): they show at scale 2 and below.
- **Edit in the Library opens the VARIANT editor** (re-skin, materials, parameters); an import (no source) gets Remix….
- **Shape hints are shown, not edited** in the Style editor (they and the slots ride along unchanged from `bible.json`); the mock's
  pitch / storey steppers are left for later.
- **Save draft** as above (the smallest meaning that outlives a session; no auto-restore).
- **The title row** of the editor shows only when there is a remix or an open Variants dialog to switch to (New | Variant of "X").

## Notes for later

- lab-ui wish list (would remove hacks here): PickerScreen extension points for detail-pane actions and a title-bar menu; a
  select-without-pick click mode; CompactPicker with a custom "more" action (the Style row is hand-made because "more" must open the
  Style browser); a parked-mouse hook for shots of plain PickerScreens.
- The material pickers' detail preview is lab-ui's 40 px slot; "Preview on ghost" is queued after U3 (PLAN).
- U4 note from U2 still holds: the kit's example designs build walls from the wood set, so a wall-defined Style only partly re-skins.
- `.gradle-home` here still has lab_ui 0.1.0 only; builds resolve 0.2.0 through the clean `../lab-ui` checkout at `v0.2.0`.

## Evidence (DEV MODE)

See the run below; the shots of the step are in the coordinator's scratchpad `u3-shots/` (GUI scale 2 and 4).

Run `artifacts/gate-runs-U3/20261024-083800-change/` (main checkout), `gate-run change --only unit-mod,unit-kit,unit-sidecar,lint-structure,
lint-look,water-lint,p3-lint,u3-ingame` at 064c3c60 (the code; only docs came after), ports 8898/8899, its own run dir
(`../architect-mc-U3-run`) and lock: **PASS 8/8** in 19m56s.
- **u3-ingame: PASS, 39/39** (client, sim, $0): every flow above, 26 states shot at GUI scale 2 and 4 (52 PNGs).
- **unit-mod** PASS (918 tests, 0 failures: `StyleLookTest`, `StyleDraftTest`, `StyleNoteTest` new; `StyleFormTest` unchanged).
- **unit-kit** PASS (897/897; the fallback-palettes freshness test covers the new `colors`).
- **unit-sidecar** PASS (771; `styles-u3.test.ts` new: bible.check passes a sound Style, refuses a dark light and a glass roof, saves
  nothing).
- **Lints:** lint-structure (177), lint-look (14), water-lint (126), p3-lint (16): all PASS.
- The nightly gallery's U3 states were shot once with `GATEUIG_ONLY` (44 shots, 0 failed).
