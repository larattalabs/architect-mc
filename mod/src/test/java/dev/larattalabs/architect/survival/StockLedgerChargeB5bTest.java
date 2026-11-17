package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.BillCaps;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/**
 * (fix b5b, the GPT review's finding 3) A region charge (fluids, a gate mechanism) is booked in the ledger with its key in the same change as
 * its debit. A crash after the ledger's save and before the region record's: the saved ledger holds the charge, the record does not. The
 * replay debits nothing again, and the record settled from the ledger counts the charge in its rid's cap (no second payment fits past it).
 */
class StockLedgerChargeB5bTest {
	private static final String BARS = "minecraft:iron_bars";

	@Test
	void aChargeReplayedAfterACrashIsPaidOnceAndCounted() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(BARS, 20), 99, k -> 64);
		String key = "region:rg1@5:mech:gate_a:charge@100";
		Map<String, Integer> bill = Map.of(BARS, 6);
		assertTrue(l.chargeOnce(key, bill, 2, 99, k -> 64, new TreeMap<>()));
		assertEquals(14, l.stock(BARS));
		// the ledger saved, then the halt: the record (survival.mech.gate_a) was not
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(l.toJson().toString()).getAsJsonObject());
		assertEquals(14, back.stock(BARS));
		assertNotNull(back.charged(key));
		assertEquals(new StockLedger.Charge(bill, 2), back.charged(key));
		// the replay: nothing debited again
		assertFalse(back.chargeOnce(key, bill, 2, 99, k -> 64, new TreeMap<>()));
		assertEquals(14, back.stock(BARS), "paid once");
		// the record settled from the ledger: the cap of rid 2 counts it (a cap of 8 has 2 left, so a second 6 does not fit)
		JsonObject sv = JsonParser.parseString("{\"on\":true,\"mech\":{\"gate_a\":{\"bill\":{\"minecraft:iron_bars\":6},\"chargeKey\":\"" + key + "\"}}}")
			.getAsJsonObject();
		assertEquals(Map.of(), BillCaps.regionCharged(sv, 2), "the lost record counts nothing");
		dev.larattalabs.architect.site.MechCharges.settle(sv.getAsJsonObject("mech").getAsJsonObject("gate_a"), back.charged(key), 7L);
		assertEquals(bill, BillCaps.regionCharged(sv, 2));
		BillCaps.record(sv, 2, Map.of(BARS, 8), 2);
		BillCaps.Cap cap = BillCaps.ofRegionRecord("rg1", "g", 2, sv, 2);
		assertEquals(Map.of(BARS, 4), BillCaps.chargeOver(cap, back, Map.of(BARS, 6)), "a second 6 is past the cap by 4");
	}

	@Test
	void anUnkeyedOrNewKeyChargesAndAnOldFileReadsNone() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(BARS, 10), 99, k -> 64);
		assertTrue(l.chargeOnce("a", Map.of(BARS, 3), 0, 99, k -> 64, new TreeMap<>()));
		assertTrue(l.chargeOnce("b", Map.of(BARS, 3), 0, 99, k -> 64, new TreeMap<>()));
		assertEquals(4, l.stock(BARS));
		StockLedger old = StockLedger.fromJson(JsonParser.parseString("{\"delivered\":{\"minecraft:iron_bars\":4},\"paid\":{}}").getAsJsonObject());
		assertEquals(null, old.charged("a"));
		assertFalse(old.toJson().has("charges"), "nothing booked: the member is absent (additive)");
	}
}
