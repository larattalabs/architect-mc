package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Stage;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (slice PSVLC3, the three STALLED P1s of the v0.77.0 fix review on adef7f9b) A removal that ends before its undo holding a legacy crate's
 * stock stays STALLED (adef7f9b); these hold what that state must keep:
 * <ol>
 * <li>a crate that still stands means its take never reached the disk: a retry's take <b>replaces</b> the carried stock, never adds to it
 * (adef7f9b: the carried five plus the five taken again, ten);</li>
 * <li>no other removal of the group starts while one of its removals is stalled, so a stalled stage's carried stock is never stranded by a
 * whole-group removal (adef7f9b: the group removal ran, the stage went UNDONE, and the stage's retry was refused by its state before it found
 * its stalled entry); (undoStage also looks for its stalled entry before it judges the stage's state: not driven here, the resume's queue
 * save needs a server);</li>
 * <li>a retry runs the per-member checks again (the player scan, the blocker scan): adef7f9b resumed with the counters of the scan that had
 * finished, so a player who entered the box while it was stalled was not waited for.</li>
 * </ol>
 * The crash itself (P1 1: the queue holding the carried stock, the world's last save the crate with it) is psv-crash's PSV5.
 */
class StalledRemovalPSVLC3Test {
	@BeforeAll
	static void boot() {
		// the queue save after a resume reads Batches, whose class init needs the registries (unbooted, it fails and poisons the JVM's later tests)
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() throws Exception {
		Groups.load(new JsonArray());
		groups(Map.of());
	}

	private static void groups(Map<String, SiteGroupRec> m) throws Exception {
		Field f = Sites.class.getDeclaredField("groups");
		f.setAccessible(true);
		f.set(null, m);
	}

	private static SiteGroupRec group(String id, Stage.State stageState) {
		return new SiteGroupRec(id, null, new JsonObject(), List.of("a", "b"), List.of(new SiteGroupRec.StageRec("s1", List.of("i1"), stageState, List.of("a"),
			"b1")), SiteGroupRec.ACTIVE, false, null, null, 0L);
	}

	/** A removal saved stalled before its undo (adef7f9b's end() for a carried crate stock), loaded as the queue file loads it. */
	private static void stalled(String group, String stage, String site) {
		Groups.Removal r = new Groups.Removal(group, stage, null, true);
		r.sites.add(site);
		r.started = true;
		r.decStock.put(site, new java.util.TreeMap<>(Map.of("minecraft:oak_planks", 5)));
		r.decItems.put(site, Map.of("minecraft:oak_planks", 5));
		r.decAt.put(site, new long[] {42});
		JsonObject o = r.toJson();
		o.addProperty("stalled", true);
		JsonArray a = new JsonArray();
		a.add(o);
		Groups.load(a);
	}

	private static Groups.Removal findStalled(String group, String stage) throws Exception {
		Method m = Groups.class.getDeclaredMethod("stalled", String.class, String.class);
		m.setAccessible(true);
		return (Groups.Removal) m.invoke(null, group, stage);
	}

	// ------------------------------------------------------------------ P1 1

	@Test
	void aStandingCratesRetakeReplacesTheCarriedStockNeverAddsToIt() {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.decStock.put("s1", new java.util.TreeMap<>(Map.of("minecraft:oak_planks", 5))); // carried: saved with the removal before a crash
		// after the crash the world's last save still holds the crate with its five: R1 takes them again (all() holds the crate's stock)
		Map<String, Integer> items = Groups.withStock(r, "s1", Map.of("minecraft:oak_planks", 12), Map.of("minecraft:oak_planks", 5));
		assertEquals(Map.of("minecraft:oak_planks", 12), items, "the seven refunded plus the crate's five once (adef7f9b: 17, the five twice)");
		assertEquals(Map.of("minecraft:oak_planks", 5), r.decStock.get("s1"), "the carried stock is the take that stands now (adef7f9b: 10)");
	}

	@Test
	void aStandingEmptyCrateVoidsTheCarriedStock() {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.decStock.put("s1", new java.util.TreeMap<>(Map.of("minecraft:oak_planks", 5)));
		// the crate stands (its take never reached the disk) and its last saved stock is empty: nothing to drop
		Map<String, Integer> items = Groups.withStock(r, "s1", Map.of("minecraft:oak_planks", 7), Map.of(), true);
		assertEquals(Map.of("minecraft:oak_planks", 7), items, "no stock minted from a take the world does not hold");
		assertNull(r.decStock.get("s1"));
		// the crate is gone (its take is on disk): the carried stock is the only record of it, carried once
		Groups.Removal g = new Groups.Removal("g1", null, null, false);
		g.decStock.put("s1", new java.util.TreeMap<>(Map.of("minecraft:oak_planks", 5)));
		assertEquals(Map.of("minecraft:oak_planks", 12), Groups.withStock(g, "s1", Map.of("minecraft:oak_planks", 7), Map.of(), false));
		assertEquals(Map.of("minecraft:oak_planks", 5), g.decStock.get("s1"));
	}

	// ------------------------------------------------------------------ P1 2

	@Test
	void aWholeGroupRemovalIsRefusedWhileAStageRemovalOfTheGroupIsStalled() throws Exception {
		groups(Map.of("g1", group("g1", Stage.State.PLACED)));
		stalled("g1", "s1", "a");
		CompletableFuture<Groups.Removed> f = Groups.removeGroup(null, "g1", null, true);
		assertTrue(f.isDone() && !f.isCompletedExceptionally(), "refused at once, before anything is touched (adef7f9b: it ran)");
		Groups.Removed res = f.join();
		assertFalse(res.removed());
		assertTrue(String.join(" ", res.blockers()).contains("stage s1"), String.valueOf(res.blockers()));
		assertNotNull(findStalled("g1", "s1"), "the stalled stage keeps its carried stock for its own retry");
		assertEquals(SiteGroupRec.ACTIVE, Sites.group("g1").state(), "the group not marked REMOVING");
	}

	@Test
	void aStageUndoIsRefusedWhileTheWholeGroupsRemovalIsStalled() throws Exception {
		groups(Map.of("g1", group("g1", Stage.State.PLACED)));
		stalled("g1", null, "a");
		CompletableFuture<Groups.Removed> f = Groups.undoStage(null, "g1", "s1", true);
		assertTrue(f.isCompletedExceptionally(), "refused (adef7f9b: a stage removal started beside the stalled group removal)");
		assertNotNull(findStalled("g1", null));
	}

	@Test
	void aWholeGroupRemovalIsRefusedWhileAStageUndoOfTheGroupRuns() throws Exception {
		// (fix round, GPT P1 3) ca946197 admitted it beside the running stage undo: both could record the same crate and, both stalled, block
		// each other's retry for ever
		groups(Map.of("g1", group("g1", Stage.State.PLACED)));
		Groups.Removal st = new Groups.Removal("g1", "s1", null, true);
		st.sites.add("a");
		st.started = true;
		JsonArray a = new JsonArray();
		a.add(st.toJson());
		Groups.load(a); // running, not stalled
		CompletableFuture<Groups.Removed> f = Groups.removeGroup(null, "g1", null, true);
		assertTrue(f.isDone() && !f.isCompletedExceptionally(), "refused at once (ca946197: it started)");
		assertFalse(f.join().removed());
		assertTrue(String.join(" ", f.join().blockers()).contains("stage s1"), String.valueOf(f.join().blockers()));
		assertTrue(Groups.stageRemovalRunning("g1", "s1"));
	}

	@Test
	void aChangedCrateRecordIsConfirmedBeforeR1GoesOnTakesOrNot() {
		// (fix round, GPT P1 2) the crate emptied after its stock was recorded: the cleared record is saved and waited for, though nothing is
		// taken (ca946197 went on at once)
		assertEquals(Groups.CrateStep.SAVE, Groups.crateStep(false, true, 5, false, true));
		assertEquals(Groups.CrateStep.WAIT, Groups.crateStep(false, false, 6, false, false), "the cleared record's write pending");
		assertEquals(Groups.CrateStep.GO, Groups.crateStep(false, false, 6, false, true));
		assertEquals(Groups.CrateStep.SAVE, Groups.crateStep(false, false, 6, true, false), "its write failed: saved again");
		assertEquals(Groups.CrateStep.GO, Groups.crateStep(false, false, 0, false, false), "nothing recorded, nothing to take");
		assertEquals(Groups.CrateStep.SAVE, Groups.crateStep(true, false, 0, false, false), "a take never saved this session");
		assertEquals(Groups.CrateStep.WAIT, Groups.crateStep(true, false, 7, false, false));
		assertEquals(Groups.CrateStep.GO, Groups.crateStep(true, false, 7, false, true));
	}

	@Test
	void aContainersItemsWithTheirOwnDataAreNotCreditedById() {
		// (fix round, GPT P1 4) a holder's contents are credited by item id; a stack with its own data (a name, an enchantment) would lose it
		assertEquals(Map.of("minecraft:diamond", 5), Groups.cargoOf(List.of(new Groups.Stack("minecraft:diamond", 3, false), new Groups.Stack(
			"minecraft:diamond", 2, false))));
		assertNull(Groups.cargoOf(List.of(new Groups.Stack("minecraft:diamond", 3, false), new Groups.Stack("minecraft:diamond_sword", 1, true))),
			"the removal ends instead, the holder as it is");
	}

	// ------------------------------------------------------------------ P1 3

	@Test
	void aRetryRunsThePerMemberChecksAgain() throws Exception {
		stalled("g1", null, "a");
		Groups.Removal r = findStalled("g1", null);
		// the session's R1 that stalled it had finished both scans (a stall is an end after them)
		r.scan = 1;
		r.blockerScan = 1;
		r.outsideF = CompletableFuture.completedFuture(new java.util.LinkedHashSet<>());
		Method m = Groups.class.getDeclaredMethod("resume", Groups.Removal.class, CompletableFuture.class);
		m.setAccessible(true);
		m.invoke(null, r, new CompletableFuture<Groups.Removed>());
		assertEquals(0, r.scan, "the player scan runs again (adef7f9b: skipped, a player who entered meanwhile was not waited for)");
		assertEquals(0, r.blockerScan, "the blocker scan runs again");
		assertNull(r.outsideF, "the covering sites found again");
	}
}
