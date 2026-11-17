package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0, docs/TXN-DESIGN.md §3.1) DurableFile: a confirmed snapshot (written, forced, renamed, its folder forced) carries its store
 * and generation in the file, read back after a reload; a failure before the rename is REFUSED with the old file kept; a failed folder
 * force after the rename is IN_DOUBT (the new file is there, never read as not committed). DurableBarrier: players, then chunks, then the
 * ledger, stopping at the first failure; a refusal (save-off, a failed load) runs no step.
 */
class DurableT0Test {
	@TempDir
	Path tmp;

	@AfterEach
	void reset() {
		DurableFile.FORCER = DurableFile.REAL;
		DurableFile.FAIL_BEFORE_RENAME.set(0);
	}

	static JsonObject doc(int n) {
		JsonObject o = new JsonObject();
		o.addProperty("n", n);
		return o;
	}

	static JsonObject read(Path f) throws IOException {
		return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	@Test
	void aConfirmedSnapshotCarriesItsGenerationAcrossAReload() throws IOException {
		Path f = tmp.resolve("a/stockpiles.json");
		DurableFile d = new DurableFile("stockpiles", f);
		assertEquals(0, d.writtenGen());
		long g1 = d.request(), g2 = d.request();
		assertEquals(1, g1);
		DurableFile.Result r = d.write(doc(7), g2);
		assertTrue(r.ok());
		assertTrue(d.written(g1) && d.written(g2));
		JsonObject on = read(f);
		assertEquals(7, on.get("n").getAsInt());
		assertEquals("stockpiles", on.getAsJsonObject(DurableFile.MEMBER).get("store").getAsString());
		assertEquals(2, on.getAsJsonObject(DurableFile.MEMBER).get("gen").getAsLong());
		assertFalse(Files.exists(f.resolveSibling("stockpiles.json.tmp")), "no temp file left");
		// a reload (a restart): the generation read from the file, the next one goes on from it
		DurableFile again = new DurableFile("stockpiles", f);
		assertEquals(2, again.writtenGen());
		assertTrue(again.written(2));
		assertEquals(3, again.request());
		assertEquals(0, DurableFile.readGen(f, "queue"), "another store's generation is not read");
		assertEquals(0, DurableFile.readGen(tmp.resolve("none.json"), "stockpiles"));
	}

	@Test
	void aFailureBeforeTheRenameIsRefusedAndKeepsTheOldFile() throws IOException {
		Path f = tmp.resolve("s.json");
		DurableFile d = new DurableFile("s", f);
		assertTrue(d.write(doc(1), d.request()).ok());
		DurableFile.FAIL_BEFORE_RENAME.set(1);
		long g = d.request();
		DurableFile.Result r = d.write(doc(2), g);
		assertEquals(DurableFile.Outcome.REFUSED, r.outcome());
		assertFalse(d.written(g));
		assertTrue(d.failing());
		assertEquals(1, read(f).get("n").getAsInt(), "the previous snapshot stands");
		// a file force that fails is refused too
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				throw new IOException("injected file force failure");
			}

			@Override
			public void dir(Path dir) {
			}
		};
		assertEquals(DurableFile.Outcome.REFUSED, d.write(doc(3), d.request()).outcome());
		assertEquals(1, read(f).get("n").getAsInt());
	}

	@Test
	void aFailedDirectoryForceAfterTheRenameIsInDoubt() throws IOException {
		Path f = tmp.resolve("s.json");
		DurableFile d = new DurableFile("s", f);
		assertTrue(d.write(doc(1), d.request()).ok());
		List<Path> forced = new ArrayList<>();
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				ch.force(true);
			}

			@Override
			public void dir(Path dir) throws IOException {
				forced.add(dir);
				throw new IOException("injected directory force failure");
			}
		};
		long g = d.request();
		DurableFile.Result r = d.write(doc(2), g);
		assertEquals(DurableFile.Outcome.IN_DOUBT, r.outcome());
		assertEquals(List.of(f.toAbsolutePath().getParent()), forced, "the parent folder is the one forced");
		assertEquals(2, read(f).get("n").getAsInt(), "the rename happened: the new snapshot is the file (never 'not committed')");
		assertEquals(g, d.inDoubt());
		assertFalse(d.written(g), "nor is it known durable");
		DurableFile.FORCER = DurableFile.REAL;
		long g2 = d.request();
		assertTrue(d.write(doc(3), g2).ok());
		assertEquals(0, d.inDoubt(), "a later OK write covers it");
		assertTrue(d.written(g));
	}

	/** Steps that record their order and fail where told. */
	static final class Fake implements DurableBarrier.Steps {
		final List<String> order = new ArrayList<>();
		String refuse, players, chunks;
		DurableFile.Outcome ledger = DurableFile.Outcome.OK;

		@Override
		public String refusal() {
			order.add("refusal");
			return refuse;
		}

		@Override
		public String players() {
			order.add("players");
			return players;
		}

		@Override
		public String chunks() {
			order.add("chunks");
			return chunks;
		}

		@Override
		public DurableFile.Result ledger() {
			order.add("ledger");
			return new DurableFile.Result(ledger, 5, ledger == DurableFile.Outcome.OK ? null : "x");
		}
	}

	@Test
	void theBarrierRunsPlayersThenChunksThenTheLedger() {
		Fake f = new Fake();
		DurableBarrier.Result r = DurableBarrier.run(f);
		assertTrue(r.ok());
		assertEquals(List.of("refusal", "players", "chunks", "ledger"), f.order);
		assertEquals(5, r.ledgerGen());
		assertNull(r.reason());
	}

	@Test
	void theBarrierStopsAtTheFirstFailure() {
		Fake off = new Fake();
		off.refuse = "saving is off (/save-off)";
		DurableBarrier.Result r = DurableBarrier.run(off);
		assertEquals(DurableFile.Outcome.REFUSED, r.outcome());
		assertEquals(List.of("refusal"), off.order, "save-off: no step runs");
		Fake pl = new Fake();
		pl.players = "1 player save(s) failed";
		r = DurableBarrier.run(pl);
		assertEquals(DurableFile.Outcome.REFUSED, r.outcome());
		assertTrue(r.reason().startsWith("players: "));
		assertEquals(List.of("refusal", "players"), pl.order, "a failed player save: no chunk or ledger write");
		Fake ch = new Fake();
		ch.chunks = "2 region file(s) not durable";
		r = DurableBarrier.run(ch);
		assertEquals(DurableFile.Outcome.REFUSED, r.outcome());
		assertEquals(List.of("refusal", "players", "chunks"), ch.order, "undurable chunks: the ledger is not written");
		Fake doubt = new Fake();
		doubt.ledger = DurableFile.Outcome.IN_DOUBT;
		assertEquals(DurableFile.Outcome.IN_DOUBT, DurableBarrier.run(doubt).outcome(), "the ledger's in-doubt rename is the barrier's");
	}

	@Test
	void aFailedPlayerSaveIsCounted() {
		int before = DurableBarrier.PLAYER_SAVE_FAILURES.get();
		DurableBarrier.playerSaveFailed();
		assertEquals(before + 1, DurableBarrier.PLAYER_SAVE_FAILURES.get());
	}
}
