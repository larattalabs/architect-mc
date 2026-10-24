package dev.larattalabs.architect.placement;

/**
 * Which rows of a HUD panel fit a height budget (UI-2b; pure, unit-tested in {@code HudFitTest}). The placement HUD may not cover
 * the crosshair, so on a short screen (GUI scale 4 on 1080p: 270 px) its lowest-priority rows go first (the status line that
 * repeats the refusal, the path, the notes, the legend's extra rows) until the rest fits; equal priorities drop from the bottom.
 * Rows of priority {@link #KEEP} or more never drop.
 */
public final class HudFit {
	public static final int KEEP = 100;

	private HudFit() {
	}

	/** {@code heights[i]}, {@code prios[i]}; the rows kept within {@code budget} (plus {@code fixed}, the panel's padding). */
	public static boolean[] keep(int[] heights, int[] prios, int fixed, int budget) {
		int n = heights.length;
		boolean[] keep = new boolean[n];
		int total = fixed;
		for (int i = 0; i < n; i++) {
			keep[i] = true;
			total += heights[i];
		}
		while (total > budget) {
			int drop = -1;
			for (int i = n - 1; i >= 0; i--) {
				if (keep[i] && prios[i] < KEEP && (drop < 0 || prios[i] < prios[drop])) {
					drop = i;
				}
			}
			if (drop < 0) {
				break;
			}
			keep[drop] = false;
			total -= heights[drop];
		}
		return keep;
	}
}
