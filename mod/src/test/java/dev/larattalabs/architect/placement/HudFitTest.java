package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;

import org.junit.jupiter.api.Test;

/** UI-2b: the placement HUD drops its lowest-priority rows on a short screen. */
class HudFitTest {
	@Test
	void everythingFitsOnATallScreen() {
		assertArrayEquals(new boolean[] {true, true, true}, HudFit.keep(new int[] {10, 10, 10}, new int[] {100, 5, 1}, 6, 200));
	}

	@Test
	void lowestPriorityGoesFirstThenFromTheBottom() {
		// title (keep), status (1), path (3), note (4), note (4), keys (8): 6 rows of 10 + 6 padding = 66; budget 46 drops two
		boolean[] k = HudFit.keep(new int[] {10, 10, 10, 10, 10, 10}, new int[] {100, 1, 3, 4, 4, 8}, 6, 46);
		assertArrayEquals(new boolean[] {true, false, false, true, true, true}, k);
		boolean[] k2 = HudFit.keep(new int[] {10, 10, 10, 10, 10, 10}, new int[] {100, 1, 3, 4, 4, 8}, 6, 36);
		assertArrayEquals(new boolean[] {true, false, false, true, false, true}, k2, "equal priorities: the lower row goes first");
	}

	@Test
	void keptRowsNeverDrop() {
		assertArrayEquals(new boolean[] {true, true}, HudFit.keep(new int[] {50, 50}, new int[] {100, 100}, 6, 10));
	}
}
