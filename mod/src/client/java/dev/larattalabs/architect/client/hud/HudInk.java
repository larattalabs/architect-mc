package dev.larattalabs.architect.client.hud;

import dev.larattalabs.labui.client.hud.UiBits;
import dev.larattalabs.labui.client.ui.UiStyle;

/**
 * The one colour palette of Architect's in-world HUD panels (UI-2b: the placement, plot and construction HUDs, the helper
 * strip), all lab-ui {@link UiStyle} tokens. Those panels are ink (dark) tooltips, and lab-ui 0.2.0's {@code semantic.*}
 * tokens are for text on paper (about 2:1 on ink), so the dark-surface tokens are used: {@code monitor_dark.*}, {@code status.*}
 * and {@code ink_ui.*}. Replaces the HUDs' own RED / ORANGE / WATER_INK literals. (A lab-ui follow-up: semantic on-ink tokens.)
 */
public final class HudInk {
	private HudInk() {
	}

	/** Body text (cream). */
	public static int text() {
		return UiStyle.CREAM;
	}

	/** Secondary text. */
	public static int soft() {
		return UiBits.activityOnInk();
	}

	/** Refusals, errors (monitor_dark.error, #EA847B). */
	public static int error() {
		return UiStyle.color("monitor_dark.error", 0xFFEA847B);
	}

	/** Cautions: blocks replaced, a design limit moved (monitor_dark.attention, #F4A585). */
	public static int warn() {
		return UiStyle.color("monitor_dark.attention", 0xFFF4A585);
	}

	/** Ready, done (monitor_dark.result, #B8CBB3). */
	public static int ok() {
		return UiStyle.color("monitor_dark.result", 0xFFB8CBB3);
	}

	/** Notes beside the building: water in the footprint, mobs removed (monitor_dark.diff_hunk, #80D2CD). */
	public static int note() {
		return UiStyle.color("monitor_dark.diff_hunk", 0xFF80D2CD);
	}

	/** An armed choice: force, place on top, paused (monitor_dark.tool, #E6C659). */
	public static int armed() {
		return UiStyle.color("monitor_dark.tool", 0xFFE6C659);
	}

	/** A progress bar's fill and track. */
	public static int bar() {
		return UiStyle.status("working");
	}

	public static int track() {
		return UiStyle.withAlpha(soft(), 0x60);
	}

	/** A chip's edge on ink. */
	public static int chipEdge() {
		return UiStyle.color("monitor_dark.rule", 0xFF4A423B);
	}
}
