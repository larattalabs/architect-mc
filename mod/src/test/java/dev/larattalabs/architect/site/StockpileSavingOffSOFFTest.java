package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (slice SOFF) A ledger save never publishes over a level with saving off (/save-off): saveAllChunks skips such a level unless forced and
 * RegionDurability sees no write for it, so the ledger would be ahead of the world (soff-crash measures the mint and the loss in game).
 */
class StockpileSavingOffSOFFTest {
	@Test
	void refusedWhileAnyLevelHasSavingOffUnlessForced() {
		assertNull(Stockpiles.savingOffRefusal(List.of(), false, "x", "y"), "saving on: no refusal (behaviour as before)");
		assertNull(Stockpiles.savingOffRefusal(List.of(), true, "x", "y"));
		assertNull(Stockpiles.savingOffRefusal(List.of("minecraft:overworld"), true, "x", "y"), "a forced save (/save-all) writes those levels too");
		String m = Stockpiles.savingOffRefusal(List.of("minecraft:overworld", "minecraft:the_nether"), false, "the periodic save did not write", "it is saved");
		assertNotNull(m);
		assertTrue(m.contains("minecraft:overworld") && m.contains("minecraft:the_nether"), "names every dimension: " + m);
		assertTrue(m.contains("/save-on") && m.contains("/save-off"), "says /save-on: " + m);
	}

	@Test
	void loggedOncePerChangeOfTheLevelsOff() {
		assertTrue(Stockpiles.savingOffLogs(null, "minecraft:overworld"), "the first refusal");
		assertFalse(Stockpiles.savingOffLogs("minecraft:overworld", "minecraft:overworld"), "the same levels: quiet (every 10 s otherwise)");
		assertTrue(Stockpiles.savingOffLogs("minecraft:overworld", "minecraft:overworld, minecraft:the_end"), "another set: logged");
	}

	@Test
	void theRunningMarkerIsNotAdvancedOverASkippedLevel() {
		assertTrue(Repairs.marksSave(null));
		assertFalse(Repairs.marksSave("the save skipped minecraft:the_nether"), "skipped: saved= stays at the last real save");
	}

	/** (review findings 4, 5) a save is coherent only by what it recorded while it ran: every level written, the players with it. */
	@Test
	void aWorldSaveCarriesTheLedgerOnlyWithItsOwnEvidence() {
		assertNull(SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), true, true), "an autosave or /save-all (forced too)");
		assertNotNull(SaveEvidence.incoherent(3, List.of("a", "b"), List.of("c"), true, true), "a level skipped (saving off then)");
		assertNotNull(SaveEvidence.incoherent(3, List.of("a", "b"), List.of(), true, true), "a level not visited");
		String raw = SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), true, false);
		assertNotNull(raw, "another mod's saveAllChunks(.., force): no players saved with it");
		assertTrue(raw.contains("players"));
		assertNull(SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), false, false), "an explicit save saves its players itself");
	}

	/** The hold: entered whenever a level has saving off; released only by a passed barrier with saving on everywhere. */
	@Test
	void theHoldIsReleasedOnlyByAPassedBarrier() {
		assertEquals(SaveHold.State.OPEN, SaveHold.next(SaveHold.State.OPEN, false, false), "saving on: as before");
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.OPEN, true, false));
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.HELD, true, true), "still off: held whatever the barrier");
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.HELD, false, false), "the flag on again releases nothing by itself");
		assertEquals(SaveHold.State.OPEN, SaveHold.next(SaveHold.State.HELD, false, true));
		String m = SaveHold.message(List.of("minecraft:the_nether"), null);
		assertTrue(m.contains("minecraft:the_nether") && m.contains("/save-on"), m);
		assertTrue(SaveHold.message(List.of(), "chunk writes not durable").contains("confirmed"));
		assertTrue(SaveHold.admits(null), "no server (units): admitted");
	}

	/** Source guard: the holds and the evidence are where the review found the gaps (the save needs a live server; soff-crash runs it). */
	@Test
	void everyPublisherAndIngressIsGuarded() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String sww = StockpileSaveHFTest.body(s, "static void saveWithWorld(MinecraftServer srv)");
		int check = sww.indexOf("savingOffCheck(srv, false,");
		assertTrue(check > 0 && check < sww.indexOf("getPlayerList().saveAll()") && check < sww.indexOf("srv.saveAllChunks("),
			"saveWithWorld refuses before the players and the chunks");
		assertTrue(sww.indexOf("SaveEvidence.chunksRefusal(srv)") > sww.indexOf("srv.saveAllChunks("), "then requires its own save's evidence");
		assertTrue(StockpileSaveHFTest.body(s, "static boolean save()").contains("savingOffCheck(sv, evidencedSave,"), "save() too");
		int after = s.indexOf("AFTER_SAVE.register(");
		int ev = s.indexOf("SaveEvidence.worldSaveRefusal(server)", after);
		assertTrue(after > 0 && ev > after && ev < s.indexOf("evidencedSave = true;", after), "the world save's callback: its own save's evidence");
		assertTrue(StockpileSaveHFTest.body(s, "public static Ledger.@Nullable Accepted accept(").contains("SaveHold.admits(srv)"), "ingress held");
		for (String sig : List.of("public static Pile create(", "public static Pile addCrate(", "public static CrateRemoval removeCrate(",
			"public static Map<String, Integer> dissolve(", "public static List<String> setFeedOrder(", "public static Map<String, Integer> withdraw(",
			"public static Pile adopt(")) {
			String b = StockpileSaveHFTest.body(s, sig);
			assertTrue(b.substring(b.indexOf('{') + 1).trim().startsWith("SaveHold.require(srv);"), sig + " held first");
		}
		String fills = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Fills.java"));
		assertTrue(fills.contains("!Stockpiles.ledgerOnDisk(srv)"), "(review finding 2) a fill's in-memory marker needs the ledger on disk");
		String barrier = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/DurableBarrier.java"));
		assertTrue(barrier.contains("SaveEvidence.chunksRefusal(srv)"), "(finding 4) the barrier's chunks step: its own save's evidence");
		String placement = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Placement.java"));
		assertTrue(placement.contains("if (!SaveHold.admits(srv)) {"), "every job parks while saving is off");
		String builder = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		assertTrue(builder.contains("SaveHold.whenAdmitted(s, \"the start's stockpile reconcile\""), "the start's reconcile deferred");
	}
}
