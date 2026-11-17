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
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0 structural round, T0 review 3 on a4531467: findings 1-7 P1, 8 P2) One test or more per item, failing-first on a4531467: s1 the
 * one lock (3, 4), s2 the full ancestor chain (5), s3 caches reset per world session (6), s4 payouts and IN_DOUBT (2), s5 the stop's order
 * (1), s6 the .dat_old fallback (7), s7 no stale debt for want of a snapshot (8).
 */
class DurableT0StructTest {
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
		PlayerSaves.reset();
		ChunkDebt.OWED.clear();
		ChunkDebt.LATEST.clear();
		ChunkDebt.PENDING.clear();
		ChunkDebt.TEST_BEFORE_PAY = null;
		ChunkDebt.TEST_BEFORE_RESUBMIT = null;
		RegionDurability.reset();
		Stockpiles.loadFrom(tmp.resolve("none"));
		Stockpiles.unsaved = false;
		SaveGuards.clear();
	}

	/** Records each folder forced, failing the ones named. */
	static class Rec implements DurableFile.Forcer {
		final List<Path> dirs = new ArrayList<>();
		final Set<Path> fail;

		Rec(Set<Path> fail) {
			this.fail = fail;
		}

		@Override
		public void file(FileChannel ch) throws IOException {
			ch.force(true);
		}

		@Override
		public void dir(Path dir) throws IOException {
			Path d = dir.toAbsolutePath().normalize();
			dirs.add(d);
			if (fail.contains(d)) {
				throw new IOException("injected folder force failure");
			}
		}
	}

	static final String PILE = """
		{"id":"sp1","owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}}""";

	Path ledger() throws IOException {
		Path f = tmp.resolve(Stockpiles.FILE);
		Files.writeString(f, "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		return f;
	}

	final UUID id = UUID.randomUUID();
	final Object steve = new Object();

	void save(Object player, boolean ok, Object snapshot) {
		PlayerSaves.saving(id, player);
		if (snapshot != null) {
			PlayerSaves.captured(snapshot);
		}
		PlayerSaves.replaced(ok);
		PlayerSaves.done();
	}

	// ---------------------------------------------------------------- s1: one lock (findings 3, 4)

	/** Runs {@code r} on another thread and gives it 300 ms: with the lock it is still blocked when the caller's critical section goes on. */
	static Thread racer(Runnable r) {
		Thread t = new Thread(r, "t0-racer");
		t.start();
		try {
			t.join(300);
		} catch (InterruptedException e) {
			throw new AssertionError(e);
		}
		return t;
	}

	@Test
	void s1_aPaymentNeverRemovesANewerFailureRecordedMeanwhile() throws Exception {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 4, 4);
		ChunkDebt.remark(k, () -> {
		}, "A failed", true);
		long b = ChunkDebt.submitted(k, 0); // B, newer than A's failure
		ChunkDebt.pendingData(k, b);
		Thread[] t = new Thread[1];
		ChunkDebt.TEST_BEFORE_PAY = () -> {
			ChunkDebt.TEST_BEFORE_PAY = null;
			// between B's check and its payment, the server thread records a newer synchronous serialization failure C
			t[0] = racer(() -> ChunkDebt.remark(k, () -> {
			}, "C failed", true));
		};
		ChunkDebt.written(k, ChunkDebt.writing(k));
		t[0].join(5000);
		assertEquals(1, ChunkDebt.owed().size(), "C's failure, newer than B, stays owed");
	}

	@Test
	void s1_aRetryNeverReplaysAnOlderSnapshotAfterANewerWriteSucceeded() throws Exception {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 5, 5);
		long a = ChunkDebt.submitted(k, 0);
		ChunkDebt.pendingData(k, a);
		AtomicInteger replays = new AtomicInteger();
		ChunkDebt.writeFailed(k, "A", ChunkDebt.writing(k), replays::incrementAndGet, "disk full");
		long b = ChunkDebt.submitted(k, 0); // B: newer, its write under way on the IO thread
		ChunkDebt.pendingData(k, b);
		long wb = ChunkDebt.writing(k);
		Thread[] t = new Thread[1];
		ChunkDebt.TEST_BEFORE_RESUBMIT = () -> {
			ChunkDebt.TEST_BEFORE_RESUBMIT = null;
			t[0] = racer(() -> ChunkDebt.written(k, wb)); // B succeeds while the retry holds A's debt
		};
		ChunkDebt.retry();
		t[0].join(5000);
		assertEquals(0, replays.get(), "A is never written over B");
		assertTrue(ChunkDebt.owed().isEmpty(), "B paid it");
	}

	// ---------------------------------------------------------------- s2: the full ancestor chain (finding 5)

	@Test
	void s2_aNativeRegionFolderIsConfirmedUpToTheWorld() throws IOException {
		Path world = tmp.resolve("world").toAbsolutePath().normalize();
		Path region = Files.createDirectories(world.resolve("dimensions/minecraft/overworld/region"));
		Files.writeString(region.resolve("r.0.0.mca"), "x");
		RegionDurability.worldOpened(world);
		RegionDurability.open(region.resolve("r.0.0.mca"), "chunk");
		Rec rec = new Rec(Set.of());
		DurableFile.FORCER = rec;
		assertTrue(RegionDurability.confirmFolders("chunk").isEmpty());
		assertTrue(rec.dirs.containsAll(List.of(world.resolve("dimensions/minecraft"), world.resolve("dimensions"), world)),
			"minecraft's entry in dimensions, dimensions' in the world, the world's own: " + rec.dirs);
	}

	// ---------------------------------------------------------------- s3: caches per world session (finding 6)

	@Test
	void s3_aReopenedWorldConfirmsItsFoldersAgain() throws IOException {
		Path world = tmp.resolve("world").toAbsolutePath().normalize();
		Path region = Files.createDirectories(world.resolve("region"));
		Files.writeString(region.resolve("r.0.0.mca"), "x");
		Files.writeString(region.resolve("c.0.0.mcc"), "payload");
		RegionDurability.worldOpened(world);
		RegionDurability.open(region.resolve("r.0.0.mca"), "chunk");
		assertTrue(RegionDurability.confirmFolders("chunk").isEmpty());
		RegionDurability.worldClosed(); // the .mcc's later force failed; its debt goes with the world
		RegionDurability.worldOpened(world); // reopened in the same process
		RegionDurability.open(region.resolve("r.0.0.mca"), "chunk");
		AtomicInteger files = new AtomicInteger();
		Rec rec = new Rec(Set.of()) {
			@Override
			public void file(FileChannel ch) throws IOException {
				files.incrementAndGet();
				super.file(ch);
			}
		};
		DurableFile.FORCER = rec;
		assertTrue(RegionDurability.confirmFolders("chunk").isEmpty());
		assertTrue(rec.dirs.contains(region) && rec.dirs.contains(world), "the folder and its chain forced again: " + rec.dirs);
		assertEquals(1, files.get(), "the .mcc forced again");
	}

	// ---------------------------------------------------------------- s4: payouts and IN_DOUBT (finding 2)

	@Test
	void s4_anInDoubtLedgerWriteIsNotSaved() throws IOException {
		Path f = ledger();
		Stockpiles.writeConfirmed(null);
		DurableFile.FORCER = new Rec(Set.of(f.toAbsolutePath().normalize().getParent())); // the rename lands, its folder force fails
		Stockpiles.unsaved = true;
		Stockpiles.save();
		assertTrue(Stockpiles.unsaved, "IN_DOUBT: still pending, never counted as saved");
	}

	@Test
	void s4_aPayoutWhosePreSaveLeavesADebtIsRefused() throws IOException {
		ledger();
		Stockpiles.unsaved = true;
		assertThrows(Sites.SiteException.class, () -> Stockpiles.payoutPreSave(() -> save(steve, false, "inventory")),
			"the pre-save's player replace failed: nothing is paid");
		PlayerSaves.reset();
		Stockpiles.unsaved = true;
		assertThrows(Sites.SiteException.class, () -> Stockpiles.payoutPreSave(() -> {
		}), "the pending ledger was not saved: nothing is paid");
	}

	@Test
	void s4_aPayoutsLedgerFirstSaveStopsWhenTheLedgerIsNotPublished() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		int i = sp.indexOf("static void saveLedgerFirst(MinecraftServer srv) {");
		assertTrue(i > 0 && sp.indexOf("if (!save()) {", i) > i && sp.indexOf("if (!save()) {", i) < sp.indexOf("srv.getPlayerList().saveAll();", i),
			"no player or chunk save after a ledger that was not published");
		assertTrue(sp.contains("payoutPreSave(() -> saveWithWorld(srv)); // (J1) what was pending first, in HF's order: the save after the Take"));
	}

	// ---------------------------------------------------------------- s5: the stop saves the ledger last (finding 1)

	@Test
	void s5_theStopSavesTheLedgerAfterThePlayersAndTheChunks() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		int i = sp.indexOf("ServerLifecycleEvents.SERVER_STOPPING.register(");
		int j = sp.indexOf("});", i);
		assertFalse(sp.substring(i, j).contains("save();"), "no ledger save at stopServer's head: the stop's AFTER_SAVE writes it, last");
	}

	// ---------------------------------------------------------------- s6: the .dat_old fallback (finding 7)

	@Test
	void s6_aLoginIsServedTheSnapshotEvenWhenItsRewriteSucceeded() throws IOException {
		PlayerSaves.worldOpened((u, snap) -> true); // the rewrite at login succeeds
		save(steve, false, "after the deposit");
		assertEquals("after the deposit", PlayerSaves.loadInstead(id), "served: a failing .dat read can't fall back to .dat_old");
	}

	@Test
	void s6_theDatOldFallbackIsServedTheLastAcknowledgedSnapshot() throws IOException {
		save(steve, true, "acknowledged");
		assertEquals("acknowledged", PlayerSaves.loadOld(id), "never the older .dat_old");
		String m = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/PlayerSaveFailMixin.java"));
		assertTrue(m.contains("\".dat_old\".equals(suffix) ? PlayerSaves.loadOld(who.id())"));
	}

	// ---------------------------------------------------------------- s7: no stale debt for want of a snapshot (P2, finding 8)

	@Test
	void s7_aChunkReloadedBeforeItsRetryIsServedItsKeptObject() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 7, 7);
		ChunkDebt.remark(k, () -> {
		}, () -> "kept state", "unload serialization failed", true);
		assertEquals("kept state", ChunkDebt.snapshot(k), "the reload gets the kept chunk's state, not the older file");
		long c = ChunkDebt.submitted(k, 0); // the reloaded chunk saves
		ChunkDebt.pendingData(k, c);
		ChunkDebt.written(k, ChunkDebt.writing(k));
		assertTrue(ChunkDebt.owed().isEmpty(), "not stale: paid by its next write");
	}

	@Test
	void s7_aPlayerSaveThatFailedBeforeItsCaptureKeepsACurrentSnapshot() throws IOException {
		List<Object> written = new ArrayList<>();
		PlayerSaves.worldOpened((u, snap) -> written.add(snap));
		PlayerSaves.saving(id, steve);
		PlayerSaves.failed("the temp file could not be made", () -> "serialized again");
		PlayerSaves.done();
		assertNotNull(PlayerSaves.loadInstead(id), "the login is served it, never stale");
		assertEquals(List.of("serialized again"), written);
	}
}
