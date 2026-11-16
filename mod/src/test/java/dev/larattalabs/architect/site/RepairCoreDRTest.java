package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/** (DR) The core's units: the classifier, the owner pick (XR), plan staleness, commit order and the auto-diagnose's time bound. */
class RepairCoreDRTest {
	static {
		UmtRunner.boot();
	}

	private static Journal.Value v(BlockState s) {
		return WorldJournal.value(s);
	}

	private static RepairCore.Cell cls(BlockState now, boolean pt, BlockState expected, BlockState pre) {
		return RepairCore.classify(now, () -> null, pt, v(expected), v(pre));
	}

	@Test
	void classifierNoVotePerCell() {
		BlockState brick = Blocks.STONE_BRICKS.defaultBlockState();
		BlockState air = Blocks.AIR.defaultBlockState();
		assertEquals(RepairCore.Cell.OK, cls(brick, false, brick, air), "holds the committed value");
		assertEquals(RepairCore.Cell.LAGGING, cls(air, false, brick, air), "holds the pre-op value exactly: lagging");
		assertEquals(RepairCore.Cell.FOREIGN, cls(Blocks.GLASS.defaultBlockState(), false, brick, air), "anything else: foreign");
		assertEquals(RepairCore.Cell.FOREIGN, cls(air, true, brick, air), "a player's record: foreign even at the pre-op value");
		// StillOurs' equivalences: a weathered copper pre-op value still lags; a turned stair (facing) is not the pre-op value
		BlockState copper = Blocks.COPPER_BLOCK.asList().get(0).defaultBlockState();
		assertEquals(RepairCore.Cell.LAGGING, cls(Blocks.COPPER_BLOCK.asList().get(1).defaultBlockState(), false, air, copper), "a copper stage of the pre-op block");
		BlockState stair = Blocks.OAK_STAIRS.defaultBlockState();
		assertEquals(RepairCore.Cell.FOREIGN, cls(stair.setValue(StairBlock.FACING, net.minecraft.core.Direction.EAST), false, air, stair),
			"a turned stair is a change, not the pre-op value");
		assertEquals(RepairCore.Cell.OK, cls(Blocks.WATER.defaultBlockState(), false, air, brick), "water in cleared air is still ours (6a)");
	}

	@Test
	void ownerPickIsTheTopWriter() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.site(1, G + 1, 1, 3, G + 1, 3, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
			c.site(2, G + 1, 2, 4, G + 1, 4, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
			JournalStore js = c.sim.store;
			List<RepairCore.Want> lower = new ArrayList<>();
			List<RepairCore.Want> upper = new ArrayList<>();
			for (JournalStore.Meta m : js.index().entries().values()) {
				if (m.status() == Journal.Status.ACTIVE && m.kind().equals(WorldJournal.SITE)) {
					(m.site().equals("s1") ? lower : upper).addAll(RepairCore.placementWants(js, m));
				}
			}
			// the 2x2 shared cells are the upper's only (XR: one owner per cell); a lower cell under a standing higher one is never checked
			assertEquals(9 - 4, lower.size(), "the lower owns its 5 uncovered cells");
			assertEquals(9, upper.size(), "the upper owns all 9 of its cells");
			assertTrue(lower.stream().noneMatch(w -> upper.stream().anyMatch(u -> u.pos() == w.pos())), "no cell has two owners");
			assertTrue(upper.stream().allMatch(w -> w.expected().name().equals("minecraft:oak_planks")), "the expected value is the owner's after");
		}
	}

	@Test
	void planIdChangesWithTheCellsAndTheJournal() {
		JournalStore.Index idx = new JournalStore.Index(Map.of(), 5, 9, 1, 1, Map.of());
		String a = RepairCore.planId("site s1", idx, List.of(), List.of("lag s1 1,2,"));
		assertEquals(a, RepairCore.planId("site s1", idx, List.of(), List.of("lag s1 1,2,")), "stable");
		assertNotEquals(a, RepairCore.planId("site s1", idx, List.of(), List.of("lag s1 1,")), "a cell changed since: another plan (REPAIR_STALE)");
		assertNotEquals(a, RepairCore.planId("site s1", new JournalStore.Index(Map.of(), 6, 9, 1, 1, Map.of()), List.of(), List.of("lag s1 1,2,")),
			"a commit since: another plan");
		assertNotEquals(a, RepairCore.planId("all", idx, List.of(), List.of("lag s1 1,2,")), "another scope: another plan");
		assertTrue(a.matches("[0-9a-f]{8}"));
	}

	@Test
	void commitOrderPlacementsBottomUpRemovalsTopDown() {
		Journal.Value s = Journal.Value.of("minecraft:stone");
		Journal.Value a = Journal.AIR;
		List<RepairCore.Want> w = new ArrayList<>(List.of(
			new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(0, 70, 0), a, s, "s2", "j2", true, 200, 5, null, 0),
			new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(0, 70, 1), a, s, "s1", "j1", true, 300, 3, null, 0),
			new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(0, 66, 0), s, a, "s3", "j3", false, 100, 7, null, 0),
			new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(0, 65, 0), s, a, "s3", "j3", false, 100, 7, null, 0),
			new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(1, 70, 0), a, s, "s2", "j2", true, 200, 6, null, 0)));
		RepairCore.commitOrder(w);
		assertEquals(List.of("j3@65", "j3@66", "j2@6", "j2@5", "j1@3"), w.stream().map(x -> x.entry() + (x.removal() ? "@" + x.layer() : "@"
			+ Journal.y(x.pos()))).toList(), "commit time first; a placement bottom-up; a removal top-down (higher layer first)");
	}

	@Test
	void autoDiagnoseBoundIncludesAJobStraddlingTheSave() {
		long save = 1000;
		JournalStore.Meta before = JournalStore.Meta.header("j1", "site", "s1", null, "d", Journal.Policy.BOX, 1, Journal.Status.ACTIVE, 900);
		JournalStore.Meta after = JournalStore.Meta.header("j2", "site", "s2", null, "d", Journal.Policy.BOX, 2, Journal.Status.ACTIVE, 1100);
		JournalStore.Meta straddle = JournalStore.Meta.header("j3", "site", "s3", null, "d", Journal.Policy.BOX, 3, Journal.Status.ACTIVE, 950);
		assertFalse(RepairCore.afterSave(before, save, Set.of()), "committed and written before the save: saved with it");
		assertTrue(RepairCore.afterSave(after, save, Set.of()), "committed after the save");
		assertTrue(RepairCore.afterSave(straddle, save, Set.of("s3")), "P3 before the save, its job's writes after it (a job at the save)");
		assertFalse(RepairCore.afterSave(straddle, save, Set.of("s9")));
	}

	@Test
	void ledgerKeyIdsAndCreditOnceAcrossARestart() {
		assertEquals("s12", Repairs.idOfKey("site:s12@1731"));
		assertEquals("r3", Repairs.idOfKey("road:r3@9"));
		assertEquals(null, Repairs.idOfKey("weird"));
		// a repair's credit books through the ledger's key rule: an open repair finished after DRK1 books nothing twice
		var led = new dev.larattalabs.architect.survival.StockLedger();
		led.holdPending("site:s1@1", Map.of("minecraft:oak_planks", 5), 0L);
		var c1 = led.credit("site:s1@1", Map.of("minecraft:oak_planks", 5), 1000, k -> 64);
		var c2 = led.credit("site:s1@1", Map.of("minecraft:oak_planks", 5), 1000, k -> 64);
		assertTrue(c2.already() && c2.returned().isEmpty(), "credited once per key (first " + c1.returned() + ")");
	}
}
