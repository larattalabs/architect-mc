package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.Test;

/**
 * (6c H §3, §12) The fluids stage's reading of the IR: a fluid op's column runs, its prediction and settle bound, the watch set (the
 * cells, shell, spill and watched cells grown by 2), the declared region (cells, spill, joins), the tile filter of a body not written,
 * fluid-stopping blocks as 26.3 decides them.
 */
class RegionFluidsTest {
	static final String IR = "{\"parts\":[{\"id\":\"pond_shell\",\"stage\":\"ground\",\"ops\":[{\"op\":\"columns\"}]},{\"id\":\"pond\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\","
		+ "\"id\":\"pond\",\"part\":\"p\",\"fluid\":\"water\",\"level\":63,\"cells\":[[0,0,62,63],[1,0,63,63]],\"ice\":[],\"shell\":[[0,0,61,61],[2,0,63,64]],"
		+ "\"spill\":[[3,0,64,64]],\"joins\":[],\"watch\":[[-1,0,63,63]],\"predicted\":[[3,64,0,1]],\"settleTicks\":35}]},{\"id\":\"lava\",\"stage\":\"fluids\","
		+ "\"ops\":[{\"op\":\"fluid\",\"id\":\"lava\",\"fluid\":\"lava\",\"level\":60,\"cells\":[[9,9,60,60]],\"settleTicks\":80}]}]}";

	@Test
	void bodiesOfTheIr() {
		List<RegionFluids.Body> bodies = RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
		assertEquals(2, bodies.size());
		RegionFluids.Body b = bodies.get(0);
		assertEquals("pond", b.id);
		assertEquals("p", b.part);
		assertFalse(b.lava);
		assertArrayEquals(new long[] {BlockPos.asLong(0, 62, 0), BlockPos.asLong(0, 63, 0), BlockPos.asLong(1, 63, 0)}, b.cells);
		assertEquals(1, b.predicted.get(BlockPos.asLong(3, 64, 0)));
		assertEquals(35, b.settleTicks);
		assertEquals(4, b.declared().size());
		assertTrue(b.watchSet().contains(BlockPos.asLong(-3, 61, 2)), "grown by 2");
		assertFalse(b.watchSet().contains(BlockPos.asLong(-4, 63, 0)));
		RegionFluids.Body l = bodies.get(1);
		assertTrue(l.lava);
		assertEquals(null, l.part);
		assertEquals(0, l.spill.length);
	}

	@Test
	void fluidStoppingAsVanilla() {
		Boot.boot();
		var air = Blocks.AIR.defaultBlockState();
		assertFalse(RegionFluids.fluidStopping(null, BlockPos.ZERO, air));
		// (a torch or a plant is not: the block tag washed_away_by_fluids, bound only with a data pack, so in game; the kit's generated table
		// agrees: kit/test/h-core.test.mjs)
		assertTrue(RegionFluids.fluidStopping(null, BlockPos.ZERO, Blocks.STONE_BRICKS.defaultBlockState()));
		assertTrue(RegionFluids.fluidStopping(null, BlockPos.ZERO, Blocks.CLAY.defaultBlockState()));
		assertTrue(RegionFluids.fluidStopping(null, BlockPos.ZERO, Blocks.OAK_SLAB.defaultBlockState()), "a waterloggable block takes no flowing fluid");
		assertFalse(RegionFluids.fluidStopping(null, BlockPos.ZERO, Blocks.WATER.defaultBlockState()));
	}

	@Test
	void othersAreTheSiblingsStandingBodies() {
		List<RegionFluids.Body> bodies = RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
		RegionFluids.Regional st = new RegionFluids.Regional(bodies);
		var others = st.othersOf(bodies.get(0));
		assertTrue(others.contains(BlockPos.asLong(9, 60, 9)), "the lava pit's source is its own, never the pond's escape");
		assertFalse(others.contains(BlockPos.asLong(0, 62, 0)), "not the body's own cells");
		assertTrue(st.othersOf(bodies.get(1)).contains(BlockPos.asLong(3, 64, 0)), "a sibling's predicted flow");
		st.states.get("lava").state = "drained";
		assertTrue(st.othersOf(bodies.get(0)).isEmpty(), "a drained sibling claims nothing");
	}

	@Test
	void runs() {
		JsonObject o = JsonParser.parseString("{\"r\":[[5,-3,10,12]]}").getAsJsonObject();
		assertArrayEquals(new long[] {BlockPos.asLong(5, 10, -3), BlockPos.asLong(5, 11, -3), BlockPos.asLong(5, 12, -3)}, RegionFluids.runs(o.get("r")));
		assertEquals(0, RegionFluids.runs(null).length);
	}

	/** (the H batch, review defect 1) The removal's wait after the drain is capped at 2 x the settle bound: a river never holds it. */
	@Test
	void removalWaitIsCapped() {
		long drainedAt = 1000;
		int bound = 35;
		long until = drainedAt + bound;
		assertEquals(RegionFluids.RemovalWait.WAIT, RegionFluids.removalWait(drainedAt + 10, until, bound, false), "inside the bound");
		assertEquals(RegionFluids.RemovalWait.DONE, RegionFluids.removalWait(until, until, bound, false), "nothing ticking after the bound");
		// a natural flowing source in the watch set: ticking for ever
		for (long t = until; t < until + bound; t++) {
			assertEquals(RegionFluids.RemovalWait.WAIT, RegionFluids.removalWait(t, until, bound, true), "still ticking, under the cap: " + t);
		}
		assertEquals(RegionFluids.RemovalWait.CAPPED, RegionFluids.removalWait(drainedAt + 2L * bound, until, bound, true), "2 x the bound after the drain");
		assertEquals(RegionFluids.RemovalWait.CAPPED, RegionFluids.removalWait(drainedAt + 100_000, until, bound, true));
		assertEquals(RegionFluids.RemovalWait.DONE, RegionFluids.removalWait(drainedAt + 100_000, until, bound, false));
	}

	/**
	 * (the H batch, review defect 2, §4.2) A drain's stray pass takes only the body's predicted cells and the cells recorded as escaped from
	 * it, never the rest of the watch set (a player's water added after the realise stays).
	 */
	@Test
	void straysAreOnlyPredictedAndRecordedEscapes() {
		RegionFluids.Body b = RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject()).get(0);
		RegionFluids.BodyState bs = new RegionFluids.BodyState();
		long esc = BlockPos.asLong(-2, 63, 1), player = BlockPos.asLong(-2, 63, -1);
		assertTrue(b.watchSet().contains(esc) && b.watchSet().contains(player));
		assertArrayEquals(new long[] {BlockPos.asLong(3, 64, 0)}, RegionFluids.strayCandidates(b, bs), "the predicted flow only");
		bs.escapedCells.add(esc);
		long[] c = RegionFluids.strayCandidates(b, bs);
		assertEquals(2, c.length);
		assertTrue(java.util.Arrays.stream(c).anyMatch(x -> x == esc));
		assertFalse(java.util.Arrays.stream(c).anyMatch(x -> x == player), "an unrecorded cell of the watch set is kept");
	}
}
