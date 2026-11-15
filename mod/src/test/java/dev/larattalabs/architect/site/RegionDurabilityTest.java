package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * (SS, the GPT review) RegionDurability's rules, driven the way RegionFileFlushMixin drives them (open, writeHeader, flush's head and
 * return, close's head and force). The same cases run against real RegionFiles with the mixins applied in SaveProbe (ps-crash).
 */
class RegionDurabilityTest {
	static final Path A = Path.of("w/region/r.0.0.mca");

	@BeforeEach
	void reset() {
		RegionDurability.reset();
	}

	/** A flush as the mixin runs it: head (skip?), the force, the return. False when skipped. */
	static boolean flush(RegionDurability.State s) throws IOException {
		if (RegionDurability.skip(s)) {
			return false;
		}
		RegionDurability.forced(s);
		return true;
	}

	@Test
	void aNewObjectIsUnknownAndItsFirstFlushForces() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		assertTrue(flush(s), "first flush forces with nothing written by this object");
		assertFalse(flush(s), "then a clean flush skips");
	}

	@Test
	void aWriteIsUndurableUntilAForceCoversItsGeneration() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		flush(s);
		RegionDurability.written(s);
		assertEquals(1, RegionDurability.undurable("chunk").size());
		assertTrue(RegionDurability.skip(s) == false);
		RegionDurability.written(s); // a write after the force began: not covered by it
		RegionDurability.forced(s);
		assertEquals(1, RegionDurability.undurable("chunk").size(), "the later write is not taken as covered");
		assertTrue(flush(s));
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
	}

	@Test
	void aFailedForceCoversNothingAndIsRetried() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		flush(s);
		RegionDurability.written(s);
		RegionDurability.FAILING.add(A);
		assertThrows(IOException.class, () -> RegionDurability.skip(s));
		RegionDurability.FAILING.remove(A);
		assertFalse(RegionDurability.undurable("chunk").isEmpty(), "still owed");
		assertTrue(flush(s), "retried at the next flush");
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
	}

	@Test
	void aFailedCloseOwesItsPathAndAReopenStartsUnknown() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		flush(s);
		RegionDurability.written(s);
		RegionDurability.closing(s);
		RegionDurability.FAILING.add(A);
		assertThrows(IOException.class, () -> RegionDurability.closeForcing(s)); // the close's force failed; the channel is closed anyway
		RegionDurability.FAILING.remove(A);
		RegionDurability.State r = RegionDurability.open(A, "chunk");
		assertEquals(1, RegionDurability.undurable("chunk").size(), "the owed path blocks the ledger after the reopen");
		assertTrue(flush(r), "the reopened object forces at its first flush");
		assertTrue(RegionDurability.undurable("chunk").isEmpty(), "its force discharges the path (fsync is per file)");
	}

	@Test
	void aCleanCloseOwesNothing() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		RegionDurability.written(s);
		RegionDurability.closing(s);
		RegionDurability.closeForcing(s);
		RegionDurability.closeForced(s);
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
	}

	@Test
	void oneBarrierPerWorldSave() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		flush(s);
		RegionDurability.saveStarted();
		assertTrue(RegionDurability.barrierNeeded(), "nothing forced in this save yet");
		assertFalse(flush(s), "clean");
		RegionDurability.barrier(() -> assertTrue(flush(s), "the barrier's flush forces a clean file"));
		assertFalse(RegionDurability.barrierNeeded(), "once per save");
		RegionDurability.saveStarted();
		RegionDurability.written(s);
		assertTrue(flush(s));
		assertFalse(RegionDurability.barrierNeeded(), "a real force is the barrier");
	}

	@Test
	void theLedgerCheckIsScopedByStorageType() throws IOException {
		RegionDurability.State poi = RegionDurability.open(Path.of("w/poi/r.0.0.mca"), "poi");
		RegionDurability.written(poi); // vanilla's flushed save never forces POI: not the ledger's
		RegionDurability.State e = RegionDurability.open(Path.of("w/entities/r.0.0.mca"), "entities");
		RegionDurability.written(e);
		assertTrue(RegionDurability.undurable("chunk").isEmpty());
		assertEquals(1, RegionDurability.undurable("chunk", "entities").size());
	}

	@Test
	void anOwedPathIsRetriedAtTheNextSaveOnceTheDiskRecovers(@org.junit.jupiter.api.io.TempDir Path dir) throws IOException {
		Path f = dir.resolve("r.0.0.mca");
		java.nio.file.Files.writeString(f, "region");
		RegionDurability.worldOpened(dir);
		RegionDurability.State s = RegionDurability.open(f, "chunk");
		RegionDurability.written(s);
		RegionDurability.closing(s);
		RegionDurability.FAILING.add(f);
		assertThrows(IOException.class, () -> RegionDurability.closeForcing(s));
		assertEquals(1, RegionDurability.retryOwed().size(), "still failing: the retry fails, the path stays owed");
		assertEquals(1, RegionDurability.undurable("chunk").size(), "the ledger stays refused");
		RegionDurability.FAILING.remove(f); // the disk recovers
		assertTrue(RegionDurability.retryOwed().isEmpty(), "the next save's retry reopens and forces it");
		assertTrue(RegionDurability.undurable("chunk").isEmpty(), "and the ledger may publish");
	}

	@Test
	void aMissingOwedFileStaysOwed(@org.junit.jupiter.api.io.TempDir Path dir) {
		Path f = dir.resolve("r.1.1.mca");
		RegionDurability.worldOpened(dir);
		RegionDurability.OWED.put(f, "chunk");
		assertEquals(1, RegionDurability.retryOwed().size(), "a file that can't be opened can't be forced: fail closed");
		assertEquals(1, RegionDurability.undurable("chunk").size());
	}

	@Test
	void onlyTheRunningWorldCountsAndAClosedWorldOwesNothing(@org.junit.jupiter.api.io.TempDir Path dir) throws IOException {
		Path w1 = dir.resolve("w1"), w2 = dir.resolve("w2");
		RegionDurability.worldOpened(w1);
		RegionDurability.OWED.put(w1.resolve("region/r.0.0.mca"), "chunk");
		RegionDurability.State other = RegionDurability.open(w2.resolve("region/r.0.0.mca"), "chunk");
		RegionDurability.written(other);
		assertEquals(1, RegionDurability.undurable("chunk").size(), "w1's owed path counts, w2's file does not");
		RegionDurability.worldClosed();
		RegionDurability.worldOpened(w2);
		RegionDurability.State s = RegionDurability.open(w2.resolve("region/r.0.0.mca"), "chunk");
		assertTrue(RegionDurability.undurable("chunk").isEmpty(), "nothing of w1 is owed in w2");
		RegionDurability.written(s);
		assertEquals(1, RegionDurability.undurable("chunk").size());
	}

	@Test
	void aForceThatStartedInAnEarlierSaveIsNotThisSavesBarrier() throws IOException {
		RegionDurability.State s = RegionDurability.open(A, "chunk");
		RegionDurability.saveStarted(); // save 1
		RegionDurability.written(s);
		assertFalse(RegionDurability.skip(s)); // a force starts in save 1 ...
		RegionDurability.saveStarted(); // ... save 2 starts (the players saved) before the force's return hook runs
		RegionDurability.forced(s);
		assertTrue(RegionDurability.barrierNeeded(), "save 2 still needs its own barrier");
		RegionDurability.State c = RegionDurability.open(Path.of("w/region/r.2.2.mca"), "chunk");
		RegionDurability.written(c);
		RegionDurability.closing(c);
		RegionDurability.closeForcing(c); // an eviction's close force starts in save 2 ...
		RegionDurability.saveStarted(); // ... save 3 starts
		RegionDurability.closeForced(c);
		assertTrue(RegionDurability.barrierNeeded(), "nor is a close's force that started earlier");
	}
}
