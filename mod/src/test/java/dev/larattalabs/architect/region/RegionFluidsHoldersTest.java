package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (fix/drain-holders) Which cells a region's whole-group drain leaves to another journal entry ({@link RegionFluids#heldIn},
 * {@link RegionFluids#heldAt}): the top of each stack by the undo planner's rule (layer, ties by the greater id). A later site's cell
 * over the region's (a waterlogged stair over a pond source) is held; the region's cell over an earlier site's is not; where the region
 * has no cell, another entry is held only above the bodies' entry layer (the floor), never one that was there when the befores were read.
 * The in-game repro is tools/gate6ch.mjs holders (h-holders).
 */
class RegionFluidsHoldersTest {
	static final Value WATER = Value.of("minecraft:water");
	static final Value AIR = Value.of("minecraft:air");
	static final Value DIRT = Value.of("minecraft:dirt");
	static final Value STAIR = Value.of("minecraft:oak_stairs", "waterlogged", "true");
	static final Set<String> GROUP = Set.of("r-tile", "r-fluid");

	static long p(int x, int y, int z) {
		return BlockPos.asLong(x, y, z);
	}

	static Entry entry(String id, Cell... cells) {
		return new Entry(id, "cells", id, "minecraft:overworld", Journal.Policy.CELL, 0L, Journal.Status.ACTIVE, List.of(cells), null, null);
	}

	@Test
	void laterSiteOverTheRegionsSourceIsHeld() {
		long src = p(0, 0, 0);
		long other = p(1, 0, 0);
		var h = RegionFluids.heldIn(List.of(entry("r-tile", new Cell(src, 5, DIRT, AIR), new Cell(other, 5, DIRT, AIR)), entry("r-fluid", new Cell(src, 9,
			AIR, WATER), new Cell(other, 9, AIR, WATER)), entry("stair", new Cell(src, 12, WATER, STAIR))), GROUP::contains);
		assertTrue(RegionFluids.heldAt(h, src, 9), "the stair site's cell on top of the region's source");
		assertFalse(RegionFluids.heldAt(h, other, 9), "a source of the region's own, on top");
		assertEquals(9L, h.ours().get(src), "the group's highest layer there");
	}

	@Test
	void theRegionOverAnEarlierSiteIsNotHeld() {
		long c = p(2, 0, 0);
		var h = RegionFluids.heldIn(List.of(entry("road", new Cell(c, 3, DIRT, AIR)), entry("r-fluid", new Cell(c, 9, AIR, WATER))), GROUP::contains);
		assertFalse(RegionFluids.heldAt(h, c, 9));
	}

	@Test
	void sameLayerTiesGoToTheGreaterId() {
		long c = p(3, 0, 0);
		// "zz" > "r-fluid": the other entry is on top at an equal layer, as WorldJournal.stack and the undo planner order them
		var h = RegionFluids.heldIn(List.of(entry("r-fluid", new Cell(c, 9, AIR, WATER)), entry("zz", new Cell(c, 9, WATER, STAIR))), GROUP::contains);
		assertTrue(RegionFluids.heldAt(h, c, 9));
		var h2 = RegionFluids.heldIn(List.of(entry("r-fluid", new Cell(c, 9, AIR, WATER)), entry("a0", new Cell(c, 9, WATER, STAIR))), GROUP::contains);
		assertFalse(RegionFluids.heldAt(h2, c, 9));
	}

	/**
	 * A farm lot removed alone ({@link RegionFluids#drainLot}): the lot's site is one of the region's group, so its own cells are never held,
	 * while a later separate site over one of the lot's irrigation sources is (irr-holders in game).
	 */
	@Test
	void aLotsDrainHoldsOnlyOtherGroups() {
		long src = p(7, 0, 0);
		long own = p(8, 0, 0);
		Set<String> group = Set.of("r-fluid", "lot-f2");
		var h = RegionFluids.heldIn(List.of(entry("lot-f2", new Cell(src, 4, DIRT, AIR), new Cell(own, 4, DIRT, AIR)), entry("r-fluid", new Cell(src, 9, AIR,
			WATER)), entry("lot-f2b", new Cell(own, 11, AIR, WATER)), entry("stair", new Cell(src, 15, WATER, STAIR))), group::contains);
		assertTrue(RegionFluids.heldAt(h, src, 9), "the stair site over the lot's source");
		assertTrue(RegionFluids.heldAt(h, own, 9), "lot-f2b is not the group's: held (a site of another group on top)");
		Set<String> withB = Set.of("r-fluid", "lot-f2", "lot-f2b");
		var h2 = RegionFluids.heldIn(List.of(entry("lot-f2", new Cell(own, 4, DIRT, AIR)), entry("lot-f2b", new Cell(own, 11, AIR, WATER))), withB::contains);
		assertFalse(RegionFluids.heldAt(h2, own, 9), "the group's own lot entries on top: drained");
	}

	@Test
	void whereTheRegionHasNoCellOnlyEntriesAboveTheFloorAreHeld() {
		long later = p(4, 0, 0);
		long earlier = p(5, 0, 0);
		long none = p(6, 0, 0);
		var h = RegionFluids.heldIn(List.of(entry("watch-stair", new Cell(later, 14, AIR, STAIR)), entry("old-road", new Cell(earlier, 2, DIRT, AIR))),
			GROUP::contains);
		assertTrue(RegionFluids.heldAt(h, later, 9), "a site written after the bodies' sources: its block is not the before there");
		assertFalse(RegionFluids.heldAt(h, earlier, 9), "a site that was there when the befores were read");
		assertFalse(RegionFluids.heldAt(h, none, 9), "no entry at all");
		assertFalse(RegionFluids.heldAt(h, later, Long.MAX_VALUE), "no floor (no journaled source): as before the fix");
	}
}
