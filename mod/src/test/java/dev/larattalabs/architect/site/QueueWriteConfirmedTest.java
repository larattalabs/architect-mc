package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice PSV) An undo's pre-save (Groups' preSaved, RestoreJob's groupSaved) lets the commit go only once the queue file generation that
 * holds the removal's record is confirmed written (forced to disk and renamed, no exception). On 97d04b80 the guard was the saver's turn
 * ({@code Placement.saved()}), which completed after a failed write: the undo committed unrecorded.
 */
class QueueWriteConfirmedTest {
	private static long nextGen() {
		return Math.max(Placement.writtenGen(), Placement.requestedGen()) + 1;
	}

	@Test
	void aFailedQueueWriteKeepsTheCommitWaitingAndASuccessfulRetryLetsItGo(@TempDir Path dir) throws Exception {
		Path f = dir.resolve(Placement.FILE);
		JsonObject root = new JsonObject();
		root.addProperty("version", 1);
		long gen = nextGen();
		// a real IO fault: a directory where the temporary file goes (the write throws, as on a full disk or a read-only world folder)
		Path tmp = dir.resolve(Placement.FILE + ".tmp");
		Files.createDirectory(tmp);
		assertFalse(Placement.writeSave(root, f, gen), "the write fails");
		assertTrue(Placement.writeFailing(), "a retry is due");
		assertFalse(Placement.written(gen), "the failed generation is not written");
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.planned = "u:group-g1:1";
		r.preSave = gen;
		assertFalse(Groups.preSaveWritten(r.preSave), "no commit: the queue file does not hold the removal's planned undo");
		assertFalse(Files.exists(f), "nothing reached the file");

		// the retry (Placement's tick saves again every 5 s while writes fail): a later generation holds the same record
		Files.delete(tmp);
		assertTrue(Placement.writeSave(root, f, gen + 1), "the retry is written");
		assertFalse(Placement.writeFailing());
		assertTrue(Placement.written(gen), "a later completed write covers the earlier generation");
		assertTrue(Groups.preSaveWritten(r.preSave), "the commit goes once its record is on disk");
		assertTrue(Files.exists(f));
		assertFalse(Files.exists(tmp));
	}

	@Test
	void anInjectedFailureIsNotConfirmedEither(@TempDir Path dir) {
		Path f = dir.resolve(Placement.FILE);
		long gen = nextGen();
		Placement.FAIL_WRITES.set(1);
		try {
			assertFalse(Placement.writeSave(new JsonObject(), f, gen));
			assertFalse(Groups.preSaveWritten(gen));
			assertTrue(Placement.writeSave(new JsonObject(), f, gen + 1), "the injection is used up");
			assertTrue(Groups.preSaveWritten(gen));
		} finally {
			Placement.FAIL_WRITES.set(0);
		}
	}

	@Test
	void aRefusedSaveIsNeverWrittenAndALoadedPlanIsAlreadyDurable(@TempDir Path dir) {
		assertTrue(Placement.writeSave(new JsonObject(), dir.resolve(Placement.FILE), nextGen()));
		assertFalse(Placement.written(Placement.NOT_SAVED), "the queue file failed to load: nothing is saved, so no commit");
		assertFalse(Groups.preSaveWritten(Placement.NOT_SAVED));
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.planned = "u:group-g1:1";
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals(0, back.preSave, "a loaded removal requested no save this session");
		assertTrue(Groups.preSaveWritten(back.preSave), "its planned undo came from the file");
	}
}
