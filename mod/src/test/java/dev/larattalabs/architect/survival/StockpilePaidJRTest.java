package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * Slice JR: the stockpile ledger's per-target paid record. A keyed refund never credits more than the record (the saved ledger's
 * consumption for that target): the same item first, then unit for unit (copper and soil variants); a partial refund reports its
 * shortfall; the record goes with its refund; a retake takes out of it; a key with no record credits as before; the record is saved
 * with the ledger and a file without it loads with none.
 */
class StockpilePaidJRTest {
	static final String COBBLE = "minecraft:cobblestone";
	static final String DIRT = "minecraft:dirt";
	static final String GRASS = "minecraft:grass_block";
	static final String COPPER = "minecraft:copper_block";
	static final String WEATHERED = "minecraft:weathered_copper";
	static final String GRAVEL = "minecraft:gravel";
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;
	static final String KEY = "site:s1@100";

	static StockLedger fed(Map<String, Integer> consumed) {
		StockLedger l = new StockLedger();
		consumed.forEach((k, v) -> {
			l.giveBack(Map.of(k, v), CAP, MAX); // in stock (as delivered would be)
			assertTrue(l.consume(k, v, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, k, v);
		});
		return l;
	}

	@Test
	void sameItemFirstThenUnitForUnit() {
		StockLedger l = fed(Map.of(COPPER, 2, DIRT, 5));
		// a weathered copper block stands where a copper block was paid, a grass block where dirt was: refunded unit for unit
		StockLedger.Credit c = l.credit(KEY, Map.of(COPPER, 1, WEATHERED, 1, GRASS, 2, DIRT, 3), CAP, MAX);
		assertEquals(Map.of(COPPER, 1, WEATHERED, 1, GRASS, 2, DIRT, 3), c.returned());
		assertTrue(c.shortfall().isEmpty());
		assertTrue(l.identityHolds());
		assertFalse(l.tracks("s1"), "the record goes with its refund");
	}

	@Test
	void partialRefundWhenTheRecordIsSmaller() {
		// the crash: the saved ledger recorded 3 cobblestone for the site, 10 stand in the saved world
		StockLedger l = fed(Map.of(COBBLE, 3));
		StockLedger.Credit c = l.credit(KEY, Map.of(COBBLE, 10, GRAVEL, 4), CAP, MAX);
		assertEquals(3, c.returned().values().stream().mapToInt(Integer::intValue).sum(), "never more units than the record");
		assertEquals(Map.of(COBBLE, 3), c.returned());
		assertEquals(Map.of(COBBLE, 7, GRAVEL, 4), c.shortfall());
		assertEquals(0, l.stock(COBBLE) - 3, "the stock back to what was in it before the target consumed");
		assertTrue(l.identityHolds());
	}

	@Test
	void nothingRecordedNothingMinted() {
		StockLedger l = fed(Map.of());
		l.pay(KEY, COBBLE, 0); // no record made by a zero
		StockLedger.Credit c = l.credit(KEY, Map.of(COBBLE, 5), CAP, MAX);
		assertEquals(Map.of(COBBLE, 5), c.returned(), "a key with no record credits as before (consumption before JR)");
		StockLedger m = new StockLedger();
		m.pay(KEY, DIRT, 1);
		StockLedger.Credit d = m.credit(KEY, Map.of(COBBLE, 5, DIRT, 2), CAP, MAX);
		assertEquals(1, d.returned().values().stream().mapToInt(Integer::intValue).sum());
	}

	@Test
	void creditedOnceAndRecordDropped() {
		StockLedger l = fed(Map.of(COBBLE, 4));
		l.credit(KEY, Map.of(COBBLE, 4), CAP, MAX);
		assertTrue(l.credit(KEY, Map.of(COBBLE, 4), CAP, MAX).already());
		StockLedger e = fed(Map.of(COBBLE, 4));
		e.dropPaid(KEY);
		assertFalse(e.tracks("s1"));
	}

	@Test
	void retakeTakesOutOfTheRecord() {
		StockLedger l = fed(Map.of(COBBLE, 5));
		assertEquals(Map.of(COBBLE, 2), l.fromPaid("s1", Map.of(COBBLE, 2)));
		assertEquals(Map.of(COBBLE, 3), l.paid().get(KEY));
		assertEquals(Map.of(COBBLE, 3), l.fromPaid("s1", Map.of(COBBLE, 9)), "capped by what is left");
		assertFalse(l.tracks("s1"), "spent: the record is gone");
		assertEquals(Map.of(COBBLE, 9), l.fromPaid("s1", Map.of(COBBLE, 9)), "no record: as it is");
		StockLedger r = new StockLedger();
		r.pay("road:c10@7", GRAVEL, 6);
		assertTrue(r.tracks("c10"));
		assertFalse(r.tracks("c1"), "an id is matched whole, not as a prefix");
	}

	@Test
	void savedWithTheLedgerAndOldFilesLoad() {
		StockLedger l = fed(Map.of(COBBLE, 3, DIRT, 2));
		JsonObject j = l.toJson();
		assertTrue(j.has("paid"));
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(j.toString()).getAsJsonObject());
		assertEquals(l.paid(), back.paid());
		assertEquals(l.consumed(), back.consumed());
		// a file written before JR: no paid field, no records, credits as before
		JsonObject old = l.toJson();
		old.remove("paid");
		StockLedger o = StockLedger.fromJson(old);
		assertTrue(o.paid().isEmpty());
		assertEquals(Map.of(COBBLE, 7), o.credit(KEY, Map.of(COBBLE, 7), CAP, MAX).returned());
		assertFalse(new StockLedger().toJson().has("paid"), "no records: the file as before");
	}
}
