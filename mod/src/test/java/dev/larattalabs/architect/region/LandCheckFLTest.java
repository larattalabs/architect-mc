package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.site.Fills;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (Slice FL, Steward's S-M5-18) The land check reads a filled fill container holding exactly its fill (or less of it) as SAME; one item
 * more, another item, or a component stack stays CHANGED (cargo, FK-b's rule), and so does a swapped block.
 */
class LandCheckFLTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	static final Map<String, Integer> DECL = Map.of("minecraft:flint", 41, "minecraft:petrified_oak_slab", 4);

	static LandCheck.Cls judge(Map<String, Integer> now, boolean stateHolds) {
		return LandCheck.fillCell(LandCheck.Cls.CHANGED, stateHolds, Fills.fillOurs(now, DECL));
	}

	@Test
	void anExactFillIsSameAndMoreIsCargo() {
		assertEquals(LandCheck.Cls.SAME, judge(DECL, true), "exactly the fill (provided slabs included): SAME");
		assertEquals(LandCheck.Cls.SAME, judge(Map.of("minecraft:flint", 30), true), "less of the fill (a player took some): SAME");
		assertEquals(LandCheck.Cls.CHANGED, judge(Map.of("minecraft:flint", 42, "minecraft:petrified_oak_slab", 4), true), "one more: cargo");
		assertEquals(LandCheck.Cls.CHANGED, judge(Map.of("minecraft:flint", 41, "minecraft:petrified_oak_slab", 4, "minecraft:cobblestone", 1), true),
			"another item: cargo");
		assertEquals(LandCheck.Cls.CHANGED, judge(DECL, false), "the block swapped or its state changed: still CHANGED");
		assertFalse(Fills.fillOurs(null, DECL), "a component stack (plainCounts null) is never ours");
		assertFalse(Fills.fillOurs(Map.of(), null), "not a declared container");
		assertTrue(Fills.fillOurs(Map.of(), DECL), "empty: ours");
		assertEquals(LandCheck.Cls.PLAYER, LandCheck.fillCell(LandCheck.Cls.PLAYER, true, true), "only a CHANGED cell is reconsidered");
	}
}
