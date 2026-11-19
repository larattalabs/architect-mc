package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
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
		assertTrue(catchAt > step.indexOf("Stockpiles.saveCredit(server);") && step.indexOf("return false;", catchAt) > catchAt,
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
		RegionOverwrites.TakeUp t = new RegionOverwrites.TakeUp("steward_mc:settlement/1", "minecraft:overworld", "xr-lot:s7@e12",
			Map.of("r3", Map.of("minecraft:stone_bricks", 81), "s2", Map.of("minecraft:oak_planks", 4)), 123456789L, "s7");
		assertEquals(t, RegionOverwrites.TakeUp.fromJson(t.toJson()));
	}
}
