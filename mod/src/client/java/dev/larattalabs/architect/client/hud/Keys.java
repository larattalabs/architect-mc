package dev.larattalabs.architect.client.hud;

import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.Architect;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.input.KeyEvent;

/**
 * Architect's key mappings (Options > Controls > Key Binds > Architect, rebindable like any vanilla key): the Architect
 * screen ({@code B}), the construction HUD's full / one line / hidden ({@code J}, UI-2b) and Undo last placement ({@code Z},
 * SAFETY). Registered once.
 */
public final class Keys {
	public static KeyMapping screen;
	/** UI-2b: the construction HUD full / one line / hidden ({@code J}). */
	public static KeyMapping siteHud;
	/**
	 * SAFETY: "Undo last placement" ({@code Z}): removes the newest site this player placed this session, after a second press
	 * within 5 s. Z is free in vanilla 26.3 (its letter defaults are W A S D E F Q T O P L G C X), in Architect (B, J; R, H, L only
	 * while placing) and in Steward (Y, I, U, and K for the jobs panel; N is Build a link since PR K1).
	 */
	public static KeyMapping undoLast;
	/** (7c CX) Build a link: the plot marker's connector mode (N by default since PR K1, K before: K is the jobs panel; from a site house's drop when one was just placed). */
	public static KeyMapping buildLink;
	private static boolean registered;
	/** (PR A4) The placing, plot and massing keys, by action (Controls > "Architect: while placing"). */
	public static final java.util.EnumMap<PlacingKeys.Action, KeyMapping> placing = new java.util.EnumMap<>(PlacingKeys.Action.class);

	private Keys() {
	}

	public static synchronized void ensureRegistered() {
		if (registered) {
			return;
		}
		registered = true;
		KeyMapping.Category cat;
		try {
			cat = KeyMapping.Category.register(Architect.id("architect"));
		} catch (IllegalArgumentException alreadyThere) {
			cat = new KeyMapping.Category(Architect.id("architect"));
		}
		screen = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.architect_mc.screen", InputConstants.Type.KEYBOARD, KeyDefaults.SCREEN, cat,
			1));
		siteHud = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.architect_mc.site_hud", InputConstants.Type.KEYBOARD, KeyDefaults.SITE_HUD, cat,
			2));
		undoLast = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.architect_mc.undo_last", InputConstants.Type.KEYBOARD, KeyDefaults.UNDO_LAST,
			cat, 3));
		buildLink = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.architect_mc.build_link", InputConstants.Type.KEYBOARD, KeyDefaults.BUILD_LINK,
			cat, 4));
		// (PR A4) the keys that act only while placing, marking a plot or reviewing a massing: their own category, today's keys by default
		KeyMapping.Category placingCat;
		try {
			placingCat = KeyMapping.Category.register(Architect.id("architect_placing"));
		} catch (IllegalArgumentException alreadyThere) {
			placingCat = new KeyMapping.Category(Architect.id("architect_placing"));
		}
		int order = 10;
		for (PlacingKeys.Action a : PlacingKeys.Action.values()) {
			placing.put(a, KeyMappingHelper.registerKeyMapping(new KeyMapping(a.translationKey(), InputConstants.Type.KEYBOARD, a.defaultKey, placingCat,
				order++)));
		}
	}

	/**
	 * Short label of the key a mapping is bound to ("B", "Enter", "Backtick"). Punctuation keys whose glyph is only a pixel
	 * or two in the Minecraft font are spelled out, so a keycap never looks empty.
	 */
	public static String label(KeyMapping k) {
		if (k == null || k.isUnbound()) {
			return "?";
		}
		return readable(k.getTranslatedKeyMessage().getString());
	}

	/** Spell out tiny punctuation glyphs; long names stay whole (PR3: {@link PlacingKeys#readable}; fitted by width where drawn). */
	public static String readable(String s) {
		return PlacingKeys.readable(s);
	}

	/** (PR3) A keycap label fitted to {@code maxCapW}, the keycap's whole width (its padding included). */
	public static String fitCap(net.minecraft.client.gui.Font font, String label, int maxCapW) {
		dev.larattalabs.labui.client.ui.Kit.Padding p = dev.larattalabs.labui.client.ui.Kit.padding("keycap");
		return PlacingKeys.fit(label, maxCapW - p.left() - p.right(), font::width);
	}

	/** (PR3) A hint row ({@code UiBits.hints}) with every key fitted so each pair fits {@code inner} alone. */
	public static String[] fitHints(net.minecraft.client.gui.Font font, String[] keyThenVerb, int inner) {
		dev.larattalabs.labui.client.ui.Kit.Padding p = dev.larattalabs.labui.client.ui.Kit.padding("keycap");
		return PlacingKeys.fitHints(keyThenVerb, inner, p.left() + p.right(), font::width);
	}

	/**
	 * (PR A4) The key code an action is bound to now (-1 when unbound; its default before registration). (PR2) A mouse button's binding is
	 * its {@link PlacingKeys#mouse} code, which the mouse hook resolves, so Rotate on Mouse 4 rotates.
	 */
	public static int bound(PlacingKeys.Action a) {
		KeyMapping k = placing.get(a);
		if (k == null) {
			return a.defaultKey;
		}
		if (k.isUnbound()) {
			return -1;
		}
		InputConstants.Key key = KeyMappingHelper.getBoundKeyOf(k);
		return PlacingKeys.code(key.getType() == InputConstants.Type.KEYBOARD, key.getType() == InputConstants.Type.MOUSE, key.getValue());
	}

	/** (PR A4) An action's keycap label ("R", "Enter"), read live; its default's name before registration. */
	public static String label(PlacingKeys.Action a) {
		KeyMapping k = placing.get(a);
		if (k == null) {
			return switch (a.defaultKey) {
				case PlacingKeys.ENTER -> "Enter";
				case PlacingKeys.BACKSPACE -> "Backspace";
				case PlacingKeys.PAGE_UP -> "PgUp";
				case PlacingKeys.PAGE_DOWN -> "PgDn";
				case PlacingKeys.UP -> "Up";
				case PlacingKeys.DOWN -> "Down";
				case PlacingKeys.LEFT -> "Left";
				case PlacingKeys.RIGHT -> "Right";
				case PlacingKeys.R -> "R";
				case PlacingKeys.L -> "L";
				case PlacingKeys.F -> "F";
				case PlacingKeys.H -> "H";
				default -> "?";
			};
		}
		return label(k);
	}

	/** (PR A4) "Shift+R": a Shift variant's label. */
	public static String shift(PlacingKeys.Action a) {
		return "Shift+" + label(a);
	}

	/**
	 * (PR A4) The nudge keys as one keycap: "Arrows" while they are the four arrows, else the four labels. Likewise "PgUp/Dn".
	 */
	public static String nudgeLabel() {
		if (bound(PlacingKeys.Action.FORWARD) == PlacingKeys.UP && bound(PlacingKeys.Action.BACK) == PlacingKeys.DOWN && bound(PlacingKeys.Action.LEFT_)
			== PlacingKeys.LEFT && bound(PlacingKeys.Action.RIGHT_) == PlacingKeys.RIGHT) {
			return "Arrows";
		}
		return label(PlacingKeys.Action.FORWARD) + label(PlacingKeys.Action.LEFT_) + label(PlacingKeys.Action.BACK) + label(PlacingKeys.Action.RIGHT_);
	}

	public static String heightLabel() {
		if (bound(PlacingKeys.Action.RAISE) == PlacingKeys.PAGE_UP && bound(PlacingKeys.Action.LOWER) == PlacingKeys.PAGE_DOWN) {
			return "PgUp/Dn";
		}
		return label(PlacingKeys.Action.RAISE) + "/" + label(PlacingKeys.Action.LOWER);
	}

	public static boolean matches(KeyMapping k, KeyEvent e) {
		return k != null && k.matches(e);
	}
}
