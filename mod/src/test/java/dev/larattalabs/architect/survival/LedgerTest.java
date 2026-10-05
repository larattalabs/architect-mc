package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/** Equivalents arithmetic (one way, vanilla yields) and the crate's ledger: accept only what is needed, credit, consume. */
class LedgerTest {
	static final String LOG = "minecraft:spruce_log";
	static final String PLANKS = "minecraft:spruce_planks";
	static final String SLAB = "minecraft:spruce_slab";
	static final Equivalents EQ = Equivalents.bundled();

	@Test
	void bundledTableIsOneWayAtVanillaYields() {
		assertTrue(EQ.size() > 100);
		assertEquals(List.of(new Equivalents.Path(PLANKS, 4, 1), new Equivalents.Path(SLAB, 8, 2)), EQ.paths(LOG));
		assertEquals(List.of(new Equivalents.Path(SLAB, 2, 1)), EQ.paths(PLANKS));
		assertEquals(List.of(), EQ.paths(SLAB), "nothing converts back");
		assertTrue(EQ.paths("minecraft:stripped_spruce_wood").contains(new Equivalents.Path(PLANKS, 4, 1)));
		assertTrue(EQ.paths("minecraft:cobblestone").contains(new Equivalents.Path("minecraft:cobblestone_slab", 2, 1)));
		assertTrue(EQ.paths("minecraft:cobblestone").contains(new Equivalents.Path("minecraft:cobblestone_wall", 1, 1)));
		assertTrue(EQ.paths("minecraft:stone").contains(new Equivalents.Path("minecraft:stone_bricks", 1, 1)));
		assertTrue(EQ.paths("minecraft:stone").contains(new Equivalents.Path("minecraft:stone_brick_slab", 2, 2)));
		// nothing skips smelting, nothing cheaper becomes something dearer
		assertTrue(EQ.paths("minecraft:cobblestone").stream().noneMatch(p -> p.item().equals("minecraft:stone")));
		assertTrue(EQ.paths("minecraft:stone_bricks").stream().noneMatch(p -> p.item().equals("minecraft:stone")));
		assertTrue(EQ.paths("minecraft:spruce_planks").stream().noneMatch(p -> p.item().equals(LOG)));
	}

	@Test
	void cyclesAreRejected() {
		assertThrows(IllegalArgumentException.class, () -> new Equivalents(List.of(new Equivalents.Rule("a:x", "a:y", 2),
			new Equivalents.Rule("a:y", "a:x", 1))));
	}

	/** Unbuilt cost per item, mutable. */
	static ToIntFunction<String> need(Map<String, Integer> m) {
		return k -> m.getOrDefault(k, 0);
	}

	@Test
	void acceptsOnlyWhatTheSiteStillNeeds() {
		Map<String, Integer> unbuilt = new HashMap<>(Map.of(PLANKS, 6));
		Ledger l = new Ledger();
		for (int i = 0; i < 6; i++) {
			assertEquals(new Ledger.Accepted(PLANKS, 1, false), l.accept(PLANKS, need(unbuilt), EQ, true));
		}
		assertNull(l.accept(PLANKS, need(unbuilt), EQ, false), "6 planks needed and 6 in stock: a 7th jams nothing, it is refused");
		assertNull(l.accept("minecraft:dirt", need(unbuilt), EQ, false), "junk is refused");
		assertEquals(6, l.stock(PLANKS));
	}

	@Test
	void logsConvertOnInsertAndLeftoversStayAsCredit() {
		Map<String, Integer> unbuilt = new HashMap<>(Map.of(PLANKS, 6));
		Ledger l = new Ledger();
		assertEquals(new Ledger.Accepted(PLANKS, 4, true), l.accept(LOG, need(unbuilt), EQ, true));
		assertEquals(new Ledger.Accepted(PLANKS, 4, true), l.accept(LOG, need(unbuilt), EQ, true));
		assertEquals(8, l.stock(PLANKS));
		assertEquals(Map.of(PLANKS, 2), l.credit(need(unbuilt)));
		assertNull(l.accept(LOG, need(unbuilt), EQ, false));
		// 6 planks -> 12 slabs: slabs needed and planks in excess are not converted after the fact; a plank inserted is
		assertTrue(l.consume(PLANKS, 6));
		unbuilt.put(PLANKS, 0);
		unbuilt.put(SLAB, 12);
		for (int i = 0; i < 6; i++) {
			assertEquals(new Ledger.Accepted(SLAB, 2, true), l.accept(PLANKS, need(unbuilt), EQ, true));
		}
		assertEquals(12, l.stock(SLAB));
		assertNull(l.accept(PLANKS, need(unbuilt), EQ, false));
	}

	@Test
	void aLogGoesToSlabsWhenOnlySlabsAreMissing() {
		Map<String, Integer> unbuilt = new HashMap<>(Map.of(SLAB, 3));
		Ledger l = new Ledger();
		assertEquals(new Ledger.Accepted(SLAB, 8, true), l.accept(LOG, need(unbuilt), EQ, true));
		assertEquals(Map.of(SLAB, 5), l.credit(need(unbuilt)));
	}

	@Test
	void consumeNeedsStockAndTakeStockEmptiesIt() {
		Map<String, Integer> unbuilt = new HashMap<>(Map.of(PLANKS, 4));
		Ledger l = new Ledger();
		assertFalse(l.consume(PLANKS, 1));
		l.accept(LOG, need(unbuilt), EQ, true);
		assertTrue(l.consume(PLANKS, 3));
		assertEquals(4, l.delivered(PLANKS));
		assertEquals(3, l.placed(PLANKS));
		assertEquals(Map.of(PLANKS, 1), l.takeStock());
		assertEquals(0, l.stock(PLANKS));
		assertEquals(Map.of(), l.stock());
	}

	@Test
	void minedCellsAreNeededAgain() {
		// a built plank was mined while building: the unbuilt cost grows back and the crate accepts one more
		Map<String, Integer> unbuilt = new HashMap<>(Map.of(PLANKS, 1));
		Ledger l = new Ledger();
		l.accept(PLANKS, need(unbuilt), EQ, true);
		l.consume(PLANKS, 1);
		unbuilt.put(PLANKS, 0);
		assertNull(l.accept(PLANKS, need(unbuilt), EQ, false));
		unbuilt.put(PLANKS, 1);
		assertEquals(new Ledger.Accepted(PLANKS, 1, false), l.accept(PLANKS, need(unbuilt), EQ, false));
	}
}
