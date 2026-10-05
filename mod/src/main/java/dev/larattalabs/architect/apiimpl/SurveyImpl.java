package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Sample;
import dev.larattalabs.architect.api.Survey;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.QuartPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * {@link Survey}, time-sliced on the server thread: queued surveys read whole chunks at the end of each server tick until
 * {@link #BUDGET_NANOS} is spent, then wait for the next tick. {@code LOADED_ONLY} never loads a chunk
 * ({@code getChunkNow}); {@code LOAD_BOUNDED(n)} loads (generating if needed) at most {@code n} chunks through the
 * ordinary chunk source, which only holds them by a short-lived ticket, so they unload again by themselves. Internal.
 */
public final class SurveyImpl implements Survey {
	/** The per-tick time budget for all running surveys. */
	public static final long BUDGET_NANOS = 3_000_000L;
	private static final List<Task> TASKS = new ArrayList<>();

	private record Task(ServerLevel level, SurveyGrid grid, List<Long> chunks, LoadPolicy load, CompletableFuture<Sample> future, int[] state) {
		// state: {next chunk index, chunks loaded}
	}

	static void init() {
		ServerTickEvents.END_SERVER_TICK.register(SurveyImpl::tick);
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
			for (Task t : TASKS) {
				t.future().completeExceptionally(new IllegalStateException("the world closed"));
			}
			TASKS.clear();
		});
	}

	@Override
	public CompletableFuture<Sample> sample(ServerLevel level, BoundingBox area, int resolution, LoadPolicy load) {
		CompletableFuture<Sample> f = new CompletableFuture<>();
		MinecraftServer server = level.getServer();
		Runnable start = () -> {
			SurveyGrid grid = new SurveyGrid(area.minX(), area.minZ(), area.maxX(), area.maxZ(), resolution);
			TASKS.add(new Task(level, grid, grid.chunks(), load == null ? LoadPolicy.LOADED_ONLY : load, f, new int[] {0, 0}));
		};
		if (server.isSameThread()) {
			start.run();
		} else {
			server.execute(start);
		}
		return f;
	}

	private static void tick(MinecraftServer server) {
		if (TASKS.isEmpty()) {
			return;
		}
		long end = System.nanoTime() + BUDGET_NANOS;
		while (!TASKS.isEmpty() && System.nanoTime() < end) {
			Task t = TASKS.get(0);
			try {
				while (t.state()[0] < t.chunks().size() && System.nanoTime() < end) {
					long k = t.chunks().get(t.state()[0]++);
					read(t, k);
				}
			} catch (RuntimeException e) {
				TASKS.remove(0);
				Architect.LOGGER.warn("Survey failed", e);
				t.future().completeExceptionally(e);
				continue;
			}
			if (t.state()[0] >= t.chunks().size()) {
				TASKS.remove(0);
				t.future().complete(t.grid().finish(t.state()[1]));
			}
		}
	}

	private static void read(Task t, long k) {
		int cx = SurveyGrid.keyX(k);
		int cz = SurveyGrid.keyZ(k);
		ServerLevel level = t.level();
		LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
		if (chunk == null && t.load().loads() && t.state()[1] < t.load().maxChunks()) {
			chunk = level.getChunk(cx, cz); // generates when needed; held by a short-lived ticket only
			t.state()[1]++;
		}
		if (chunk == null) {
			t.grid().miss(k);
			return;
		}
		LevelChunk c = chunk;
		t.grid().sample(k, new SurveyGrid.Columns() {
			@Override
			public SurveyGrid.Column column(int x, int z) {
				return SurveyImpl.column(c, x, z);
			}

			@Override
			public @Nullable String biome(int x, int z) {
				int y = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x & 15, z & 15);
				return c.getNoiseBiome(QuartPos.fromBlock(x), QuartPos.fromBlock(y), QuartPos.fromBlock(z)).unwrapKey()
					.map(key -> key.identifier().toString()).orElse(null);
			}
		});
	}

	/** One column: height and floor as the top block's y (the heightmap's first free y minus one). */
	static SurveyGrid.Column column(LevelChunk c, int x, int z) {
		int lx = x & 15;
		int lz = z & 15;
		int h = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, lx, lz);
		int floor = c.getHeight(Heightmap.Types.OCEAN_FLOOR, lx, lz);
		int withLeaves = c.getHeight(Heightmap.Types.MOTION_BLOCKING, lx, lz);
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos(x, h, z);
		BlockState top = c.getBlockState(p);
		boolean water = c.getFluidState(p).is(FluidTags.WATER);
		boolean tree = top.is(BlockTags.LOGS) || top.is(BlockTags.LEAVES)
			|| withLeaves > h && c.getBlockState(p.set(x, withLeaves, z)).is(BlockTags.LEAVES);
		String id = BuiltInRegistries.BLOCK.getKey(top.getBlock()).toString();
		return new SurveyGrid.Column(h, floor, id, water, tree, natural(top, water));
	}

	/** Natural terrain at the top of a column: soil, stone, sand, snow and ice, logs and leaves, water, lava. */
	static boolean natural(BlockState s, boolean water) {
		return water || s.is(BlockTags.DIRT) || s.is(BlockTags.SAND) || s.is(BlockTags.BASE_STONE_OVERWORLD) || s.is(BlockTags.BASE_STONE_NETHER)
			|| s.is(BlockTags.LOGS) || s.is(BlockTags.LEAVES) || s.is(BlockTags.ICE) || s.is(BlockTags.SNOW) || s.is(BlockTags.TERRACOTTA)
			|| s.is(Blocks.GRAVEL) || s.is(Blocks.CLAY) || s.is(Blocks.SANDSTONE) || s.is(Blocks.RED_SANDSTONE) || s.is(Blocks.LAVA)
			|| s.is(Blocks.SNOW_BLOCK) || s.is(Blocks.POWDER_SNOW) || s.is(Blocks.BEDROCK) || s.is(Blocks.END_STONE) || s.is(Blocks.SOUL_SAND)
			|| s.is(Blocks.SOUL_SOIL) || s.is(Blocks.MAGMA_BLOCK) || s.is(Blocks.CALCITE) || s.is(Blocks.DRIPSTONE_BLOCK) || s.is(Blocks.POINTED_DRIPSTONE)
			|| s.is(Blocks.AMETHYST_BLOCK) || s.is(Blocks.MUSHROOM_STEM) || s.is(Blocks.BROWN_MUSHROOM_BLOCK) || s.is(Blocks.RED_MUSHROOM_BLOCK)
			|| s.is(Blocks.BAMBOO) || s.is(Blocks.CACTUS) || s.is(Blocks.PUMPKIN) || s.is(Blocks.MELON) || s.is(Blocks.SUGAR_CANE);
	}
}
