package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.BitSet;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * Slice RL: the targets' cell books in the stockpile ledger and the reconcile's comparison. A book is saved with the ledger (an older
 * file has none); the comparison covers only the cells the book knows; a cell standing that never stood paid is ahead (charged or
 * owed), a cell that stood paid and is gone is lost (its cost goes back, capped by the record); applying the result and comparing again
 * finds only what is still owed (idempotent); the ledger's numbers: the world ahead charged once, the ledger ahead taken once.
 */
class StockpileReconcileRLTest {
	static final String DIRT = "minecraft:dirt";
	static final String PLANKS = "minecraft:oak_planks";
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;
	static final String KEY = "site:s1@100";
	static final int[] QUEUE = {3, 4, 5, 6, 7, 8, 9, 10};

	static BitSet bits(int... on) {
		BitSet b = new BitSet();
		for (int i : on) {
			b.set(i);
		}
		return b;
	}

	static BitSet range(int from, int to) {
		BitSet b = new BitSet();
		b.set(from, to);
		return b;
	}

	static StockLedger.Book book(BitSet known, BitSet standing, BitSet owed) {
		return new StockLedger.Book(java.util.Arrays.hashCode(QUEUE), QUEUE.length, known, standing, owed);
	}

	@Test
	void bookSavedWithTheLedger() {
		StockLedger l = new StockLedger();
		l.book(KEY, book(range(0, 8), bits(0, 1, 2), bits(5)));
		JsonObject j = l.toJson();
		assertTrue(j.has("cells"));
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(j.toString()).getAsJsonObject());
		StockLedger.Book b = back.book(KEY);
		assertNotNull(b);
		assertTrue(b.fits(QUEUE));
		assertTrue(!b.fits(new int[] {3, 4, 5}), "a book of another queue is not used");
		assertEquals(range(0, 8), b.known());
		assertEquals(bits(0, 1, 2), b.standing());
		assertEquals(bits(5), b.owed());
		// a file written before RL: no books, nothing to reconcile
		JsonObject old = l.toJson();
		old.remove("cells");
		assertNull(StockLedger.fromJson(old).book(KEY));
		assertTrue(StockLedger.fromJson(old).books().isEmpty());
		// a ledger with no books writes no field
		assertTrue(!new StockLedger().toJson().has("cells"));
	}

	@Test
	void planComparesKnownCellsOnly() {
		// known 0..5 (6, 7 in a chunk never loaded since the start), paid standing 0..2 at the save
		StockLedger.Book b = book(range(0, 6), bits(0, 1, 2), new BitSet());
		// now: 0, 1 stand; 2 is gone (its chunk never saved); 3, 4 stand (built after the save); 6, 7 stand (never seen: left alone)
		StockLedger.Plan p = StockLedger.plan(b, bits(0, 1, 3, 4, 6, 7), i -> false);
		assertEquals(bits(3, 4), p.ahead());
		assertEquals(bits(2), p.lost());
		// cells placed free since or another writer's now: neither ahead nor lost
		StockLedger.Plan q = StockLedger.plan(b, bits(0, 1, 3, 4), i -> i == 2 || i == 4);
		assertEquals(bits(3), q.ahead());
		assertTrue(q.lost().isEmpty());
	}

	@Test
	void applyingThePlanIsIdempotent() {
		BitSet stands = bits(0, 1, 3, 4, 5);
		StockLedger.Book b = book(range(0, 8), bits(0, 1, 2), new BitSet());
		StockLedger.Plan p = StockLedger.plan(b, stands, i -> false);
		assertEquals(bits(3, 4, 5), p.ahead());
		// 3 and 4 are charged, 5 the stock cannot pay: owed; the book then says what stands paid, every cell known
		BitSet owed = bits(5);
		BitSet standing = (BitSet) stands.clone();
		standing.andNot(owed);
		StockLedger.Book after = book(range(0, 8), standing, owed);
		StockLedger.Plan again = StockLedger.plan(after, stands, i -> false);
		assertEquals(owed, again.ahead(), "a second reconcile finds only what is still owed");
		assertTrue(again.lost().isEmpty(), "and nothing lost");
	}

	@Test
	void worldAheadChargedOnceLedgerAheadTakenOnce() {
		// delivered 10 dirt and 4 planks before the save; the saved ledger paid 2 dirt (cells 0, 1)
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(DIRT, 10, PLANKS, 4), CAP, MAX);
		for (int i = 0; i < 2; i++) {
			assertTrue(l.consume(DIRT, 1, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, DIRT, 1);
		}
		// the world ahead: 6 more dirt cells stand: the reconcile charges them, as the builder pays a cell
		for (int i = 0; i < 6; i++) {
			assertTrue(l.consume(DIRT, 1, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, DIRT, 1);
		}
		assertEquals(2, l.stock(DIRT), "the blocks that stand are no longer in the stock too");
		assertEquals(Map.of(DIRT, 8), l.paid().get(KEY));
		assertTrue(l.identityHolds());
		// the ledger ahead: 3 of the paid cells are gone: their cost back, capped by the record and taken out of it
		// (at the cells' target cost, as the record booked them; more than the record is never given: JR's cap)
		Map<String, Integer> back = l.fromPaid("s1", Map.of(DIRT, 3));
		assertEquals(Map.of(DIRT, 3), back);
		assertTrue(l.fromPaid("s9", Map.of(PLANKS, 5)).isEmpty(), "a target with no record gets nothing back");
		l.giveBack(back, CAP, MAX);
		assertEquals(Map.of(DIRT, 5), l.paid().get(KEY));
		// the builder places the 3 again and pays them: the record is the standing cells' cost again, the stock's net charge once
		for (int i = 0; i < 3; i++) {
			assertTrue(l.consume(DIRT, 1, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, DIRT, 1);
		}
		assertEquals(Map.of(DIRT, 8), l.paid().get(KEY));
		assertEquals(2, l.stock(DIRT));
		// consumed 11, given back 3 (returned holds the delivery's 10 here too): net 8, the record
		assertEquals(11, l.consumed().get(DIRT));
		assertEquals(13, l.returned().get(DIRT));
		assertEquals(8, l.consumed().get(DIRT) - (l.returned().get(DIRT) - 10));
		assertTrue(l.identityHolds());
	}

	@Test
	void anOwedCellIsNotRefundedUntilCharged() {
		// (audit note b) 3 cells charged (the record), a 4th stands owed: an undo now refunds the record, never the owed cell
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(DIRT, 3), CAP, MAX);
		for (int i = 0; i < 3; i++) {
			assertTrue(l.consume(DIRT, 1, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, DIRT, 1);
		}
		StockLedger.Credit c = l.credit(KEY, Map.of(DIRT, 4), CAP, MAX);
		assertEquals(Map.of(DIRT, 3), c.returned());
		assertEquals(Map.of(DIRT, 1), c.shortfall());
		assertTrue(l.identityHolds());
	}

	@Test
	void aSwapRefundComesOutOfTheRecord() {
		// (audit F7) a construction delta's swap gives the old block back out of the site's record (Purse.giveBackPaid -> fromPaid)
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(PLANKS, 2), CAP, MAX);
		assertTrue(l.consume(PLANKS, 2, CAP, MAX, new TreeMap<>()));
		l.pay(KEY, PLANKS, 2);
		assertEquals(Map.of(PLANKS, 1), l.fromPaid("s1", Map.of(PLANKS, 1)), "the old block, paid: back, once");
		assertEquals(Map.of(PLANKS, 1), l.paid().get(KEY), "the record no longer holds it: old + new never both");
		// the old block of a cell built after the save (the record never had it): nothing back
		assertEquals(Map.of(PLANKS, 1), l.fromPaid("s1", Map.of(PLANKS, 3)));
		assertTrue(l.fromPaid("s1", Map.of(PLANKS, 1)).isEmpty());
		assertTrue(l.fromPaid("s2", Map.of(PLANKS, 1)).isEmpty(), "a fed target with no record: nothing (no legacy pool)");
	}
}
