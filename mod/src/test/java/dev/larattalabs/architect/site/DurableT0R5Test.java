package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0, review 5 on 8d799fb0) Item 1: a payout refused after an IN_DOUBT ledger write leaves the disk equal to memory (the restored
 * ledger written durably), or a ledger debt when that fails too. Item 2: a forced crate removal is ledger-first. Item 3: an older write never
 * discards a newer kept chunk copy.
 */
class DurableT0R5Test {
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

	static final String OWNER = "test:a", COBBLE = "minecraft:cobblestone";
	static final String PILE = """
		{"id":"sp1","owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}}""";

	Stockpiles.Pile loaded() throws IOException {
		Files.writeString(tmp.resolve(Stockpiles.FILE), "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get(OWNER);
	}

	/** The ledger folder's force fails the next {@code n} times (n < 0: always): the payout's write renames, then is IN_DOUBT. */
	AtomicInteger ledgerForceFails(int n) {
		Path dir = tmp.resolve(Stockpiles.FILE).toAbsolutePath().normalize().getParent();
		AtomicInteger left = new AtomicInteger(n);
		DurableFile.FORCER = new DurableFile.Forcer() {
			@Override
			public void file(FileChannel ch) throws IOException {
				ch.force(true);
			}

			@Override
			public void dir(Path d) throws IOException {
				if (d.toAbsolutePath().normalize().equals(dir) && (left.get() < 0 || left.getAndDecrement() > 0)) {
					throw new IOException("injected folder force failure");
				}
			}
		};
		return left;
	}

	/** The stockpile as a reload from disk sees it (a restart). */
	int onDisk() {
		Stockpiles.loadFrom(tmp);
		Stockpiles.Pile p = Stockpiles.get(OWNER);
		return p == null ? -1 : p.ledger.stock().getOrDefault(COBBLE, 0);
	}

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

	// ---------------------------------------------------------------- item 1

	@Test
	void i1_aWithdrawalRefusedAfterAnInDoubtWriteLeavesTheDiskEqualToMemory() throws IOException {
		Stockpiles.Pile p = loaded();
		ledgerForceFails(1); // stock 5, withdraw 3: the renamed file says 2, its folder force fails
		Inv inv = new Inv();
		assertThrows(Sites.SiteException.class, () -> Stockpiles.withdrawCore(p, Map.of(COBBLE, 5), Map.of(COBBLE, 3), inv, new TreeMap<>(),
			Stockpiles::save));
		int memory = p.ledger.stock().getOrDefault(COBBLE, 0);
		assertEquals(5, memory);
		assertTrue(inv.items.isEmpty());
		assertEquals(memory, onDisk(), "a restart loads what memory holds: the refused withdrawal lost nothing");
	}

	@Test
	void i1_aDissolveRefusedAfterAnInDoubtWriteLeavesThePileOnDisk() throws IOException {
		Stockpiles.Pile p = loaded();
		ledgerForceFails(1);
		assertThrows(Sites.SiteException.class, () -> Stockpiles.dissolveCore(p, new Inv(), new TreeMap<>(), new TreeMap<>(), Stockpiles::save));
		assertEquals(5, onDisk(), "the pile is still on disk, with its stock");
	}

	@Test
	void i1_whenTheRestoredWriteFailsTooALedgerDebtRefusesPayouts() throws IOException {
		Stockpiles.Pile p = loaded();
		ledgerForceFails(-1); // the folder keeps refusing its force
		assertThrows(Sites.SiteException.class, () -> Stockpiles.withdrawCore(p, Map.of(COBBLE, 5), Map.of(COBBLE, 3), new Inv(), new TreeMap<>(),
			Stockpiles::save));
		assertFalse(DurableBarrier.owedDebts().isEmpty(), "owed: the file may hold the refused move");
		assertThrows(Sites.SiteException.class, () -> Stockpiles.payoutPreSave(() -> {
		}), "payouts refuse");
		DurableFile.FORCER = DurableFile.REAL; // the disk recovers
		assertTrue(Stockpiles.save(), "a durable save");
		assertTrue(DurableBarrier.owedDebts().isEmpty(), "clears it");
		assertEquals(5, onDisk());
	}

	// ---------------------------------------------------------------- item 2

	@Test
	void i2_aForcedCrateRemovalIsLedgerFirstAndRestoredOnAFailedWrite() throws IOException {
		Stockpiles.Pile p = loaded();
		Stockpiles.CrateRec a = new Stockpiles.CrateRec(0, 64, 0, "minecraft:air", null, null), b = new Stockpiles.CrateRec(2, 64, 0, "minecraft:air",
			null, null);
		p.crates.add(a);
		p.crates.add(b);
		assertTrue(Stockpiles.writeConfirmed(null).ok());
		ledgerForceFails(1);
		AtomicInteger moved = new AtomicInteger();
		assertThrows(Sites.SiteException.class, () -> Stockpiles.removeCrateCore(p, a, Map.of(COBBLE, 3), () -> {
			if (!Stockpiles.save()) {
				return false; // the ledger-first save: nothing after it
			}
			moved.incrementAndGet();
			return true;
		}));
		assertEquals(0, moved.get(), "the crate was not taken, nothing dropped");
		assertEquals(2, p.crates.size(), "the crate is back in the pile");
		assertEquals(5, p.ledger.stock().getOrDefault(COBBLE, 0), "its stock restored");
		assertEquals(5, onDisk(), "and on disk");
	}

	@Test
	void i2_removeCrateGoesThroughItsCore() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String rc = StockpileSaveHFTest.body(sp, "public static CrateRemoval removeCrate(");
		assertTrue(rc.contains("ended = removeCrateCore(p, c, drop, () -> saveLedgerFirst(srv, () -> {"), "the excess dropped only after the ledger");
		int core = rc.indexOf("removeCrateCore(");
		assertTrue(rc.indexOf("Builder.dropItems(level, at, drop, null);") > core, "the drop inside the core's publication");
	}

	// ---------------------------------------------------------------- item 3

	@Test
	void i3_anOlderWriteNeverDiscardsANewerKeptCopy() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 6, 6);
		long older = ChunkDebt.submitted(k, 0); // queued before the failure
		ChunkDebt.pendingData(k, older);
		ChunkDebt.remark(k, () -> {
		}, () -> "A", "unload serialization failed", true);
		ChunkDebt.written(k, ChunkDebt.writing(k)); // the older write completes after the failure
		assertNotNull(ChunkDebt.snapshot(k), "the kept copy survives: a reload is served it");
	}
}
