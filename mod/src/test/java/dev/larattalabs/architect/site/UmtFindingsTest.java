package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.cells;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import net.minecraft.world.level.block.Blocks;
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
	 * UC (unsaved chunks; an open question in docs/PLAN.md): a site and a delta of it (oak leaves), an autosave before the delta, the group
	 * removed, another site placed, then a crash that loses every world write since the autosave. The journal kept the delta and the
	 * removal; the world shows the site without the delta's leaves. The settle finds the site standing (RECOVER: its group comes back,
	 * the delta's entry too), so the standing site's delta cells should hold leaves and hold air. (Re-minimised from the CI pin's CRASH
	 * seed 130 after the V10/F8 generator changes made the old seed-2115 repro stale.)
	 */
	@Test
	void uc_aRecoveredSiteLostItsDeltasWrites() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(4037L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 17, 21, 6, 8, 5, 8909114239340923264L, 1,
			null), new UmtOps.Autosave(), new UmtOps.Delta(7, 7518167551877707928L), new UmtOps.RemoveGroup(1, null), new UmtOps.Place(UmtOps.Kind.SITE, 14,
				19, 2, 7, 5, 486550789251323484L, 0, null), new UmtOps.Place(UmtOps.Kind.SITE, 10, 12, 6, 6, 4, 2876625382995206321L, 2, new UmtOps.Crash("K2",
					null, 7, false))), UmtOps.Gen.CRASH));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[UC]")), r.report());
	}

	/**
	 * (6c close-out B, F9; umt-long on v0.40.1 and v0.41.0, PLAIN seed 604864872) A road over a site's edge clears head room (air over the
	 * site's cobblestone and lantern). The road is removed (its undo writes the site's blocks back), then the site (its box back to air). At
	 * the next start the road's evidence compares the world with its after, air, which the site's removal wrote: it reads as standing, the
	 * road is recovered, and its second removal writes the site's blocks back for good. F1's kind (an upper's evidence over cells a lower's
	 * later undo rewrote), for a road's air cells over a site, which F1's fix (Sites.evidence's laterWrite) doesn't reach.
	 */
	@Test
	void f9_aRoadsHeadRoomOverASiteRemovedTopDownIsRecovered() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(18750811039L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 26, 9, 8, 9, 4, 3020441061667383187L, 3,
			null), new UmtOps.Place(UmtOps.Kind.ROAD, 33, 10, 1, 13, 4, -7512719053491803402L, 3, null)), UmtOps.Gen.PLAIN));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[F9]")), r.report());
	}

	/**
	 * (6c close-out B, DPT; umt-long PLAIN seed 606069345) A delta of a site writes over a player's block (with its PT record) next to the
	 * site's box. The delta's create annotates its cells with the record (JournalStore.ptSource), but its D7 commit rewrites the sections
	 * from new cells without it (SiteDeltas: {@code new Cell(q, layer, before, after)}); the removal puts the block back without its record.
	 */
	@Test
	void dpt_aDeltaOverAPlayersBlockLosesItsRecord() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(18788149702L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 32, 15, 2, 3, 2, -7709475027701739650L, 3,
			null), new UmtOps.Delta(5, 7981485692747926230L)), UmtOps.Gen.PLAIN));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[DPT]")), r.report());
	}

	/**
	 * (6c close-out B, F10; umt-long PLAIN seed 606068584) A lot over short grass (its before), then a delta of the lot clears the grass block
	 * under it (the delta's cell). The removal restores both in one template over the union of their boxes; the plant is restored over air
	 * and breaks (V5), so the grass is gone though the lot's entry holds the cell. Rests on modelled template order and V5: confirm in game.
	 */
	@Test
	void f10_aPlantOverADeltasCellBreaksAtTheRemoval() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(18788126111L, List.of(new UmtOps.Place(UmtOps.Kind.LOT, 27, 17, 6, 3, 2, 3130843489786039882L, 0,
			null), new UmtOps.Delta(1, -7952756831339956499L)), UmtOps.Gen.PLAIN));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[F10]")), r.report());
	}

	/**
	 * (6c close-out B, PTS; umt-long PLAIN seed 731544100) A player's cobblestone with its PT record inside two stacked boxes of one group
	 * (a site, then a lot over its edge), removed as a group: the block comes back without its record. Not yet isolated between the
	 * restore's PT expectations for a lower entry (SiteJournal.restore, production) and the modelled record restore (UmtWorld.restoring).
	 */
	@Test
	void pts_aPlayersBlockUnderTwoStackedBoxesLosesItsRecord() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(22677867107L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 31, 10, 5, 7, 6, 2529238243948841804L, 2,
			null), new UmtOps.Place(UmtOps.Kind.LOT, 33, 14, 3, 9, 5, 5479923252941712732L, 2, null), new UmtOps.RemoveGroup(2, null)), UmtOps.Gen.PLAIN));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[PTS]")), r.report());
	}

	/**
	 * (6c close-out B, UC; umt-long ALL seed 777124280, found by the close-out B verifier) A road over a lot, killed at P5 after an
	 * autosave, rolls back; the lot's removal is killed at K6 and the world goes back to the autosave, losing the rollback's writes. The
	 * start recovers the road (it reads standing), restores the lot, then removes the road, which writes the lot's blocks back: the lot is
	 * left half and its record KEEP. Unsaved chunks (UC) under a rollback.
	 */
	@Test
	void uc_aRoadsRollbackLostToACrashBringsTheRoadBack() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(24090852687L, List.of(new UmtOps.Place(UmtOps.Kind.LOT, 26, 28, 5, 3, 2, -3578255712285927539L, 2,
			null), new UmtOps.Place(UmtOps.Kind.ROAD, 20, 27, 12, 2, 3, -5226597523096308268L, 1, new UmtOps.Crash("P5", null, 32, true)), new UmtOps.Remove(2,
			new UmtOps.Crash("K6", null, 0, false))), UmtOps.Gen.ALL));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[UC]")) && r.violations().isEmpty(), r.report());
	}
}
