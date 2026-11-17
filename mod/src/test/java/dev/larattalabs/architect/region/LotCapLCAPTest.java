package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Quote;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.site.BillCaps;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** (LCAP, S-M5-16) maxBillPerLot: the request members, the lot's bill, the refusal's measure, both caps, the record and its reload. */
class LotCapLCAPTest {
	private static final String PL = "minecraft:oak_planks", CO = "minecraft:cobblestone", GL = "minecraft:glass_pane";

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static RealiseRequest req(Map<String, Integer> cap, Map<String, Map<String, Integer>> lots) {
		return new RealiseRequest("p1", Mode.INSTANT, null, Map.of("a", "hut"), null, true, null, false, new JsonObject(), 0, "k1", null, cap, lots);
	}

	/** Two lots bound to the same entry (they share planks), a road, a fill on lot b. */
	private static JsonObject parts() {
		return JsonParser.parseString("{\"tiles:g\":{\"minecraft:oak_planks\":9},\"road:r1\":{\"minecraft:cobblestone\":4},"
			+ "\"lot:a\":{\"minecraft:oak_planks\":40,\"minecraft:glass_pane\":2},\"lot:b\":{\"minecraft:oak_planks\":40,\"minecraft:glass_pane\":2},"
			+ "\"fill:b\":{\"minecraft:oak_planks\":3},\"mech:b\":{\"minecraft:cobblestone\":1}}").getAsJsonObject();
	}

	@Test
	void theRequestsCarryTheLotCapsSortedAndTheOldShapesHaveNone() {
		RealiseRequest r = req(null, Map.of("b", Map.of(PL, 1), "a", Map.of(PL, 2, CO, 0)));
		assertEquals(List.of("a", "b"), List.copyOf(r.maxBillPerLot().keySet()));
		assertEquals(List.of(CO, PL), List.copyOf(r.maxBillPerLot().get("a").keySet()));
		assertNull(new RealiseRequest("p1", Mode.INSTANT, null, Map.of(), null, true, null, false, new JsonObject(), 0, "k1", null, Map.of(PL, 1)).maxBillPerLot(),
			"the 1.60.0 canonical shape: no lot cap");
		assertNull(new RealiseRequest("p1", Mode.INSTANT, null, Map.of(), null, true, null, false, new JsonObject()).maxBillPerLot());
		assertEquals(r.maxBillPerLot(), r.withMaxBill(Map.of(PL, 9)).maxBillPerLot(), "withMaxBill keeps the lot caps");
		assertEquals(r.maxBillPerLot(), r.withConsent(null).maxBillPerLot(), "withConsent keeps the lot caps");
		assertNull(r.withMaxBillPerLot(null).maxBillPerLot());
		assertNull(new ApprovedRealise("sha", Mode.INSTANT, null, Map.of(), null, new JsonObject(), Map.of(PL, 1)).maxBillPerLot(), "the 1.60.0 shape");
		ApprovedRealise a = new ApprovedRealise("sha", Mode.INSTANT, null, Map.of(), null, new JsonObject(), Map.of(PL, 1)).withMaxBillPerLot(Map.of("a", Map.of(PL, 1)));
		assertEquals(Map.of("a", Map.of(PL, 1)), a.maxBillPerLot());
		assertEquals(Map.of(PL, 1), a.maxBill(), "withMaxBillPerLot keeps maxBill");
		assertThrows(IllegalArgumentException.class, () -> req(null, Map.of("a", Map.of(PL, -1))));
		assertThrows(IllegalArgumentException.class, () -> req(null, Map.of(" ", Map.of(PL, 1))));
	}

	@Test
	void aNullLotCapKeepsTheKeyedBodyHash() {
		RealiseRequest none = new RealiseRequest("p1", Mode.INSTANT, null, Map.of("a", "hut"), null, true, null, false, new JsonObject(), 0, "k1");
		String h0 = RegionKeys.hash(RegionKeys.realiseBody(none));
		assertFalse(RegionKeys.realiseBody(req(null, null)).has("maxBillPerLot"));
		assertEquals(h0, RegionKeys.hash(RegionKeys.realiseBody(req(null, null))), "a realise keyed before LCAP keeps its hash");
		assertFalse(h0.equals(RegionKeys.hash(RegionKeys.realiseBody(req(null, Map.of("a", Map.of(PL, 1)))))), "a lot cap is part of the body");
	}

	@Test
	void aLotsBillIsItsLotFillAndMechPieces() {
		Quote q = new Quote("p1", null, null, true, new JsonObject(), parts(), Map.of(), true, List.of());
		assertEquals(Map.of(PL, 40, GL, 2), q.lotBill("a"));
		assertEquals(Map.of(PL, 43, GL, 2, CO, 1), q.lotBill("b"), "lot:b + fill:b + mech:b; never the tiles or the roads");
		assertEquals(Map.of(), q.lotBill("pad"), "a pad (no entry): nothing");
	}

	@Test
	void oneLotPastItsOwnCapIsNamedWithItsItemsAndBill() {
		JsonObject p = parts();
		assertNull(Quotes.lotOver(p, Map.of("a", Map.of(PL, 40, GL, 2), "b", Map.of(PL, 43, GL, 2, CO, 1))), "each lot at its own bill: fits");
		assertArrayEquals(new String[] {"b", "oak_planks 43 > 42"}, Quotes.lotOver(p, Map.of("a", Map.of(PL, 40, GL, 2), "b", Map.of(PL, 42, GL, 2, CO, 1))),
			"the shared item: lot b past its own cap although a's cap leaves room");
		assertArrayEquals(new String[] {"a", "glass_pane 2 > 0"}, Quotes.lotOver(p, Map.of("a", Map.of(PL, 40))), "an item the lot cap does not name: 0");
		assertNull(Quotes.lotOver(p, Map.of("pad", Map.of())), "a pad's empty cap fits its empty bill");
		// an unknown lot: named (sorted) before any measure
		assertEquals("zz", Quotes.unknownLot(Map.of("a", Map.of(), "zz", Map.of()), Set.of("a", "b")));
		assertNull(Quotes.unknownLot(Map.of("a", Map.of(), "b", Map.of()), Set.of("a", "b")));
	}

	@Test
	void bothCapsApplyAndTheTighterWins() {
		// a lot cap above maxBill is accepted; the target draws what both leave (the region cap counts the whole rid, the lot cap its lot)
		BillCaps.Cap region = new BillCaps.Cap("rg1", "g1", 0, Map.of(PL, 100), Map.of(), Map.of());
		BillCaps.Cap lot = new BillCaps.Cap("rg1", "g1", 0, Map.of(PL, 500), Map.of(), Map.of(), "b");
		assertEquals(60, BillCaps.leftUnder(region, Map.of(PL, 40), lot, Map.of(PL, 10), PL), "the region cap is the tighter");
		BillCaps.Cap tight = new BillCaps.Cap("rg1", "g1", 0, Map.of(PL, 42), Map.of(), Map.of(), "b");
		assertEquals(2, BillCaps.leftUnder(region, Map.of(PL, 80), tight, Map.of(PL, 40), PL), "the lot cap is the tighter (shared item)");
		assertEquals(0, BillCaps.leftUnder(null, null, tight, Map.of(PL, 50), PL), "a lot cap alone (no maxBill)");
		assertEquals(Integer.MAX_VALUE, BillCaps.leftUnder(null, null, null, null, PL), "no cap");
		assertEquals(Map.of(PL, 5, GL, 1), BillCaps.mergeOver(Map.of(PL, 5), Map.of(PL, 3, GL, 1)), "nextNeeded: the larger of the two");
	}

	@Test
	void theLotCapsAreRecordedPerRidBesideMaxBill() {
		JsonObject sv = new JsonObject();
		BillCaps.record(sv, 0, Map.of(PL, 100), Map.of("b", Map.of(PL, 42)), 0);
		BillCaps.record(sv, 2, null, Map.of("q", Map.of(CO, 3)), 1); // a revision with lot caps and no maxBill
		assertEquals("{\"caps\":{\"0\":{\"maxBill\":{\"minecraft:oak_planks\":100},\"lots\":{\"b\":{\"minecraft:oak_planks\":42}}},\"2\":{\"lots\":{\"q\":"
			+ "{\"minecraft:cobblestone\":3}}}}}", sv.toString());
		assertEquals(Map.of(PL, 42), BillCaps.lotCapOf("rg", "g", 0, "b", sv, 2).max());
		assertNull(BillCaps.lotCapOf("rg", "g", 0, "a", sv, 2), "an uncapped lot: none");
		assertNull(BillCaps.lotCapOf("rg", "g", 2, "b", sv, 2), "lot b's cap is rid 0's only (per revision)");
		assertNull(BillCaps.ofRegionRecord("rg", "g", 2, sv, 2), "rid 2 has lot caps and no maxBill");
		assertEquals("b", BillCaps.lotCapOf("rg", "g", 0, "b", sv, 2).lot());
		// a plain revision reusing rid 2 clears its lot caps too; a capped revision replaces both
		BillCaps.record(sv, 2, null, null, 2);
		assertNull(BillCaps.lotCapOf("rg", "g", 2, "q", sv, 2));
		BillCaps.record(sv, 0, Map.of(PL, 90), null, 2);
		assertNull(BillCaps.lotCapOf("rg", "g", 0, "b", sv, 2), "a realise's caps replace its rid's entry whole");
	}

	@Test
	void theLotCapsSurviveTheRecordsSaveAndReload(@TempDir Path dir) throws Exception {
		RegionRec rec = new RegionRec("rg7", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 31, 90, 31}, 1L);
		JsonObject sv = new JsonObject();
		sv.addProperty("on", true);
		BillCaps.record(sv, 0, Map.of(PL, 100), Map.of("a", Map.of(PL, 40), "b", Map.of(PL, 42)), 0);
		// a gate mechanism charged for lot b (rid 0) counts against lot b's cap; lot a has none
		sv.add("mech", JsonParser.parseString("{\"b\":{\"charged\":{\"minecraft:cobblestone\":1},\"rid\":0}}"));
		rec.survival = sv;
		Path f = dir.resolve("region.json");
		RegionStore.writeJson(f, rec.toJson()); // the region record's save (fsync, atomic rename): BC-d's path
		RegionRec back = RegionRec.fromJson(RegionStore.readJson(f)); // a restart reads it back
		assertEquals(Map.of("a", Map.of(PL, 40), "b", Map.of(PL, 42)), BillCaps.lotCaps(back.survival, 0, back.headRid));
		BillCaps.Cap b = BillCaps.lotCapOf("rg7", "g", 0, "b", back.survival, back.headRid);
		assertNotNull(b);
		assertEquals(Map.of(CO, 1), b.charged(), "its mechanism's charge");
		assertEquals(Map.of(), BillCaps.lotCapOf("rg7", "g", 0, "a", back.survival, back.headRid).charged());
		assertEquals(Map.of(PL, 100), BillCaps.ofRegionRecord("rg7", "g", 0, back.survival, back.headRid).max(), "maxBill beside it");
		// recovery enforces it: past the lot's cap after the reload, its room is negative and its overshoot named
		assertEquals(Map.of(PL, 3, CO, 1), b.overshoot(Map.of(PL, 45, CO, 1)), "the mech's cobblestone: an item lot b's cap does not name");
	}

	@Test
	void aRegionRecordThatCannotBeSavedIsReportedAndRefusedTyped(@TempDir Path dir) throws Exception {
		// (LCAP, rule 17, the review's P1) the realise's and the revision's publication call saveConfirmed (writeRec): a failed write throws
		RegionRec rec = new RegionRec("rg8", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 31, 90, 31}, 1L);
		rec.survival = new JsonObject();
		BillCaps.record(rec.survival, 0, Map.of(PL, 100), Map.of("b", Map.of(PL, 42)), 0);
		RegionStore.failNext = "region.json";
		java.io.IOException e = assertThrows(java.io.IOException.class, () -> RegionsImpl.writeRec(dir, rec));
		assertFalse(java.nio.file.Files.exists(RegionStore.region(dir, "rg8").resolve("region.json")), "nothing on disk");
		RegionsImpl.RegionException r = RegionsImpl.recordUnsaved("region rg8", e);
		assertEquals(dev.larattalabs.architect.api.Reason.JOURNAL_UNAVAILABLE, r.reason);
		assertEquals("region_record", r.detail());
		// once: the next write goes through, and carries the caps
		RegionsImpl.writeRec(dir, rec);
		RegionRec back = RegionRec.fromJson(RegionStore.readJson(RegionStore.region(dir, "rg8").resolve("region.json")));
		assertEquals(Map.of("b", Map.of(PL, 42)), BillCaps.lotCaps(back.survival, 0, 0));
		assertNull(RegionStore.failNext);
	}

	@Test
	void aBillCapWaitNamesTheCapItHit() {
		// (LCAP-Q1) SiteWait.capScope: region, lot:<id>, or both (lot first); the old shapes have none
		assertEquals("lot:b", BillCaps.scopeOf(Map.of(), Map.of(PL, 3), "b"));
		assertEquals("region", BillCaps.scopeOf(Map.of(PL, 3), Map.of(), "b"));
		assertEquals("lot:b,region", BillCaps.scopeOf(Map.of(PL, 3), Map.of(PL, 1), "b"));
		assertEquals("region", BillCaps.scopeOf(Map.of(PL, 3), Map.of(), null), "no lot cap");
		assertNull(new dev.larattalabs.architect.api.SiteWait("s1", true, 0L, List.of(), 0, dev.larattalabs.architect.api.SiteWait.BILL_CAP, List.of()).capScope());
		assertEquals("lot:b", new dev.larattalabs.architect.api.SiteWait("s1", true, 0L, List.of(), 0, dev.larattalabs.architect.api.SiteWait.BILL_CAP, List.of(), "lot:b")
			.capScope());
	}
}
