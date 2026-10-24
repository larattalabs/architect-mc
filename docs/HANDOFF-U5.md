# U5 (Style unification: the hybrid default U5a, parts for any Style U5b, medieval's wall): handoff

Branch `slice/U5`, off `origin/main` (72e8939f, U3 merged; U4's `chore/u4-ab` is not on main). The binding text is docs/CONTRACT.md
"Style unification U5 … (as built)" (end of the file). API: additive, stamped `NEXT` (`Bible.parts`/`hasParts`, `Bibles.addParts`/
`estimateParts`, sidecar feature `bible.parts`). Not merged to main. Versions untouched.

## What changed

- **One rule for a Style's own parts** (`sidecar/src/bibles.ts` `partsOf`, `apiimpl/Wire4b.partsOf`): stored `parts`; else a built-in's
  kit library (rustic only); else a pre-U5 bible job's components; else none (hand-made). `BibleInfo.parts` and the shape hints on the
  wire. No Style ever gets another Style's components: the rustic fallback is gone from `resolve()`, and `bible.save` no longer copies
  the reference library. A hand save of a Style with parts carries them forward.
- **U5a, the hybrid default** (`claude/brief.ts` `hintsOf` / `styleHintLines`, `sidecar.ts` `paletteHints` / `setMode`):
  - a materials-only request's brief gets "The Style's look: <name> (guidance)", each hint written as "lean toward …";
  - a `bible` request naming a Style without parts gets its roles plus the same guidance: no components, no "follow it", no
    `--restraint`;
  - set mode is unchanged (byte-equal section) for a Style with parts.
- **U5b, `bible.parts`** ("Add parts…", `Bibles.parts` / `seedFromStyle`):
  - a bible job seeded from the Style (no drafting pass), writing the next version of the same Style;
  - a built-in's parts go on a hand-made copy `bib_<name>_parts` based on it (CONTRACT §3 says why);
  - `bible.estimate {parts: true}` gives the estimate first (an upper bound);
  - bible.save's ownership rule applies.
- **Medieval's wall** `white_concrete` (was white_terracotta, salmon); the fallback palettes and the parity fixture regenerated.
- **"Use this style's parts"** in `StyleForm` (kit twin `formApply ['parts']`, parity sequences):
  - offered only for a Style with parts; on by default for a Claude-made one, off for every other;
  - on = `{bible, bibleVersion}`; a custom mix sends the palette.
  - `DesignForm.bible` is now derived (`bible()`, `bibleVersion()`, `setUseParts`). Every Style is picked; origin no longer decides set
    mode.
  - Drafts keep the toggle; a set-mode remix picks the Style with its parts on.
- **UI:**
  - the Design editor's Style section: a "Use this style's parts" chip with a note and the parts' provenance;
  - the Style browser: "Parts: N" / "No parts · Add parts… (+ New style)", and a "+ New style" menu item "Add parts to <Style>…";
  - the Style editor: a Parts row with Add parts… / Redraft parts…;
  - the new `AddPartsScreen` (the estimate first).
- **Gate tooling:** `tools/gateu5.mjs` (step `u5-ingame`, client, sim, $0), the impact entry, step inputs. `dev.style.parts` (the Java
  API's addParts / estimateParts) and `parts` in `dev.style.get`. `gateu1` and `gateu2` expect medieval's new wall.

## Decisions to confirm (coordinator / Noah)

- **Built-in parts storage: a hand-made copy, not a built-in version.** The plan for the 15: run Add parts on each built-in in a dev game
  dir (paid), review the sheets, then copy each `components.mjs` into `kit/bibles/<id>/` (where rustic's lives) plus a kit test.
  Nothing else to migrate. A small promotion tool is the natural first item of that slice.
- **Estimate per Style:** **$1.16-1.55 and 5-8 min** (the seed bible-job basis; no bible job has been measured on this machine). It is an
  upper bound: the parts job skips the drafting pass. At most about $17-23 for the 15. PLAN said $20-40; confirm the cap with Noah first.
- **Steward RC:** not needed in DEV MODE. Nothing Steward constructs or calls changed shape. Its Claude-made settlement bibles keep set
  mode. CONTRACT §4 has the reasoning and the greps.

## Left / queued

- **Massing gap:** a massing carries no palette, so with Massing first (L and plot) the hints reach only the detail pass. Next slice:
  carry the Style's hints (not its materials) on the massing request too.
- Cozy's plaster (wall_alt) is white_terracotta too, the same salmon. Not in scope.
- Parts jobs are not recorded into the estimate history (they would skew the bible average). Give them their own kind once a few run.
- A hand edit that carries parts forward doesn't re-run the component check with the new roles (the sheet is not copied either). A
  role edit that breaks a part shows only when a design uses it.
- The U4 A/B (hints vs a parts bible) is PLAN item 3, after the built-ins have parts.

## Evidence (DEV MODE)

All $0 (sim). Ports 8900/8901, run dir `../architect-mc-U5-run` (frozen source `-src`), lock and runs in the main checkout's
`artifacts/gate-runs-U5/`.
- **Run 1, `20261024-185112-change`** at 84475b7c (the code; only docs and the blurb label came after): `gate-run change --only
  unit-mod,unit-kit,unit-sidecar,lint-structure,lint-look,water-lint,p3-lint,u1-ingame,u2-ingame,u3-ingame,u5-ingame`. **PASS 11/11**
  in 14m45s.
  - **u5-ingame 31/31.**
  - u1-ingame 29/29 and u2-ingame 33/33, both with medieval's new wall.
  - u3-ingame 39/39: the editor rework holds.
  - unit-mod 923 tests, 0 failures. unit-kit 898/898. unit-sidecar 783.
  - lint-structure 177, lint-look 14, water-lint 126, p3-lint 16.
- **Run 2, `20261024-190638-change`** at 4acb427c (the brief's blurb line renamed "in short:"): `--only unit-sidecar,u5-ingame`. **PASS
  2/2** (783; 31/31).
- **Shots** (`gate6b/shots/` of each run): editor_hybrid, browser_no_parts, browser_menu_parts, add_parts (the estimate "about
  $1.16-1.55, 5-8 min (at most)"), browser_parts ("Parts: 5"), style_editor_no_parts, editor_parts_off, editor_parts_on (the chip, the
  note and the provenance line).
- **api-compat** (by hand, the merged main and client classes at 8fbae53a): the 0.44.0 mod jar's api surface (2600 members) and the
  0.44.0 apitest jar (932 references) resolve. **step-inputs check**: 255 steps OK.
- The gate's hybrid brief lines (u5-ingame.json `hybridBrief`): "## The Style's look: Medieval (guidance)", "- in short: Dark oak timber
  framing with pale daub walls and steep spruce roofs.", "- roofs: lean toward steep gables, jettied upper floors.", "- proportions:
  lean toward a roof pitch of about 1.5 (1 is 45 degrees; steeper than the default)."
- The test frame in the copy's roles: dark_oak_planks, **white_concrete**, spruce_stairs, spruce_planks, dark_oak_log, dark_oak_door,
  lantern. No white_terracotta.
