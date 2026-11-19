package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4a, finding 4 of the T2b last-round review) A put-down's take-ups (a survival region lot's placement over another writer's paid
 * cells, a construction road's cuts) are credited only once the placement can no longer roll back, and a refused save waits instead of
 * throwing past the credit. On the T4a base, {@code RegionOverwrites.retakeOnce} credited and saved inside the PlaceJob's step right after
 * the journal commit: the save's IllegalStateException escaped the step, Placement rolled the lot back, and the credit stayed (twice on a
 * retry). The InfraJob twin was reported placed with its convert half done. These read the sources (as {@code StockpileSaveJ1Test} does);
 * {@code t4-xr} is the in-game row.
 */
class TakeUpT4aTest {
	static final String SITE = "src/main/java/dev/larattalabs/architect/site/";

	static String read(String f) throws Exception {
		return Files.readString(Path.of(f));
	}

	@Test
	void aLotsTakeUpIsPlannedAtItsCommitAndBookedOnlyOnceItsRecordIsPlaced() throws Exception {
		String ro = read(SITE + "RegionOverwrites.java");
		String lot = StockpileSaveHFTest.body(ro, "static @Nullable TakeUp lotTakeUp(");
		assertFalse(lot.contains("Stockpiles.credit(") || lot.contains("saveCredit(") || lot.contains("fromPaid("), "the lot's take-up only plans");
		String pj = read(SITE + "PlaceJob.java");
		String placed = StockpileSaveHFTest.body(pj, "private boolean placed(MinecraftServer server)");
		int finish = placed.indexOf("Sites.finishPlacing(");
		int take = placed.indexOf("phase = TAKE_UP;");
		assertTrue(finish >= 0 && take > finish, "the take-up books after the record is placed (no rollback reaches past it)");
		String step = StockpileSaveHFTest.body(pj, "private boolean takeUpStep(MinecraftServer server)");
		int catchAt = step.indexOf("catch (RuntimeException e)");
		assertTrue(catchAt > step.indexOf("Stockpiles.saveCredit(server);") && step.indexOf("return waitTakeUp(", catchAt) > catchAt,
			"a refused save waits (returns false), never throws out of the step");
	}

	@Test
	void aRoadsCutsAreBookedByItsJobAfterItsRecordIsPlaced() throws Exception {
		String rb = read(SITE + "RoadBuilder.java");
		String conv = StockpileSaveHFTest.body(rb, "static Infra convert(ServerLevel level, Infra road)");
		assertFalse(conv.contains("retakeOnce(") || conv.contains("saveCredit("), "convert plans the cuts' take-up only");
		String ij = read(SITE + "InfraJob.java");
		int put = ij.indexOf("Infras.put(server, done);");
		int take = ij.indexOf("phase = TAKE_UP;");
		assertTrue(put >= 0 && take > put, "the road's take-up books after its record is placed");
		String pl = read(SITE + "Placement.java");
		assertTrue(pl.contains("} else if (j instanceof InfraJob ij) {\n\t\t\t\t\tij.broken = \"it failed (\" + e + \")\";"),
			"a throwing InfraJob is broken (rolled back, its futures failed), never reported placed");
	}

	@Test
	void aTakeUpPlanSurvivesTheQueueFile() {
		RegionOverwrites.TakeUp t = new RegionOverwrites.TakeUp("steward_mc:settlement/1", "minecraft:overworld", "xr-lot:s7@e12", List.of(
			new RegionOverwrites.Cell(123L, "minecraft:stone_bricks", "r3", Map.of("minecraft:stone_bricks", 1)), new RegionOverwrites.Cell(456L,
				"minecraft:oak_planks", "s2", Map.of("minecraft:oak_planks", 1))), 123456789L, "s7");
		assertEquals(t, RegionOverwrites.TakeUp.fromJson(t.toJson()));
	}

	// ------------------------------------------------------------------ (T4a fix round: the early review of e5ea86b4)

	/** Finding 4.3: only the cells whose taken-up block is gone are credited (a cut or a write that never reached the disk keeps it). */
	@Test
	void onlyCellsWhoseBlockIsGoneAreCredited() {
		RegionOverwrites.TakeUp t = new RegionOverwrites.TakeUp("p", "minecraft:overworld", "k", List.of(new RegionOverwrites.Cell(1L,
			"minecraft:stone_bricks", "r3", Map.of("minecraft:stone_bricks", 1)), new RegionOverwrites.Cell(2L, "minecraft:stone_bricks", "r3", Map.of(
				"minecraft:stone_bricks", 1)), new RegionOverwrites.Cell(3L, "minecraft:cobblestone", "s2", Map.of("minecraft:cobblestone", 1))), 0L, "s7");
		Map<Long, String> world = Map.of(1L, "minecraft:air", 2L, "minecraft:stone_bricks", 3L, "minecraft:gravel");
		assertEquals(List.of(1L, 3L), RegionOverwrites.gone(t, world::get).stream().map(RegionOverwrites.Cell::pos).toList());
	}

	/** Finding 4.4: an unreadable or missing pile holds the booking (never "done"); only its key credited is done. */
	@Test
	void anUnavailablePileHoldsTheBookingAndOnlyACreditedKeyIsDone() {
		assertEquals(RegionOverwrites.Booked.HOLD, RegionOverwrites.bookStatus(true, true, true, false).how());
		assertEquals(RegionOverwrites.Booked.HOLD, RegionOverwrites.bookStatus(false, false, false, false).how());
		assertEquals(RegionOverwrites.Booked.HOLD, RegionOverwrites.bookStatus(false, true, false, false).how());
		assertEquals(RegionOverwrites.Booked.ALREADY, RegionOverwrites.bookStatus(false, true, true, true).how());
		assertEquals(null, RegionOverwrites.bookStatus(false, true, true, false));
	}

	/**
	 * Findings 4.1 and 4.2: a job taking up never rolls back (a cancel, an unclean start), and it books only after a confirmed queue generation
	 * holds its plan; its item is reported placed when it starts waiting (a refused save never holds the batch).
	 */
	@Test
	void theTakeUpPhaseIsPastRollbackAndItsPlanIsDurableFirst() throws Exception {
		String pl = read(SITE + "Placement.java");
		String rb = StockpileSaveHFTest.body(pl, "static void rollBack(MinecraftServer srv, String siteId, String why)");
		assertTrue(rb.indexOf("pj.phase == PlaceJob.TAKE_UP") >= 0 && rb.indexOf("pj.phase == PlaceJob.TAKE_UP") < rb.indexOf("JOBS.remove(j);"),
			"a cancel never rolls back a job in TAKE_UP");
		int resume = pl.indexOf("if (pj.phase == PlaceJob.TAKE_UP && level != null) {");
		assertTrue(resume >= 0 && resume < pl.indexOf("if (!clean || level == null || !pj.resume(level)) {"), "an unclean start resumes TAKE_UP, never rolls it back");
		assertTrue(pl.contains("!clean && ij.phase != InfraJob.TAKE_UP"), "nor an InfraJob's");
		String pj = read(SITE + "PlaceJob.java");
		String tu = StockpileSaveHFTest.body(pj, "private boolean takeUpStep(MinecraftServer server)");
		assertTrue(tu.indexOf("Placement.written(takeUpGen)") >= 0 && tu.indexOf("Placement.written(takeUpGen)") < tu.indexOf("bookTakeUp("),
			"booked only after a confirmed queue generation holds the plan");
		String ij = read(SITE + "InfraJob.java");
		String it = StockpileSaveHFTest.body(ij, "private boolean takeUpStep(MinecraftServer server)");
		assertTrue(it.indexOf("Placement.written(takeUpGen)") < it.indexOf("bookTakeUp(") && it.indexOf("Placement.written(takeUpGen)") >= 0, "an InfraJob's too");
		String placed = StockpileSaveHFTest.body(pj, "private boolean placed(MinecraftServer server)");
		assertTrue(placed.indexOf("Batches.placed(server, this);") > placed.indexOf("phase = TAKE_UP;"), "its item is placed when it starts waiting");
	}

	/** Finding 4.5 and P2 6: a tile's free pass plans its take-ups (none given back mid-write); a throwing InfraJob drops its extras. */
	@Test
	void aTilesFreePassPlansItsTakeUpsAndAThrowingInfraJobDropsItsExtras() throws Exception {
		String ij = read(SITE + "InfraJob.java");
		assertFalse(ij.contains("retakeToPile("), "no immediate, unkeyed give-back in the tile's writes");
		assertTrue(ij.contains("RegionOverwrites.tileCell("), "the tile's cells planned");
		String pl = read(SITE + "Placement.java");
		int broken = pl.indexOf("} else if (ij.broken != null) {");
		assertTrue(broken >= 0 && pl.indexOf("Infras.drop(srv, e.record.id());", broken) < pl.indexOf("ij.failed(ij.broken);", broken)
			&& pl.indexOf("Infras.drop(srv, e.record.id());", broken) > broken, "its extras' records dropped before it rolls back");
	}

	/** The review: an imported legacy decStock is ignored (never carried into a deconstruct). */
	@Test
	void anImportedDecStockIsIgnored() {
		Groups.Removal r = new Groups.Removal("g7", null, null, false);
		com.google.gson.JsonObject o = r.toJson();
		com.google.gson.JsonObject ds = new com.google.gson.JsonObject();
		com.google.gson.JsonObject it = new com.google.gson.JsonObject();
		it.addProperty("minecraft:cobblestone", 17);
		ds.add("s4", it);
		o.add("decStock", ds);
		assertTrue(Groups.Removal.fromJson(o).decStock.isEmpty());
	}
}
