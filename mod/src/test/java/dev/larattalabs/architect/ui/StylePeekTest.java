package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.screen.StylePeek;
import org.junit.jupiter.api.Test;

/** (PR P1) Preview on ghost's caps: over 60,000 cells, or after slow frames, only the outline and the top-down shell are drawn. */
class StylePeekTest {
	@Test
	void theCapAndTheFrameFallback() {
		assertFalse(StylePeek.thinAt(60_000, false));
		assertTrue(StylePeek.thinAt(60_001, false));
		assertTrue(StylePeek.thinAt(10, true), "slow frames thin even a small design");
	}

	@Test
	void theShellKeepsTheSidesAndEachColumnsTop() {
		// a solid 3 x 3 x 3 cube: everything but its centre column's lower two cells is on a side or a top
		int n = 27;
		int[] xyz = new int[n * 3];
		int k = 0;
		for (int x = 0; x < 3; x++) {
			for (int y = 0; y < 3; y++) {
				for (int z = 0; z < 3; z++) {
					xyz[k * 3] = x;
					xyz[k * 3 + 1] = y;
					xyz[k * 3 + 2] = z;
					k++;
				}
			}
		}
		boolean[] keep = StylePeek.shell(xyz, n, 3, 3);
		int kept = 0;
		for (int i = 0; i < n; i++) {
			if (keep[i]) {
				kept++;
			} else {
				assertEquals(1, xyz[i * 3]);
				assertEquals(1, xyz[i * 3 + 2]);
				assertTrue(xyz[i * 3 + 1] < 2);
			}
		}
		assertEquals(25, kept);
	}
}
