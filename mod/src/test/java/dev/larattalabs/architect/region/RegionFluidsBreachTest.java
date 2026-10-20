package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (6c IRR, the CU/IRR/VOC-c batch's fix of the verifier's breach finding) {@link RegionFluids#breachTake}: which water an irrigation
 * source's breach flow is, read from the fluid levels before the drain writes. A bare flow is taken whole (a falling column and its
 * spread too); a flow joined by a foreign source (a player's bucket, a pond) or a waterlogged block is spared where they meet and
 * downstream of that; water there before the realise and another body's cells are never taken; with the source already drained (a
 * removal resumed after a stop) the flow is still taken; nothing outside the box.
 */
class RegionFluidsBreachTest {
	static final RegionFluids.Wet SRC = new RegionFluids.Wet(8, true, true);
	static final RegionFluids.Wet LOGGED = new RegionFluids.Wet(8, true, false);
	static final int[] BOX = {-20, -10, -20, 20, 2, 20};

	static long p(int x, int y, int z) {
		return BlockPos.asLong(x, y, z);
	}

	static RegionFluids.Wet flow(int amount) {
		return new RegionFluids.Wet(amount, false, true);
	}

	/** The body's source at 0,0,0 (unless drained), its broken side 1,0,0, the flow east along x at y 0. */
	static Long2ObjectOpenHashMap<RegionFluids.Wet> field(boolean sourceThere, int... amounts) {
		Long2ObjectOpenHashMap<RegionFluids.Wet> w = new Long2ObjectOpenHashMap<>();
		if (sourceThere) {
			w.put(p(0, 0, 0), SRC);
		}
		for (int i = 0; i < amounts.length; i++) {
			w.put(p(i + 1, 0, 0), flow(amounts[i]));
		}
		return w;
	}

	static Set<String> take(Long2ObjectOpenHashMap<RegionFluids.Wet> w, LongOpenHashSet foreign, int[] box) {
		LongOpenHashSet own = new LongOpenHashSet(new long[] {p(0, 0, 0)});
		List<long[]> seeds = List.of(new long[] {p(0, 0, 0)}, new long[] {p(1, 0, 0), p(-1, 0, 0), p(0, 0, 1), p(0, 0, -1), p(0, -1, 0)}, new long[0]);
		LongOpenHashSet s = RegionFluids.breachTake(seeds, own, foreign, box, w::get, RegionFluids.BREACH_MAX);
		Set<String> out = new TreeSet<>();
		for (long k : s) {
			out.add(BlockPos.getX(k) + "," + BlockPos.getY(k) + "," + BlockPos.getZ(k));
		}
		return out;
	}

	static Set<String> xs(int... x) {
		Set<String> out = new TreeSet<>();
		for (int i : x) {
			out.add(i + ",0,0");
		}
		return out;
	}

	@Test
	void aBareFlowIsTakenWithItsFallingColumnAndSpread() {
		var w = field(true, 7, 6, 5, 4);
		w.put(p(5, 0, 0), flow(3));
		w.put(p(5, -1, 0), flow(8)); // falling off the pad's edge
		w.put(p(5, -2, 0), flow(8));
		w.put(p(6, -2, 0), flow(7)); // its spread on the ground below
		w.put(p(7, -2, 0), flow(6));
		Set<String> want = xs(1, 2, 3, 4, 5);
		want.addAll(List.of("5,-1,0", "5,-2,0", "6,-2,0", "7,-2,0"));
		assertEquals(want, take(w, new LongOpenHashSet(), BOX));
	}

	@Test
	void aForeignSourceSparesTheJointWaterAndDownstreamOfIt() {
		// a player's source at 6,0,0 meets the flow: 5 and 4 are fed from it, 3 from both; 1 and 2 only from the body
		var w = field(true, 7, 6, 5, 6, 7);
		w.put(p(6, 0, 0), SRC);
		w.put(p(7, 0, 0), flow(7)); // the player's own flow
		w.put(p(6, 0, 1), flow(7));
		assertEquals(xs(1, 2), take(w, new LongOpenHashSet(), BOX));
	}

	@Test
	void aPondJoiningTheFlowIsNeverTakenNorTheFlowItFeeds() {
		var w = field(true, 7, 6, 5, 4);
		// a pond's 2 x 2 sources south of x 3..4, its own flow beside it
		for (int x = 3; x <= 4; x++) {
			for (int z = 1; z <= 2; z++) {
				w.put(p(x, 0, z), SRC);
			}
		}
		w.put(p(5, 0, 1), flow(7));
		Set<String> got = take(w, new LongOpenHashSet(), BOX);
		assertEquals(xs(1, 2), got, "3 and 4 touch the pond's sources (fed by them): spared, and so is all the pond");
	}

	@Test
	void aWaterloggedBlockIsAForeignFeeder() {
		var w = field(true, 7, 6, 5, 4);
		w.put(p(2, 0, 1), LOGGED);
		assertEquals(xs(1), take(w, new LongOpenHashSet(), BOX));
	}

	@Test
	void waterThereBeforeAndAnotherBodysCellsAreNeverTaken() {
		var w = field(true, 7, 6, 5, 4);
		w.put(p(3, 0, 1), flow(3)); // there before the realise: lower, so it feeds nothing of the body's
		w.put(p(4, 0, -1), flow(7)); // another body's predicted flow: higher, so 4 is fed from it
		LongOpenHashSet foreign = new LongOpenHashSet(new long[] {p(3, 0, 1), p(4, 0, -1)});
		assertEquals(xs(1, 2, 3), take(w, foreign, BOX));
	}

	@Test
	void theSourceAlreadyDrainedStillTakesItsFlow() {
		assertEquals(xs(1, 2, 3, 4), take(field(false, 7, 6, 5, 4), new LongOpenHashSet(), BOX));
	}

	@Test
	void nothingOutsideTheBox() {
		assertEquals(xs(1, 2), take(field(true, 7, 6, 5, 4), new LongOpenHashSet(), new int[] {-20, -10, -20, 2, 2, 20}));
	}
}
