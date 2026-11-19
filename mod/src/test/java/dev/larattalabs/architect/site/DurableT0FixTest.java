package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0 fix round, rule 18: each review finding failing-first) The GPT review of 042da098 (P1-1..P3-11) and TXN review 3's items 1 and 5.
 * Tests named {@code p1_5...} etc. follow the finding they pin.
 */
class DurableT0FixTest {
	@TempDir
	Path tmp;

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() throws IOException {
		DurableFile.FORCER = DurableFile.REAL;
		DurableFile.FAIL_BEFORE_RENAME.set(0);
		DurableFile.dirOpenBestEffort = false;
		PlayerSaves.reset();
		ChunkDebt.OWED.clear();
		ChunkDebt.FAIL_WRITES.set(0);
		RegionDurability.reset();
		Stockpiles.loadFrom(tmp.resolve("none"));
		SaveGuards.clear();
	}

	static JsonObject doc(int n) {
		JsonObject o = new JsonObject();
		o.addProperty("n", n);
		return o;
	}

	static JsonObject read(Path f) throws IOException {
		return JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	/** A forcer that records each folder forced, failing the ones named. */
	static class Recording implements DurableFile.Forcer {
		final List<Path> dirs = new ArrayList<>();
		final Set<Path> failDirs;

		Recording(Set<Path> failDirs) {
			this.failDirs = failDirs;
		}

		@Override
		public void file(FileChannel ch) throws IOException {
			ch.force(true);
		}

		@Override
		public void dir(Path dir) throws IOException {
			dirs.add(dir.toAbsolutePath().normalize());
			if (failDirs.contains(dir.toAbsolutePath().normalize())) {
				throw new IOException("injected directory force failure");
			}
		}
	}

	// ---------------------------------------------------------------- DurableFile

	@Test
	void p1_5_aFolderThatCannotBeOpenedIsInDoubtNotOk() throws IOException {
		Path dir = Files.createDirectory(tmp.resolve("noread"));
		Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("-wx------")); // create and rename allowed, open for reading denied
		try {
			assumeFalse(Files.isReadable(dir), "running as root: the folder stays readable");
			DurableFile d = new DurableFile("s", dir.resolve("s.json"));
			long g = d.request();
			DurableFile.Result r = d.write(doc(1), g);
			assertEquals(DurableFile.Outcome.IN_DOUBT, r.outcome(), "the rename happened, its folder was never forced: " + r);
			assertFalse(d.written(g));
		} finally {
			Files.setPosixFilePermissions(dir, PosixFilePermissions.fromString("rwx------"));
		}
	}

	@Test
	void p1_5_aFolderOpenFailureThrowsOffWindows() {
		DurableFile.dirOpenBestEffort = false;
		assertThrows(IOException.class, () -> DurableFile.forceDir(tmp.resolve("missing-folder")), "an open that fails is a failed force");
		DurableFile.dirOpenBestEffort = true;
		try {
			DurableFile.forceDir(tmp.resolve("missing-folder"));
		} catch (IOException e) {
			throw new AssertionError("Windows: best effort", e);
		}
	}

	@Test
	void p1_6_eachNewFolderHasItsEntryForcedInItsParent() throws IOException {
		Recording rec = new Recording(Set.of());
		DurableFile.FORCER = rec;
		Path root = tmp.toAbsolutePath().normalize();
		DurableFile d = new DurableFile("s", root.resolve("a/b/c/s.json"));
		assertTrue(d.write(doc(1), d.request()).ok());
		assertTrue(rec.dirs.containsAll(List.of(root, root.resolve("a"), root.resolve("a/b"), root.resolve("a/b/c"))),
			"the new folders a, a/b, a/b/c: each entry forced in its parent, then the file's folder: " + rec.dirs);
		assertTrue(rec.dirs.indexOf(root.resolve("a/b")) < rec.dirs.indexOf(root.resolve("a/b/c")), "outermost first, before the rename's folder force");
	}

	@Test
	void p1_6_aNewFolderWhoseEntryForceFailsIsRefusedAndRetried() throws IOException {
		Path root = tmp.toAbsolutePath().normalize();
		DurableFile.FORCER = new Recording(Set.of(root)); // a's entry in tmp can't be forced
		DurableFile d = new DurableFile("s", root.resolve("a/s.json"));
		assertEquals(DurableFile.Outcome.REFUSED, d.write(doc(1), d.request()).outcome(), "nothing renamed into a folder whose entry is not durable");
		Recording ok = new Recording(Set.of());
		DurableFile.FORCER = ok;
		assertTrue(d.write(doc(2), d.request()).ok());
		assertTrue(ok.dirs.contains(root), "the folder exists now, its entry still owed: retried at the next write: " + ok.dirs);
	}

	@Test
	void p1_8_eachFileCarriesItsOwnPersistedId() throws IOException {
		Path f1 = tmp.resolve("one/stockpiles.json"), f2 = tmp.resolve("two/stockpiles.json");
		DurableFile a = new DurableFile("stockpiles", f1), b = new DurableFile("stockpiles", f2);
		assertTrue(a.write(doc(1), a.request()).ok());
		assertTrue(b.write(doc(1), b.request()).ok());
		String s1 = read(f1).getAsJsonObject(DurableFile.MEMBER).get("store").getAsString();
		String s2 = read(f2).getAsJsonObject(DurableFile.MEMBER).get("store").getAsString();
		UUID.fromString(s1); // a UUID, not the type label
		assertNotEquals(s1, s2, "two ledgers of the same type are two stores");
		assertEquals(s1, new DurableFile("stockpiles", f1).id(), "kept across a reload");
		assertTrue(new DurableFile("stockpiles", f1).satisfies(s1, 1));
		assertFalse(new DurableFile("stockpiles", f2).satisfies(s1, 1), "a replaced file (another id) satisfies nothing");
	}

	@Test
	void p2_9_anObsoleteGenerationNeverReplacesANewerOne() throws IOException {
		Path f = tmp.resolve("s.json");
		DurableFile d = new DurableFile("s", f);
		long g1 = d.request(), g2 = d.request();
		assertTrue(d.write(doc(2), g2).ok());
		DurableFile.Result late = d.write(doc(1), g1); // a delayed older snapshot
		assertEquals(2, read(f).get("n").getAsInt(), "the newer snapshot stays on disk");
		assertEquals(2, read(f).getAsJsonObject(DurableFile.MEMBER).get("gen").getAsLong());
		assertTrue(late.ok(), "generation 1 is covered by 2: " + late);
	}

	@Test
	void txn1_aLoadedGenerationIsWrittenOnlyOnceConfirmed() throws IOException {
		Path f = tmp.resolve("q/s.json");
		DurableFile d = new DurableFile("s", f);
		assertTrue(d.write(doc(1), d.request()).ok());
		Path dir = f.toAbsolutePath().normalize().getParent();
		DurableFile.FORCER = new Recording(Set.of(dir));
		long g = d.request();
		assertEquals(DurableFile.Outcome.IN_DOUBT, d.write(doc(2), g).outcome());
		// a process restart: the page cache still holds the rename, the folder force still fails
		DurableFile again = new DurableFile("s", f);
		assertFalse(again.written(g), "a loaded IN_DOUBT generation is not durable until forced again");
		assertEquals(g, again.inDoubt());
		assertTrue(again.request() > g, "its number is never handed out again");
		// the disk recovers: the next load (or confirm) forces the file and folders, and only then reports it written
		DurableFile.FORCER = DurableFile.REAL;
		DurableFile third = new DurableFile("s", f);
		assertTrue(third.written(g));
		assertTrue(again.confirm().ok());
		assertTrue(again.written(g));
	}

	// ---------------------------------------------------------------- Stockpiles (P1-7)

	static final String PILE = """
		{"id":"sp1","owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}}""";

	@Test
	void p1_7_anOrdinarySaveKeepsTheStoreAndTheGeneration() throws IOException {
		Path f = tmp.resolve(Stockpiles.FILE);
		Files.writeString(f, "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		DurableFile.Result r = null;
		for (int i = 0; i < 3; i++) {
			r = Stockpiles.writeConfirmed(null);
		}
		assertTrue(r.ok(), String.valueOf(r));
		long g = r.gen();
		String id = DurableFile.readId(f, "stockpiles");
		assertNotNull(id);
		Stockpiles.save(); // an autosave, a clean stop
		assertTrue(DurableFile.readGen(f, "stockpiles") >= g, "the ordinary save keeps the generation in the file");
		assertEquals(id, DurableFile.readId(f, "stockpiles"), "and the store id");
		// a new JVM: generations go on from the file's, never reused
		Stockpiles.loadFrom(tmp);
		assertTrue(Stockpiles.writeConfirmed(null).gen() > g);
	}

	@Test
	void p1_7_aReopenedWorldReadsItsLedgerAgain() throws IOException {
		Path f = tmp.resolve(Stockpiles.FILE);
		String plain = "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}";
		Files.writeString(f, plain, StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		for (int i = 0; i < 3; i++) {
			Stockpiles.writeConfirmed(null);
		}
		// the world closes; its ledger is restored from a copy without T0's member; the world opens again in the same process
		Files.writeString(f, plain, StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		DurableFile.Result r = Stockpiles.writeConfirmed(null);
		assertEquals(1, r.gen(), "the restored file's generations, not the closed session's: " + r);
	}

	// ---------------------------------------------------------------- the barrier (P2-10)

	@Test
	void p2_10_aBarrierInsideABarrierIsRefused() {
		DurableBarrier.Result[] inner = new DurableBarrier.Result[1];
		DurableBarrier.Steps f = new DurableBarrier.Steps() {
			@Override
			public String refusal() {
				return null;
			}

			@Override
			public String players() {
				return null;
			}

			@Override
			public String chunks() {
				if (inner[0] == null) {
					inner[0] = DurableBarrier.run(this); // an AFTER_SAVE callback that calls barrier()
				}
				return null;
			}

			@Override
			public DurableFile.Result ledger() {
				return new DurableFile.Result(DurableFile.Outcome.OK, 1, null);
			}
		};
		assertTrue(DurableBarrier.run(f).ok());
		assertEquals(DurableFile.Outcome.REFUSED, inner[0].outcome(), "the nested barrier is refused, never recursed into");
		assertTrue(DurableBarrier.run(new DurableT0Test.Fake()).ok(), "the guard is released");
	}

	@Test
	void p2_10_theExplicitSaveFlagIsRestoredNotReset() {
		boolean outer = Stockpiles.explicitSave(true);
		boolean inner = Stockpiles.explicitSave(true);
		Stockpiles.explicitSave(inner);
		assertTrue(Stockpiles.explicitSave(outer), "the inner scope restored the outer one's true");
	}

	// ---------------------------------------------------------------- players (P1-1, P1-2, TXN item 5)

	final Object steve = new Object();
	final UUID id = UUID.randomUUID();

	void save(UUID who, Object player, boolean ok) {
		PlayerSaves.saving(who, player);
		PlayerSaves.captured("snapshot of " + player);
		PlayerSaves.replaced(ok);
		PlayerSaves.done();
	}

	String step(Set<UUID> online, Runnable saveAll) throws IOException {
		Path dir = Files.createDirectories(tmp.resolve("playerdata"));
		return PlayerSaves.step(saveAll, () -> online, u -> dir.resolve(u + ".dat"), dir);
	}

	void dat(UUID who) throws IOException {
		Files.writeString(Files.createDirectories(tmp.resolve("playerdata")).resolve(who + ".dat"), "x");
	}

	@Test
	void p1_1_aReplaceThatReturnedFalseRefusesTheBarrier() throws IOException {
		dat(id);
		String why = step(Set.of(id), () -> save(id, steve, false));
		assertNotNull(why, "Util.safeReplaceFile's dropped false is a failed save");
		assertNull(step(Set.of(id), () -> save(id, steve, true)), "the next save of the same player pays it");
	}

	@Test
	void p1_1_aMissingFileOrAnUnacknowledgedPlayerRefuses() throws IOException {
		assertNotNull(step(Set.of(id), () -> save(id, steve, true)), "acknowledged, but its .dat is missing");
		dat(id);
		assertNotNull(step(Set.of(id), () -> {
		}), "online, never acknowledged in this round");
		assertNull(step(Set.of(id), () -> save(id, steve, true)));
	}

	@Test
	void p1_2_aFailedLogoutSaveStaysOwedAndIsRewrittenAtTheNextBarrier() throws IOException {
		List<Object> written = new ArrayList<>();
		AtomicInteger fail = new AtomicInteger(1);
		PlayerSaves.worldOpened((u, snap) -> {
			if (fail.getAndDecrement() > 0) {
				return false;
			}
			written.add(snap);
			dat(u);
			return true;
		});
		save(id, steve, false); // the logout save fails; the player leaves
		assertNotNull(step(Set.of(), () -> {
		}), "offline and owed: refused (the snapshot's rewrite failed once)");
		assertNull(step(Set.of(), () -> {
		}), "the kept snapshot rewritten at the next barrier: the debt is paid");
		assertEquals(List.of("snapshot of " + steve), written);
	}

	@Test
	void txn4_2_aReconnectLoadsTheKeptSnapshotNeverTheOlderFile() throws IOException {
		// conservation: deposit 64, the logout replace fails, reconnect while the disk still refuses, barrier, crash: items in == items out
		Map<UUID, Integer> disk = new HashMap<>(Map.of(id, 64)); // the .dat still holds the 64 deposited items
		AtomicBoolean refusing = new AtomicBoolean(true);
		PlayerSaves.worldOpened((u, snap) -> {
			if (refusing.get()) {
				return false;
			}
			disk.put(u, (Integer) snap);
			return true;
		});
		int ledger = 64; // the deposit: 64 items out of the inventory, credited in memory
		PlayerSaves.saving(id, steve);
		PlayerSaves.captured(0); // the inventory after the deposit
		PlayerSaves.replaced(false); // the logout's replace fails: the disk keeps the 64
		PlayerSaves.done();
		Object served = PlayerSaves.loadInstead(id); // the login's read of <uuid>.dat (PlayerSaveFailMixin)
		int joined = served != null ? (Integer) served : disk.get(id);
		assertEquals(0, joined, "the joining player gets the kept snapshot, never the older file's 64");
		Object rejoined = new Object();
		refusing.set(false);
		dat(id);
		assertNull(step(Set.of(id), () -> {
			PlayerSaves.saving(id, rejoined);
			PlayerSaves.captured(joined);
			disk.put(id, joined);
			PlayerSaves.replaced(true);
			PlayerSaves.done();
		}), "the session started from the snapshot: its save pays the debt, the barrier publishes");
		// a crash right after the barrier: what is on disk
		assertEquals(64, disk.get(id) + ledger, "items in == items out");
	}

	@Test
	void txn4_2_theLoginReadIsServedTheSnapshot() throws IOException {
		String p = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/PlayerSaveFailMixin.java"));
		assertTrue(p.contains("load(Lnet/minecraft/server/players/NameAndId;Ljava/lang/String;)Ljava/util/Optional;") && p.contains("cir.setReturnValue("),
			"the login's .dat read answers the kept snapshot when it could not be written first");
	}

	@Test
	void txn4_1_aFolderAnEarlierSessionMadeIsConfirmedBeforeAnAcknowledgedWrite() throws IOException {
		Path root = tmp.toAbsolutePath().normalize();
		Path f = root.resolve("w/architect/stockpiles.json");
		// session 1 creates w/architect and crashes before the folders' entries are forced (their forces fail: the write never acknowledges)
		DurableFile.FORCER = new Recording(Set.of(root, root.resolve("w")));
		assertFalse(new DurableFile("stockpiles", f).write(doc(1), 1).ok());
		assertTrue(Files.isDirectory(f.getParent()), "the folders exist on the restart");
		// session 2 (a restart): an acknowledged write
		Recording rec = new Recording(Set.of());
		DurableFile.FORCER = rec;
		DurableFile d = new DurableFile("stockpiles", f);
		assertTrue(d.write(doc(2), d.request()).ok());
		// a power loss now keeps an entry only if its parent was forced after it was made: architect's in w, w's in the root
		assertTrue(rec.dirs.contains(root.resolve("w")) && rec.dirs.contains(root), "no entry on the path is lost: " + rec.dirs);
	}

	@Test
	void txn4_1_playerdataIsConfirmedInTheWorldBeforeAPlayerSaveIsAcknowledged() throws IOException {
		Recording rec = new Recording(Set.of());
		DurableFile.FORCER = rec;
		dat(id);
		assertNull(step(Set.of(id), () -> save(id, steve, true)));
		assertTrue(rec.dirs.contains(tmp.toAbsolutePath().normalize()), "playerdata's entry in the world forced: " + rec.dirs);
	}

	@Test
	void txn5_aRejoinFirstWritesTheKeptSnapshot() throws IOException {
		List<Object> written = new ArrayList<>();
		PlayerSaves.worldOpened((u, snap) -> written.add(snap));
		save(id, steve, false);
		PlayerSaves.loading(id);
		assertEquals(1, written.size(), "written before the login reads the file");
		assertTrue(PlayerSaves.OWED.isEmpty());
	}

	@Test
	void txn5_aRespawnCarriesTheSessionOnAndPaysTheDebt() throws IOException {
		save(id, steve, false); // the save fails; the player dies before the next barrier
		Object respawned = new Object(); // PlayerList.respawn: a new ServerPlayer, restoreFrom the old one; nothing loaded from the file
		dat(id);
		assertNull(step(Set.of(id), () -> save(id, respawned, true)), "the respawned session holds the loss: its save pays the debt");
	}

	@Test
	void txn5_aDebtWithoutASnapshotTurnsStaleAtALogin() throws IOException {
		PlayerSaves.saving(id, steve);
		PlayerSaves.failed("the save threw before its snapshot"); // no snapshot kept
		PlayerSaves.done();
		PlayerSaves.loading(id); // the player logs in again: the older file loads
		dat(id);
		assertNotNull(step(Set.of(id), () -> save(id, new Object(), true)), "a session loaded from the older file never pays it");
	}

	// ---------------------------------------------------------------- chunks (P1-3, TXN item 5)

	@Test
	void p1_3_aFailedChunkWriteIsOwedResubmittedAndServedToALoad() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 3, -4);
		AtomicInteger resubmitted = new AtomicInteger();
		long a = ChunkDebt.submitted(k, 0);
		ChunkDebt.pendingData(k, a);
		ChunkDebt.writeFailed(k, "tag", ChunkDebt.writing(k), resubmitted::incrementAndGet, "disk full");
		ChunkDebt.saveFailed(k, "reported"); // vanilla's report that follows keeps the snapshot
		assertEquals(1, ChunkDebt.owed().size());
		assertEquals("tag", ChunkDebt.snapshot(k), "a load of the owed chunk gets the snapshot, not the older file");
		assertEquals(1, ChunkDebt.retry());
		assertEquals(1, resubmitted.get());
		long again = ChunkDebt.submitted(k, a); // the resubmission keeps its number
		ChunkDebt.pendingData(k, again);
		ChunkDebt.written(k, ChunkDebt.writing(k));
		assertTrue(ChunkDebt.owed().isEmpty(), "paid by the write of that snapshot");
	}

	@Test
	void r2_3_anOlderQueuedWriteNeverClearsANewerSerializationFailure() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 1, 1);
		// snapshot A queued; then a hopper adds items and snapshot B's serialization fails (marked saved first); then A is written
		ChunkDebt.remark(k, () -> {
		}, "B's serialization failed");
		ChunkDebt.saveFailed(k, "reported");
		ChunkDebt.written(k); // A (queued before B) reaches the region file
		assertEquals(1, ChunkDebt.owed().size(), "A is older than B: B stays owed");
	}

	@Test
	void r2_3_onlyAWriteAtLeastAsNewAsTheFailurePaysAndAResubmissionNeverReplacesNewerData() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 2, 2);
		long a = ChunkDebt.submitted(k, 0);
		ChunkDebt.pendingData(k, a);
		ChunkDebt.remark(k, () -> {
		}, "B's serialization failed"); // after A was submitted
		ChunkDebt.written(k, ChunkDebt.writing(k));
		assertEquals(1, ChunkDebt.owed().size(), "A is numbered before B's failure");
		long c = ChunkDebt.submitted(k, 0); // the barrier's re-mark makes the chunk save again: C
		ChunkDebt.pendingData(k, c);
		ChunkDebt.written(k, ChunkDebt.writing(k));
		assertTrue(ChunkDebt.owed().isEmpty(), "C is newer than B's failure: paid");
		// a failed write's snapshot is never resubmitted over newer data submitted since
		String k2 = ChunkDebt.key("w/minecraft:overworld/chunk", 9, 9);
		long d = ChunkDebt.submitted(k2, 0);
		ChunkDebt.pendingData(k2, d);
		AtomicInteger resub = new AtomicInteger();
		ChunkDebt.writeFailed(k2, "D", ChunkDebt.writing(k2), resub::incrementAndGet, "disk full");
		ChunkDebt.submitted(k2, 0); // E, newer, still in flight
		ChunkDebt.retry();
		assertEquals(0, resub.get(), "D would replace E's pending data");
		assertNull(ChunkDebt.snapshot(k2), "a load reads E (pending), not D");
	}

	@Test
	void txn5_aSerializationFailureIsMarkedUnsavedAtTheBarrierNotAtOnce() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 0, 0);
		AtomicInteger remarked = new AtomicInteger();
		ChunkDebt.remark(k, remarked::incrementAndGet, "serialization failed");
		ChunkDebt.saveFailed(k, "reported");
		assertEquals(0, remarked.get(), "not inside the save that failed");
		assertNull(ChunkDebt.snapshot(k));
		ChunkDebt.retry();
		assertEquals(1, remarked.get(), "the barrier marks it unsaved: its flushed save rewrites it");
		assertEquals(1, ChunkDebt.owed().size(), "owed until that write succeeds");
	}

	@Test
	void txn5_aChunkReloadedWithoutItsSnapshotIsNeverPaidByItsNextWrite() {
		String k = ChunkDebt.key("w/minecraft:overworld/chunk", 5, 5);
		ChunkDebt.remark(k, () -> {
		}, "serialization failed");
		ChunkDebt.saveFailed(k, "reported");
		assertNull(ChunkDebt.snapshot(k), "the chunk unloaded and loads again: from the older file");
		ChunkDebt.written(k); // the reloaded chunk saved
		assertEquals(1, ChunkDebt.owed().size(), "stale: owed until an operator clears it");
		assertEquals(1, ChunkDebt.forgiveAll());
	}

	@Test
	void r2_2_anOutdatedSnapshotNeverPaysANewerFailure() throws IOException {
		List<Object> written = new ArrayList<>();
		PlayerSaves.worldOpened((u, snap) -> {
			written.add(snap);
			dat(u);
			return true;
		});
		save(id, steve, false); // deposit one diamond: the save with one diamond left fails its replace
		PlayerSaves.saving(id, steve); // deposit the second; the logout save fails before its capture (no temp file)
		PlayerSaves.failed("the temp file could not be made");
		PlayerSaves.done();
		assertNotNull(step(Set.of(), () -> {
		}), "the kept snapshot (one diamond) is older than the newest failure: it never pays it");
		assertTrue(written.isEmpty(), "and is never written over the file");
	}

	@Test
	void r2_1_anOrdinarySaveNeverPublishesTheLedgerOverADebt() throws IOException {
		Path f = tmp.resolve(Stockpiles.FILE);
		Files.writeString(f, "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		long g = Stockpiles.writeConfirmed(null).gen();
		save(id, steve, false); // a player's logout save fails: owed
		Stockpiles.save(); // the autosave's (or a save with the world's) ledger write
		assertEquals(g, DurableFile.readGen(f, "stockpiles"), "held: no credit reaches the disk over the owed save");
	}

	@Test
	void r2_1_payoutsWaitWhileASaveIsOwed() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		// (slice SOFF) the saving-off hold may come first: it refuses before anything changes too
		String hold = "\n\t\tSaveHold.require(srv); // (slice SOFF) held while saving is off: refused before anything changes";
		assertTrue(sp.contains("dissolve(MinecraftServer srv, String owner, @Nullable ServerPlayer to) throws Sites.SiteException {" + hold + "\n\t\trequireNoDebt();")
			&& sp.contains("ServerPlayer to) throws Sites.SiteException {" + hold + "\n\t\trequireNoDebt();"), "withdraw and dissolve refuse first");
	}

	@Test
	void r2_4_aFolderWhoseEntryForceFailedBeforeTheFirstRenameIsForcedAfterARestart() throws IOException {
		Path root = tmp.toAbsolutePath().normalize();
		Path f = root.resolve("a/state.json");
		DurableFile.FORCER = new Recording(Set.of(root)); // a's entry in its parent can't be forced: REFUSED, nothing installed
		assertEquals(DurableFile.Outcome.REFUSED, new DurableFile("s", f).write(doc(1), 1).outcome());
		Recording rec = new Recording(Set.of());
		DurableFile.FORCER = rec;
		DurableFile d = new DurableFile("s", f); // the restart: a exists, no generation loads
		assertTrue(d.write(doc(2), d.request()).ok());
		assertTrue(rec.dirs.contains(root), "a's entry forced before the write is acknowledged: " + rec.dirs);
	}

	@Test
	void r2_5_aRegionFolderAndItsMccAreReconfirmedAfterARestart() throws IOException {
		Path world = tmp.resolve("world").toAbsolutePath().normalize();
		Path region = Files.createDirectories(world.resolve("region"));
		Files.writeString(region.resolve("r.0.0.mca"), "x");
		Files.writeString(region.resolve("c.1.1.mcc"), "payload");
		RegionDurability.worldOpened(world);
		RegionDurability.open(region.resolve("r.0.0.mca"), "chunk"); // an existing region file opened after the restart
		AtomicInteger files = new AtomicInteger();
		Recording rec = new Recording(Set.of()) {
			@Override
			public void file(FileChannel ch) throws IOException {
				files.incrementAndGet();
				super.file(ch);
			}
		};
		DurableFile.FORCER = rec;
		assertTrue(RegionDurability.confirmFolders("chunk").isEmpty());
		assertTrue(rec.dirs.contains(region), "the region folder forced: its .mca entries, whatever an earlier session left: " + rec.dirs);
		assertEquals(1, files.get(), "and its .mcc payload");
	}

	@Test
	void r2_6_anUnforcedReplacementUnacknowledgesTheEarlierGeneration() throws IOException {
		Path f = tmp.resolve("s.json");
		DurableFile d = new DurableFile("s", f);
		long g7 = d.request();
		assertTrue(d.write(doc(7), g7).ok());
		assertTrue(d.writeUnforced(doc(8), d.request()));
		assertFalse(d.written(g7), "the unforced file replaced it: a power loss may tear it");
		assertTrue(d.confirm().ok());
		assertTrue(d.written(g7));
	}

	@Test
	void r2_6_theLedgersOrdinarySaveIsForced() throws IOException {
		Path f = tmp.resolve(Stockpiles.FILE);
		Files.writeString(f, "{\"format\":2,\"nextId\":2,\"stockpiles\":[" + PILE + "]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		Stockpiles.writeConfirmed(null);
		Stockpiles.save();
		DurableFile lf = Stockpiles.ledgerFile();
		assertEquals(lf.installedGen(), lf.writtenGen(), "every ledger replacement is acknowledged");
	}

	@Test
	void r2_7_8_theUnloadRewritesAnOwedChunkAndTheBarrierStopsTheTimer() throws IOException {
		String m = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/ChunkMapDebtMixin.java"));
		assertTrue(m.contains("method = \"lambda$scheduleUnload$0\"") && m.contains("chunk.markUnsaved(); // an owed chunk is rewritten by its unload save"));
		String b = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/DurableBarrier.java"));
		assertTrue(b.contains("if (!timerWasOn && SaveTiming.on()) {") && b.contains("SaveTiming.stop();"));
	}

	// ---------------------------------------------------------------- native entries (P1-4)

	@Test
	void p1_4_aNewRegionFolderOrMccWhoseForceFailsIsOwedUntilRetried() throws IOException {
		Path world = tmp.resolve("world").toAbsolutePath().normalize();
		Path region = Files.createDirectories(world.resolve("region"));
		Path mcc = Files.writeString(region.resolve("c.1.2.mcc"), "payload");
		RegionDurability.worldOpened(world);
		assertTrue(RegionDurability.forceNew(mcc, "chunk"));
		RegionDurability.FAILING.add(region);
		assertFalse(RegionDurability.forceNew(region, "chunk"));
		assertEquals(1, RegionDurability.undurable("chunk").size(), "the folder's entry is owed: no ledger over it");
		assertEquals(1, RegionDurability.retryOwed().size(), "still failing");
		RegionDurability.FAILING.clear();
		assertTrue(RegionDurability.retryOwed().isEmpty(), "a folder is retried as a folder");
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
	}

	@Test
	void p1_4_anOwedMccTheCommitDeletedIsPaid() throws IOException {
		Path world = tmp.resolve("world").toAbsolutePath().normalize();
		Path region = Files.createDirectories(world.resolve("region"));
		Path mcc = Files.writeString(region.resolve("c.3.4.mcc"), "payload");
		RegionDurability.worldOpened(world);
		RegionDurability.FAILING.add(mcc);
		assertFalse(RegionDurability.forceNew(mcc, "chunk"));
		RegionDurability.FAILING.clear();
		Files.delete(mcc); // the chunk went back inline: the commit deleted its .mcc
		assertTrue(RegionDurability.retryOwed().isEmpty(), "nothing left to force: paid, never owed for the rest of the session");
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
	}

	@Test
	void theMixinsTakeTheRealResults() throws IOException {
		String p = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/PlayerSaveFailMixin.java"));
		assertTrue(p.contains("Util.safeReplaceOrMoveFile(current, latest, backup, false)") && p.contains("safeReplaceFile(Ljava/nio/file/Path;"),
			"P1-1: the replace's boolean is kept");
		assertTrue(p.contains("PlayerSaves.loadInstead(who.id())"), "TXN 5: a login writes a kept snapshot first (or is served it)");
		String io = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/IOWorkerDebtMixin.java"));
		assertTrue(io.contains("method = \"runStore\"") && io.contains("lambda$loadAsync$0"), "P1-3: runStore's outcome, a load served the snapshot");
		String rf = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/RegionFileFlushMixin.java"));
		assertTrue(rf.contains("writeToExternalFile") && rf.contains("forceNew"), "P1-4: the .mcc forced");
		assertTrue(rf.contains("architect$writeStarts") && rf.contains("architect$external = false; // a write that threw"),
			"the external flag is reset at each write's head (a write that threw never leaves it set)");
		String rc = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/RegionCreateMixin.java"));
		assertTrue(rc.contains("getRegionFile") && rc.contains("forceNew"), "P1-4: a new region file's entry forced");
		String json = Files.readString(Path.of("src/main/resources/architect_mc.mixins.json"));
		for (String m : List.of("IOWorkerDebtMixin", "ChunkSaveFailMixin", "ChunkMapDebtMixin", "RegionCreateMixin")) {
			assertTrue(json.contains("\"" + m + "\""), m + " registered");
		}
		String b = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/DurableBarrier.java"));
		assertTrue(b.contains("SaveTiming.explicit = true") && b.contains("ChunkDebt.retry()"), "P3-11 scope, P1-3 retry in the barrier's chunk step");
	}
}
