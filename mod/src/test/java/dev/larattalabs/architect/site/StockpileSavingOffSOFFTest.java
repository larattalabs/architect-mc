package dev.larattalabs.architect.site;

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
		assertTrue(Repairs.marksSave(List.of(), false));
		assertTrue(Repairs.marksSave(List.of("minecraft:overworld"), true), "forced: written");
		assertFalse(Repairs.marksSave(List.of("minecraft:overworld"), false), "skipped: saved= stays at the last real save");
	}

	/** Source guard: every ledger publisher checks saving off (the save needs a live server; soff-crash runs it in game). */
	@Test
	void everyPublisherChecksSavingOff() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String sww = StockpileSaveHFTest.body(s, "static void saveWithWorld(MinecraftServer srv)");
		int check = sww.indexOf("savingOffCheck(srv, false,");
		assertTrue(check > 0 && check < sww.indexOf("getPlayerList().saveAll()") && check < sww.indexOf("srv.saveAllChunks("),
			"saveWithWorld refuses before the players and the chunks");
		String save = StockpileSaveHFTest.body(s, "static boolean save()");
		assertTrue(save.contains("savingOffCheck(sv, forcedWorldSave,"), "save() refuses too (saveLedgerFirst's and compensate's write)");
		int after = s.indexOf("AFTER_SAVE.register(");
		int afterCheck = s.indexOf("savingOffCheck(server, force,", after);
		assertTrue(after > 0 && afterCheck > after && afterCheck < s.indexOf("forcedWorldSave = force;", after), "the world save's callback, unless forced");
		String pre = StockpileSaveHFTest.body(s, "static void payoutPreSave(Runnable preSave)");
		assertTrue(pre.contains("levelsSavingOff(sv)") && pre.indexOf("levelsSavingOff") < pre.indexOf("preSave.run()"), "a payout refused up front");
		String r = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Repairs.java"));
		assertTrue(r.contains("if (marksSave(Stockpiles.levelsSavingOff(srv), force)) {"), "the running marker's save time");
	}
}
