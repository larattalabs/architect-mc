package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/**
 * (DR2 round after OVF) A cell a player took from a stuck survival removal after its undo (its mark) keeps the removal pending, its whole
 * refund held (never paid twice). DR2 ships without the taken-share settle (settling around taken cells, their share withheld): it moved
 * to TXN T6 (the review's two P1s: a multi-block such as a bed paid twice, weathered/variant pricing). These pin that it does not pay.
 */
class RepairDR2OvfTest {
	static {
		UmtRunner.boot();
	}

	private static final BlockState BRICK = Blocks.STONE_BRICKS.defaultBlockState();

	@Test
	void aStuckRemovalAPlayerTookFromStaysPending() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			c.sim.remove(a, null);
			JournalStore js = c.sim.store;
			String g = SiteJournal.lastGroup(a.id);
			assertNotNull(g);
			List<RepairCore.Want> w = RepairCore.removalWants(js, a.id, g);
			Repairs.Unit taken = new Repairs.Unit(a.id, null, true, g, w, List.of(), 1, List.of(), List.of(), 0, 1, "");
			assertEquals(Set.of(), Repairs.settling(js, List.of(taken), Set.of(a.id)), "its only non-OK cell a player took: it stays pending, "
				+ "nothing paid (the taken-share settle moved to TXN T6)");
			Repairs.Unit foreign = new Repairs.Unit(a.id, null, true, g, w, List.of(), 2, List.of(), List.of(), 0, 1, "");
			assertEquals(Set.of(), Repairs.settling(js, List.of(foreign), Set.of(a.id)), "a foreign cell no player took still keeps it pending");
			Repairs.Unit clean = new Repairs.Unit(a.id, null, true, g, w, List.of(), 0, List.of(), List.of(), 0, 0, "");
			assertEquals(Set.of(a.id), Repairs.settling(js, List.of(clean), Set.of(a.id)), "control: with nothing foreign or taken it settles");
		}
	}

	@Test
	void takenAfterTheUndoWhateverTheCellReads() {
		long a = p(1, G + 1, 1);
		RepairCore.Want w = new RepairCore.Want("d", a, WorldJournal.value(Blocks.DIRT.defaultBlockState()), WorldJournal.value(BRICK), "s1", "j1",
			true, 1000, 1, null, 0);
		assertTrue(RepairCore.takenAfter(1500, w, true), "mined after the undo: taken (the cell reads air over the pre-op dirt: FOREIGN)");
		assertTrue(!RepairCore.takenAfter(900, w, true), "before the undo: an earlier owner's");
		assertTrue(!RepairCore.takenAfter(1500, w, false), "creative: nothing refunded, nothing taken");
		assertTrue(!RepairCore.takenAfter(-1, w, true), "no mark");
	}
}
