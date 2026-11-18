package dev.larattalabs.architect.client.hud;

import java.util.List;

/**
 * (PR K1) Architect's default key codes as plain numbers (26.3's {@code InputConstants.KEY_*}: SDL scancodes, not GLFW) (pure: {@link Keys} registers from these, and
 * {@code KeyDefaultsTest} checks them without a Minecraft bootstrap).
 * <ul>
 * <li>Global keys (Controls &gt; Architect, acting with no screen open): no two share a key, and none shares lab-ui's
 * ({@code dev.larattalabs.labui.ui.KeyDefaults.globals()}, the jobs panel's K).</li>
 * <li>No default is one of Steward's Y, I or U (S-PR-2, {@code KeyDefaults.STEWARD_RESERVED}).</li>
 * </ul>
 * Build a link moved from K to N (N-PR-5): on 26.3 {@code KeyMapping.MAP} is {@code Key -> List<KeyMapping>} and
 * {@code KeyMapping.click} clicks every mapping on the key, so K opened the jobs panel and started a link at once.
 */
public final class KeyDefaults {
	public static final int SCREEN = 5; // B
	public static final int SITE_HUD = 13; // J
	public static final int UNDO_LAST = 29; // Z
	public static final int BUILD_LINK = 17; // N (was K)

	private KeyDefaults() {
	}

	/** The global defaults, in registration order. */
	public static List<Integer> globals() {
		return List.of(SCREEN, SITE_HUD, UNDO_LAST, BUILD_LINK);
	}
}
