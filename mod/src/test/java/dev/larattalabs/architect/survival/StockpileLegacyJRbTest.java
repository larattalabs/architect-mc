package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * Slice JR-b (docs/CONTRACT.md "Slice JR-b, the legacy pool"; audit F3): the legacy pool is stamped with the time of its conversion
 * ({@code legacySince}, wall-clock ms like a target's {@code placedAt}); only a target placed before it draws on the pool, after its own
 * record; a target placed at or after it never does (its crash refund is its record, as JR's); an adopted crate's placed counts are keyed
 * to the targets it fed (capped by the crate) and never grow the pool; a v0.64.0 file (records and a pool, no stamp) takes the v0.64.0
 * release time.
 */
class StockpileLegacyJRbTest {
	static final String COBBLE = "minecraft:cobblestone";
	static final String DIRT = "minecraft:dirt";
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;
	static final long T = 1_800_000_000_000L; // the conversion (this load)

	/** A v0.63.0 ledger: delivered 20 cobblestone, consumed 12 (no paid field): its pool is cobblestone 12. */
	static JsonObject v063() {
		return JsonParser.parseString("{\"delivered\":{\"" + COBBLE + "\":20},\"returned\":{},\"consumed\":{\"" + COBBLE + "\":12},\"withdrawn\":{},"
			+ "\"dropped\":{},\"refundOverflow\":{},\"credited\":[]}").getAsJsonObject();
	}

	@Test
	void theConversionIsStampedAndSavedOnce() {
		StockLedger l = StockLedger.fromJson(v063(), T);
		assertEquals(Map.of(COBBLE, 12), l.legacy());
		assertEquals(T, l.legacySince());
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(l.toJson().toString()).getAsJsonObject(), T + 99_000);
		assertEquals(T, back.legacySince(), "read back, never restamped at a later load");
		assertEquals(l.legacy(), back.legacy());
		assertEquals(0, StockLedger.fromJson(new StockLedger().toJson(), T).legacySince(), "a ledger with no pool has no stamp");
		assertFalse(new StockLedger().toJson().has("legacySince"));
	}

	@Test
	void aPostJrTargetNeverDrawsThePool() {
		// K5 / RVU2 after a crash in an upgraded world: the target was placed after the conversion and fed after the save: no record
		StockLedger l = StockLedger.fromJson(v063(), T);
		StockLedger.Credit c = l.credit("site:hall_1@" + (T + 5_000), Map.of(COBBLE, 9), CAP, MAX);
		assertTrue(c.returned().isEmpty(), "nothing minted out of the pool");
		assertEquals(Map.of(COBBLE, 9), c.shortfall());
		assertEquals(Map.of(COBBLE, 12), l.legacy(), "the pool untouched");
		// with a record: capped by it, the pool still untouched
		l.pay("road:c1@" + (T + 7_000), COBBLE, 2);
		assertEquals(Map.of(COBBLE, 2), l.credit("road:c1@" + (T + 7_000), Map.of(COBBLE, 6), CAP, MAX).returned());
		assertEquals(Map.of(COBBLE, 12), l.legacy());
		assertFalse(l.mayDrawLegacy(T), "placed at the conversion: post-JR");
		assertFalse(l.mayDrawLegacy(-1), "unknown: never");
	}

	@Test
	void aPreJrTargetStillRefundsFromThePool() {
		StockLedger l = StockLedger.fromJson(v063(), T);
		String pre = "site:cottage_1@" + (T - 60_000);
		l.pay(pre, COBBLE, 3); // fed after the upgrade: its record first, the pool for what it consumed before
		assertEquals(Map.of(COBBLE, 10), l.credit(pre, Map.of(COBBLE, 10), CAP, MAX).returned(), "3 by its record, 7 from the pool");
		assertEquals(Map.of(COBBLE, 5), l.legacy());
		assertTrue(l.identityHolds());
	}

	@Test
	void retakesAndDeltasFollowTheTargetsPlacedAt() {
		StockLedger l = StockLedger.fromJson(v063(), T);
		l.pay("site:old@" + (T - 1), COBBLE, 1);
		l.pay("site:new@" + (T + 1), COBBLE, 1);
		assertEquals(Map.of(COBBLE, 4), l.fromPaid("old", Map.of(COBBLE, 4)), "a pre-JR target's retake: record, then pool");
		assertEquals(Map.of(COBBLE, 1), l.fromPaid("new", Map.of(COBBLE, 4)), "a post-JR target's retake: its record only");
		assertTrue(l.fromPaid("none", Map.of(COBBLE, 4)).isEmpty(), "no record: no placedAt known, never the pool");
		assertEquals(Map.of(COBBLE, 9), l.legacy());
		StockLedger d = StockLedger.fromJson(v063(), T);
		d.pay("site:s9@" + (T + 1), COBBLE, 1);
		assertEquals(Map.of(COBBLE, 1), d.credit("delta:e1:s9", Map.of(COBBLE, 5), CAP, MAX).returned(), "a post-JR site's delta: its record only");
		assertTrue(d.credit("delta:e1:s8", Map.of(COBBLE, 5), CAP, MAX).returned().isEmpty(), "a delta of a site with no record: never the pool");
		assertEquals(Map.of(COBBLE, 12), d.legacy());
	}

	@Test
	void aV064FileTakesTheReleaseTime() {
		JsonObject f = StockLedger.fromJson(v063(), T).toJson();
		f.remove("legacySince"); // what v0.64.0 wrote: paid and legacy, no stamp
		StockLedger l = StockLedger.fromJson(f, T + 1_000_000);
		assertEquals(StockLedger.JR_RELEASED_MS, l.legacySince());
		assertTrue(l.mayDrawLegacy(StockLedger.JR_RELEASED_MS - 1));
		assertFalse(l.mayDrawLegacy(StockLedger.JR_RELEASED_MS));
		assertEquals(Map.of(COBBLE, 12), l.legacy());
	}

	@Test
	void anAdoptionKeysTheCratesTargetsAndNeverGrowsThePool() {
		StockLedger l = StockLedger.fromJson(v063(), T);
		Map<String, Map<String, Integer>> by = new LinkedHashMap<>();
		by.put("site:a@" + (T + 1), Map.of(COBBLE, 4, DIRT, 9)); // more dirt than the crate placed: capped by the crate
		by.put("road:r@" + (T + 2), Map.of(COBBLE, 4)); // only 2 cobblestone left for it
		l.adopt("adopt:group:g@1", Map.of(COBBLE, 10, DIRT, 3), Map.of(COBBLE, 6, DIRT, 2), by, CAP, MAX);
		assertEquals(Map.of(COBBLE, 12), l.legacy(), "an adoption never grows the pool");
		assertEquals(Map.of(COBBLE, 4, DIRT, 2), l.paid().get("site:a@" + (T + 1)));
		assertEquals(Map.of(COBBLE, 2), l.paid().get("road:r@" + (T + 2)));
		assertEquals(12, l.stock(COBBLE), "the stock grows by the crate's stock (8 + 4)");
		assertEquals(1, l.stock(DIRT));
		assertTrue(l.identityHolds());
		// a post-JR adopted target's normal undo: refunded what the crate paid for it
		assertEquals(Map.of(COBBLE, 4, DIRT, 2), l.credit("site:a@" + (T + 1), Map.of(COBBLE, 4, DIRT, 2), CAP, MAX).returned());
		// the 5-arg overload (no targets) keys nothing and pools nothing
		StockLedger m = new StockLedger();
		m.adopt("adopt:x", Map.of(COBBLE, 5), Map.of(COBBLE, 3), CAP, MAX);
		assertTrue(m.legacy().isEmpty() && m.paid().isEmpty());
	}

	@Test
	void placedAtOfAKey() {
		assertEquals(123L, StockLedger.placedAtOf("site:s1@123"));
		assertEquals(7L, StockLedger.placedAtOf("road:c@7"));
		assertEquals(-1L, StockLedger.placedAtOf("site:s1"));
		assertEquals(-1L, StockLedger.placedAtOf("site:s1@x"));
	}
}
