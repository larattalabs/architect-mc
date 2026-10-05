package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The default shared-crate cell (docs/CONTRACT.md phase 4d, R6): outside every item's restore box, near the first approach end. */
class CratePlacementTest {
	private static final int[] SOUTH = {0, 1};

	@Test
	void besideTheApproachEndWhenFree() {
		// end at (10, 64, 20), approach going south: right of the walking line is -x
		assertArrayEquals(new int[] {9, 64, 21}, CratePlacement.choose(new int[] {10, 64, 20}, SOUTH, List.of()));
	}

	@Test
	void skipsCellsInsideAnyRestoreBox() {
		// the next lot's restore box covers the cells right after the end on both sides, 3 rows deep
		Anchors.Bounds lot2 = new Anchors.Bounds(0, 60, 21, 20, 80, 23);
		int[] c = CratePlacement.choose(new int[] {10, 64, 20}, SOUTH, List.of(lot2));
		assertArrayEquals(new int[] {9, 64, 24}, c);
		assertFalse(lot2.contains(c[0], c[1], c[2]));
		// the left side is tried too
		Anchors.Bounds rightOnly = new Anchors.Bounds(0, 60, 21, 9, 80, 40);
		assertArrayEquals(new int[] {11, 64, 21}, CratePlacement.choose(new int[] {10, 64, 20}, SOUTH, List.of(rightOnly)));
	}

	@Test
	void noneWhenEverythingIsTaken() {
		Anchors.Bounds all = new Anchors.Bounds(-50, 0, -50, 50, 100, 50);
		assertNull(CratePlacement.choose(new int[] {10, 64, 20}, SOUTH, List.of(all)));
	}
}
