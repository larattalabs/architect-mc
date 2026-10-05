package dev.larattalabs.architect.survival;

import static dev.larattalabs.architect.survival.BuildOrder.ATTACHABLE;
import static dev.larattalabs.architect.survival.BuildOrder.FULL;
import static dev.larattalabs.architect.survival.BuildOrder.PARTIAL;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** Build order: bottom-up, full before partial before attachables, attachables after their support, pairs together. */
class BuildOrderTest {
	static int pos(int[] order, int cell) {
		for (int i = 0; i < order.length; i++) {
			if (order[i] == cell) {
				return i;
			}
		}
		throw new AssertionError("cell " + cell + " missing from " + Arrays.toString(order));
	}

	static void assertPermutation(int[] order, int n) {
		int[] s = order.clone();
		Arrays.sort(s);
		for (int i = 0; i < n; i++) {
			assertEquals(i, s[i]);
		}
	}

	@Test
	void bottomUpThenFullPartialAttachable() {
		// cells: 0 torch y1, 1 stairs y1, 2 planks y1, 3 planks y0, 4 slab y0
		int[] y = {1, 1, 1, 0, 0};
		int[] kind = {ATTACHABLE, PARTIAL, FULL, FULL, PARTIAL};
		int[] none = {-1, -1, -1, -1, -1};
		int[] order = BuildOrder.order(y, kind, none, none);
		assertArrayEquals(new int[] {3, 4, 2, 1, 0}, order);
	}

	@Test
	void attachablesWaitForTheirSupportEvenAboveThem() {
		// 0: lantern hanging at y2 from 1: a beam at y3; 2: wall torch at y2 on 3: a planks wall cell at y2
		int[] y = {2, 3, 2, 2};
		int[] kind = {ATTACHABLE, FULL, ATTACHABLE, FULL};
		int[] support = {1, -1, 3, -1};
		int[] pair = {-1, -1, -1, -1};
		int[] order = BuildOrder.order(y, kind, support, pair);
		assertPermutation(order, 4);
		assertTrue(pos(order, 0) > pos(order, 1), "the lantern comes after the beam above it");
		assertTrue(pos(order, 2) > pos(order, 3), "the torch comes after its wall");
		assertEquals(3, order[0]);
	}

	@Test
	void pairsArePlacedTogether() {
		// 0: floor y0; 1: door lower y1 (support 0); 2: door upper y2 (pair of 1); 3: wall y1; 4: wall y2
		// 5: bed foot y1 (support 0), 6: bed head y1 (pair of 5)
		int[] y = {0, 1, 2, 1, 2, 1, 1};
		int[] kind = {FULL, ATTACHABLE, ATTACHABLE, FULL, FULL, ATTACHABLE, ATTACHABLE};
		int[] support = {-1, 0, 1, -1, -1, 0, 0};
		int[] pair = {-1, -1, 1, -1, -1, -1, 5};
		int[] order = BuildOrder.order(y, kind, support, pair);
		assertPermutation(order, 7);
		assertEquals(pos(order, 1) + 1, pos(order, 2), "the door's upper half right after its lower half");
		assertEquals(pos(order, 5) + 1, pos(order, 6), "the bed's head right after its foot");
		assertTrue(pos(order, 1) < pos(order, 4), "the door at y1 comes before the y2 wall (its upper half rides with it)");
		assertTrue(pos(order, 0) < pos(order, 1));
	}

	@Test
	void cyclesStillEmitEveryCell() {
		int[] y = {0, 0};
		int[] kind = {ATTACHABLE, ATTACHABLE};
		int[] support = {1, 0};
		int[] pair = {-1, -1};
		assertPermutation(BuildOrder.order(y, kind, support, pair), 2);
	}

	@Test
	void largeQueueIsAPermutation() {
		int n = 5000;
		int[] y = new int[n];
		int[] kind = new int[n];
		int[] support = new int[n];
		int[] pair = new int[n];
		for (int i = 0; i < n; i++) {
			y[i] = (i * 7919) % 23;
			kind[i] = i % 3;
			support[i] = kind[i] == ATTACHABLE ? (i * 31) % n : -1;
			pair[i] = -1;
		}
		assertPermutation(BuildOrder.order(y, kind, support, pair), n);
	}
}
