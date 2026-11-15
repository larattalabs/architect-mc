# Handoff: slice UI-2b (Architect UI on lab-ui 0.2.0)

Branch `slice/UI2b` off origin/main 42956aa5. DEV MODE: unit tests, the instant lints and the slice's own in-game check. The
scope is in docs/PLAN.md "UI track" (UI-2b). It leaves out UI-2a (the design form, the palette and style pickers, VariantForm)
and rebindable placement keys.

**Merge order.** Steward pins `lab_ui >=0.1.0 <0.2.0` (`../steward-mc/mod/src/main/resources/fabric.mod.json`, gradle
`lab_ui_version=0.1.0`). Architect now needs `>=0.2.0 <0.3.0`, so the two mods can't load together until Steward's UI-3 moves
to 0.2.0. Release this with UI-3, or after it.

## What changed

**lab-ui 0.2.0**
- `lab_ui_version=0.2.0`, and fabric.mod.json declares `"lab_ui": ">=0.2.0 <0.3.0"`.
- Architect's copies of `TextModel`, `TextFieldView`, `TextKeys`, `UiRules`, `ToastStack` and `Toasts` are gone, along with
  their tests (lab-ui has them). Every import now points to `dev.larattalabs.labui.*`.
- `ArchitectClient` calls `Toasts.install()` once and `Toasts.avoid(BuildPlacement::hudRect)`. It no longer registers its own
  HUD element.
- `OwnedConfirm` is deleted:
  - Library > Placed > Remove on a site another mod owns now uses lab-ui `ConfirmArm`. The button reads "Press again to
    remove (N)", and a click anywhere else disarms it. Your own sites still remove with one press.
  - CrateScreen's Deconstruct is lab-ui `Confirm`. Clicks reach the Confirm first. Esc disarms it. An owned site asks a
    second time on the same arm, as before.
  - The crate footer keeps the Confirm at the width of its armed label, so arming never shifts the row. The Insert button
    shortens to "Insert" when "Insert from inventory" doesn't fit.
  - `dev.crate.press deconstruct` twice still deconstructs, which gate3 relies on.

**1. Paged chat lists** (`site/ChatLists`, lab-ui `ChatPager`, 8 a page, `[‹ prev]` / `[next ›]` / `[filter…]`)
- These commands take a trailing `[page] [filter]`, parsed as one greedy argument. A leading number is the page, so
  `/architect list cabin` and `/architect list 2 cabin` both work:
  - `/architect list`
  - `/architect reload problems`
  - `/architect batches`
  - `/architect groups`
  - `/architect stockpile list`
  - `/architect build list`
  - `/architect site history <site>`
- `/architect list`:
  - One line per design and per site.
  - A site's check or note is hover text, marked "· check" / "· note".
  - Clicking a design puts `/architect place <id>` in the chat box.
- `/architect groups`: one line per group, with its stages and sites in the hover. `stockpile list` puts the stock in the
  hover.
- `/architect reload` prints "Reloaded N designs" and, when designs were skipped, a `[show]` link to
  `/architect reload problems` (which doesn't reload again).
- "Unknown design" now reads "Unknown design 'cabn'. Did you mean cabin? See /architect list." It names at most 5 close
  matches, each clickable (`site/DidYouMean`: lab-ui `TextMatch`, then edit distance for typos). Both `SiteCommands.place`
  and `BuildPlacement.start` use it.
- The return values and the "No … in this world" lines are unchanged.

**2. Placed links**
- After a placement, the chat gets the line with `[Undo]` (`/architect remove <site>`) and `[Open in Library]`. The second
  link runs a new `/architect library [site]` command, which opens Library > Placed here with the site selected
  (singleplayer, through `SiteCommands.libraryOpener`).
- A construction site gets the same links. A move gets only `[Open in Library]`.
- The toast reads "Log Cabin (s7). Undo: [Undo] in chat".

**3. Placement HUD** (`PlacementHud`, rewritten)
- **State chips, always shown:**
  - rotation, entrance, and locked / follows your look;
  - `! force armed: Shift+Enter` and `▲ place on top: Enter` when armed.
- **Keys:**
  - The collapsed hint row is "? keys", plus Shift+Enter force when armed, Enter, and Esc.
  - "?" (Shift+/, so plain / still opens chat) or H shows the whole legend and the refusals' detail. The setting is kept for
    the session; `dev.build.legend`.
- **Refusals:** grouped as "Would be refused: N issues", with a "• issue" list on "?" (`placement/VerdictSummary`). One
  issue is named inline.
- **No colour words:** "(orange)", "(red)" and the rest are gone, including the "(blue)" / "(magenta)" notes. Each count
  and note now has a 7 px swatch of its ghost colour next to its words. Notes carry their ink as `View.noteInk`.
- **One progress strip** (`hud/ProgressStrip`, a sweeping bar) for "Placing… / Moving…" and "Checking the site with the
  server…", and for the helper's install and first start.
- **Colours** are lab-ui tokens through `hud/HudInk`. The RED / ORANGE / WATER_INK literals are gone from PlacementHud,
  PlotHud and SiteHud.
- **Short screens:** at GUI scale 4 on 1080p, the lowest-priority rows drop until the panel fits above the hotbar without
  covering the crosshair (`placement/HudFit`). The status line repeating the refusal goes first, then notes, the path and
  extra key rows.
- While placing, a refusal's status line is one line.

**4. Launcher**
- `Launcher.set(state, summary, detail)`:
  - `summary` is the plain sentence for the player. The toasts and the Status tab headline use it.
  - `detail` is unchanged (the API's `ApiClientBridge`, `dev.launcher.state`, the log) and shows as "Details: …" small
    print in the Status tab.
  - The NO_BUNDLE env-var text is small print only.
- `launcher/LaunchNotices`:
  - "Architect is ready" toasts once per session.
  - A RUNNING after a drop under 10 s is a blip, logged at debug.
  - The same failure doesn't toast twice within 60 s.
  - A RUNNING after a crash and restart stays silent, as asked.
- The install shows a strip at the top left (`launcher/HelperProgressHud`) and in the Status tab. It shows "Installing the
  design helper (about 200 MB, first run only)…", the elapsed m:ss, a sweeping bar and npm's last output line.
- `npm ci` prints no percentage when it isn't writing to a terminal, so "progress from the npm log" means the latest line
  plus the elapsed time. There is no fraction.

**6. SiteHud**
- Full (the line and its bar), one line ("Log Cabin 62%") or hidden.
- Set with a new rebindable key, `key.architect_mc.site_hud` (default J), or the Status tab's "Construction HUD: …" link.
- Stored in `config/architect_mc_ui.json` as `siteHud` (`UiPrefs`).
- It shows one line at most while the placement HUD is up.

**7. Terms**
- Recorded in docs/PLAN.md "UI track": design, site, construction site, build (only `/architect build`), crate, stockpile,
  design helper.
- Applied to the strings this slice touched.

## Evidence

- **mod unit tests:** `./gradlew build --offline` gives 885 tests, 0 failures, 1 skipped, at d32a8182. Since then only the
  dev hook, the driver and docs have changed. The slice's new tests:
  - DidYouMeanTest 6
  - ChatListsTest 3
  - VerdictSummaryTest 4
  - LaunchNoticesTest 4
  - HudFitTest 3
  - ProgressStripTest 2
- **Instant lints, run mid-slice (this slice changes nothing they read: no kit, lint or ledger code):**
  - lint-structure 59 cases, 0 failing
  - lint-look 13 cases, 0 failing
  - water-lint 123 pass, 0 fail
  - p3-lint (LedgerLintTest 14, RegionFluidsLintTest 2), 0 failures
- **`node tools/step-inputs.mjs check`:** 230 steps OK. A new step, `ui2b-ingame` (chain `ui2b`), has an impact rule and a
  step-inputs entry.
- **In game:** `tools/gateui2b.mjs ingame` passes 31/31 at 8a31d7df. It uses its own client, run worktree
  `../architect-mc-UI2b-run`, ports 8896/8897 and the sim sidecar, at $0. The checks cover:
  - every changed command's components and links;
  - `[next ›]`, `[Open in Library]` and `[Undo]` clicked through vanilla's own chat click handler (`dev.ui2b.click`, from the
    chat screen): each ran with no confirm screen, the Library opened on Placed with the site selected, and Undo removed it;
  - the HUD states;
  - the SiteHud modes;
  - the crate Confirm, including Esc;
  - the launcher summary and its one ready toast.
- **Shots** at GUI scale 2 and 4: `/private/tmp/claude-501/-Users-noahlaratta/caacffbe-2fca-4024-9f8a-06a0f4535ae3/scratchpad/ui2b-shots/`.
  There are 24 PNGs: hud_ready, hud_checking, hud_legend, hud_force, hud_ontop_legend, placed_toast_chat, placed_chat_open,
  library_placed, sitehud_full / line / hidden, crate_confirm, helper_strip, status_tab.
- **Run outside gate-run:** the driver ran directly, not through `gate-run change --only ui2b-ingame`, to stay off the slot
  queue (D3's turbo run was holding it). `gate-run slice --since origin/main --plan` lists
  `ui2b-ingame` (client 6b, host client) as defined.

## For the verifier

There are no changes to undo, the journal, crash recovery, survival accounting or `Sites.remove`. Three UI paths into removal
did change, for review:
- `[Undo]` runs the existing `/architect remove <site>`.
- Library Remove's owned-site second press is now `ConfirmArm`, with a 5 s window instead of OwnedConfirm's 10 s.
- CrateScreen Deconstruct is now `Confirm`, with a 5 s window. It had no timeout before.

## For UI-2a and the unified editor

- **ArchitectScreen hunks from this slice**, kept small:
  - `mouseClicked` disarms `OWNED_REMOVE` first;
  - the static `OWNED_REMOVE`, `ownedLabel`, `ownedRemoveOk` and `openPlaced`;
  - the Placed tab's Remove button (label and width);
  - the Status tab's helper block (summary, strip, small print) and its Construction HUD link.

  The lab-ui import swap also touched these files, imports only: LibraryTab, DesignForm, SetDialog, RedirectScreen,
  SetFeature, MassingReview, DesignFeature, LibraryFeature, SurvivalFeature and Launcher. Beyond that, nothing in the
  design form, pickers, LibraryTab or VariantForm changed.
- **Where lab-ui 0.2.0 came from.** It resolved through the sibling `../lab-ui` checkout (clean, at tag `v0.2.0`), not the
  Gradle cache. Main's `.gradle-home` holds only 0.1.0. Offline builds in other worktrees and the frozen snapshots work only
  while `../lab-ui` stays clean at that tag. Resolve the package online once into main's `.gradle-home`
  (`GITHUB_TOKEN=$(gh auth token)`, with `../lab-ui` moved off the tag or `LAB_UI_DIR` unset).
- **lab-ui 0.2.0's `semantic.*` tokens are for text on paper** and are about 2:1 on the ink HUD panels. `HudInk` maps the
  HUDs onto `monitor_dark.*` / `status.*` / `ink_ui.*` instead. Semantic on-ink tokens would be a good lab-ui 0.3
  follow-up; then HudInk becomes a thin alias.
- **One colour word is left, out of scope:** "(yellow)" in the Library versions panel (ArchitectScreen, the delta preview
  info, about line 1472).
- **Pager adoption:** `ChatLists.send(src, lines, ChatLists.args(ctx), "/architect <cmd>")` plus a greedy
  `ChatLists.ARG` argument is all a new list command needs.
- **Placed line for the API preview flow:** the `BuildPlacement.placedChat` pattern (RunCommand links) is reusable if the
  API's preview flow wants the same line.
