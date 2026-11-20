package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (slice SOFF) A ledger save never publishes over a level with saving off (/save-off): saveAllChunks skips such a level unless forced and
 * RegionDurability sees no write for it, so the ledger would be ahead of the world (soff-crash measures the mint and the loss in game).
 */
class StockpileSavingOffSOFFTest {
	@Test
	void refusedWhileAnyLevelHasSavingOffUnlessForced() {
		assertNull(Stockpiles.savingOffRefusal(List.of(), false, "x", "y"), "saving on: no refusal (behaviour as before)");
		assertNull(Stockpiles.savingOffRefusal(List.of(), true, "x", "y"));
		assertNull(Stockpiles.savingOffRefusal(List.of("minecraft:overworld"), true, "x", "y"), "a forced save (/save-all) writes those levels too");
		String m = Stockpiles.savingOffRefusal(List.of("minecraft:overworld", "minecraft:the_nether"), false, "the periodic save did not write", "it is saved");
		assertNotNull(m);
		assertTrue(m.contains("minecraft:overworld") && m.contains("minecraft:the_nether"), "names every dimension: " + m);
		assertTrue(m.contains("/save-on") && m.contains("/save-off"), "says /save-on: " + m);
	}

	@Test
	void loggedOncePerChangeOfTheLevelsOff() {
		assertTrue(Stockpiles.savingOffLogs(null, "minecraft:overworld"), "the first refusal");
		assertFalse(Stockpiles.savingOffLogs("minecraft:overworld", "minecraft:overworld"), "the same levels: quiet (every 10 s otherwise)");
		assertTrue(Stockpiles.savingOffLogs("minecraft:overworld", "minecraft:overworld, minecraft:the_end"), "another set: logged");
	}

	@Test
	void theRunningMarkerIsNotAdvancedOverASkippedLevel() {
		assertTrue(Repairs.marksSave(null));
		assertFalse(Repairs.marksSave("the save skipped minecraft:the_nether"), "skipped: saved= stays at the last real save");
	}

	/** (review findings 4, 5) a save is coherent only by what it recorded while it ran: every level written, the players with it. */
	@Test
	void aWorldSaveCarriesTheLedgerOnlyWithItsOwnEvidence() {
		assertNull(SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), true, true), "an autosave or /save-all (forced too)");
		assertNotNull(SaveEvidence.incoherent(3, List.of("a", "b"), List.of("c"), true, true), "a level skipped (saving off then)");
		assertNotNull(SaveEvidence.incoherent(3, List.of("a", "b"), List.of(), true, true), "a level not visited");
		String raw = SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), true, false);
		assertNotNull(raw, "another mod's saveAllChunks(.., force): no players saved with it");
		assertTrue(raw.contains("players"));
		assertNull(SaveEvidence.incoherent(3, List.of("a", "b", "c"), List.of(), false, false), "an explicit save saves its players itself");
	}

	/** (slice SOFF2) Each saveAllChunks call's own frame: nested calls, the player save and exceptions. */
	@Test
	void evidenceIsPerInvocation() {
		// an autosave: the players saved (completed), then its own chunk save
		SaveEvidence.Frame ev = SaveEvidence.enter(SaveEvidence.Kind.EVERYTHING);
		// a mod's raw save from a player-save hook: before the player save completed
		SaveEvidence.Frame hook = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		assertFalse(hook.players, "a chunk save inside the player save: the players are not saved yet");
		SaveEvidence.exit(hook, true);
		SaveEvidence.playersSaved(ev, true);
		SaveEvidence.ownChunkSave(ev);
		long mark = SaveEvidence.mark();
		SaveEvidence.Frame own = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		assertTrue(own.players, "the method's own chunk save, after the player save completed");
		SaveEvidence.level("a", false, true);
		// a nested raw save from its BEFORE_SAVE: its own record, no players, never the outer's
		SaveEvidence.Frame nested = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		assertFalse(nested.players, "a nested chunk save inherits no players");
		SaveEvidence.level("a", false, true);
		SaveEvidence.level("b", false, true);
		SaveEvidence.level("c", false, true);
		SaveEvidence.exit(nested, true);
		SaveEvidence.level("b", false, true);
		SaveEvidence.level("c", true, false);
		assertEquals(List.of("a", "b"), own.saved, "the outer record is untouched by the nested one");
		assertEquals(List.of("c"), own.skipped);
		SaveEvidence.exit(own, true);
		assertNotNull(SaveEvidence.refusal(own, mark, 3, true), "its skipped level refuses it");
		assertNotNull(SaveEvidence.refusal(nested, mark, 3, false), "another call's frame is never this call's");
		// a later chunk save inside the same method inherits nothing
		SaveEvidence.Frame later = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		assertFalse(later.players, "only the method's own call");
		SaveEvidence.exit(later, true);
		SaveEvidence.exit(ev, true);
		assertFalse(SaveEvidence.saving());
		// an exception: the frame popped, not completed, its levels recorded only on return
		SaveEvidence.Frame st = SaveEvidence.enter(SaveEvidence.Kind.STOP);
		SaveEvidence.playersSaved(st, false); // a player save failed
		SaveEvidence.ownChunkSave(st);
		long m2 = SaveEvidence.mark();
		SaveEvidence.Frame c = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		assertFalse(c.players, "a player save that failed grants nothing");
		SaveEvidence.level("a", false, false); // threw: never written
		SaveEvidence.exit(c, false);
		SaveEvidence.exit(st, false);
		assertFalse(SaveEvidence.saving(), "an exception leaves no frame open");
		assertEquals("the save did not complete", SaveEvidence.refusal(c, m2, 1, false));
		assertTrue(c.saved.isEmpty());
	}

	/** (slice SOFF2, Steward's ask) The hold's refusal sub-code, stable: saving_off:<dims>, carried to ArchitectRefused.detail(). */
	@Test
	void theHoldsRefusalCarriesAStableDetail() throws Exception {
		assertEquals("saving_off:minecraft:the_nether", SaveHold.detail(List.of("minecraft:the_nether")));
		assertEquals("saving_off:minecraft:overworld,minecraft:the_nether", SaveHold.detail(List.of("minecraft:overworld", "minecraft:the_nether")));
		String hold = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/SaveHold.java"));
		assertTrue(StockpileSaveHFTest.body(hold, "public static void require(").contains("detail("), "require() throws with the detail");
		String api = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/apiimpl/SitesImpl.java"));
		assertTrue(api.contains("new ArchitectRefused(e.reason(), e.getMessage(), e.detail(), e.builds())"), "the stockpile API carries it");
		Sites.SiteException e = new Sites.SiteException(dev.larattalabs.architect.api.Reason.NOT_ALLOWED, "m", List.of(), SaveHold.detail(List.of("x")));
		assertEquals("saving_off:x", e.detail());
		assertEquals(dev.larattalabs.architect.api.Reason.NOT_ALLOWED, e.reason(), "the Reason as before");
	}

		/** The hold: entered whenever a level has saving off; released only by a passed barrier with saving on everywhere. */
	@Test
	void theHoldIsReleasedOnlyByAPassedBarrier() {
		assertEquals(SaveHold.State.OPEN, SaveHold.next(SaveHold.State.OPEN, false, false), "saving on: as before");
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.OPEN, true, false));
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.HELD, true, true), "still off: held whatever the barrier");
		assertEquals(SaveHold.State.HELD, SaveHold.next(SaveHold.State.HELD, false, false), "the flag on again releases nothing by itself");
		assertEquals(SaveHold.State.OPEN, SaveHold.next(SaveHold.State.HELD, false, true));
		String m = SaveHold.message(List.of("minecraft:the_nether"), null);
		assertTrue(m.contains("minecraft:the_nether") && m.contains("/save-on"), m);
		assertTrue(SaveHold.message(List.of(), "chunk writes not durable").contains("confirmed"));
		assertTrue(SaveHold.admits(null), "no server (units): admitted");
	}

	/** Source guard: the holds and the evidence are where the review found the gaps (the save needs a live server; soff-crash runs it). */
	@Test
	void everyPublisherAndIngressIsGuarded() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String sww = StockpileSaveHFTest.body(s, "static void saveWithWorld(MinecraftServer srv)");
		int check = sww.indexOf("savingOffCheck(srv, false,");
		assertTrue(check > 0 && check < sww.indexOf("getPlayerList().saveAll()") && check < sww.indexOf("srv.saveAllChunks("),
			"saveWithWorld refuses before the players and the chunks");
		assertTrue(sww.indexOf("SaveEvidence.ownRefusal(srv, mark)") > sww.indexOf("srv.saveAllChunks(") && sww.indexOf("long mark = SaveEvidence.mark();")
			< sww.indexOf("srv.saveAllChunks("), "then requires its own save's evidence (SOFF2: its own frame)");
		assertTrue(StockpileSaveHFTest.body(s, "static boolean save()").contains("savingOffCheck(sv, evidencedSave,"), "save() too");
		int after = s.indexOf("AFTER_SAVE.register(");
		int ev = s.indexOf("SaveEvidence.worldSaveRefusal(server)", after);
		assertTrue(after > 0 && ev > after && ev < s.indexOf("evidencedSave = true;", after), "the world save's callback: its own save's evidence");
		assertTrue(StockpileSaveHFTest.body(s, "public static Ledger.@Nullable Accepted accept(").contains("SaveHold.admits(srv)"), "ingress held");
		for (String sig : List.of("public static Pile create(", "public static Pile addCrate(", "public static CrateRemoval removeCrate(",
			"public static Map<String, Integer> dissolve(", "public static List<String> setFeedOrder(", "public static Map<String, Integer> withdraw(",
			"public static Pile adopt(")) {
			String b = StockpileSaveHFTest.body(s, sig);
			assertTrue(b.substring(b.indexOf('{') + 1).trim().startsWith("SaveHold.require(srv);"), sig + " held first");
		}
		String fills = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Fills.java"));
		assertTrue(fills.contains("!Stockpiles.ledgerOnDisk(srv)"), "(review finding 2) a fill's in-memory marker needs the ledger on disk");
		String barrier = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/DurableBarrier.java"));
		assertTrue(barrier.contains("SaveEvidence.ownRefusal(srv, mark)"), "(finding 4) the barrier's chunks step: its own save's evidence");
		String placement = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Placement.java"));
		assertTrue(placement.contains("if (!SaveHold.jobsAdmitted(srv)) {"), "every job parks while saving is off (a stockpile ledger standing)");
		String builder = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		assertTrue(builder.contains("SERVER_STARTED.register(Stockpiles::reconcileAtStartHeld)"), "(SOFF2) the start's reconcile at the start, held");
		String fc = StockpileSaveHFTest.body(fills, "static boolean step(");
		assertTrue(fc.indexOf("onDisk = Stockpiles.savedOrOff();") > 0 && fc.indexOf("if (!onDisk) {") < fc.lastIndexOf("s = setPhase(srv, s, FILLED);"),
			"(SOFF2 item 4) the commit advances to FILLED only over a confirmed ledger");
		String rj = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/RestoreJob.java"));
		assertTrue(rj.indexOf("Stockpiles.saveCreditConfirmed(server)") < rj.indexOf("infraDone = inf;"), "(SOFF2 item 5) infraDone only after the credit's confirmed save");
		String hold = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/SaveHold.java"));
		String bso = StockpileSaveHFTest.body(hold, "public static @Nullable String beforeSavingOff(");
		assertTrue(bso.indexOf("state = State.HELD;") > 0 && bso.indexOf("state = State.HELD;") < bso.indexOf("Stockpiles.durableBarrier(srv)"),
			"(SOFF2 item 3) admission closed before /save-off's barrier");
		assertFalse(hold.contains("testOff"), "(SOFF2 item 6) no TEST switch turns the hold off");
		// (SOFF2 fix round)
		String mx = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/mixin/SaveEvidenceServerMixin.java"));
		assertTrue(mx.contains("cancellable = true") && mx.contains("cir.setReturnValue(false)"), "(finding 3) a failed barrier refuses the save-off itself");
		assertTrue(StockpileSaveHFTest.body(s, "static void saveWithWorld(MinecraftServer srv)").contains("if (!save()) {"), "(leftover 5) save()'s false is a refusal");
		// (T4 merge) SOFF2's hand-ordered adoption is replaced by T3b's pile.adopt txn (persist before mutate, recovered from its intent)
		assertTrue(StockpileSaveHFTest.body(s, "public static PileAdopt.Result adoptResult(").contains("PileAdopt.adopt(srv, owner)"), "adoption is the pile.adopt txn");
		String pl = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Placement.java"));
		assertTrue(StockpileSaveHFTest.body(pl, "static void rollBack(").contains("if (inTakeUp(siteId)) {"), "(finding 1) never rolled back past its take-ups (T4a's persisted TAKE_UP)");
		String fg = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/FillGuard.java"));
		assertTrue(StockpileSaveHFTest.body(fg, "public static boolean guardedSlot(").contains("Fills.waitingBox("), "(finding 2) a waiting fill's every stack held");
	}
}
