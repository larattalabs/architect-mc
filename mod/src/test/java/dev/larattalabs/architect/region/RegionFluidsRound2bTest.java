package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8c, the 8cG review's round 2) P1-2: a resumed stray pass waits until every remaining chunk is loaded (never seeds from loaded chunks
 * only) and redoes no finished chunk; P1-3: a held body's tile-written sources are drained through the ownership checks (a player's
 * waterlogged chest stays), so it is never "drained" while its sources stand.
 */
class RegionFluidsRound2bTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static final String IR = "{\"parts\":[{\"id\":\"p\",\"stage\":\"fluids\",\"ops\":["
		+ "{\"op\":\"fluid\",\"id\":\"r_r1\",\"part\":\"r\",\"fluid\":\"water\",\"level\":70,\"cells\":[[0,0,69,70]],\"spill\":[[1,0,70,70]],"
		+ "\"predicted\":[[1,70,0,1],[40,70,0,6]],\"settleTicks\":60,\"flow\":\"current\"}]}]}";

	static RegionFluids.Regional st() {
		return new RegionFluids.Regional(RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject()));
	}

	@Test
	void aResumedStrayPassWaitsForEveryRemainingChunk() {
		RegionFluids.Regional st = st();
		st.strayChunks = RegionFluids.watchChunks(st);
		long far = ChunkPos.pack(40 >> 4, 0);
		assertTrue(st.strayChunks.contains(far) && st.strayChunks.size() >= 2, "the watch set spans the far chunk");
		assertFalse(RegionFluids.strayReady(st, k -> k != far), "the far chunk unloaded: the pass waits (the old pass seeded without it)");
		assertTrue(RegionFluids.strayReady(st, k -> true));
		long[][] work = {{BlockPos.asLong(1, 70, 0), 0, 0}, {BlockPos.asLong(40, 70, 0), 0, 0}};
		st.strayChunks = new LongOpenHashSet(new long[] {far});
		assertEquals(1, RegionFluids.remainingWork(work, st.strayChunks).length, "a finished chunk is not redone; the left one is");
		assertEquals(BlockPos.asLong(40, 70, 0), RegionFluids.remainingWork(work, st.strayChunks)[0][0]);
	}

	@Test
	void aHeldBodysWrittenSourcesAreDrainedButAPlayersChestStays() {
		RegionFluids.Regional st = st();
		RegionFluids.Body b = st.bodies.get(0);
		RegionFluids.BodyState bs = st.states.get(b.id);
		long src = BlockPos.asLong(0, 69, 0), chest = BlockPos.asLong(0, 70, 0);
		bs.before.put(src, "minecraft:air");
		bs.before.put(chest, "minecraft:air");
		Map<Long, BlockState> world = new java.util.HashMap<>();
		world.put(src, Blocks.WATER.defaultBlockState());
		world.put(chest, Blocks.CHEST.defaultBlockState().setValue(ChestBlock.WATERLOGGED, true));
		RegionFluids.DrainTarget t = new RegionFluids.DrainTarget() {
			@Override
			public BlockState get(BlockPos p) {
				return world.getOrDefault(p.asLong(), Blocks.AIR.defaultBlockState());
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				world.put(p.asLong(), s);
			}
		};
		int n = RegionFluids.drain(t, null, st, b, bs, false, new LongOpenHashSet(), RegionFluids.NOT_HELD, false);
		assertEquals(1, n);
		assertTrue(world.get(src).isAir(), "the tile-written source drained");
		assertTrue(world.get(chest).is(Blocks.CHEST), "the player's waterlogged chest stands");
		void_(List.of());
	}

	static void void_(Object o) {
	}
}
