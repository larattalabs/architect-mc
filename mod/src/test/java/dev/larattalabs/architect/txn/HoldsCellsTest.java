package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** (slice T2a) The held-cell index every block write pre-filters on: box and crate resources by dimension and packed position. */
class HoldsCellsTest {
	static TxnEntry entry(String id, String... resources) {
		return new TxnEntry(id, "test.move", 1, null, 0, 0, null, List.of(resources), "txn");
	}

	@Test
	void thePackingIsBlockPosAsLong() {
		for (int[] p : new int[][] {{0, 0, 0}, {1, 64, -2}, {-30000000, -64, 29999999}, {123456, 319, -654321}, {-1, -1, -1}}) {
			assertEquals(BlockPos.asLong(p[0], p[1], p[2]), Holds.pack(p[0], p[1], p[2]), java.util.Arrays.toString(p));
		}
	}

	@Test
	void boxAndCrateResourcesAreCellsOthersAreNot() {
		assertEquals(new Holds.Cell("minecraft:overworld", 1, 64, -2), Holds.cell("box:minecraft:overworld@1,64,-2"));
		assertEquals(new Holds.Cell("minecraft:the_nether", -5, 10, 7), Holds.cell("crate:minecraft:the_nether@-5,10,7"));
		assertNull(Holds.cell("site:s12"));
		assertNull(Holds.cell("pile:steward:town"));
		assertNull(Holds.cell("box:minecraft:overworld@1,64"));
		assertNull(Holds.cell("box:minecraft:overworld@a,b,c"));
	}

	@Test
	void heldCellsAreFoundAndReleased() {
		Holds h = new Holds();
		TxnEntry a = entry("tx-1", "box:minecraft:overworld@1,64,-2", "box:minecraft:overworld@2,64,-2", "site:s1");
		TxnEntry b = entry("tx-2", "crate:minecraft:the_nether@0,70,0");
		h.hold(a);
		h.hold(b);
		assertSame(a, h.cellHolder("minecraft:overworld", 1, 64, -2));
		assertSame(a, h.cellHolder("minecraft:overworld", 2, 64, -2));
		assertNull(h.cellHolder("minecraft:overworld", 3, 64, -2));
		assertNull(h.cellHolder("minecraft:the_nether", 1, 64, -2)); // another dimension
		assertSame(b, h.cellHolder("minecraft:the_nether", 0, 70, 0));
		assertEquals("box:minecraft:overworld@2,64,-2", h.cellIn("minecraft:overworld", 2, 60, -5, 10, 70, 0));
		assertNull(h.cellIn("minecraft:overworld", 3, 60, -5, 10, 70, 0));
		assertTrue(h.anyCell("minecraft:overworld"));
		h.release(a);
		assertNull(h.cellHolder("minecraft:overworld", 1, 64, -2));
		assertFalse(h.anyCell("minecraft:overworld"));
		assertSame(b, h.cellHolder("minecraft:the_nether", 0, 70, 0));
		h.clear();
		assertNull(h.cellHolder("minecraft:the_nether", 0, 70, 0));
		assertTrue(h.isEmpty());
	}

	@Test
	void anotherTxnsReleaseLeavesTheHolderInPlace() {
		Holds h = new Holds();
		TxnEntry a = entry("tx-1", "box:minecraft:overworld@1,64,-2");
		TxnEntry b = entry("tx-2", "box:minecraft:overworld@1,64,-2");
		h.hold(a);
		h.release(b); // not the holder: nothing released
		assertSame(a, h.cellHolder("minecraft:overworld", 1, 64, -2));
	}
}
