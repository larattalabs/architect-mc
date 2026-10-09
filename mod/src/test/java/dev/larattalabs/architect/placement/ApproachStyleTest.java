package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Random;
import org.junit.jupiter.api.Test;

/** The styled entrance approach (docs/CONTRACT.md "6b addition: region lot entrances") against fake worlds. */
class ApproachStyleTest {
	static final Anchors.Bounds BOX = ApproachTest.BOX;
	static final int FEET = ApproachTest.FEET;
	/** Flat natural ground, its top at y 10 (the door's feet at 11). */
	static final TerrainFit.World FLAT = ApproachTest.ground((x, z) -> 10);
	static final String STONE = "minecraft:stone_bricks";
	static final String PATH = "minecraft:polished_andesite";
	static final String FILL = "minecraft:andesite";

	static Approach.Plan south(TerrainFit.World w, Approach.Style style) {
		return Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, w, style);
	}

	/** A walk surface: the ground cells (y 10) from row {@code row} (z = 9 + row) outwards, of {@code block}. */
	static Approach.Surface deckFrom(int row, String block, boolean full) {
		return (x, y, z) -> y == 10 && z >= 9 + row ? new Approach.Met(block, full) : null;
	}

	@Test
	void withoutAStyleTheApproachIsUnchanged() {
		Random r = new Random(7);
		for (int n = 0; n < 50; n++) {
			int[][] h = new int[40][40];
			for (int[] row : h) {
				for (int i = 0; i < row.length; i++) {
					row[i] = 4 + r.nextInt(12);
				}
			}
			TerrainFit.World w = ApproachTest.ground((x, z) -> h[Math.floorMod(x, 40)][Math.floorMod(z, 40)]);
			Approach.Plan a = Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, w);
			Approach.Plan b = Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, w, null);
			assertArrayEquals(a.path(), b.path());
			assertArrayEquals(a.slabs(), b.slabs());
			assertArrayEquals(a.fill(), b.fill());
			assertArrayEquals(a.clear(), b.clear());
			assertArrayEquals(a.feet(), b.feet());
			assertEquals(a.ground(), b.ground());
			assertNull(b.pathBlock());
			assertNull(b.fillBlock());
		}
	}

	@Test
	void stopsBeforeTheNearestWalkSurfaceAndTakesItsBlock() {
		Approach.Plan p = south(FLAT, new Approach.Style(PATH, FILL, deckFrom(4, STONE, true)));
		assertEquals(3, p.rows());
		assertTrue(p.metRoad());
		assertArrayEquals(new int[] {3, 10, 13}, p.road()); // the first column (x 3) of row 4
		assertEquals(STONE, p.pathBlock());
		assertEquals(FILL, p.fillBlock());
		assertEquals(9, p.pathCount());
	}

	@Test
	void anEntranceOpeningOntoAWalkSurfaceHasNoApproach() {
		Approach.Plan p = south(FLAT, new Approach.Style(PATH, FILL, deckFrom(1, STONE, true)));
		assertEquals(0, p.rows());
		assertEquals(0, p.pathCount());
		assertEquals(0, p.changed());
		assertNull(p.bounds());
	}

	@Test
	void aSurfaceThatIsNotAFullBlockGivesTheStylesPath() {
		Approach.Plan p = south(FLAT, new Approach.Style(PATH, null, deckFrom(3, "minecraft:oak_slab", false)));
		assertEquals(2, p.rows());
		assertEquals(PATH, p.pathBlock());
		assertNull(p.fillBlock());
	}

	@Test
	void aRoadCellWithNoSurfaceAnswerGivesTheStylesPath() {
		TerrainFit.World w = (x, y, z) -> FLAT.flags(x, y, z) | (y == 10 && z >= 12 ? TerrainFit.ROAD : 0);
		Approach.Plan p = south(w, new Approach.Style(PATH, FILL, Approach.Surface.NONE));
		assertEquals(2, p.rows());
		assertEquals(PATH, p.pathBlock());
	}

	@Test
	void noSurfaceWithinReachKeepsTheDefaultLengthInTheStyle() {
		Approach.Plan plain = Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, FLAT);
		Approach.Plan p = south(FLAT, new Approach.Style(PATH, FILL, Approach.Surface.NONE));
		assertFalse(p.metRoad());
		assertEquals(Approach.DEFAULT_LENGTH, p.rows());
		assertArrayEquals(plain.path(), p.path());
		assertArrayEquals(plain.feet(), p.feet());
		assertEquals(plain.ground(), p.ground());
		assertEquals(PATH, p.pathBlock());
		assertEquals(FILL, p.fillBlock());
		// a surface just past the maximum length is not reached either
		Approach.Plan far = south(FLAT, new Approach.Style(PATH, FILL, deckFrom(Approach.DEFAULT_LENGTH + Approach.EXTEND + 1, STONE, true)));
		assertFalse(far.metRoad());
		assertEquals(Approach.DEFAULT_LENGTH, far.rows());
		assertEquals(PATH, far.pathBlock());
	}

	@Test
	void runsPastTheGroundToReachASurfaceWithinTheMaximumLength() {
		int row = Approach.DEFAULT_LENGTH + 3;
		Approach.Plan p = south(FLAT, new Approach.Style(PATH, FILL, deckFrom(row, STONE, true)));
		assertTrue(p.metRoad());
		assertEquals(row - 1, p.rows());
		assertEquals(STONE, p.pathBlock());
		// the unstyled approach stops at the ground
		assertEquals(Approach.DEFAULT_LENGTH, Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, FLAT).rows());
	}

	@Test
	void joinBlock() {
		Approach.Style s = new Approach.Style(PATH, null, Approach.Surface.NONE);
		assertEquals(PATH, Approach.joinBlock(null, s));
		assertEquals(STONE, Approach.joinBlock(new Approach.Met(STONE, true), s));
		assertEquals(PATH, Approach.joinBlock(new Approach.Met(STONE, false), s));
		assertEquals(PATH, Approach.joinBlock(new Approach.Met("", true), s));
	}
}
