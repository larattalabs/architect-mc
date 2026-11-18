package dev.larattalabs.architect.client.help;

import dev.larattalabs.architect.client.design.UiPrefs;
import dev.larattalabs.architect.client.hud.Keys;
import dev.larattalabs.labui.client.help.KeysOverlay;
import dev.larattalabs.labui.client.help.WhatsThis;
import dev.larattalabs.labui.ui.HelpKeys.Row;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * (PR W1) Architect's first-run help: each screen's and HUD's "what's this" line (lab-ui {@link WhatsThis}, hidden by key in
 * {@code architect_mc_ui.json}) and its "?" overlay (lab-ui {@link KeysOverlay}: its keys, read live from the bindings, and the
 * glossary terms it uses). The texts are pure ({@link #TIPS}, {@link #TERMS}); {@code ArchitectHelpTest} holds them to one line
 * and the glossary.
 */
public final class ArchitectHelp {
	/** Screen and HUD ids: the 4 tabs, 6 screens and 3 HUDs. */
	public static final Map<String, String> TIPS = new LinkedHashMap<>();
	public static final Map<String, List<String>> TERMS = new HashMap<>();
	private static final Map<String, WhatsThis> TIP_CACHE = new HashMap<>();
	private static final Map<String, KeysOverlay> OVERLAYS = new HashMap<>();

	static {
		tip("design", "Describe a building and the design helper designs it for you.", "design", "design helper", "set", "Style");
		tip("library", "Your designs. Pick one to place it here, or make a variant.", "design", "variant", "collection", "site");
		tip("designs", "Designs being made right now, and what each one costs.", "design", "design helper", "variant");
		tip("status", "The design helper, Claude access and your settings. Help and terms are here.", "design helper");
		tip("styles", "A Style is a set of materials and shape hints a design wears.", "Style", "parts", "variant");
		tip("style_editor", "Choose the block for each part of a Style: walls, roof, trim and more.", "Style", "parts");
		tip("add_parts", "Parts are pieces a Style can add to a design, such as a porch or a tower.", "parts", "Style");
		tip("describe_style", "Say what a Style looks like and the design helper drafts it.", "Style", "design helper");
		tip("crate", "This construction site builds from what you put in its crate.", "construction site", "crate", "stockpile");
		tip("redirect", "Tell the design helper what to change before it adds the details.", "design", "design helper");
		tip("hud.placement", "The ghost shows where it goes; its outline says if it fits.", "ghost", "site", "build");
		tip("hud.plot", "Mark an area on the ground: look at a corner and press Enter.", "plot", "connector or link");
		tip("hud.site", "A construction site near you: what it builds and what it still needs.", "construction site", "crate", "stockpile");
	}

	private static void tip(String id, String text, String... terms) {
		TIPS.put(id, text);
		TERMS.put(id, List.of(terms));
	}

	private ArchitectHelp() {
	}

	public static String key(String id) {
		return ArchitectGlossary.OWNER + ":" + id;
	}

	/** The "what's this" line of a screen or HUD. */
	public static WhatsThis tip(String id) {
		return TIP_CACHE.computeIfAbsent(id, k -> new WhatsThis(UiPrefs.TIPS, key(k), TIPS.get(k)));
	}

	/** The "?" overlay of a screen (one per id, so it stays open across a re-init). */
	public static KeysOverlay overlay(String id, String title, Supplier<List<Row>> rows) {
		return OVERLAYS.computeIfAbsent(id, k -> new KeysOverlay(title, rows, TERMS.getOrDefault(k, List.of())));
	}

	/** A screen opening starts with its "?" overlay closed (the overlays are kept per screen id). */
	public static void closeOverlays() {
		OVERLAYS.values().forEach(o -> o.open(false));
	}

	/** Status: "Show tips again". */
	public static void showTipsAgain() {
		UiPrefs.TIPS.showAll();
	}

	// ------------------------------------------------------------------ the keys of each screen (labels read live)

	/** The keys every Architect screen shares: Architect (B), Undo last placement (Z), Esc. */
	static List<Row> common(List<Row> own) {
		List<Row> out = new ArrayList<>(own);
		out.add(new Row(Keys.label(Keys.screen), "open or close Architect (in the world)"));
		out.add(new Row(Keys.label(Keys.undoLast) + " ×2", "undo your last placement (in the world)"));
		return out;
	}

	public static List<Row> tabKeys(String tab) {
		List<Row> r = new ArrayList<>();
		r.add(new Row("1-4", "switch tab"));
		switch (tab) {
			case "design" -> {
				r.add(new Row("Tab", "next field"));
				r.add(new Row("Ctrl+Enter", "design it"));
			}
			case "library" -> {
				r.add(new Row("Click", "pick a design; Place puts it in the world"));
				r.add(new Row("Esc", "close a dialog, then the screen"));
				return common(r);
			}
			default -> {
			}
		}
		r.add(new Row("Esc", "close"));
		return common(r);
	}

	public static List<Row> styleKeys() {
		return common(List.of(new Row("Arrows", "move through the Styles"), new Row("Enter", "use this Style"), new Row("Tab", "search, grid, filters"),
			new Row("Esc", "clear the search, then back")));
	}

	public static List<Row> u3Keys(String verb) {
		return common(List.of(new Row("Tab", "next field"), new Row("Ctrl+Enter", verb), new Row("Esc", "back")));
	}

	public static List<Row> crateKeys() {
		return common(List.of(new Row("Click", "Deconstruct asks twice"), new Row("Esc", "close")));
	}

	public static List<Row> redirectKeys() {
		return common(List.of(new Row("Enter", "send the note"), new Row("Shift+Enter", "new line"), new Row("Esc", "back to the review")));
	}
}
