package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/** (DR2) The GPT release review's DR findings: a mined cell is not LAGGING (P1-3), a resume revalidates (P1-2) and keeps Want.pt (P1-4). */
class RepairDR2Test {
	static {
		UmtRunner.boot();
	}

	private static final BlockState BRICK = Blocks.STONE_BRICKS.defaultBlockState();
	private static final BlockState PLANK = Blocks.OAK_PLANKS.defaultBlockState();
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();

	/** A reader over fixed states with a mined mark at one cell. */
	private static RepairCore.Reader reader(Map<Long, BlockState> world, long minedPos, long minedAt) {
		return new RepairCore.Reader() {
			@Override
			public BlockState get(long pos) {
				return world.getOrDefault(pos, AIR);
			}

			@Override
			public net.minecraft.nbt.CompoundTag nbt(long pos) {
				return null;
			}

			@Override
			public boolean pt(long pos) {
				return false;
			}

			@Override
			public long mined(long pos) {
				return pos == minedPos ? minedAt : -1;
			}
		};
	}

	@Test
	void p13_aCellMinedAfterTheCommitIsForeignNotLagging() {
		long a = p(1, G + 1, 1), b = p(2, G + 1, 1), c = p(3, G + 1, 1);
		Journal.Value brick = WorldJournal.value(BRICK), air = WorldJournal.value(AIR);
		RepairCore.Want wa = new RepairCore.Want("d", a, brick, air, "s1", "j1", false, 1000, 1, null, 0);
		RepairCore.Want wb = new RepairCore.Want("d", b, brick, air, "s1", "j1", false, 1000, 1, null, 0);
		RepairCore.Want wc = new RepairCore.Want("d", c, brick, air, "s1", "j1", false, 1000, 1, null, 0);
		// a: mined at 1500, after the placement's commit (1000): the player's, FOREIGN; b: no mark: a lost write, LAGGING
		assertEquals(RepairCore.Cell.FOREIGN, RepairCore.classify(reader(Map.of(), a, 1500), wa), "mined back to the pre-op value: not a lost write");
		assertEquals(RepairCore.Cell.LAGGING, RepairCore.classify(reader(Map.of(), a, 1500), wb), "no mark: lagging");
		// c: a mark older than the commit is an earlier owner's (the cell was mined, then this placement committed and its write was lost)
		assertEquals(RepairCore.Cell.LAGGING, RepairCore.classify(reader(Map.of(), c, 900), wc), "an older mark: still lagging");
		// a mark never makes an OK cell or a foreign one anything else
		assertEquals(RepairCore.Cell.OK, RepairCore.classify(reader(Map.of(a, BRICK), a, 1500), wa));
		assertEquals(RepairCore.Cell.FOREIGN, RepairCore.minedSince(RepairCore.Cell.FOREIGN, -1, 0));
	}

	@Test
	void minedCellsPersistPruneAndCap() {
		MinedCells m = MinedCells.EMPTY.with(5L, 1000).with(6L, 2000);
		assertEquals(1000, m.at(5L));
		MinedCells back = MinedCells.read(m.write());
		assertEquals(2000, back.at(6L), "saved with the chunk (NBT round trip)");
		assertEquals(-1, m.without(5L).at(5L), "an Architect write clears it");
		assertEquals(2000, m.without(5L).at(6L));
		MinedCells late = m.with(7L, 1000 + MinedCells.KEEP_MS + 1);
		assertEquals(-1, late.at(5L), "marks older than a day go as the chunk gains one");
		assertEquals(2000, m.with(5L, 2500).with(5L, 3000).without(6L).with(6L, 2000).at(6L));
		assertEquals(3000, m.with(5L, 3000).at(5L), "a cell mined again: its newest time");
		MinedCells many = MinedCells.EMPTY;
		for (int i = 0; i < MinedCells.MAX + 10; i++) {
			many = many.with(i, 10_000 + i);
		}
		assertEquals(MinedCells.MAX, many.pos().length, "at most MAX a chunk");
		assertEquals(-1, many.at(0), "the oldest go first");
		assertEquals(10_000 + MinedCells.MAX + 9, many.at(MinedCells.MAX + 9));
	}

	@Test
	void p14_aRecordedCellKeepsItsPlayersRecord() {
		Pt pt = new Pt(new UUID(7L, 9L), "b12");
		RepairCore.Want w = new RepairCore.Want("minecraft:overworld", p(1, G + 1, 1), WorldJournal.value(PLANK), WorldJournal.value(BRICK), "s1",
			"j1", true, 1234, 5, pt, 3, List.of(WorldJournal.value(BRICK)));
		RepairCore.Want back = Repairs.wantOf(Repairs.wantJson(w));
		assertEquals(pt, back.pt(), "Want.pt survives the record (was null)");
		assertEquals(new Pt(new UUID(7L, 9L), null), Repairs.wantOf(Repairs.wantJson(new RepairCore.Want(w.dim(), w.pos(), w.expected(), w.pre(), w
			.site(), w.entry(), true, 1, 1, new Pt(new UUID(7L, 9L), null), 3))).pt());
		assertEquals(null, Repairs.wantOf(Repairs.wantJson(new RepairCore.Want(w.dim(), w.pos(), w.expected(), w.pre(), w.site(), w.entry(), true, 1,
			1, null, 3))).pt());
		assertEquals(w.pos(), back.pos());
		assertEquals(w.at(), back.at());
		assertEquals(1, back.morePre().size());
	}

	private static List<RepairCore.Want> placements(JournalStore js, String site) throws Exception {
		List<RepairCore.Want> out = new ArrayList<>();
		for (JournalStore.Meta m : js.index().entries().values()) {
			if (m.site().equals(site) && m.status() == Journal.Status.ACTIVE) {
				out.addAll(RepairCore.placementWants(js, m));
			}
		}
		return out;
	}

	@Test
	void p12_aResumedPlacementYieldsToANewerPlacementAndToItsRemoval() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			JournalStore js = c.sim.store;
			List<RepairCore.Want> recorded = placements(js, a.id);
			assertEquals(9, recorded.size());
			assertEquals(9, RepairCore.stillOwed(js, recorded).size(), "nothing since: all still owed");
			// a newer placement over 4 of its cells owns them now (XR): never written over
			c.site(2, G + 1, 2, 3, G + 1, 3, PLANK, Map.of(), 1);
			List<RepairCore.Want> owed = RepairCore.stillOwed(js, recorded);
			assertEquals(5, owed.size(), "the 4 cells under the newer placement are dropped");
			assertTrue(owed.stream().allMatch(w -> w.expected().name().equals("minecraft:stone_bricks")));
		}
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			JournalStore js = c.sim.store;
			List<RepairCore.Want> recorded = placements(js, a.id);
			c.sim.remove(a, null);
			assertEquals(0, RepairCore.stillOwed(js, recorded).size(), "removed since: a resume never resurrects it");
		}
	}

	@Test
	void p12_aResumedRemovalYieldsToANewerPlacement() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			c.sim.remove(a, null);
			JournalStore js = c.sim.store;
			String g = SiteJournal.lastGroup(a.id);
			assertTrue(g != null, "the removal's undo group is kept (pending)");
			List<RepairCore.Want> recorded = RepairCore.removalWants(js, a.id, g);
			assertEquals(9, recorded.size());
			assertEquals(9, RepairCore.stillOwed(js, recorded).size(), "nothing since: all still owed");
			// a newer placement of the same block over 4 of the cells (what the stale record calls the pre-op value): it wins
			UmtSim.Rec n = c.site(2, G + 1, 2, 3, G + 1, 3, BRICK, Map.of(), 1);
			assertEquals(5, RepairCore.stillOwed(js, recorded).size(), "the newer placement's 4 cells are dropped");
			// and the removal never settles under it (its undo released, N's own removal would bring the bricks back)
			assertEquals(java.util.Set.of(n.id), RepairCore.shadowedBy(js, a.id, g), "N, placed after the undo, shadows the removal");
			c.sim.remove(n, null);
			assertEquals(java.util.Set.of(), RepairCore.shadowedBy(js, a.id, g), "N gone: the removal may settle");
		}
		// (the hand-down case, an upper placed before the lower's removal, is gated in game by dr-crash DR3: UMT's site clock and its undo
		// clock differ, so the time order can't be built here)
	}
}
