package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0, review 4 on bd99c1fb) P1-1: a kept chunk copy never covers a newer failed attempt (GPT's probe sequence). P1-2: a payout whose
 * ledger write fails moves nothing: the holder and the stockpile are restored exactly, in the same call, and it is refused.
 */
class DurableT0R4Test {
	@TempDir
	Path tmp;

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() {
		DurableFile.FORCER = DurableFile.REAL;
		ChunkDebt.OWED.clear();
		ChunkDebt.LATEST.clear();
		ChunkDebt.PENDING.clear();
		PlayerSaves.reset();
		RegionDurability.reset();
		Stockpiles.loadFrom(tmp.resolve("none"));
		Stockpiles.unsaved = false;
		SaveGuards.clear();
	}

	static final String K = ChunkDebt.key("w/minecraft:overworld/chunk", 3, 3);

	static void save(String k) {
		long c = ChunkDebt.submitted(k, 0);
		ChunkDebt.pendingData(k, c);
		ChunkDebt.written(k, ChunkDebt.writing(k));
	}

	// ---------------------------------------------------------------- P1-1

	@Test
	void p1_1_gptsProbe_anOldKeptCopyNeverPaysANewerAsyncFailure() {
		// the chunk's unload serialization fails: its object A is kept
		ChunkDebt.remark(K, () -> {
		}, () -> "A", "unload serialization failed", true);
		assertEquals("A", ChunkDebt.snapshot(K), "the reload is served A");
		// the reloaded chunk changes (B); its save's asynchronous serialization fails (no object kept)
		long b = ChunkDebt.submitted(K, 0);
		ChunkDebt.serializationFailed(K, b, "B's serialization failed");
		ChunkDebt.remark(K, () -> {
		}, "B's save failed", false);
		// another reload
		assertNotEquals("A", ChunkDebt.snapshot(K), "the old A object is never served for B's failure");
		save(K); // whatever the reloaded chunk holds is saved
		assertEquals(1, ChunkDebt.owed().size(), "the debt must NOT clear: B's changes are not on disk");
	}

	@Test
	void p1_1_aSuccessfulSaveDropsTheKeptCopy() {
		long old = ChunkDebt.submitted(K, 0); // a write queued before the failure
		ChunkDebt.pendingData(K, old);
		ChunkDebt.remark(K, () -> {
		}, () -> "A", "unload serialization failed", true);
		ChunkDebt.written(K, ChunkDebt.writing(K)); // a successful save of the chunk (older: it pays nothing)
		assertNull(ChunkDebt.snapshot(K), "the kept object is no longer the chunk's newest state: not served");
	}

	@Test
	void p1_1_theKeptStateIsWrittenOnlyForTheNewestAttempt() {
		ChunkDebt.remark(K, () -> {
		}, () -> "A", "unload serialization failed", true);
		assertEquals("A", ChunkDebt.keptState(K), "its tag is the debt's failSeq");
		ChunkDebt.remark(K, () -> {
		}, "a newer save failed", true);
		assertNull(ChunkDebt.keptState(K), "a newer failure (no object kept) drops it");
	}

	// ---------------------------------------------------------------- P1-2

	static final String PILE = """
		{"id":"sp1","owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}}""";

	/** A player's inventory stand-in. */
	static final class Inv implements Stockpiles.Holder {
		Map<String, Integer> items = new TreeMap<>();

		@Override
		public int give(String item, int n) {
			items.merge(item, n, Integer::sum);
			return n;
		}

		@Override
		public Object snapshot() {
			return new TreeMap<>(items);
		}

		@Override
		@SuppressWarnings("unchecked")
		public void restore(Object snapshot) {
			items = new TreeMap<>((Map<String, Integer>) snapshot);
		}
	}

	Stockpiles.Pile loaded() throws IOException {
		Files.writeString(tmp.resolve(Stockpiles.FILE), "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get("test:a");
	}

	/** The ledger's folder force fails: its write is IN_DOUBT, never saved. */
	void ledgerWriteInDoubt() {
		Path dir = tmp.resolve(Stockpiles.FILE).toAbsolutePath().normalize().getParent();
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				ch.force(true);
			}

			@Override
			public void dir(Path d) throws IOException {
				if (d.toAbsolutePath().normalize().equals(dir)) {
					throw new IOException("injected folder force failure");
				}
			}
		};
	}

	@Test
	void p1_2_aWithdrawalWhoseLedgerWriteFailsMovesNothing() throws IOException {
		Stockpiles.Pile p = loaded();
		int stock = p.ledger.stock().getOrDefault("minecraft:cobblestone", 0);
		Inv inv = new Inv();
		Map<String, Integer> ground = new TreeMap<>();
		ledgerWriteInDoubt();
		assertThrows(Sites.SiteException.class, () -> Stockpiles.withdrawCore(p, Map.of("minecraft:cobblestone", stock), Map.of("minecraft:cobblestone",
			3), inv, ground, Stockpiles::save), "refused");
		assertTrue(inv.items.isEmpty(), "the items taken back from the player");
		assertTrue(ground.isEmpty(), "nothing dropped");
		assertEquals(stock, p.ledger.stock().getOrDefault("minecraft:cobblestone", 0), "the stockpile restored");
		assertTrue(Stockpiles.unsaved, "and still pending");
	}

	@Test
	void p1_2_aDissolveWhoseLedgerWriteFailsMovesNothing() throws IOException {
		Stockpiles.Pile p = loaded();
		int stock = p.ledger.stock().getOrDefault("minecraft:cobblestone", 0);
		Inv inv = new Inv();
		ledgerWriteInDoubt();
		assertThrows(Sites.SiteException.class, () -> Stockpiles.dissolveCore(p, inv, new TreeMap<>(), new TreeMap<>(), Stockpiles::save));
		assertTrue(inv.items.isEmpty(), "the items taken back from the player");
		assertSame(p, Stockpiles.get("test:a"), "the stockpile is back in the registry");
		assertEquals(stock, p.ledger.stock().getOrDefault("minecraft:cobblestone", 0), "with its stock");
	}

	@Test
	void p1_2_aWithdrawalWhoseLedgerIsDurableKeepsItsMove() throws Exception {
		Stockpiles.Pile p = loaded();
		Inv inv = new Inv();
		Map<String, Integer> out = Stockpiles.withdrawCore(p, Map.of("minecraft:cobblestone", 5), Map.of("minecraft:cobblestone", 3), inv, new TreeMap<>(),
			Stockpiles::save);
		assertEquals(Map.of("minecraft:cobblestone", 3), out);
		assertEquals(Map.of("minecraft:cobblestone", 3), inv.items);
		assertEquals(Stockpiles.ledgerFile().installedGen(), Stockpiles.ledgerFile().writtenGen(), "its debit durably on disk");
		assertEquals(2, p.ledger.stock().getOrDefault("minecraft:cobblestone", 0));
	}

	@Test
	void p1_2_withdrawAndDissolveGoThroughTheirCores() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		assertTrue(sp.contains("return withdrawCore(p, credit, items, holder(to), ground, () -> saveLedgerFirst(srv,"),
			"withdraw: the ledger durable before the items can leave, else restored and refused");
		assertTrue(sp.contains("Map<String, Integer> out = dissolveCore(p, to == null ? null : holder(to), toPlayer, toGround, () -> saveLedgerFirst(srv,"),
			"dissolve: likewise; crates taken and items dropped only after the ledger");
	}
}
