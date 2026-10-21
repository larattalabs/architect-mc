package dev.larattalabs.architect.region;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.mixin.LevelTicksAccessor;
import it.unimi.dsi.fastutil.longs.Long2ObjectMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.ticks.LevelChunkTicks;
import net.minecraft.world.ticks.LevelTicks;

/**
 * (gate waits, 2026-10-20) The scheduled block and fluid ticks a level holds, per loaded chunk (each chunk's tick container, its
 * not yet unpacked saved ticks included), for the scenario gate's settle condition: a fresh world copy is quiet once no chunk the
 * server simulates has a scheduled tick (worldgen springs, fluids settling, first block ticks). Read only; dev and gate use.
 */
public final class PendingTicks {
	private PendingTicks() {
	}

	/**
	 * {box?: [minX, minZ, maxX, maxZ]} -> {block, fluid (in the chunks the server ticks), blockAll, fluidAll (every loaded chunk),
	 * chunks, tickingChunks, and for the box's chunks: boxChunks, boxLoaded, boxTicking, boxBlock, boxFluid}.
	 */
	public static JsonObject of(ServerLevel level, int[] box) {
		JsonObject o = new JsonObject();
		@SuppressWarnings("unchecked")
		Long2ObjectMap<LevelChunkTicks<?>> blocks = (Long2ObjectMap<LevelChunkTicks<?>>) (Object) ((LevelTicksAccessor<?>) (LevelTicks<?>) level.getBlockTicks()).architect$allContainers();
		@SuppressWarnings("unchecked")
		Long2ObjectMap<LevelChunkTicks<?>> fluids = (Long2ObjectMap<LevelChunkTicks<?>>) (Object) ((LevelTicksAccessor<?>) (LevelTicks<?>) level.getFluidTicks()).architect$allContainers();
		int cx0 = box == null ? 0 : box[0] >> 4, cz0 = box == null ? 0 : box[1] >> 4, cx1 = box == null ? -1 : box[2] >> 4, cz1 = box == null ? -1 : box[3] >> 4;
		long block = 0, fluid = 0, blockAll = 0, fluidAll = 0, boxBlock = 0, boxFluid = 0;
		int chunks = 0, ticking = 0, boxLoaded = 0, boxTicking = 0;
		for (Long2ObjectMap.Entry<LevelChunkTicks<?>> e : blocks.long2ObjectEntrySet()) {
			long k = e.getLongKey();
			int b = e.getValue().count();
			LevelChunkTicks<?> f0 = fluids.get(k);
			int f = f0 == null ? 0 : f0.count();
			boolean t = level.shouldTickBlocksAt(k);
			chunks++;
			blockAll += b;
			fluidAll += f;
			if (t) {
				ticking++;
				block += b;
				fluid += f;
			}
			int x = ChunkPos.getX(k), z = ChunkPos.getZ(k);
			if (x >= cx0 && x <= cx1 && z >= cz0 && z <= cz1) {
				boxLoaded++;
				boxBlock += b;
				boxFluid += f;
				if (t) {
					boxTicking++;
				}
			}
		}
		o.addProperty("block", block);
		o.addProperty("fluid", fluid);
		o.addProperty("blockAll", blockAll);
		o.addProperty("fluidAll", fluidAll);
		o.addProperty("chunks", chunks);
		o.addProperty("tickingChunks", ticking);
		if (box != null) {
			o.addProperty("boxChunks", (cx1 - cx0 + 1) * (cz1 - cz0 + 1));
			o.addProperty("boxLoaded", boxLoaded);
			o.addProperty("boxTicking", boxTicking);
			o.addProperty("boxBlock", boxBlock);
			o.addProperty("boxFluid", boxFluid);
		}
		o.addProperty("gameTime", level.getGameTime());
		return o;
	}
}
