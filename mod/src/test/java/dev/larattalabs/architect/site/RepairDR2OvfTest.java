package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/**
 * (DR2 round after OVF) The final review's P1: one mined cell withheld a stuck survival removal's whole refund forever. Now the repair
 * settles it around its taken cells, books what was restored or removed and holds only the taken cells' share (the player holds those
 * blocks), split on disk before the release. {@link #aStuckRemovalSettlesAroundItsTakenCells} fails on 16f29895 (it never settled).
 */
class RepairDR2OvfTest {
	static {
		UmtRunner.boot();
	}

	private static final BlockState BRICK = Blocks.STONE_BRICKS.defaultBlockState();
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();
	private static final String K = "site:s1@5";
	private static final String ITEM = "minecraft:stone_bricks";

	@Test
	void aStuckRemovalSettlesAroundItsTakenCells() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 3, G + 1, 3, BRICK, Map.of(), 0);
			c.sim.remove(a, null);
			JournalStore js = c.sim.store;
			String g = SiteJournal.lastGroup(a.id);
			assertNotNull(g);
			List<RepairCore.Want> w = RepairCore.removalWants(js, a.id, g);
			Repairs.Unit taken = new Repairs.Unit(a.id, null, true, g, w, List.of(), 1, List.of(), List.of(), 0, 1, "");
			assertEquals(Set.of(a.id), Repairs.settling(js, List.of(taken), Set.of(a.id)), "its only non-OK cell a player took: it settles, "
				+ "its share withheld (was: pending for good, the whole refund held)");
			Repairs.Unit foreign = new Repairs.Unit(a.id, null, true, g, w, List.of(), 2, List.of(), List.of(), 0, 1, "");
			assertEquals(Set.of(), Repairs.settling(js, List.of(foreign), Set.of(a.id)), "a foreign cell no player took still keeps it pending");
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

	@Test
	void theTakenShareIsWhatTheTallyPaidForEachTakenCell() {
		// a 3x1x1 box: queue cells 0 (paid), 1 (free-pass), 2 not queued
		var box = new dev.larattalabs.architect.placement.Anchors.Bounds(30, G + 1, 30, 32, G + 1, 30);
		int[] queue = {0, 1};
		java.util.BitSet free = new java.util.BitSet();
		free.set(1);
		BlockState slab = Blocks.STONE_BRICK_SLAB.defaultBlockState().setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties
			.WATERLOGGED, true);
		RepairCore.Want paid = want(30, slab);
		RepairCore.Want freeCell = want(31, BRICK);
		RepairCore.Want outside = want(32, BRICK);
		Map<String, Integer> s = RepairCore.takenShare(box, queue, free, List.of(paid, freeCell, outside));
		assertEquals(Cells.cost(slab.setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED, false)).stream()
			.collect(java.util.stream.Collectors.toMap(x -> x.item(), x -> x.count(), Integer::sum)), s, "only the paid queued cell, costed dry "
			+ "(the Run's rule)");
	}

	private static RepairCore.Want want(int x, BlockState placed) {
		return new RepairCore.Want("d", net.minecraft.core.BlockPos.asLong(x, G + 1, 30), WorldJournal.value(AIR), WorldJournal.value(placed), "s1",
			"j1", true, 1000, 1, null, 0);
	}

	private static StockLedger pendingTen() {
		StockLedger l = new StockLedger();
		l.pay(K, ITEM, 10);
		l.holdPending(K, Map.of(ITEM, 10), 77L);
		return l;
	}

	private static int returned(StockLedger l) {
		JsonObject r = l.toJson().getAsJsonObject("returned");
		return r != null && r.has(ITEM) ? r.get(ITEM).getAsInt() : 0;
	}

	@Test
	void withholdSplitsOnceAndNeverPastThePending() {
		StockLedger l = pendingTen();
		assertEquals(Map.of(ITEM, 2), Stockpiles.withhold(l, K, Map.of(ITEM, 2, "minecraft:oak_door", 1)), "a share item not pending is not held");
		assertEquals(Map.of(ITEM, 8), l.pendingItems(K));
		assertEquals(Map.of(ITEM, 2), l.pendingItems(Stockpiles.TAKEN + K));
		assertEquals(Map.of(ITEM, 2), Stockpiles.withhold(l, K, Map.of(ITEM, 2)), "a resumed repair splits nothing again");
		assertEquals(Map.of(ITEM, 8), l.pendingItems(K));
		assertEquals(Stockpiles.PendingAction.LEAVE, Stockpiles.pendingAction(Stockpiles.TAKEN + K, false, false, false), "the held key is never booked");
		StockLedger big = pendingTen();
		assertEquals(Map.of(ITEM, 10), Stockpiles.withhold(big, K, Map.of(ITEM, 12)), "never more than pending");
		assertTrue(big.pendingItems(K).isEmpty());
	}

	/**
	 * Speed rule 18: a stop at each of the repair's saves around the split (DRK4 before it, DRK5 after its save, DRK6 after the release,
	 * DRK7 after the booking), then the start's settle and the repair resumed: the stock gets the restored share once, the taken share is
	 * held, never booked (items in == items out: 10 paid = 8 returned + 2 held). Released before the split (the old order), DRK6 booked 10.
	 */
	@Test
	void everyStopAroundTheSplitBooksTheRestOnce() {
		for (String stop : List.of("DRK4", "DRK5", "DRK6", "DRK7", "none")) {
			StockLedger mem = pendingTen();
			JsonObject disk = mem.toJson();
			Stockpiles.withhold(mem, K, Map.of(ITEM, 2));
			if (!stop.equals("DRK4")) {
				disk = mem.toJson(); // ledgerSaved: the split confirmed on disk before the release
			}
			boolean released = !stop.equals("DRK4") && !stop.equals("DRK5");
			if (stop.equals("DRK7") || stop.equals("none")) {
				mem.credit(K, mem.pendingItems(K), 1000, item -> 64);
				disk = mem.toJson();
			}
			StockLedger back = StockLedger.fromJson(disk);
			// the start's settle (Stockpiles.settlePendingCredits): the removal still pending, or released
			for (String key : new TreeMap<>(Map.of(K, 0, Stockpiles.TAKEN + K, 0)).keySet()) {
				if (back.pendingKeys().contains(key) && Stockpiles.pendingAction(key, back.credited(key), false, !released)
					== Stockpiles.PendingAction.BOOK) {
					back.credit(key, back.pendingItems(key), 1000, item -> 64);
				}
			}
			if (!released) { // the open record resumed: the split (once), then the booking
				Stockpiles.withhold(back, K, Map.of(ITEM, 2));
				back.credit(K, back.pendingItems(K), 1000, item -> 64);
			}
			assertEquals(8, returned(back), stop + ": the restored share booked once");
			assertEquals(Map.of(ITEM, 2), back.pendingItems(Stockpiles.TAKEN + K), stop + ": the taken share held");
			assertTrue(back.credited(K) && !back.pendingKeys().contains(K), stop + ": credited, nothing of it pending");
			assertEquals(10, returned(back) + back.pendingItems(Stockpiles.TAKEN + K).getOrDefault(ITEM, 0), stop + ": items in == items out");
		}
	}
}
