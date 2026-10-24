package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.hud.ProgressStrip;
import org.junit.jupiter.api.Test;

/** UI-2b: the progress strip's sweep moves and stays on the track; the elapsed clock. */
class ProgressStripTest {
	@Test
	void theSweepMovesAcrossTheTrack() {
		int w = 160;
		int[] a = ProgressStrip.sweep(w, 0);
		int[] b = ProgressStrip.sweep(w, 700);
		assertNotEquals(a[1], b[1], "it moves");
		for (long t = 0; t < 3_000; t += 37) {
			int[] s = ProgressStrip.sweep(w, t);
			assertTrue(s[0] >= 0 && s[1] <= w && s[0] <= s[1], t + ": " + s[0] + ".." + s[1]);
		}
		assertArrayEquals(ProgressStrip.sweep(w, 100), ProgressStrip.sweep(w, 100 + 1400), "one sweep a period");
	}

	@Test
	void clock() {
		assertEquals("0:00", ProgressStrip.clock(0));
		assertEquals("0:07", ProgressStrip.clock(7));
		assertEquals("1:42", ProgressStrip.clock(102));
	}
}
