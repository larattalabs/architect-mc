package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * Slice J1 (docs/CONTRACT.md "Slice J1, crash and refund edges"): source guards for what needs a live server (the gate steps rs-drops,
 * ps-crash and rl-crash measure it in game). Comments are stripped before each check.
 */
class StockpileSaveJ1Test {
	static final String SITE = "src/main/java/dev/larattalabs/architect/site/";

	static String read(String p) throws Exception {
		return Files.readString(Path.of(p)).replaceAll("//[^\n]*", "");
	}

	@Test
	void autosaveWritesTheLedgerAfterItsChunkWrites() throws Exception {
		String s = read(SITE + "Stockpiles.java");
		assertFalse(s.contains("BEFORE_SAVE.register"), "(N3) no ledger write at saveAllChunks' head, ahead of the chunk writes");
		int after = s.indexOf("ServerLifecycleEvents.AFTER_SAVE.register");
		assertTrue(after >= 0, "the world's save writes the ledger after its chunks");
		String body = s.substring(after, s.indexOf("});", after));
		int skip = body.indexOf("if (explicitSave) {");
		int sync = body.indexOf("chunkMap.synchronize(true).join()");
		int ledger = body.lastIndexOf("save();");
		assertTrue(skip >= 0 && skip < sync, "an explicit save writes its own ledger (HF)");
		assertTrue(body.indexOf("if (!flush)") >= 0 && body.indexOf("if (!flush)") < sync, "an unflushed save (autosave) waits for its queued chunk writes");
		assertTrue(sync < ledger, "the chunks are on disk before the ledger is written");
		assertTrue(body.indexOf("haltBeforeAutosaveLedger") < ledger, "kill point AS1 sits between the chunk writes and the ledger write");
	}

	@Test
	void everyN1ShapedCreditIsSavedAtTheCredit() throws Exception {
		String sp = read(SITE + "Stockpiles.java");
		String sc = StockpileSaveHFTest.body(sp, "static void saveCredit(MinecraftServer srv)");
		assertTrue(sc.contains("if (!testNoCreditSave)") && sc.contains("saveWithWorld(srv);"), "saveCredit is saveWithWorld unless the TEST switch");

		String b = read(SITE + "Builder.java");
		String dec = StockpileSaveHFTest.body(b, "static void dropDeconstruction(ServerLevel level, Site s, Deconstruction d, Sites.Drops drops, boolean credit)"); // (T4b)
		int credit = dec.indexOf("creditRefund(");
		int save = dec.indexOf("Stockpiles.saveCreditPending("); // (J2) saveCredit, a refusal left pending
		assertTrue(credit >= 0 && save > credit && save < dec.indexOf("forget("), "a deconstruct's credit is saved before its record goes");
		String cr = StockpileSaveHFTest.body(b, "static boolean creditRefund(");
		assertTrue(cr.contains("!c.already()"), "creditRefund answers whether a credit booked now (once per key)");
		int delta = b.indexOf("\"delta:\" + entry + \":\" + s.id()");
		assertTrue(delta >= 0 && b.indexOf("Stockpiles.saveCredit(srv);", delta) - delta < 200, "a delta's refund is saved with its construction");

		String rj = read(SITE + "RestoreJob.java");
		int rc = rj.indexOf("boolean booked = Builder.creditRefund(");
		int rs = rj.indexOf("Stockpiles.saveCreditConfirmed(server);", rc); // (SOFF2) saveCredit, confirmed
		assertTrue(rc >= 0 && rs > rc && rs < rj.indexOf("phase = DONE;", rc), "a standalone road's restore credit is saved before the job ends");

		// (slice T4a, finding 4) a put-down's take-ups are planned at its commit, booked once its record is placed, and saved by its job
		String ro = read(SITE + "RegionOverwrites.java");
		String book = StockpileSaveHFTest.body(ro, "static Booking bookTakeUp(");
		assertTrue(book.contains("credited(t.key())") && book.contains(".already()"), "a put-down's take-ups book once per key");
		String pj = read(SITE + "PlaceJob.java");
		String tu = StockpileSaveHFTest.body(pj, "private boolean takeUpStep(MinecraftServer server)");
		assertTrue(tu.indexOf("Stockpiles.saveCreditConfirmed(server);") > tu.indexOf("bookTakeUp("), "a lot's take-ups are saved once they book");

		String g = read(SITE + "Groups.java");
		// (slice T4R, R1) a group member's credit is published by its removal.group txn's member barrier (players, chunks, then the ledger)
		assertTrue(read("src/main/java/dev/larattalabs/architect/txn/TxnCore.java").contains("TxnEnv.Barrier mb = env.barrier();"), "a group member's credit is published by its member barrier");
	}

	@Test
	void fromPaidMarksTheLedgerChanged() throws Exception {
		String sp = read(SITE + "Stockpiles.java");
		String fp = StockpileSaveHFTest.body(sp, "static Map<String, Integer> fromPaid(String targetId, Map<String, Integer> items)");
		int took = fp.indexOf("tracking.ledger.fromPaid(");
		assertTrue(took >= 0 && fp.indexOf("changed(tracking);") > took, "(PS's leftover, closed by RL) the record's move marks the ledger changed");
	}

	@Test
	void theReconcileLeavesAPlayersBlockUncharged() throws Exception {
		String sp = read(SITE + "Stockpiles.java");
		String rc = StockpileSaveHFTest.body(sp, "static boolean reconcile(MinecraftServer srv, ServerLevel level, Pile p, Object t, String key");
		int pt = rc.indexOf("Placed.record(level, r.pos(i)) != null");
		int charge = rc.indexOf("consumeAtStart("); // (slice T0) the reconcile's charge
		assertTrue(pt >= 0 && pt < charge, "an ahead cell with a PT record is checked before any charge");
		String branch = rc.substring(pt, rc.indexOf("continue;", pt));
		assertTrue(branch.contains("r.markBuilt(i, true);") && !branch.contains("consume"), "it stands built, charged nothing");
	}

	@Test
	void roadsDropAPlayersMatchingBlockAsTheirs() throws Exception {
		String rb = read(SITE + "RoadBuilder.java");
		String dm = StockpileSaveHFTest.body(rb, "static it.unimi.dsi.fastutil.longs.LongOpenHashSet dropPlayerMatches(ServerLevel level, Infra road, boolean apply,"); // (DR-S: find, then apply; T4R-D: its sink overload)
		assertTrue(dm.contains("free.get(q)") && dm.contains("Placed.record(level, p) == null"), "only a non-free cell with a PT record");
		assertTrue(dm.indexOf("cuEquivalent") < dm.indexOf("Builder.dropAtCell"), "a CU equivalent is kept, not dropped");
		// (LC2, F10) the before written, then the items dropped on top of it (never inside it), in the same tick (a second pass finds nothing)
		assertTrue(dm.indexOf("Placed.set(level, p, was") >= 0 && dm.indexOf("Placed.set(level, p, was") < dm.indexOf("Builder.dropAtCell"),
			"the before written, then dropped on top of it");
		assertTrue(rb.contains("skip = dropPlayerMatches(level, road);") && rb.contains("tallyOf(level, road, skip)"), "a standalone road's refund leaves them out"); // (T4b fix round: per cell; T4R-D: and its extracted cells)
		String g = read(SITE + "Groups.java");
		int m = g.indexOf("RoadBuilder.dropPlayerMatches(level, inf, false)"); // (DR-S) found for the tally, dropped after the credits' save
		assertTrue(m >= 0 && m < g.indexOf("RoadBuilder.tallyOf(level, inf, dropped)"), "a group's road refund leaves them out");
	}

	@Test
	void pistonsAndExplosionsHonourFreeCells() throws Exception {
		String mix = Files.readString(Path.of("src/main/resources/architect_mc.mixins.json"));
		assertTrue(mix.contains("\"BlockBehaviourExplosionMixin\"") && mix.contains("\"PistonBaseBlockMixin\""), "both mixins registered");
		String pm = read("src/main/java/dev/larattalabs/architect/mixin/PistonBaseBlockMixin.java");
		assertTrue(pm.contains("method = \"isPushable\"") && pm.contains("RegionFreeDrops.pistonHolds(level, pos)"), "a free write is not pushable");
		assertTrue(pm.contains("method = \"moveBlocks\"") && pm.contains("takenWithoutDrop(l, pos, false)"), "a piston's break of one drops nothing");
		String em = read("src/main/java/dev/larattalabs/architect/mixin/BlockBehaviourExplosionMixin.java");
		assertTrue(em.contains("method = \"onExplosionHit\"") && em.contains("dropFromExplosion") && em.contains("takenWithoutDrop(level, pos, true)"),
			"an explosion takes a free write without loot");
		String fd = read(SITE + "RegionFreeDrops.java");
		String taken = StockpileSaveHFTest.body(fd, "public static boolean takenWithoutDrop(Level level, BlockPos pos, boolean explosion)");
		assertTrue(taken.contains("mined(l, pos);"), "remembered as mined: the removal puts it back first");
		assertEquals(2, taken.split("nearSurvivalRegion|freeWriteOf").length - 1, "the cheap region test before the journal read");
	}

	@Test
	void aMoveIntoAPlayerSavesTheLedgerBeforeThePlayer() throws Exception {
		String sp = read(SITE + "Stockpiles.java");
		String lf = StockpileSaveHFTest.body(sp, "static boolean saveLedgerFirst(MinecraftServer srv, Runnable between)");
		int ledger = lf.indexOf("if (!save()) {"); // (slice T0) and nothing after a ledger that was not published
		int players = lf.indexOf("saveAll()");
		int chunks = lf.indexOf("saveAllChunks(true, true, false)");
		assertTrue(ledger >= 0 && ledger < players && players < chunks, "the ledger, then the players, then the chunks flushed");
		assertTrue(lf.indexOf("kill(\"LF1\")") > ledger && lf.indexOf("kill(\"LF1\")") < players, "kill point LF1 inside the window");
		// (slice T0) the pending changes saved first (payoutPreSave), then the move and its ledger-first save in the core
		String w = StockpileSaveHFTest.body(sp, "public static Map<String, Integer> withdraw(");
		assertTrue(w.indexOf("payoutPreSave(") >= 0 && w.indexOf("payoutPreSave(") < w.indexOf("withdrawCore(") && w.indexOf("saveLedgerFirst(srv,")
			> w.indexOf("withdrawCore("), "a Take: what was pending saved first (HF's order), then the Take ledger-first");
		String wc = StockpileSaveHFTest.body(sp, "static Map<String, Integer> withdrawCore(");
		assertTrue(wc.indexOf("p.ledger.withdraw(") < wc.indexOf("publish.getAsBoolean()"), "the debit, then its publication");
		String d = StockpileSaveHFTest.body(sp, "public static Map<String, Integer> dissolve(");
		assertTrue(d.indexOf("payoutPreSave(") >= 0 && d.indexOf("payoutPreSave(") < d.indexOf("dissolveCore(") && d.indexOf("saveLedgerFirst(srv,")
			> d.indexOf("dissolveCore("), "a dissolve: the same");
		String dc = StockpileSaveHFTest.body(sp, "static Map<String, Integer> dissolveCore(");
		assertTrue(dc.indexOf("dissolveLedger(") < dc.indexOf("publish.getAsBoolean()"), "the dissolve's ledger side, then its publication");
		String sww = StockpileSaveHFTest.body(sp, "static void saveWithWorld(MinecraftServer srv)");
		assertTrue(sww.indexOf("kill(\"HF1\")") > sww.indexOf("saveAll()"), "kill point HF1 after saveWithWorld's player write");
	}
}
