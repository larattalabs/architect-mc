package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * (slice DR-S, the coordinator's strict fix) A survival group removal whose save is refused changes nothing: the save-first probe runs
 * before its fluid drain and a stage's irrigation drain, the custody save's refusal gives the custody back, and the player blocks are found
 * (not dropped) for the tally and dropped only after the credit hold's save. The probe itself: a refusal is its message, a save that runs
 * is none. The ordering is read from Groups.java (as PredicatePathsTest reads the write paths).
 */
class GroupsSaveFirstDRSTest {
	@Test
	void probeTurnsARefusedSaveIntoItsReasonAndRunsTheSaveOnce() {
		AtomicInteger runs = new AtomicInteger();
		assertNull(Groups.probe(runs::incrementAndGet), "a save that runs: no refusal");
		assertEquals(1, runs.get());
		String why = Groups.probe(() -> {
			throw new IllegalStateException("Stockpiles: the ledger was not saved: chunk writes not durable [r.0.0.mca]");
		});
		assertEquals("Stockpiles: the ledger was not saved: chunk writes not durable [r.0.0.mca]", why);
	}

	@Test
	void nothingDrainsOrDropsBeforeTheSaves() throws Exception {
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java"));
		int probe = src.indexOf("String refused = probe(() -> Stockpiles.saveWithWorld(server));");
		int drain = src.indexOf("RegionFluids.removalGate(server, r.group)");
		int irrigation = src.indexOf("Sites.drainIrrigation(server, Sites.get(sid))");
		assertTrue(probe > 0 && probe < drain && probe < irrigation, "the save-first probe precedes the fluid drain and the irrigation drain");
		int find = src.indexOf("RegionTargets.dropPlayerBlocks(level, inf, false)");
		int hold = src.indexOf("if (holdPending(r)) {");
		int apply = src.indexOf("Extractions.run(server, level, inf, r.requester)"); // (slice T4R-D, D1c) the extraction, after the saves
		int applyRoad = apply; // (slice T4R-D, D1c) one extraction covers both producers
		assertTrue(find > 0 && find < hold && hold < apply && hold < applyRoad, "found for the tally, dropped only after the credit hold's save");
		assertFalse(src.contains("dropPlayerBlocks(level, inf);") || src.contains("dropPlayerMatches(level, inf);"), "no drop before the save");
		int custodySave = src.indexOf("String refused = probe(() -> Stockpiles.saveWithWorld(server)); // (DR-S) a refused save gives the custody back");
		assertTrue(custodySave > 0 && custodySave < find, "the custody save's refusal is caught (custody written back) before the tally");
	}
}
