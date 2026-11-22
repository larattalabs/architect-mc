package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (8c, the 8cG review's round 2, P1-4) foreignOnly to its real fixed point, against the kit's water model (kit/test/flowing-8cf.test.mjs
 * runs the same two scenes through sim.mjs steady): a 48-high falling column under a foreign source stays falling to its foot (amount 8
 * all the way down), and a flow beside a player's waterlogged chest standing in an own cell keeps amount 7 (the chest feeds it).
 */
class RegionFluidsRound2Test {
	@Test
	void aFortyEightHighFallingColumnConvergesToFalling() {
		LongOpenHashSet take = new LongOpenHashSet();
		Map<Long, RegionFluids.Wet> w = new java.util.HashMap<>();
		// the foreign source at y 113 over a column y 64..112 (49 cells), all taken (the river's stale flow there before)
		w.put(BlockPos.asLong(0, 113, 0), new RegionFluids.Wet(8, true, true));
		for (int y = 64; y <= 112; y++) {
			take.add(BlockPos.asLong(0, y, 0));
			w.put(BlockPos.asLong(0, y, 0), new RegionFluids.Wet(8, false, true));
		}
		var lv = RegionFluids.foreignOnly(take, new LongOpenHashSet(), w::get);
		for (int y = 64; y <= 112; y++) {
			assertEquals(8, lv.get(BlockPos.asLong(0, y, 0)), "falling (amount 8) at y " + y + " (the kit's steady: level 8)");
		}
	}

	@Test
	void aPlayersWaterloggedChestInAnOwnCellFeedsTheFlowBesideIt() {
		long chest = BlockPos.asLong(0, 64, 0), beside = BlockPos.asLong(1, 64, 0), next = BlockPos.asLong(2, 64, 0);
		LongOpenHashSet own = new LongOpenHashSet(new long[] {chest});
		LongOpenHashSet take = new LongOpenHashSet(new long[] {beside, next});
		Map<Long, RegionFluids.Wet> w = new java.util.HashMap<>();
		w.put(chest, new RegionFluids.Wet(8, true, false)); // a waterlogged chest: a source, no liquid block (ownStillOurs keeps it)
		w.put(beside, new RegionFluids.Wet(7, false, true));
		w.put(next, new RegionFluids.Wet(6, false, true));
		var lv = RegionFluids.foreignOnly(take, own, w::get);
		assertEquals(7, lv.get(beside), "beside the chest: amount 7 (the kit's level 1)");
		assertEquals(6, lv.get(next));
		// the body's own source (a liquid block) in that cell never feeds
		w.put(chest, new RegionFluids.Wet(8, true, true));
		assertEquals(0, RegionFluids.foreignOnly(take, own, w::get).get(beside), "the body's own water: nothing of the foreign stays");
	}
}
