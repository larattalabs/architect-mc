package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.cells;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * The minimal repros of what UMT found (docs/UMT.md "Findings"). Each asserts the behaviour the contract asks for, so each FAILS on the
 * code it was found on; they run only by {@code ./gradlew umtFindings}, never in {@code build}. When one is fixed, its test passes and
 * moves to {@link UmtPropertiesTest}; the coordinator decides which are bugs.
 */
@Tag("umt-findings")
class UmtFindingsTest {
	private static void exact(List<String> v) {
		assertTrue(v.isEmpty(), "not exact:\n" + String.join("\n", v));
	}

	/**
	 * F1: two stacked sites removed upper first, then lower, then a start: the upper's settle reads its own undo's written values,
	 * which the lower's removal has since rewritten, so its evidence is neither restored nor standing and Reconcile keeps it pending
	 * (KEEP) at every start: its record and journal entries never go. The world is exact.
	 */
	@Test
	void f1_aStackedRemovalIsNeverSettled() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec lower = c.site(0, G, 0, 5, G + 2, 5, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
			UmtSim.Rec upper = c.site(1, G, 1, 4, G + 3, 4, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 0);
			c.sim.remove(upper, null);
			c.sim.remove(lower, null);
			c.sim.restart(false);
			c.sim.restart(false);
			assertTrue(c.sim.recs.isEmpty(), "pending records left: " + c.sim.recs.values() + "; kept on " + c.sim.kept);
			assertTrue(c.sim.store.index().entries().isEmpty(), "journal entries left: " + c.sim.store.index().entries().keySet());
		}
	}

	/**
	 * F2: worldgen sand hanging over a cave inside a site's box: the removal's template writes it back (Sites.FLAGS: its onPlace
	 * schedules a tick; TickDeferral holds the tick and then releases it), and it falls into the cave.
	 */
	@Test
	void f2_restoredHangingSandFalls() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
			w.put0(p(2, G, 2), Blocks.SAND.defaultBlockState(), null, null);
			w.put0(p(2, G - 1, 2), Blocks.AIR.defaultBlockState(), null, null);
			w.put0(p(2, G - 2, 2), Blocks.AIR.defaultBlockState(), null, null);
		})) {
			c.site(1, G, 1, 3, G + 2, 3, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
			exact(c.sim.end());
		}
	}

	/**
	 * F3: gravel resting on a stone ledge that a site's box takes: the site writes under it (Sites.FLAGS), the gravel falls into the box,
	 * and the box's undo puts the ledge back but never the gravel (it was outside the box, no entry's cell). The 4d "gravel column into
	 * the restored hole" noise has this cause.
	 */
	@Test
	void f3_gravelOverASitesTopFallsIntoIt() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
			w.put0(p(2, G + 1, 2), Blocks.STONE.defaultBlockState(), null, null);
			w.put0(p(2, G + 2, 2), Blocks.GRAVEL.defaultBlockState(), null, null);
		})) {
			c.site(1, G, 1, 3, G + 1, 3, Blocks.AIR.defaultBlockState(), Map.of(), 0);
			exact(c.sim.end());
		}
	}

	/**
	 * F8: a plant standing on a cell a site (or a delta) changes, but outside its box: the write (Sites.FLAGS) updates it, it breaks
	 * (V5), and no entry has its cell, so the removal can't bring it back. The 4d "leaf_litter missing after the undo" has this cause
	 * when the litter sat next to the plan.
	 */
	@Test
	void f8_aPlantOverABoxsTopBreaks() throws Exception {
		try (UmtCase c = UmtCase.of(w -> w.put0(p(2, G + 1, 2), Blocks.POPPY.defaultBlockState(), null, null))) {
			c.site(1, G - 1, 1, 3, G, 3, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
			exact(c.sim.end());
		}
	}

	/**
	 * F4 (the coordinator's crash window, item 1): Groups.committed saves the removal with its undo group as the R2 commit is submitted,
	 * before it is durable. A kill inside that commit (the K8 window, before the index) leaves a saved removal that names an undo group
	 * the journal never got. Resumed, it marks every member pending and runs RestoreJob.writing for each: SiteJournal.restore finds no
	 * undone entry and writes nothing, and the removal ends as done; the members stand again only at the next start.
	 */
	@Test
	void f4_aGroupRemovalKilledInsideR2EndsDoneWithNothingRestored() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.COBBLESTONE, p(2, G, 1), Blocks.DIRT_PATH));
			UmtSim.Rec s = c.site(3, G, 3, 5, G + 2, 5, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
			try {
				c.sim.removeGroup(List.of(t, s), new UmtOps.Crash("R2", "index", 0, false));
			} catch (UmtSim.Halt h) {
				c.sim.restart(true);
			}
			assertTrue(c.sim.violations.stream().noneMatch(v -> v.startsWith("[F4]")), String.join("\n", c.sim.violations));
		}
	}

	/**
	 * F5: a removal's restore finished (its job done) but the world had not saved when the server died again: the world is back to
	 * half-restored, the journal says UNDONE, and the settle finds the site neither restored nor standing: KEEP at every start, the
	 * half-restored blocks stay.
	 */
	@Test
	void f5_aRestoreLostToASecondCrashIsKeptForever() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(6424L, List.of(new UmtOps.Place(UmtOps.Kind.LOT, 18, 20, 4, 6, 6, -1524067361526679596L, 1,
			null), new UmtOps.Remove(2, new UmtOps.Crash("K7", null, 28, true)), new UmtOps.Place(UmtOps.Kind.ROAD, 22, 29, 13, 1, 2, 8028642063678089977L,
				0, new UmtOps.Crash("P8", null, 31, false))), UmtOps.Gen.ALL));
		assertTrue(r.violations().isEmpty(), r.report());
	}

	/**
	 * F6: Sites.reconcile settles each pending site on its own evidence, but SiteJournal.reactivate takes back the whole undo group: a
	 * group member whose own cells show it removed comes back as a standing record too.
	 */
	@Test
	void f6_oneMembersRecoverReactivatesTheWholeGroup() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(1991L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 27, 26, 9, 3, 3, 5368466833381451274L, 1,
			null), new UmtOps.Restart(), new UmtOps.Place(UmtOps.Kind.TILE, 28, 29, 7, 7, 6, -4780181343283276411L, 1, null), new UmtOps.RemoveGroup(1, null),
			new UmtOps.Place(UmtOps.Kind.LOT, 23, 28, 9, 5, 6, 3259127719780762313L, 0, null), new UmtOps.Place(UmtOps.Kind.LOT, 26, 16, 2, 4, 6,
				-2838765659432227269L, 2, new UmtOps.Crash("P3", "index", 20, false))), UmtOps.Gen.ALL));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[F6]")), r.report());
	}

	/**
	 * F7: two sites recovered at one start (both removals lost to a crash): settling the lower first reverses its hand-downs only into
	 * entries still active; the upper one is still UNDONE then, so its hand-down is skipped (Journal.reactivate), and once the upper
	 * is recovered too its cell's before is the ground, not the lower site's block. Removing the upper then cuts into the lower site.
	 */
	@Test
	void f7_twoRecoversAtOneStartLoseAHandDown() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(9276L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 30, 27, 4, 8, 6, -5752358685865391763L, 0,
			null), new UmtOps.Place(UmtOps.Kind.ROAD, 25, 31, 6, 2, 5, 4940682819886696756L, 1, null), new UmtOps.Autosave(), new UmtOps.Remove(2, null),
			new UmtOps.Place(UmtOps.Kind.TILE, 36, 35, 2, 3, 2, 2962523880634667676L, 3, null), new UmtOps.RemoveGroup(1, null), new UmtOps.Remove(0,
				new UmtOps.Crash("K7", null, 23, false))), UmtOps.Gen.ALL));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[F7]")), r.report());
	}

	/**
	 * LP (lamp on dirt path, the journal half; fix/lamp-path 52cc9606 makes it pass): a road's dirt path under a site's solid block
	 * written just above it (Sites.FLAGS, outside the road's cells) turns to dirt (V3); the road's removal finds dirt, not its path,
	 * leaves it, and the grass never comes back.
	 */
	@Test
	void lp_aJournaledPathTurnedToDirtIsStillOurs() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec road = c.sim.cells(UmtOps.Kind.ROAD, 0, cells(p(2, G, 2), Blocks.DIRT_PATH, p(3, G, 2), Blocks.DIRT_PATH));
			UmtSim.Rec post = c.site(2, G + 1, 2, 2, G + 2, 2, Blocks.AIR.defaultBlockState(), cells(p(2, G + 1, 2), Blocks.OAK_FENCE, p(2, G + 2, 2),
				Blocks.LANTERN), 0);
			assertEquals(Blocks.DIRT, c.at(p(2, G, 2)).getBlock(), "V3: the path under the post turned to dirt");
			c.sim.remove(post, null);
			c.sim.remove(road, null);
			exact(c.sim.end());
		}
	}

	/**
	 * DRAIN (the coordinator's item 2): a region's body source, then a later, separate site placing a waterlogged stair over that cell.
	 * Removing the region drains first (RegionFluids.drain, production): the cell holds a fluid (the stair is waterlogged), so it goes
	 * back to the body's before state, overwriting the site's stair before any journal hand-down. The site stands with a hole.
	 */
	@Test
	void drain_aLaterSitesWaterloggedBlockSurvivesTheRegionsDrain() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			long src = p(2, G, 2);
			BlockState grass = c.at(src);
			UmtSim.Rec region = c.sim.cells(UmtOps.Kind.TILE, 1, cells(src, Blocks.WATER, p(3, G, 2), Blocks.WATER));
			BlockState stair = Blocks.OAK_STAIRS.defaultBlockState().setValue(StairBlock.WATERLOGGED, true);
			UmtSim.Rec site = c.site(1, G, 1, 2, G + 1, 2, Blocks.AIR.defaultBlockState(), cells(p(1, G, 1), Blocks.DIRT, p(2, G, 1), Blocks.DIRT, p(1, G, 2),
				Blocks.DIRT, src, stair), 0);
			// the region's removal: its bodies drain first (removalGate), then its group undo
			dev.larattalabs.architect.region.UmtDrain.drain(UmtPropertiesTest.drainCells(c), new long[] {src, p(3, G, 2)}, new String[] {
				dev.larattalabs.architect.region.UmtDrain.stateString(grass), dev.larattalabs.architect.region.UmtDrain.stateString(grass)}, new long[0],
				new String[0], new long[0]);
			c.sim.removeGroup(List.of(region), null);
			assertEquals(stair, c.at(src), "the later site's stair survives the region's removal");
			c.sim.remove(site, null);
			exact(c.sim.end());
		}
	}

	/**
	 * UC (unsaved chunks; an open question in docs/PLAN.md): a tile removed (pending), a second tile placed over its cells, then a crash
	 * that loses every world write since the last autosave. The first tile's evidence counts its cells as owned by the second tile
	 * (covered) and releases it; the world still shows its blocks, which the second tile's removal then leaves (they are not its after).
	 */
	@Test
	void uc_aCoveredReleaseAfterLostWrites() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(2115L, List.of(new UmtOps.Place(UmtOps.Kind.TILE, 25, 12, 2, 5, 3, -4208298833246131724L, 0,
			null), new UmtOps.Autosave(), new UmtOps.Remove(4, null), new UmtOps.Place(UmtOps.Kind.TILE, 18, 10, 9, 8, 4, 3585917898638864187L, 1, null),
			new UmtOps.Place(UmtOps.Kind.SITE, 34, 34, 2, 2, 2, 1L, 0, new UmtOps.Crash("P3", "index", 0, false))), UmtOps.Gen.CRASH));
		assertTrue(r.violations().isEmpty(), r.report());
	}
}
