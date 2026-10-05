package dev.larattalabs.architect.survival;

import static dev.larattalabs.architect.survival.Refunds.Outcome.NONE;
import static dev.larattalabs.architect.survival.Refunds.Outcome.PLAYER_DROP;
import static dev.larattalabs.architect.survival.Refunds.Outcome.REFUND;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.BitSet;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Refund accounting (paid vs free vs mined vs the player's) and the bitset / delta codec of the ghost sync. */
class RefundsAndBitsTest {
	static final List<SurvivalItems.Cost> PLANK = List.of(new SurvivalItems.Cost("minecraft:spruce_planks", 1));
	static final List<SurvivalItems.Cost> DOOR = List.of(new SurvivalItems.Cost("minecraft:spruce_door", 1));
	static final List<SurvivalItems.Cost> STONE = List.of(new SurvivalItems.Cost("minecraft:stone", 1));

	@Test
	void classify() {
		// paid and standing: refunded
		assertEquals(REFUND, Refunds.classify(true, true, false, false, false, false));
		// placed free by /architect site finish: nothing
		assertEquals(NONE, Refunds.classify(true, true, true, false, false, false));
		// mined by the player (air now): nothing, they have the item
		assertEquals(NONE, Refunds.classify(true, false, false, true, false, false));
		// the player put another block on a queued cell: theirs, it drops
		assertEquals(PLAYER_DROP, Refunds.classify(true, false, false, false, false, false));
		// a cleared cell the player built on: theirs
		assertEquals(PLAYER_DROP, Refunds.classify(false, false, false, false, false, false));
		// terrain as it was, or changed by nature: nothing
		assertEquals(NONE, Refunds.classify(false, false, false, false, true, false));
		assertEquals(NONE, Refunds.classify(false, false, false, false, false, true));
	}

	@Test
	void naturalChanges() {
		assertTrue(Refunds.natural("minecraft:grass_block", "minecraft:dirt"));
		assertTrue(Refunds.natural("minecraft:dirt", "minecraft:grass_block"));
		assertTrue(Refunds.natural("minecraft:air", "minecraft:water"));
		assertTrue(Refunds.natural("minecraft:air", "minecraft:snow"));
		assertFalse(Refunds.natural("minecraft:air", "minecraft:cobblestone"));
		assertFalse(Refunds.natural("minecraft:stone", "minecraft:dirt"));
	}

	@Test
	void tallyOfADeconstruct() {
		// 10 paid planks of which 3 were mined, 2 free planks, a paid door, and 1 stone the player put on a cleared cell
		Refunds.Tally t = new Refunds.Tally();
		for (int i = 0; i < 7; i++) {
			t.add(Refunds.classify(true, true, false, false, false, false), PLANK);
		}
		for (int i = 0; i < 3; i++) {
			Refunds.Outcome o = Refunds.classify(true, false, false, true, false, false);
			assertEquals(NONE, o);
			t.add(o, PLANK);
			t.mined();
		}
		for (int i = 0; i < 2; i++) {
			t.add(Refunds.classify(true, true, true, false, false, false), PLANK);
		}
		t.add(Refunds.classify(true, true, false, false, false, false), DOOR);
		t.add(Refunds.classify(true, true, false, false, false, false), List.of()); // the door's upper half costs nothing
		t.add(Refunds.classify(false, false, false, false, false, false), STONE);
		assertEquals(Map.of("minecraft:spruce_planks", 7, "minecraft:spruce_door", 1), t.refund());
		assertEquals(Map.of("minecraft:stone", 1), t.playerBlocks());
		assertEquals(3, t.minedCells());
		assertEquals(8, Refunds.Tally.total(t.refund()));
	}

	@Test
	void bitsetRoundTrip() {
		BitSet b = new BitSet();
		b.set(0);
		b.set(63);
		b.set(64);
		b.set(1000);
		assertEquals(b, CellBits.fromWords(CellBits.words(b)));
		assertEquals(b, CellBits.fromBase64(CellBits.base64(b)));
		assertEquals(new BitSet(), CellBits.fromBase64(CellBits.base64(new BitSet())));
		assertEquals("", CellBits.base64(new BitSet()));
	}

	@Test
	void deltaRoundTrip() {
		int[] v = {5, 6, 7, 120, 3, 100000, 0};
		assertArrayEquals(v, CellBits.decodeInts(CellBits.encodeInts(v)));
		assertArrayEquals(new int[0], CellBits.decodeInts(CellBits.encodeInts(new int[0])));
		assertArrayEquals(v, CellBits.intsFromBase64(CellBits.intsBase64(v)));
		// consecutive cells cost a byte each
		int[] run = new int[200];
		for (int i = 0; i < run.length; i++) {
			run[i] = 4000 + i;
		}
		assertEquals(2 + 2 + 199, CellBits.encodeInts(run).length);
		assertThrows(IllegalArgumentException.class, () -> CellBits.decodeInts(new byte[] {5, 2}));
	}

	@Test
	void applyDeltas() {
		BitSet built = new BitSet();
		int[] tick1 = CellBits.batch(new int[] {9, 2, 4, 0, 0}, 3);
		assertArrayEquals(new int[] {2, 4, 9}, tick1);
		assertEquals(3, CellBits.apply(built, tick1, 10));
		assertEquals(1, CellBits.apply(built, new int[] {4, 5, 99, -1}, 10), "known, new, out of range");
		assertEquals(4, built.cardinality());
	}
}
