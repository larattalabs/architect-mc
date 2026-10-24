package dev.larattalabs.architect.client.hud;

import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.util.Util;

/**
 * One progress strip (UI-2b) for everything Architect waits on: Placing / Moving, Checking with the server, the helper's
 * install and start. A label line, then a 2 px track with either the fraction filled or, when the fraction is unknown, a
 * segment sweeping across it, so a wait never looks frozen. The colours are the caller's (UiStyle tokens for its surface).
 */
public final class ProgressStrip {
	/** The strip's height: the label line (10) and the bar (2). */
	public static final int H = 12;
	/** One sweep across the track. */
	static final long SWEEP_MS = 1400;

	private ProgressStrip() {
	}

	/** {@code frac} in [0, 1], or negative = unknown (the sweep). */
	public static void draw(GuiGraphicsExtractor g, Font font, int x, int y, int w, String label, double frac, int text, int bar, int track) {
		draw(g, font, x, y, w, label, null, frac, text, bar, track);
	}

	/** With {@code right} (e.g. the elapsed time) right-aligned on the label line, never cut off by a long label. */
	public static void draw(GuiGraphicsExtractor g, Font font, int x, int y, int w, String label, @org.jspecify.annotations.Nullable String right,
		double frac, int text, int bar, int track) {
		int rw = right == null ? 0 : font.width(right) + 6;
		g.text(font, dev.larattalabs.labui.client.ui.TextUtil.ellipsize(font, label, w - rw), x, y, text, false);
		if (right != null) {
			g.text(font, right, x + w - font.width(right), y, text, false);
		}
		int by = y + 10;
		g.fill(x, by, x + w, by + 2, track);
		if (frac >= 0) {
			g.fill(x, by, x + (int) Math.round(w * Math.min(1, frac)), by + 2, bar);
		} else {
			int[] seg = sweep(w, Util.getMillis());
			g.fill(x + seg[0], by, x + seg[1], by + 2, bar);
		}
	}

	/** The sweeping segment [from, to) on a track {@code w} wide at time {@code now} (pure). */
	public static int[] sweep(int w, long now) {
		int seg = Math.max(4, w / 4);
		double t = (now % SWEEP_MS) / (double) SWEEP_MS;
		int head = (int) Math.round(t * (w + seg));
		return new int[] {Math.max(0, head - seg), Math.min(w, head)};
	}

	/** "0:42" since {@code since} (wall-clock ms, {@link System#currentTimeMillis}). */
	public static String elapsed(long since) {
		long s = Math.max(0, (System.currentTimeMillis() - since) / 1000);
		return clock(s);
	}

	/** Seconds as "m:ss" (pure). */
	public static String clock(long seconds) {
		return seconds / 60 + ":" + (seconds % 60 < 10 ? "0" : "") + seconds % 60;
	}
}
