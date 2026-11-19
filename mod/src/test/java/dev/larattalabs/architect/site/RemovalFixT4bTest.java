package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4b fix round: the GPT review of 50c4a15f) Each fix's unit, failing first on 50c4a15f (the methods or the guards it reads are not
 * there); the in-game rows are t4-crash's T4-nojournal, T4-mine, T4-legacy, T4-pileroad, T4-wnf and T4-2nd-b.
 */
class RemovalFixT4bTest {
	static final String SITE = "src/main/java/dev/larattalabs/architect/site/";

	static String read(String f) throws Exception {
		return Files.readString(Path.of(f));
	}

	/** N3: a refund pays min(planned, found by its restore), per item; nothing found pays nothing; no record pays the plan. */
	@Test
	void aRefundPaysTheMinOfPlannedAndFound() {
		Map<String, Integer> planned = Map.of("minecraft:cobblestone", 10, "minecraft:oak_planks", 4);
		assertEquals(Map.of("minecraft:cobblestone", 7, "minecraft:oak_planks", 4), CrateSettle.minOf(planned, Map.of("minecraft:cobblestone", 7,
			"minecraft:oak_planks", 9, "minecraft:dirt", 3)));
		assertEquals(Map.of(), CrateSettle.minOf(planned, Map.of()));
		assertEquals(planned, CrateSettle.minOf(planned, null));
	}

	/** Finding 4: a pre-T4 held pending credit becomes a pile stash for a site or a road; any other key stays legacy. */
	@Test
	void aPreT4PendingCreditBecomesAPileStash() {
		JsonObject pend = JsonParser.parseString("{\"items\":{\"minecraft:cobblestone\":5},\"at\":123}").getAsJsonObject();
		JsonObject st = CrateSettle.legacyStash("tcc:o", "minecraft:overworld", "site:s4@99", pend);
		assertNotNull(st);
		assertEquals("s4", st.get("site").getAsString());
		assertEquals("site:s4@99", st.get("pileKey").getAsString());
		assertTrue(CrateSettle.isPileStash(st));
		JsonObject road = CrateSettle.legacyStash("tcc:o", "minecraft:overworld", "road:r2@7", pend);
		assertTrue(road != null && road.has("road") && "r2".equals(road.get("site").getAsString()));
		assertNull(CrateSettle.legacyStash("tcc:o", "minecraft:overworld", "region:g1:mech:3", pend));
	}

	/** Finding 6: a durable removal stash crediting a pile holds that pile against a dissolve. */
	@Test
	void aRemovalsStashHoldsItsPile() throws Exception {
		JsonObject root = JsonParser.parseString("{\"s4\":{\"key\":\"pile-refund:site:s4@99\",\"dim\":\"minecraft:overworld\",\"pos\":0,\"recipient\":\"tcc:o\","
			+ "\"pile\":\"tcc:o\",\"site\":\"s4\",\"pileKey\":\"site:s4@99\",\"refund\":{}}}").getAsJsonObject();
		CrateSettle.durableRead(root);
		try {
			assertNotNull(CrateSettle.stashCrediting("tcc:o"));
			assertNull(CrateSettle.stashCrediting("tcc:other"));
		} finally {
			CrateSettle.durableRead(null);
		}
		assertTrue(read(SITE + "Stockpiles.java").contains("String heldBy = CrateSettle.pileHeld(owner);"), "dissolve checks it");
	}

	/** Finding 2, the P2s and the hold: the guards are where the review put them. */
	@Test
	void theGuardsAreInPlace() throws Exception {
		String rt = read("src/main/java/dev/larattalabs/architect/txn/RemovalTxn.java");
		assertTrue(rt.indexOf("CrateSettle.journalUnreadable()") >= 0 && rt.indexOf("CrateSettle.journalUnreadable()") < rt.indexOf("!CrateSettle.undoneExists("),
			"an unreadable journal holds the W probe before any absence is read");
		assertTrue(read(SITE + "CrateSettle.java").contains("if (journalUnreadable() || Sites.loadFailed()"), "the sweep and the settles wait for the journal");
		String sites = read(SITE + "Sites.java");
		assertTrue(sites.contains("throw new SiteException(Reason.SITE_BUSY, \"held(decided) \" + why);"), "a held settle answers held(decided)");
		assertTrue(read(SITE + "InfraPlace.java").contains("notes, r.owed())"), "the road result keeps its owed keys");
		assertTrue(read(SITE + "Placement.java").contains("SiteJournal.await(SiteJournal.release(e.record.id())"), "the extras' release is awaited");
		assertTrue(read("src/main/java/dev/larattalabs/architect/txn/TxnServer.java").contains("CrateSettle.stashBoxHeld("), "every guard reads the removal box");
		assertTrue(read(SITE + "RoadBuilder.java").contains("CrateSettle.pileRoadStash("), "a stockpile road has a removal.road stash");
	}
}
