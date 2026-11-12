package dev.larattalabs.architect.client.ui;

import dev.larattalabs.labui.client.ui.UiStyle;

/**
 * Text colours on paper that lab-ui 0.4.0 has no accessor for yet (UI polish 1, 2026-11-12; Minecraft/UI-AUDIT.md item 1). Client thread.
 */
public final class PaperInk {
	private PaperInk() {
	}

	/**
	 * Clay as text (labels, section titles, provenance, warnings on paper): lab-ui's {@code semantic.clay_text} #9A3F27, at least 4.5:1 on paper,
	 * the inset and the selected and hovered fills. {@code UiStyle.CLAY_DARK} as text was 4.26:1 on paper and 3.76:1 on the inset; it stays for
	 * fills, edges and rules. Read with a fallback, so lab-ui 0.4.0 draws the same colour; becomes {@code UiStyle.clayText()} with the lab-ui
	 * release after 0.4.0.
	 */
	public static int clay() {
		return UiStyle.color("semantic.clay_text", 0xFF9A3F27);
	}
}
