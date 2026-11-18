package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8c, the 8cG review's fix round) The units of the P1s and P2s that have one: the still-ours rule every drain, restore and abort reads
 * (P1-1, P1-2), the charged items a river's removal scoops in a mixed region (P1-3), the foreign-only levels and the stray pass at the
 * cap (P1-6, P2-11, measured), a river IR stale while rivers are off and the region.plan key (P2-9), the version-4 guard's levels
 * (P2-10), a removed river's watch set never refed (P2-7).
 */
class RegionFluidsFixRoundTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() {
		RegionFluids.testFlowing = null;
	}

	static final String IR = "{\"parts\":[{\"id\":\"p\",\"stage\":\"fluids\",\"ops\":["
		+ "{\"op\":\"fluid\",\"id\":\"river_r1\",\"part\":\"river\",\"fluid\":\"water\",\"level\":70,\"cells\":[[0,0,69,70]],\"spill\":[[1,0,70,70]],"
		+ "\"predicted\":[[1,70,0,1]],\"settleTicks\":60,\"flow\":\"current\",\"grate\":[[0,0,69,69]]},"
		+ "{\"op\":\"fluid\",\"id\":\"w_pit\",\"part\":\"pit\",\"fluid\":\"lava\",\"level\":63,\"cells\":[[9,9,62,63]],\"settleTicks\":30}]}]}";

	static List<RegionFluids.Body> bodies() {
		return RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
	}

	@Test
	void theStillOursRule() {
		RegionFluids.Body river = bodies().get(0);
		long src = BlockPos.asLong(0, 70, 0), grate = BlockPos.asLong(0, 69, 0);
		assertTrue(RegionFluids.ownStillOurs(river, src, Blocks.WATER.defaultBlockState()), "its source");
		assertTrue(RegionFluids.ownStillOurs(river, src, Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 3)), "its source decayed to flow");
		assertFalse(RegionFluids.ownStillOurs(river, src, Blocks.CHEST.defaultBlockState().setValue(ChestBlock.WATERLOGGED, true)), "P1-1: a player's waterlogged chest");
		assertFalse(RegionFluids.ownStillOurs(river, src, Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.WATERLOGGED, true)), "a waterlogged slab");
		assertFalse(RegionFluids.ownStillOurs(river, src, Blocks.AIR.defaultBlockState()));
		assertTrue(RegionFluids.ownStillOurs(river, grate, Blocks.IRON_BARS.defaultBlockState()), "its grate's bars");
		assertFalse(RegionFluids.ownStillOurs(bodies().get(1), BlockPos.asLong(9, 63, 9), Blocks.WATER.defaultBlockState()), "a lava body: water isn't its");
		assertTrue(RegionFluids.flowStillOurs(river, Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 2)), "its flow");
		assertFalse(RegionFluids.flowStillOurs(river, Blocks.WATER.defaultBlockState()), "P1-2: a source in the flow is a player's bucket");
		assertFalse(RegionFluids.flowStillOurs(river, Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.WATERLOGGED, true)));
	}

	@Test
	void aMixedRegionsChargedItemsAreCountedForTheScoop() {
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		for (RegionFluids.BodyState bs : st.states.values()) {
			bs.before.put(1L, "minecraft:air");
		}
		Map<Long, BlockState> w = new java.util.HashMap<>();
		w.put(BlockPos.asLong(9, 62, 9), Blocks.LAVA.defaultBlockState());
		w.put(BlockPos.asLong(9, 63, 9), Blocks.LAVA.defaultBlockState());
		w.put(BlockPos.asLong(0, 69, 0), Blocks.IRON_BARS.defaultBlockState());
		assertTrue(st.flowingRegion() || !RegionFluids.flowingBuild(), "a river makes the region flowing (gateFlowing removes it)");
		assertArrayEquals(new int[] {2, 1}, RegionFluids.standingCharged(st, p -> w.getOrDefault(p, Blocks.AIR.defaultBlockState())),
			"P1-3: the lava pit's 2 sources and the river's grate, scooped by gateFlowing as by H's removal");
	}

	@Test
	void theStrayPassAtTheCapIsBudgetedAndMeasured() {
		// a straight current of 4096 cells (the per-body cap) with a foreign source feeding its far end
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		LongOpenHashSet take = new LongOpenHashSet();
		Map<Long, RegionFluids.Wet> w = new java.util.HashMap<>();
		for (int x = 1; x <= 4096; x++) {
			take.add(BlockPos.asLong(x, 70, 0));
			w.put(BlockPos.asLong(x, 70, 0), new RegionFluids.Wet(1 + (x % 7), false, true));
		}
		w.put(BlockPos.asLong(4097, 70, 0), new RegionFluids.Wet(8, true, true));
		long t0 = System.nanoTime();
		var lv = RegionFluids.foreignOnly(take, new LongOpenHashSet(), w::get);
		double ms = (System.nanoTime() - t0) / 1e6;
		System.out.println("8c P2-11: foreignOnly over 4096 cells " + ms + " ms");
		assertEquals(7, lv.get(BlockPos.asLong(4096, 70, 0)), "beside the foreign source: amount 7");
		assertEquals(0, lv.get(BlockPos.asLong(4000, 70, 0)), "beyond its reach: dry");
		assertTrue(RegionFluids.STRAY_BUDGET <= 4096 && RegionFluids.CENSUS_BUDGET >= RegionFluids.STRAY_BUDGET);
		assertTrue(ms < 2000, "the fixed point at the cap stays under 2 s (" + ms + " ms)");
		void_(st);
	}

	static void void_(Object o) {
	}

	@Test
	void aRiverIrIsStaleWhileRiversAreOffAndTheKeySaysWhich() {
		JsonObject ir = PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "flowingWater");
		RegionFluids.testFlowing = true;
		assertNull(IrStale.reason(ir, null), "this mod builds rivers: current");
		RegionFluids.testFlowing = false;
		String why = IrStale.reason(ir, null);
		assertNotNull(why, "P2-9: rivers off: a cached river IR is stale, never drained as H's");
		assertTrue(why.contains("flowingWater"), why);
	}

	@Test
	void aVersion4GuardComparesLevels() {
		int[] box = {0, 60, 0, 0, 61, 0};
		byte[] cells = {(byte) VoxelClass.ROCK.ordinal(), (byte) VoxelClass.WATER.ordinal()};
		int[] blocks = {1, 2};
		List<String> pal = List.of("minecraft:air", "minecraft:stone", "minecraft:water");
		byte[] fluids = {0, 2};
		Arvx.Decoded one = Arvx.decode(VolumeSurvey.encode(box, cells, Map.of(), new boolean[1], blocks, pal, fluids, new byte[] {0, 1}).raw());
		Arvx.Decoded seven = Arvx.decode(VolumeSurvey.encode(box, cells, Map.of(), new boolean[1], blocks, pal, fluids, new byte[] {0, 7}).raw());
		JsonArray runs = new JsonArray();
		for (int v : new int[] {0, 0, 60, 61}) {
			runs.add(v);
		}
		assertNull(PlanChecks.waterDiff("body b of p", one, one, runs));
		String d = PlanChecks.waterDiff("body b of p", one, seven, runs);
		assertNotNull(d, "P2-10: flowing water at level 1 then 7 is a changed guard");
		assertTrue(d.contains("@1") && d.contains("@7"), d);
	}

	@Test
	void aRemovedRiversWatchSetIsNeverRefed() {
		RegionFluids.Regional st = new RegionFluids.Regional(bodies());
		long p = BlockPos.asLong(1, 70, 0);
		RegionFluids.snapshotWatch("rgTest", st);
		assertTrue(RegionFluids.watchedByFlowing(p), "P2-7: the removed river's watch set stays known");
		assertFalse(RegionFluids.watchedByFlowing(BlockPos.asLong(500, 70, 500)));
	}
}
