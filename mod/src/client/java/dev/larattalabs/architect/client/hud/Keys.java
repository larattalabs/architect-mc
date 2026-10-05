package dev.larattalabs.architect.client.hud;

import com.mojang.blaze3d.platform.InputConstants;
import dev.larattalabs.architect.Architect;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.input.KeyEvent;

/**
 * Architect's key mapping (Options > Controls > Key Binds > Architect, rebindable like any vanilla key): the Architect
 * screen ({@code B}). Registered once.
 */
public final class Keys {
	public static KeyMapping screen;
	private static boolean registered;

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
		screen = KeyMappingHelper.registerKeyMapping(new KeyMapping("key.architect_mc.screen", InputConstants.Type.KEYBOARD, InputConstants.KEY_B, cat,
			1));
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

	/** Spell out tiny punctuation glyphs; cut long names to 9 characters. */
	public static String readable(String s) {
		String word = switch (s) {
			case "`" -> "Backtick";
			case "'" -> "Quote";
			case "´" -> "Accent";
			case "," -> "Comma";
			case "." -> "Period";
			case ";" -> "Semicolon";
			case ":" -> "Colon";
			case "|" -> "Bar";
			default -> s;
		};
		return word.length() > 9 ? word.substring(0, 9) : word;
	}

	public static boolean matches(KeyMapping k, KeyEvent e) {
		return k != null && k.matches(e);
	}
}
