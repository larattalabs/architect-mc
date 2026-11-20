package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R fix round, P1-3 and P1-4 of the T4R early review) A pre-T4 credit's found evidence over its journal cells (what its placement
 * wrote: {@code after}, over {@code before}; what stands {@code now}): a cell still standing pays, a cell its old job already restored pays
 * (its refund is owed too: conservation), a cell a player changed (mined, replaced) does not. P1-4: 100 paid road cells, 64 restored before
 * the upgrade, 36 standing: 100 found (the base found 36). P1-3: 10 paid cells of a group member, one mined: 9 found (the base: no cap, 10).
 */
class T4RLegacyFoundTest {
	static int found(Method m, String after, String before, String now, int n) throws Exception {
		return (boolean) m.invoke(null, after, before, now) ? n : 0;
	}

	@Test
	void legacyFoundCountsRestoredAndStandingCells() throws Exception {
		System.out.println("ROW T4R-P1-3/P1-4 (unit)");
		Method m = CrateSettle.class.getDeclaredMethod("legacyFound", String.class, String.class, String.class);
		m.setAccessible(true);
		int road = found(m, "minecraft:gravel", "minecraft:stone", "minecraft:stone", 64) + found(m, "minecraft:gravel", "minecraft:stone", "minecraft:gravel",
			36);
		assertEquals(100, road, "T4R-P1-4: a partly restored legacy road's 64 restored cells are owed too");
		int group = found(m, "minecraft:oak_planks", "minecraft:air", "minecraft:oak_planks", 9) + found(m, "minecraft:cobblestone", "minecraft:dirt",
			"minecraft:air", 1);
		assertEquals(9, group, "T4R-P1-3: a mined paid cell (neither the placement nor its before stands) is not paid");
	}
}
