package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.SiteWait;
import dev.larattalabs.architect.batch.BatchKeys;
import dev.larattalabs.architect.site.BillCaps;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** (BC, S-M5-9) maxBill: the request members, the refusal's measure, the cap's arithmetic and its record. */
class BillCapBCTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static RealiseRequest req(Map<String, Integer> cap) {
		return new RealiseRequest("p1", Mode.INSTANT, null, Map.of("a", "hut"), null, true, null, false, new JsonObject(), 0, "k1", null, cap);
	}

	@Test
	void theRequestCarriesTheCapSortedAndTheOldShapesHaveNone() {
		RealiseRequest r = req(Map.of("minecraft:dirt", 5, "minecraft:cobblestone", 2));
		assertEquals(List.of("minecraft:cobblestone", "minecraft:dirt"), List.copyOf(r.maxBill().keySet()));
		assertNull(new RealiseRequest("p1", Mode.INSTANT, null, Map.of(), null, true, null, false, new JsonObject(), 0, "k1").maxBill());
		assertNull(new RealiseRequest("p1", Mode.INSTANT, null, Map.of(), null, true, null, false, new JsonObject()).maxBill());
		assertEquals(r.maxBill(), r.withConsent(null).maxBill(), "withConsent keeps the cap");
		assertNull(r.withMaxBill(null).maxBill());
		assertNull(new ApprovedRealise("sha", Mode.INSTANT, null, Map.of(), null, new JsonObject()).maxBill());
		assertEquals(Map.of("minecraft:dirt", 1), new ApprovedRealise("sha", Mode.INSTANT, null, Map.of(), null, new JsonObject(), Map.of("minecraft:dirt", 1))
			.maxBill());
		assertThrows(IllegalArgumentException.class, () -> req(Map.of("minecraft:dirt", -1)));
		assertEquals(SiteWait.BILL_CAP, "bill_cap");
		assertEquals(Reason.BILL_CAP, Reason.values()[Reason.values().length - 1], "appended last");
	}

	@Test
	void aNullCapKeepsTheKeyedBodyHash() {
		// a realise keyed before the cap keeps its body hash: a null maxBill leaves no key; a cap changes it
		RealiseRequest none = new RealiseRequest("p1", Mode.INSTANT, null, Map.of("a", "hut"), null, true, null, false, new JsonObject(), 0, "k1");
		assertFalse(RegionKeys.realiseBody(none).has("maxBill"));
		String h0 = RegionKeys.hash(RegionKeys.realiseBody(none));
		assertEquals(h0, RegionKeys.hash(RegionKeys.realiseBody(req(null))));
		assertFalse(h0.equals(RegionKeys.hash(RegionKeys.realiseBody(req(Map.of("minecraft:dirt", 5))))));
		assertTrue(BatchKeys.json(req(Map.of("minecraft:dirt", 5)), true).getAsJsonObject().has("maxBill"));
	}

	@Test
	void theBillPastTheCapIsNamed() {
		JsonObject bom = JsonParser.parseString("{\"minecraft:dirt\":10,\"minecraft:lantern\":2,\"minecraft:oak_log\":4}").getAsJsonObject();
		assertEquals(List.of(), Quotes.overCap(bom, Map.of("minecraft:dirt", 10, "minecraft:lantern", 2, "minecraft:oak_log", 4)), "at the cap: fits");
		assertEquals(List.of("dirt 10 > 9", "oak_log 4 > 0"), Quotes.overCap(bom, Map.of("minecraft:dirt", 9, "minecraft:lantern", 5)),
			"an item the cap does not name is capped at 0");
		assertEquals(List.of(), Quotes.overCap(new JsonObject(), Map.of()));
	}

	@Test
	void theCapLeavesWhatTheGroupHasNotDrawnSinceItsBase() {
		BillCaps.Cap c = new BillCaps.Cap("rg1", "g1", Map.of("minecraft:dirt", 10), Map.of("minecraft:dirt", 4));
		JsonObject sv = new JsonObject();
		BillCaps.record(sv, c.max(), c.base());
		assertEquals("{\"maxBill\":{\"minecraft:dirt\":10},\"billBase\":{\"minecraft:dirt\":4}}", sv.toString());
		assertEquals(10, left(c, Map.of("minecraft:dirt", 4)), "nothing drawn since the base");
		assertEquals(3, left(c, Map.of("minecraft:dirt", 11)));
		assertEquals(0, left(c, Map.of("minecraft:dirt", 20)), "past it: none, never negative");
		assertEquals(10, left(c, Map.of("minecraft:dirt", 1)), "refunds below the base do not raise it");
		assertEquals(0, new BillCaps.Cap("rg1", "g1", Map.of(), Map.of()).left(Map.of(), "minecraft:dirt"), "an item the cap does not name: 0");
	}

	private static int left(BillCaps.Cap c, Map<String, Integer> drawn) {
		return c.left(drawn, "minecraft:dirt");
	}
}
