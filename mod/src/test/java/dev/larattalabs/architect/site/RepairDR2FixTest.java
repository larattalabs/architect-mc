package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/** (DR2 fix round) The GPT review's NOT SAFE findings on slice DR2: one unit per finding, each failing on the code before the fix. */
class RepairDR2FixTest {
	static {
		UmtRunner.boot();
	}

	private static final BlockState BRICK = Blocks.STONE_BRICKS.defaultBlockState();
	private static final BlockState PLANK = Blocks.OAK_PLANKS.defaultBlockState();
	private static final BlockState COBBLE = Blocks.COBBLESTONE.defaultBlockState();
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();

	// P1-1 (overflow paid once) moved to slice OVF's owed stock (the round after OVF): StockpileOverflowOVFTest covers CS1 there.

	// ------------------------------------------------------------------ P1-2: /save-off refuses the barrier

	@Test
	void p12_savingOffRefuses() {
		assertNull(Stockpiles.savingOffMessage(List.of()));
		String m = Stockpiles.savingOffMessage(List.of("minecraft:overworld"));
		assertNotNull(m);
		assertTrue(m.contains("/save-off") && m.contains("minecraft:overworld"), m);
	}

	// ------------------------------------------------------------------ P1-3: an evicted mark keeps its cell from LAGGING

	private static RepairCore.Reader reader(long minedPos, long minedAt, long evicted) {
		return new RepairCore.Reader() {
			@Override
			public BlockState get(long pos) {
				return AIR;
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

			@Override
			public long evicted(long pos) {
				return evicted;
			}
		};
	}

	@Test
	void p13_aMarkDroppedByTheCapOrTheExpiryNeverMakesAMinedCellLagging() {
		// 1,025 cells mined in one chunk at 10_000.. after a placement committed at 1000: the first mark is dropped by the cap
		MinedCells many = MinedCells.EMPTY;
		for (int i = 0; i <= MinedCells.MAX; i++) {
			many = many.with(i, 10_000 + i);
		}
		assertEquals(-1, many.at(0), "the oldest dropped");
		assertEquals(10_000, many.evicted(), "and remembered");
		assertEquals(10_000, MinedCells.read(many.write()).evicted(), "saved with the chunk");
		long a = p(1, G + 1, 1);
		RepairCore.Want w = new RepairCore.Want("d", a, WorldJournal.value(BRICK), WorldJournal.value(AIR), "s1", "j1", false, 1000, 1, null, 0);
		assertEquals(RepairCore.Cell.FOREIGN, RepairCore.classify(reader(-99, -1, many.evicted()), w), "cell 0, mined, its mark evicted: not "
			+ "repairable (was LAGGING)");
		RepairCore.Want later = new RepairCore.Want("d", a, WorldJournal.value(BRICK), WorldJournal.value(AIR), "s1", "j2", false, 20_000, 1, null, 0);
		assertEquals(RepairCore.Cell.LAGGING, RepairCore.classify(reader(-99, -1, many.evicted()), later), "committed after every dropped mark: "
			+ "still a lost write");
		// the 24 h expiry: a mark at 2000, the chunk's next a day later
		MinedCells old = MinedCells.EMPTY.with(5L, 2000).with(6L, 2000 + MinedCells.KEEP_MS + 1);
		assertEquals(-1, old.at(5L));
		assertEquals(2000, old.evicted());
		assertEquals(RepairCore.Cell.FOREIGN, RepairCore.classify(reader(-99, -1, old.evicted()), w), "an expired mark: not repairable");
		assertEquals(2000, old.without(6L).evicted(), "an Architect write keeps the watermark");
		assertEquals(-1, MinedCells.EMPTY.with(5L, 1).with(5L, 2).evicted(), "a cell mined again drops nothing");
	}

	// ------------------------------------------------------------------ P1-4: a mined stuck survival removal never settles

	@Test
	void p14_aPlayersTakeOfAStuckSurvivalRemovalsBlockIsForeign() {
		long a = p(1, G + 1, 1);
		// a removal undone at 1000: its expected value air (the restore), its pre the placed brick
		RepairCore.Want w = new RepairCore.Want("d", a, WorldJournal.value(AIR), WorldJournal.value(BRICK), "s1", "j1", true, 1000, 1, null, 0);
		RepairCore.Reader r = reader(a, 1500, -1);
		assertEquals(RepairCore.Cell.OK, RepairCore.classify(r, w), "air reads restored");
		assertEquals(RepairCore.Cell.FOREIGN, Repairs.cellOf(r, w, true), "mined after the undo: the player's block (was OK, then settled with "
			+ "the full refund: a dupe)");
		assertEquals(RepairCore.Cell.OK, Repairs.cellOf(r, w, false), "creative: no refund, it settles");
		assertEquals(RepairCore.Cell.OK, Repairs.cellOf(reader(a, 900, -1), w, true), "a mark before the undo is about an earlier owner");
		assertEquals(RepairCore.Cell.FOREIGN, Repairs.cellOf(reader(-99, -1, 1200), w, true), "its mark evicted after the undo (the chunk's "
			+ "watermark): it may have been taken, never settled on a guess");
	}

	// ------------------------------------------------------------------ P1-5: a stacked upper's want carries the lower's restored record

	@Test
	void p15_aStackedUppersWantRestoresTheLowersPlayerRecord() throws Exception {
		Pt pt = new Pt(new UUID(3L, 4L), null);
		long cell = p(2, G + 1, 2);
		try (UmtCase c = UmtCase.of(w -> w.player(cell, COBBLE, pt, null))) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			UmtSim.Rec b = c.site(1, G + 1, 1, 3, G + 1, 3, PLANK, Map.of(), 0);
			c.sim.remove(b, null);
			c.sim.remove(a, null);
			JournalStore js = c.sim.store;
			String gb = SiteJournal.lastGroup(b.id);
			assertNotNull(gb);
			RepairCore.Want wb = RepairCore.removalWants(js, b.id, gb).stream().filter(x -> x.pos() == cell).findFirst().orElse(null);
			assertNotNull(wb, "B owns the cell's removal");
			assertEquals("minecraft:cobblestone", wb.expected().name(), "B's expected value is A's later restore (F1)");
			assertEquals(pt, wb.pt(), "and carries A's restored player record with it (was null: B's write restored the block without its owner)");
		}
	}

	// ------------------------------------------------------------------ should-fix: the credit audit over resumes

	@Test
	void creditAuditIsCumulative() {
		JsonObject first = Repairs.creditedAudit(null, new TreeMap<>(Map.of("minecraft:dirt", 4)));
		JsonObject both = Repairs.creditedAudit(first, Map.of());
		assertEquals(4, both.get("minecraft:dirt").getAsInt(), "a resume that books nothing keeps the first attempt's credit (was empty)");
		assertEquals(6, Repairs.creditedAudit(first, Map.of("minecraft:dirt", 2)).get("minecraft:dirt").getAsInt());
	}
}
