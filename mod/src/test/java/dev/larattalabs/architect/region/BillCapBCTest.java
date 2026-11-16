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
		assertEquals(Reason.BILL_CAP, Reason.values()[Reason.JOINT_MISMATCH.ordinal() + 2], "appended after 7c's reasons (later ones follow it: DR's REPAIR_STALE)");
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
	void theCapLeavesWhatItsRidHasNotDrawn() {
		BillCaps.Cap c = new BillCaps.Cap("rg1", "g1", Map.of("minecraft:dirt", 10), Map.of());
		assertEquals(10, left(c, Map.of()));
		assertEquals(3, left(c, Map.of("minecraft:dirt", 7)));
		assertEquals(0, left(c, Map.of("minecraft:dirt", 20)), "past it: none, never negative");
		assertEquals(0, new BillCaps.Cap("rg1", "g1", Map.of(), Map.of()).left(Map.of(), "minecraft:dirt"), "an item the cap does not name: 0");
	}

	@Test
	void aCapCoversOnlyItsOwnRid() {
		// (BC-d) the first realise's cap under rid 0; a capped revision under its rid; a plain revision clears its own rid only
		JsonObject sv = new JsonObject();
		BillCaps.record(sv, 0, Map.of("minecraft:dirt", 5), 0);
		BillCaps.record(sv, 2, Map.of("minecraft:oak_planks", 7), 1);
		BillCaps.record(sv, 3, null, 2);
		assertEquals("{\"caps\":{\"0\":{\"maxBill\":{\"minecraft:dirt\":5}},\"2\":{\"maxBill\":{\"minecraft:oak_planks\":7}}}}", sv.toString());
		assertEquals(Map.of("minecraft:dirt", 5), BillCaps.ofRegionRecord("r", "g", 0, sv, 3).max());
		assertEquals(Map.of("minecraft:oak_planks", 7), BillCaps.ofRegionRecord("r", "g", 2, sv, 3).max());
		assertNull(BillCaps.ofRegionRecord("r", "g", 3, sv, 3), "a plain revision: no cap");
		assertNull(BillCaps.ofRegionRecord("r", "g", 1, sv, 3), "a revision realised before any cap: none");
		// a reused rid (a refused plan stepped nextRid back) realised plain clears what an earlier attempt recorded
		BillCaps.record(sv, 2, null, 2);
		assertNull(BillCaps.ofRegionRecord("r", "g", 2, sv, 3));
		BillCaps.record(sv, 0, null, 2);
		assertFalse(sv.has("caps"), "the last cap cleared: no member");
		// targets: a revision's ext names its rid; none: the first realise
		JsonObject ext = JsonParser.parseString("{\"architect_mc:revision\":{\"region\":\"r\",\"rid\":4}}").getAsJsonObject();
		assertEquals(4, BillCaps.ridOf(ext));
		assertEquals(0, BillCaps.ridOf(new JsonObject()));
		assertEquals(0, BillCaps.ridOf((JsonObject) null));
	}

	@Test
	void aRecordFromBeforeBCdIsReadAsItsRidsCap() {
		// 0.72.0's one region-wide cap: an empty base was a first realise's (rid 0), else the revision's that set it (the head then)
		JsonObject first = JsonParser.parseString("{\"maxBill\":{\"minecraft:dirt\":5},\"billBase\":{}}").getAsJsonObject();
		assertEquals(Map.of("minecraft:dirt", 5), BillCaps.ofRegionRecord("r", "g", 0, first, 0).max());
		JsonObject rev = JsonParser.parseString("{\"maxBill\":{\"minecraft:dirt\":5},\"billBase\":{\"minecraft:dirt\":40}}").getAsJsonObject();
		BillCaps.Cap c = BillCaps.ofRegionRecord("r", "g", 2, rev, 2);
		assertEquals(Map.of("minecraft:dirt", 5), c.max());
		assertEquals(Map.of(), c.base(), "the rid's own draws: the old base no longer applies");
		assertNull(BillCaps.ofRegionRecord("r", "g", 0, rev, 2), "the first realise is not held by a revision's cap");
		// a later plain revision (rid 3) moves the old cap to its rid and leaves itself uncapped
		BillCaps.record(rev, 3, null, 2);
		assertEquals("{\"caps\":{\"2\":{\"maxBill\":{\"minecraft:dirt\":5}}}}", rev.toString());
		assertNull(BillCaps.ofRegionRecord("r", "g", 3, rev, 3));
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
	void theRegionsOwnChargesCountForTheirRid() {
		JsonObject sv = JsonParser.parseString("{\"on\":true,\"charged\":{\"minecraft:lava_bucket\":2,\"minecraft:iron_bars\":3},\"chargedAt\":5,"
			+ "\"mech\":{\"a\":{\"bill\":{\"minecraft:redstone\":4},\"charged\":{\"minecraft:redstone\":4},\"chargedAt\":6},"
			+ "\"b\":{\"bill\":{\"minecraft:lever\":1}},\"c\":{\"charged\":{\"minecraft:iron_bars\":1},\"refunded\":true},"
			+ "\"d\":{\"charged\":{\"minecraft:lever\":2},\"rid\":2}}}").getAsJsonObject();
		// fluids once (rid 0: no chargedRid), a charged mechanism; an uncharged one (b), a refunded one (c) and rid 2's (d) count nothing for 0
		assertEquals(Map.of("minecraft:lava_bucket", 2, "minecraft:iron_bars", 3, "minecraft:redstone", 4), BillCaps.regionCharged(sv, 0));
		assertEquals(Map.of("minecraft:lever", 2), BillCaps.regionCharged(sv, 2));
		assertEquals(Map.of(), BillCaps.regionCharged(null, 0));
		JsonObject sv2 = sv.deepCopy();
		sv2.addProperty(BillCaps.CHARGED_RID, 2); // fluids charged for revision 2
		assertEquals(Map.of("minecraft:lava_bucket", 2, "minecraft:iron_bars", 3, "minecraft:lever", 2), BillCaps.regionCharged(sv2, 2));
		BillCaps.record(sv, 0, Map.of("minecraft:iron_bars", 5, "minecraft:lava_bucket", 2, "minecraft:redstone", 4), 0);
		BillCaps.Cap c = BillCaps.ofRegionRecord("r", "g", 0, sv, 0);
		assertEquals(BillCaps.regionCharged(sv, 0), c.charged());
		var ledger = new dev.larattalabs.architect.survival.StockLedger();
		assertEquals(BillCaps.regionCharged(sv, 0), BillCaps.drawn(ledger, c), "no paid record: the region's own charges alone");
		assertEquals(Map.of(), BillCaps.chargeOver(c, ledger, Map.of("minecraft:iron_bars", 2)), "2 of 5 left after 3");
		assertEquals(Map.of("minecraft:iron_bars", 1, "minecraft:lever", 1), BillCaps.chargeOver(c, ledger, Map.of("minecraft:iron_bars", 3, "minecraft:lever",
			1)), "one bar past the cap; an unnamed item past it by its count");
		assertEquals(Map.of(), BillCaps.chargeOver(null, ledger, Map.of("minecraft:lever", 9)), "no cap: nothing over");
	}

	private static int left(BillCaps.Cap c, Map<String, Integer> drawn) {
		return c.left(drawn, "minecraft:dirt");
	}
}
