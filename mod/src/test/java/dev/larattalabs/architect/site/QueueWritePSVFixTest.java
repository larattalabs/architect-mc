package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice PSV fix round, the rule-15 GPT review's three P1s) (1) a queue generation counts as written only after its rename is made durable:
 * the folder forced after the rename; (3) a removal touches nothing until a queue write it asked for is confirmed (the preflight), and a plan
 * whose pre-save write failed after R1 is dropped and made again (its legacy crate stock carried), never committed frozen. On bb95ec19 the
 * folder was never synced, preSaved kept the failed plan waiting, and a second R1 lost the crate stock the first took.
 */
class QueueWritePSVFixTest {
	@AfterEach
	void reset() {
		Placement.DIR_SYNC = Placement::forceDir;
		Placement.FAIL_WRITES.set(0);
		Placement.FAIL_AT_PRESAVE.set(0);
	}

	private static long nextGen() {
		return Math.max(Placement.writtenGen(), Placement.requestedGen()) + 1;
	}

	/** A write that succeeds, so no failure carries into the next test. */
	private static long clean(Path dir) {
		long g = nextGen();
		assertTrue(Placement.writeSave(new JsonObject(), dir.resolve(Placement.FILE), g));
		return g;
	}

	@Test
	void theFolderIsForcedAfterTheRenameAndBeforeTheGenerationCounts(@TempDir Path dir) {
		clean(dir);
		Path f = dir.resolve(Placement.FILE);
		long gen = nextGen();
		List<String> seen = new ArrayList<>();
		Placement.DIR_SYNC = d -> seen.add(d + " file=" + Files.exists(f) + " tmp=" + Files.exists(dir.resolve(Placement.FILE + ".tmp")) + " written="
			+ Placement.written(gen));
		JsonObject root = new JsonObject();
		root.addProperty("version", 1);
		assertTrue(Placement.writeSave(root, f, gen));
		assertEquals(List.of(dir.toAbsolutePath() + " file=true tmp=false written=false"), seen,
			"the folder synced once, after the rename, before the generation is acknowledged (bb95ec19: never synced)");
		assertTrue(Placement.written(gen));
	}

	@Test
	void aFailedFolderSyncIsAFailedWriteAndTheRetryAcknowledgesIt(@TempDir Path dir) {
		clean(dir);
		Path f = dir.resolve(Placement.FILE);
		long gen = nextGen();
		Placement.DIR_SYNC = d -> {
			throw new IOException("injected directory fsync failure (TEST)");
		};
		assertFalse(Placement.writeSave(new JsonObject(), f, gen), "the rename is not durable: not written");
		assertFalse(Placement.written(gen));
		assertTrue(Placement.writeFailing(), "a retry is due");
		assertTrue(Placement.failed(gen));
		Placement.DIR_SYNC = Placement::forceDir;
		assertTrue(Placement.writeSave(new JsonObject(), f, gen + 1), "the retry, the real folder sync on this platform");
		assertTrue(Placement.written(gen));
		assertFalse(Placement.writeFailing());
	}

	@Test
	void thePreflightWaitsUntouchedWhileWritesFailThenAsksAgain(@TempDir Path dir) {
		clean(dir);
		Path f = dir.resolve(Placement.FILE);
		Placement.Preflight p = new Placement.Preflight();
		int[] asked = {0};
		java.util.function.LongSupplier save = () -> {
			asked[0]++;
			long g = nextGen();
			Placement.writeSave(new JsonObject(), f, g);
			return g;
		};
		Placement.FAIL_WRITES.set(1);
		assertFalse(p.ready(save), "asked: its write fails");
		assertFalse(p.ready(save), "the failure seen: not ready");
		assertFalse(p.ready(save), "writes still failing: it waits, asking nothing");
		assertEquals(1, asked[0]);
		long retry = nextGen();
		assertTrue(Placement.writeSave(new JsonObject(), f, retry), "Placement's retry is written");
		assertFalse(p.ready(save), "asked again, after the retry");
		assertEquals(2, asked[0]);
		assertTrue(p.ready(save), "its own save confirmed: ready");
		assertTrue(p.ready(save), "ready stays while nothing fails");
	}

	@Test
	void aPreSaveThatFailedAfterR1DropsThePlan(@TempDir Path dir) {
		clean(dir);
		Path f = dir.resolve(Placement.FILE);
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.planGroup = "u:group-g1:1";
		r.planned = r.planGroup;
		r.plannedSites.add("s1");
		r.planIds = List.of("s1");
		r.scan = 3;
		r.blockerScan = 3;
		r.decItems.put("s1", Map.of("minecraft:oak_planks", 9));
		r.decAt.put("s1", new long[] {1});
		r.decCredit.put("s2", new Groups.Credit("o", "k", Map.of("minecraft:stone", 4), 0));
		long gen = nextGen();
		Placement.FAIL_WRITES.set(1);
		assertFalse(Placement.writeSave(new JsonObject(), f, gen));
		r.preSave = gen;
		assertFalse(Groups.preSaved(null, r), "no commit");
		assertNull(r.planned, "the failed plan is dropped (bb95ec19: kept, committed frozen once a retry wrote)");
		assertNull(r.planGroup);
		assertEquals(0, r.preSave);
		assertEquals(0, r.scan, "the checks run again");
		assertEquals(0, r.blockerScan);
		assertTrue(r.decItems.isEmpty() && r.decCredit.isEmpty(), "the tallies go: R1 tallies again against the world then");
		assertEquals(List.of("s1"), r.planIds, "kept: an end gives back the custody held for them");
		clean(dir);
	}

	@Test
	void aLegacyCrateStockTakenByTheFirstR1IsCarriedOnceIntoTheReplan() {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		Map<String, Integer> stock = Map.of("minecraft:oak_planks", 5);
		Map<String, Integer> first = Groups.withStock(r, "s1", Map.of("minecraft:oak_planks", 7, "minecraft:cobblestone", 2), stock);
		assertEquals(Map.of("minecraft:oak_planks", 7, "minecraft:cobblestone", 2), first, "the first R1's items (its stock in its all())");
		r.decItems.put("s1", first);
		r.decAt.put("s1", new long[] {42});
		Groups.dropPlan(r);
		assertTrue(r.decItems.containsKey("s1") && r.decAt.get("s1")[0] == 42, "a member with carried stock keeps where it drops");
		// the second R1: the crate is gone (restored), so prepareDeconstruct takes no stock; a block was mined meanwhile
		Map<String, Integer> again = Groups.withStock(r, "s1", Map.of("minecraft:cobblestone", 1), Map.of());
		assertEquals(Map.of("minecraft:oak_planks", 5, "minecraft:cobblestone", 1), again, "the stock once, the tally as the world is now");
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals(stock, back.decStock.get("s1"), "the carried stock is saved with the removal");
	}

	/**
	 * (v0.77.0 release review P1 2, fix a1) A pre-save whose write failed stays failed once a later write succeeds: the plan is dropped and
	 * tallied again, never committed with the tally made before the failure. On 5252ded7 the later write cleared failed(g): preSaved answered
	 * written and committed the stale tally (a plank mined meanwhile paid out twice).
	 */
	@Test
	void aPreSaveFailureStaysFailedAfterALaterWriteSucceeds(@TempDir Path dir) {
		clean(dir);
		Path f = dir.resolve(Placement.FILE);
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.planGroup = "u:group-g1:1";
		r.planned = r.planGroup;
		r.plannedSites.add("s1");
		r.planIds = List.of("s1");
		r.decItems.put("s1", Map.of("minecraft:oak_planks", 9));
		r.decAt.put("s1", new long[] {1});
		long gen = nextGen();
		r.preSave = gen;
		Placement.FAIL_WRITES.set(1);
		assertFalse(Placement.writeSave(new JsonObject(), f, gen), "the pre-save's write fails");
		// a later write (Placement's retry, or any other save) succeeds before the removal looks again (the saver is off the server thread,
		// and a large undo does not look while its commit is built)
		assertTrue(Placement.writeSave(new JsonObject(), f, gen + 1));
		assertTrue(Placement.written(gen), "the later write covers the generation");
		assertTrue(Placement.failed(gen), "the failure is sticky until the plan is made again (5252ded7: cleared by the later write)");
		assertFalse(Groups.preSaved(null, r), "no commit of the plan made before the failure");
		assertNull(r.planned, "the plan is dropped");
		assertEquals(0, r.preSave, "made again: the next pre-save is a new generation");
		assertTrue(r.decItems.isEmpty(), "the tally goes: R1 tallies again against the world");
		long again = nextGen();
		assertTrue(Placement.writeSave(new JsonObject(), f, again));
		assertFalse(Placement.failed(again), "the replan's own pre-save, written, is not failed");
		assertTrue(Groups.preSaveWritten(again));
	}

	/**
	 * (v0.77.0 release review P1 1, fix a2) A removal that ends before its undo with a legacy crate's stock carried (its pre-save failed, the
	 * plan dropped, the rescan refused) stays STALLED, the stock saved with it: the crate it came from is gone (prepareDeconstruct restores the
	 * crate's cell as it takes the stock) and a crate's stock never comes from a stockpile, so it can't be given back safely. On 5252ded7 the
	 * removal left the queue and the stock was lost.
	 */
	@Test
	void anEndAfterADroppedPlanKeepsTheCarriedCrateStockStalled() {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.sites.add("s1");
		r.started = true;
		Map<String, Integer> stock = Map.of("minecraft:oak_planks", 5);
		r.decItems.put("s1", Groups.withStock(r, "s1", Map.of("minecraft:oak_planks", 7), stock));
		r.decAt.put("s1", new long[] {42});
		Groups.dropPlan(r); // the pre-save failed
		assertEquals(stock, r.decStock.get("s1"));
		assertTrue(Groups.stallsAtEnd(r, false), "the carried stock keeps the removal STALLED (5252ded7: it left the queue, the stock lost)");
		com.google.gson.JsonObject o = r.toJson();
		o.addProperty("stalled", true);
		Groups.Removal back = Groups.Removal.fromJson(o);
		assertEquals(stock, back.decStock.get("s1"), "saved with it: a retry carries it into its deconstruct items once");
		assertFalse(Groups.stallsAtEnd(r, true), "a removal that ended removed dropped it with its deconstruct items");
		assertFalse(Groups.stallsAtEnd(new Groups.Removal("g2", null, null, false), false), "nothing carried, no undo: it ends");
	}
}
