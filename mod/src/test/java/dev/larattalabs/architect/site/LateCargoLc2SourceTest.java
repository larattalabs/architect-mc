package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * (Slice LC2, LC-2 #4 and #7; source order, as StockpileSaveJ1Test) Where the late-cargo take sits: a sliced RestoreJob right before each
 * cell's write (no cell list cached across ticks), the infrastructure restores before their writes, a region target's player holder.
 */
class LateCargoLc2SourceTest {
	private static String read(String f) throws Exception {
		return StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + f);
	}

	@Test
	void aSlicedRestoreTakesAtEachCellItWrites() throws Exception {
		String rj = read("RestoreJob.java");
		assertFalse(rj.contains("cargoCells"), "no holder list found once and kept across ticks (review finding 4)");
		assertTrue(rj.contains("writer.beforeSet = pass == null ? null : pass::cell;"), "the writer's hook takes at each cell");
		int pass = rj.indexOf("writer.beforeSet = pass");
		assertTrue(pass >= 0 && pass < rj.indexOf("writer.step(level, deadline);"), "set before the tick's writes");
		assertTrue(rj.indexOf("last.cells(restore.cells());") < rj.indexOf("SiteJournal.writeCells(level, restore.cells());"), "its other cells too");
		String tw = read("TemplateWriter.java");
		String set = StockpileSaveHFTest.body(tw, "private void set(ServerLevel level, int i)");
		assertTrue(set.indexOf("beforeSet.accept(p)") >= 0 && set.indexOf("beforeSet.accept(p)") < set.indexOf("Placed.set(level, p"),
			"the hook runs before the cell's write");
	}

	@Test
	void infrastructureRestoresTakeBeforeTheirWrites() throws Exception {
		String rj = read("RestoreJob.java");
		String infra = StockpileSaveHFTest.body(rj, "private boolean stepInfra(MinecraftServer server, Infra inf, long deadline)");
		assertTrue(infra.indexOf("pass.cells(part);") >= 0 && infra.indexOf("pass.cells(part);") < infra.indexOf("SiteJournal.writeCells(level, part)"),
			"each part's holders before the part's writes (review finding 7)");
		assertTrue(infra.contains("LateCargo.drop(level, RoadBuilder.dropAt(inf), cargo, null)"), "dropped above the road or cell site");
		String inf = read("Infras.java");
		String fin = StockpileSaveHFTest.body(inf, "static void finishRemoval(ServerLevel level, String id, String group, boolean event)");
		assertTrue(fin.contains("SiteJournal.writeNow(level, id, group, rs -> {") && fin.contains("new LateCargo.Pass(level, rs, null, group)"),
			"writeNow's before-hook takes in the write's tick");
		String rt = read("RegionTargets.java");
		String dp = StockpileSaveHFTest.body(rt, "static it.unimi.dsi.fastutil.longs.LongOpenHashSet dropPlayerBlocks(ServerLevel level, Infra t)");
		assertTrue(dp.indexOf("LateCargo.holder(") >= 0 && dp.indexOf("LateCargo.holder(") < dp.indexOf("Placed.set(level, p"),
			"a player's holder on a target cell gives up its contents before the cell is set back");
	}
}
