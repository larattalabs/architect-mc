package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.nio.file.Files;
import java.nio.file.Path;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import org.junit.jupiter.api.Test;

/**
 * Slice J2 item 1 (docs/CONTRACT.md "Slice J2"): an unnamed wild animal in a removal's box blocks only when the removal changes a cell it
 * occupies or stands on (the apijars flake: a bee in the air over an instant site). The world half is gated in game (apitest survival).
 */
class RemovalWildJ2Test {
	/** A bee's box (0.7 x 0.6) hovering at 116.5, 65.2, 52.5: inside one cell. */
	static final AABB BEE = new AABB(116.15, 65.2, 52.15, 116.85, 65.8, 52.85);
	/** A cow's box (0.9 x 1.4) standing on y 63 at 112.5, 63, 55.5: two cells high, its floor at y 62. */
	static final AABB COW = new AABB(112.05, 63.0, 55.05, 112.95, 64.4, 55.95);

	static LongOpenHashSet set(int[]... ps) {
		LongOpenHashSet s = new LongOpenHashSet();
		for (int[] p : ps) {
			s.add(BlockPos.asLong(p[0], p[1], p[2]));
		}
		return s;
	}

	@Test
	void cellsOfABox() {
		assertArrayEquals(new long[] {BlockPos.asLong(116, 65, 52)}, Sites.occupied(BEE));
		assertArrayEquals(new long[] {BlockPos.asLong(112, 63, 55), BlockPos.asLong(112, 64, 55)}, Sites.occupied(COW));
		assertArrayEquals(new long[] {BlockPos.asLong(112, 62, 55)}, Sites.support(COW));
	}

	@Test
	void aBeeInAirTheRemovalLeavesIsNoBlocker() {
		LongOpenHashSet changes = set(new int[] {116, 62, 52}, new int[] {116, 63, 52}); // the cabin's floor and wall below it
		assertFalse(Sites.wildHarmed(Sites.occupied(BEE), new long[0], changes::contains));
	}

	@Test
	void aBeeInACellTheRestoreFillsOrFloodsBlocks() {
		assertTrue(Sites.wildHarmed(Sites.occupied(BEE), new long[0], set(new int[] {116, 65, 52})::contains));
	}

	@Test
	void aCowOnTheSitesFloorBlocks() {
		assertTrue(Sites.wildHarmed(Sites.occupied(COW), Sites.support(COW), set(new int[] {112, 62, 55})::contains));
	}

	@Test
	void aCowOnUnchangedGrassInTheBoxIsNoBlocker() {
		assertFalse(Sites.wildHarmed(Sites.occupied(COW), Sites.support(COW), set(new int[] {113, 62, 55}, new int[] {112, 65, 55})::contains));
	}

	@Test
	void onlyUnnamedWildAnimalsAreExempt() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Sites.java"));
		int i = s.indexOf("!wildHarmed(");
		assertTrue(i > 0, "removalBlockersOf asks wildHarmed");
		String guard = s.substring(s.lastIndexOf("if (", i), i);
		assertTrue(guard.contains("f.kind() == Occupancy.Kind.LIVING") && guard.contains("!e.hasCustomName()"),
			"(Steward's review) only an unnamed LIVING animal: a named one, a pet (OWNED) and a player block anywhere in the box: " + guard);
	}
}
