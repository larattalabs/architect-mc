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
		assertEquals("{\"maxBill\":{\"minecraft:dirt\":10},\"billBase\":{\"minecraft:dirt\":4},\"billRegion\":true}", sv.toString());
		assertEquals(10, left(c, Map.of("minecraft:dirt", 4)), "nothing drawn since the base");
		assertEquals(3, left(c, Map.of("minecraft:dirt", 11)));
		assertEquals(0, left(c, Map.of("minecraft:dirt", 20)), "past it: none, never negative");
		assertEquals(10, left(c, Map.of("minecraft:dirt", 1)), "refunds below the base do not raise it");
		assertEquals(0, new BillCaps.Cap("rg1", "g1", Map.of(), Map.of()).left(Map.of(), "minecraft:dirt"), "an item the cap does not name: 0");
	}

	@Test
	void pastTheCapTheRoomIsNegativeAndTheOvershootNamed() {
		// (BC-c) a reconcile charged standing cells past the cap: left stays 0, room and overshoot give the units over
		BillCaps.Cap c = new BillCaps.Cap("rg1", "g1", Map.of("minecraft:dirt", 10, "minecraft:oak_planks", 5), Map.of("minecraft:dirt", 4));
		Map<String, Integer> drawn = Map.of("minecraft:dirt", 17, "minecraft:oak_planks", 5, "minecraft:lantern", 2);
		assertEquals(0, c.left(drawn, "minecraft:dirt"));
		assertEquals(-3, c.room(drawn, "minecraft:dirt"), "13 drawn since the base, 10 allowed");
		assertEquals(0, c.room(drawn, "minecraft:oak_planks"), "at the cap: no room, not over");
		assertEquals(Map.of("minecraft:dirt", 3, "minecraft:lantern", 2), c.overshoot(drawn), "an item the cap does not name is capped at 0");
		assertEquals(Map.of(), c.overshoot(Map.of("minecraft:dirt", 14)), "within it: none");
		assertEquals(Map.of(), new BillCaps.Cap("rg1", "g1", Map.of("minecraft:dirt", 1), Map.of()).charged(), "the old shape counts no region charge");
	}

	@Test
	void theRegionsOwnChargesCountOnlyForACapRecordedSinceBCc() {
		JsonObject sv = JsonParser.parseString("{\"on\":true,\"charged\":{\"minecraft:lava_bucket\":2,\"minecraft:iron_bars\":3},\"chargedAt\":5,"
			+ "\"mech\":{\"a\":{\"bill\":{\"minecraft:redstone\":4},\"charged\":{\"minecraft:redstone\":4},\"chargedAt\":6},"
			+ "\"b\":{\"bill\":{\"minecraft:lever\":1}},\"c\":{\"charged\":{\"minecraft:iron_bars\":1},\"refunded\":true}}}").getAsJsonObject();
		// fluids once, a charged mechanism; an uncharged one (b) and a refunded one (c) count nothing
		assertEquals(Map.of("minecraft:lava_bucket", 2, "minecraft:iron_bars", 3, "minecraft:redstone", 4), BillCaps.regionCharged(sv));
		assertEquals(Map.of(), BillCaps.regionCharged(null));
		// a cap recorded before BC-c (no billRegion): its base left the charges out, so its draws do too
		JsonObject old = sv.deepCopy();
		old.add("maxBill", JsonParser.parseString("{\"minecraft:iron_bars\":3}"));
		old.add("billBase", new JsonObject());
		BillCaps.Cap c0 = BillCaps.ofRegionRecord("r", "g", old);
		assertEquals(Map.of(), c0.charged());
		// since BC-c: counted; a charge past what is left is named, nothing over when it fits
		BillCaps.record(sv, Map.of("minecraft:iron_bars", 5, "minecraft:lava_bucket", 2, "minecraft:redstone", 4), Map.of());
		BillCaps.Cap c = BillCaps.ofRegionRecord("r", "g", sv);
		assertEquals(BillCaps.regionCharged(sv), c.charged());
		var ledger = new dev.larattalabs.architect.survival.StockLedger();
		assertEquals(Map.of("minecraft:iron_bars", 3, "minecraft:lava_bucket", 2), BillCaps.drawn(ledger, c).entrySet().stream().filter(e -> !e.getKey().equals(
			"minecraft:redstone")).collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue)));
		assertEquals(Map.of(), BillCaps.chargeOver(c, ledger, Map.of("minecraft:iron_bars", 2)), "2 of 5 left after 3");
		assertEquals(Map.of("minecraft:iron_bars", 1, "minecraft:lever", 1), BillCaps.chargeOver(c, ledger, Map.of("minecraft:iron_bars", 3, "minecraft:lever",
			1)), "one bar past the cap; an unnamed item past it by its count");
		assertEquals(Map.of(), BillCaps.chargeOver(null, ledger, Map.of("minecraft:lever", 9)), "no cap: nothing over");
		// a revision's base counts them too, so its own draws start at zero
		assertEquals(BillCaps.regionCharged(sv), BillCaps.base(ledger, "g", sv));
	}

	private static int left(BillCaps.Cap c, Map<String, Integer> drawn) {
		return c.left(drawn, "minecraft:dirt");
	}
}
