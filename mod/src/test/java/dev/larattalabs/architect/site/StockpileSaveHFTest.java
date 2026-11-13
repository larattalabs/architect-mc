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
		int ledger = code.indexOf("save();", chunks);
		assertTrue(ledger > chunks, "the ledger is written after the chunk save returns");
		String all = src().replaceAll("//[^\n]*", "");
		assertTrue(all.contains("if (!explicitSave)"), "BEFORE_SAVE (saveAllChunks' head) leaves the ledger to the explicit save");
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
		int bySaveWithWorld = 0;
		int byLifecycle = 0;
		for (int p : at) {
			if (p > swwAt && p < swwAt + sww.length()) {
				bySaveWithWorld++;
				continue;
			}
			String before = s.substring(Math.max(0, p - 400), p);
			if (before.contains("BEFORE_SAVE.register") || before.contains("SERVER_STOPPING.register")) {
				byLifecycle++;
			}
		}
		assertEquals(1, bySaveWithWorld, "saveWithWorld's own fallback");
		assertEquals(2, byLifecycle, "the world's save (BEFORE_SAVE) and the stop (SERVER_STOPPING)");
		assertEquals(3, at.size(), "no other plain save() of the ledger: an explicit save goes through saveWithWorld (players, chunks, ledger)");
		Matcher w = Pattern.compile("saveWithWorld\\(srv\\);").matcher(s);
		int callers = 0;
		while (w.find()) {
			callers++;
		}
		assertTrue(callers >= 7, "the explicit savers (create, removeCrate, dissolve, setFeedOrder, adopt, charge, scoop) call saveWithWorld: " + callers);
	}
}
