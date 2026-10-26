package dev.larattalabs.architect.client.hud;

import dev.larattalabs.labui.client.ui.UiStyle;

/**
 * The one colour palette of Architect's dark HUD panels (the placement, plot, massing, region and construction HUDs, the
 * helper strip): thin aliases of lab-ui 0.3.0's on-dark tokens ({@link UiStyle.OnDark}, every text token at least 4.5:1 on the
 * HUD ink panel). Kept so the HUDs read in their own words (soft, note, armed); the colours live in lab-ui's
 * {@code ui-style.json} {@code semantic_on_dark}.
 */
public final class HudInk {
	private HudInk() {
	}

	/** Body text. */
	public static int text() {
		return UiStyle.OnDark.text();
	}

	/** Secondary text, key hints. */
	public static int soft() {
		return UiStyle.OnDark.muted();
	}

	/** Refusals, errors. */
	public static int error() {
		return UiStyle.OnDark.error();
	}

	/** Cautions: blocks replaced, a design limit moved (amber, a different hue from error). */
	public static int warn() {
		return UiStyle.OnDark.warn();
	}

	/** Ready, done. */
	public static int ok() {
		return UiStyle.OnDark.ok();
	}

	/** Notes beside the building: water in the footprint, mobs removed. */
	public static int note() {
		return UiStyle.OnDark.accent();
	}

	/** An armed choice: force, place on top, paused. */
	public static int armed() {
		return UiStyle.OnDark.selected();
	}

	/** A progress bar's fill and track. */
	public static int bar() {
		return UiStyle.OnDark.bar();
	}

	public static int track() {
		return UiStyle.OnDark.track();
	}

	/** A chip's edge on ink. */
	public static int chipEdge() {
		return UiStyle.OnDark.rule();
	}
}
