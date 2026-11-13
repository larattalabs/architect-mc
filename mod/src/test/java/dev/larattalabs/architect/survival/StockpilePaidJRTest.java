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
 * shortfall; the record goes with its refund; a retake takes out of it; a target key with no record credits nothing (it was fed after
 * the save) but what the legacy pool covers (a file written before JR, an adopted crate); other keys are not capped; the record is saved
 * with the ledger.
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
		// the crash: the target was fed after the ledger's save, so the saved ledger has no record of it: nothing is credited
		StockLedger l = fed(Map.of());
		l.pay(KEY, COBBLE, 0); // no record made by a zero
		StockLedger.Credit c = l.credit(KEY, Map.of(COBBLE, 5), CAP, MAX);
		assertTrue(c.returned().isEmpty());
		assertEquals(Map.of(COBBLE, 5), c.shortfall());
		StockLedger m = new StockLedger();
		m.pay(KEY, DIRT, 1);
		StockLedger.Credit d = m.credit(KEY, Map.of(COBBLE, 5, DIRT, 2), CAP, MAX);
		assertEquals(1, d.returned().values().stream().mapToInt(Integer::intValue).sum());
		// keys that are not a feed target's (a region's fluids, a mechanism, a retake's own key) are not capped
		assertEquals(Map.of(COBBLE, 5), new StockLedger().credit("fluids:rg1@1", Map.of(COBBLE, 5), CAP, MAX).returned());
	}

	@Test
	void legacyPoolFromAnOldFileAndAnAdoptedCrate() {
		// a file written before JR: delivered 10 cobblestone and 4 dirt, consumed 8 and 4, 2 dirt returned: the pool is cobblestone 8, dirt 2
		JsonObject old = JsonParser.parseString("{\"delivered\":{\"" + COBBLE + "\":10,\"" + DIRT + "\":4},\"returned\":{\"" + DIRT + "\":2},"
			+ "\"consumed\":{\"" + COBBLE + "\":8,\"" + DIRT + "\":4},\"credited\":[]}").getAsJsonObject();
		StockLedger o = StockLedger.fromJson(old);
		assertTrue(o.paid().isEmpty());
		assertEquals(Map.of(COBBLE, 8, DIRT, 2), o.legacy());
		assertEquals(Map.of(COBBLE, 5), o.credit(KEY, Map.of(COBBLE, 5), CAP, MAX).returned(), "a pre-JR target refunds from the pool");
		assertEquals(Map.of(COBBLE, 3, DIRT, 2), o.legacy());
		// a target fed after the upgrade: its record first, the pool for what predates it
		o.pay("road:c2@5", COBBLE, 3);
		assertEquals(Map.of(COBBLE, 4), o.credit("road:c2@5", Map.of(COBBLE, 4), CAP, MAX).returned(), "3 by its record, 1 from the pool");
		assertEquals(Map.of(COBBLE, 2, DIRT, 2), o.legacy());
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(o.toJson().toString()).getAsJsonObject());
		assertEquals(o.legacy(), back.legacy(), "the pool is saved: the conversion happens once");
		// an adopted crate's placed counts join the pool
		StockLedger a = new StockLedger();
		a.adopt("adopt:x", Map.of(COBBLE, 5), Map.of(COBBLE, 3), CAP, MAX);
		assertEquals(Map.of(COBBLE, 3), a.legacy());
		assertEquals(Map.of(COBBLE, 3), a.credit("site:old@1", Map.of(COBBLE, 3), CAP, MAX).returned());
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
	void aDeltaRefundsFromItsSitesRecord() {
		StockLedger l = fed(Map.of(COBBLE, 5));
		StockLedger.Credit c = l.credit("delta:e1:s1", Map.of(COBBLE, 2), CAP, MAX);
		assertEquals(Map.of(COBBLE, 2), c.returned());
		assertEquals(Map.of(COBBLE, 3), l.paid().get(KEY), "taken out of the site's record");
		StockLedger.Credit d = l.credit("delta:e2:s1", Map.of(COBBLE, 9), CAP, MAX);
		assertEquals(Map.of(COBBLE, 3), d.returned());
		assertEquals(Map.of(COBBLE, 6), d.shortfall());
		assertTrue(new StockLedger().credit("delta:e1:s9", Map.of(COBBLE, 1), CAP, MAX).returned().isEmpty(), "a delta fed after the save: nothing");
		assertEquals("s1", StockLedger.deltaSite("delta:e1:s1"));
		assertEquals(null, StockLedger.deltaSite("site:s1@1"));
	}

	@Test
	void retakeTakesOutOfTheRecord() {
		StockLedger l = fed(Map.of(COBBLE, 5));
		assertEquals(Map.of(COBBLE, 2), l.fromPaid("s1", Map.of(COBBLE, 2)));
		assertEquals(Map.of(COBBLE, 3), l.paid().get(KEY));
		assertEquals(Map.of(COBBLE, 3), l.fromPaid("s1", Map.of(COBBLE, 9)), "capped by what is left");
		assertFalse(l.tracks("s1"), "spent: the record is gone");
		assertTrue(l.fromPaid("s1", Map.of(COBBLE, 9)).isEmpty(), "no record (fed after the save): nothing");
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
		// a file written before JR (no paid field): no records; its consumption less its returns is the legacy pool
		JsonObject old = l.toJson();
		old.remove("paid");
		StockLedger o = StockLedger.fromJson(old);
		assertTrue(o.paid().isEmpty());
		assertTrue(new StockLedger().toJson().has("paid"), "the marker of a ledger that keeps records");
	}
}
