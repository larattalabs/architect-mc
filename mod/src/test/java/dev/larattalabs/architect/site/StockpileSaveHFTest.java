package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Slice HF (docs/CONTRACT.md "Slice HF, player saves with the ledger"): an explicit stockpile ledger save never runs ahead of the players.
 * A source guard (the save needs a live server; hf-crash measures it in game): {@code saveWithWorld} saves the players before the chunks
 * and the ledger, and no ledger save outside the world's own save (BEFORE_SAVE, SERVER_STOPPING) bypasses it.
 */
class StockpileSaveHFTest {
	static String src() throws Exception {
		return Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
	}

	static String body(String s, String signature) {
		int i = s.indexOf(signature);
		assertTrue(i >= 0, "missing " + signature);
		int depth = 0;
		for (int k = s.indexOf('{', i); k < s.length(); k++) {
			char c = s.charAt(k);
			if (c == '{') {
				depth++;
			} else if (c == '}' && --depth == 0) {
				return s.substring(i, k + 1);
			}
		}
		throw new AssertionError("unbalanced " + signature);
	}

	@Test
	void saveWithWorldSavesThePlayersFirst() throws Exception {
		String b = body(src(), "static void saveWithWorld(MinecraftServer srv)");
		String code = b.replaceAll("//[^\n]*", "");
		int players = code.indexOf("srv.getPlayerList().saveAll();");
		int chunks = code.indexOf("srv.saveAllChunks(");
		assertTrue(players >= 0, "saveWithWorld saves the players (PlayerList.saveAll)");
		assertTrue(chunks > players, "the players are saved before the chunks and the ledger");
		assertTrue(code.contains("srv.saveAllChunks(true, true, false)"), "(N3) the chunks are flushed: on disk before the ledger is written");
		int ledger = code.indexOf("if (!save()) {", chunks); // (SOFF2 fix round) a false save() refuses
		assertTrue(ledger > chunks, "the ledger is written after the chunk save returns");
		String all = src().replaceAll("//[^\n]*", "");
		assertTrue(all.contains("if (explicitSave) {"), "the world's save (AFTER_SAVE since J1) leaves the ledger to the explicit save");
		assertTrue(all.contains("ServerPlayConnectionEvents.DISCONNECT.register"), "(F9) a logout saves an unsaved ledger with the world");
	}

	@Test
	void everyExplicitLedgerSaveGoesThroughSaveWithWorld() throws Exception {
		String s = src().replaceAll("//[^\n]*", "");
		List<Integer> at = new ArrayList<>();
		Matcher m = Pattern.compile("(?<![A-Za-z0-9_.])save\\(\\)(?=[);])").matcher(s);
		while (m.find()) {
			at.add(m.start());
		}
		String sww = body(s, "static void saveWithWorld(MinecraftServer srv)");
		int swwAt = s.indexOf(sww);
		String slf = body(s, "static boolean saveLedgerFirst(MinecraftServer srv, Runnable between)"); // (J1) a Take's or a dissolve's save: the ledger first
		int slfAt = s.indexOf(slf);
		int bySaveWithWorld = 0;
		int byLifecycle = 0;
		int byLedgerFirst = 0;
		for (int p : at) {
			if (p > swwAt && p < swwAt + sww.length()) {
				bySaveWithWorld++;
				continue;
			}
			if (p > slfAt && p < slfAt + slf.length()) {
				byLedgerFirst++;
				continue;
			}
			String before = s.substring(Math.max(0, p - 2400), p); // (SOFF) wider: AFTER_SAVE refuses over a level with saving off first
			if (before.contains("AFTER_SAVE.register") || before.contains("SERVER_STOPPING.register")) { // (J1) AFTER_SAVE, was BEFORE_SAVE
				byLifecycle++;
			}
		}
		assertEquals(1, bySaveWithWorld, "saveWithWorld's own fallback");
		assertEquals(1, byLifecycle, "the world's save (AFTER_SAVE; the stop's too: slice T0 dropped SERVER_STOPPING's early ledger save)");
		assertEquals(1, byLedgerFirst, "(J1) saveLedgerFirst's ledger write, before its players and chunks");
		assertEquals(4, at.size(), "no other plain save() of the ledger: an explicit save goes through saveWithWorld (players, chunks, ledger) or saveLedgerFirst"
			+ " (slice T0: SERVER_STOPPING's save dropped; compensate's write of a refused payout's restored ledger added)");
		assertTrue(body(src(), "static void compensate(String what)").contains("if (save()) {"), "the fourth: compensate's");
		Matcher w = Pattern.compile("saveWithWorld\\(srv\\);").matcher(s);
		int callers = 0;
		while (w.find()) {
			callers++;
		}
		assertTrue(callers >= 7, "the explicit savers (create, removeCrate, dissolve, setFeedOrder, adopt, charge, scoop) call saveWithWorld: " + callers);
	}
}
