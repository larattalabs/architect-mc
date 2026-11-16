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
import dev.larattalabs.architect.survival.StockLedger;
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

	// ------------------------------------------------------------------ P1-1: overflow paid once across CS1 and OV1

	/** A keyed (non-target) credit of 40 into no room: all 40 overflow. */
	private static StockLedger.Credit credit(StockLedger l, String key) {
		StockLedger.Credit c = l.credit(key, Map.of("minecraft:cobblestone", 40), 0, item -> 64);
		if (!c.already()) {
			l.oweDrop(key, c.overflow(), 77L); // Stockpiles.credit: owed in the same ledger change, never spawned there
		}
		return c;
	}

	/**
	 * The protocol over the ledger file and the world's entity files, through every stop: overflow is spawned only from a ledger on disk
	 * that owes it, and the owing entry leaves the ledger only in a save whose entity writes went first. Before the fix the items were
	 * spawned inside credit(): a stop at CS1 (entities on disk, the ledger not) then booked the pending refund again: 40 + 40.
	 */
	@Test
	void p11_overflowIsPaidOnceWhereverTheSaveStops() {
		String key = "put:s1:1";
		for (String stop : List.of("CS1", "OV1", "none")) {
			StockLedger mem = new StockLedger();
			JsonObject disk = mem.toJson(); // the ledger on disk before the credit (its refund still to book)
			int onDisk = 0; // overflow units in the saved entity files
			assertEquals(40, credit(mem, key).overflow().values().stream().mapToInt(Integer::intValue).sum());
			// saveCredit: chunks (no overflow entity yet: owed only) then the ledger
			if (!stop.equals("CS1")) {
				disk = mem.toJson();
				// spawnOwed: the items spawned (tagged), saved: entity files first, the entry dropped from the ledger, then the ledger
				onDisk += 40;
				mem.clearOwedDrop(key);
				if (!stop.equals("OV1")) {
					disk = mem.toJson();
				}
			}
			// the restart: the saved ledger; a pending book of the same key credits nothing twice; an owed entry resolves by the tag
			StockLedger back = StockLedger.fromJson(disk);
			StockLedger.Credit again = credit(back, key);
			int spawned = 0;
			for (String k : back.owedDropKeys()) {
				OverflowDrops.Resolution r = OverflowDrops.resolution(onDisk > 0, true);
				if (r == OverflowDrops.Resolution.SPAWN) {
					spawned += back.owedDrop(k).items().values().stream().mapToInt(Integer::intValue).sum();
				}
				back.clearOwedDrop(k);
			}
			assertEquals(40, onDisk + spawned, stop + ": the overflow exists exactly once (on disk " + onDisk + ", spawned at the start " + spawned
				+ ", credited again " + again + ")");
		}
		assertEquals(OverflowDrops.Resolution.WAIT, OverflowDrops.resolution(false, false), "its chunk's entities not loaded yet: never spawned");
	}

	@Test
	void p11_owedOverflowRoundTripsAndMerges() {
		StockLedger l = new StockLedger();
		l.oweDrop("k", Map.of("minecraft:dirt", 3), 5L);
		l.oweDrop("k", Map.of("minecraft:dirt", 2, "minecraft:stone", 1), 9L);
		l.oweDrop("e", Map.of(), 1L);
		StockLedger b = StockLedger.fromJson(l.toJson());
		assertEquals(java.util.Set.of("k"), b.owedDropKeys(), "nothing owed for an empty overflow");
		assertEquals(Map.of("minecraft:dirt", 5, "minecraft:stone", 1), b.owedDrop("k").items());
		assertEquals(5L, b.owedDrop("k").at(), "the first drop cell kept");
		b.clearOwedDrop("k");
		assertTrue(StockLedger.fromJson(b.toJson()).owedDropKeys().isEmpty());
	}

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
