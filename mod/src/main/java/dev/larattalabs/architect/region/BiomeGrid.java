package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.core.QuartPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * (6c D2, C27/C28) The plan's biome grid: one biome per 4x4 columns (a quart: the game stores biomes per 4x4x4, so a per-column read
 * adds nothing a district's edge tracing could use; C28's answer) at the surface (MOTION_BLOCKING_NO_LEAVES), over the claim, from loaded
 * chunks only (an unloaded chunk's quarts are -1). Sent to the plan as {@code region.plan.biomes} ({@code ctx.biomes} in the kit:
 * {@code {minX, minZ, res: 4, width, depth, palette, ids}}); the palette in first-seen order (z, then x). Server thread.
 */
public final class BiomeGrid {
	private BiomeGrid() {
	}

	/** The grid over the columns [x0, x1] x [z0, z1]. */
	public static JsonObject sample(ServerLevel level, int x0, int z0, int x1, int z1) {
		int qx0 = Math.floorDiv(x0, 4), qz0 = Math.floorDiv(z0, 4), qx1 = Math.floorDiv(x1, 4), qz1 = Math.floorDiv(z1, 4);
		int w = qx1 - qx0 + 1, d = qz1 - qz0 + 1;
		Map<String, Integer> palette = new LinkedHashMap<>();
		JsonArray ids = new JsonArray();
		for (int qz = qz0; qz <= qz1; qz++) {
			for (int qx = qx0; qx <= qx1; qx++) {
				int x = qx * 4, z = qz * 4;
				LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
				if (c == null) {
					ids.add(-1);
					continue;
				}
				int y = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, x & 15, z & 15);
				String id = c.getNoiseBiome(qx, QuartPos.fromBlock(y), qz).unwrapKey().map(k -> k.identifier().toString()).orElse(null);
				if (id == null) {
					ids.add(-1);
					continue;
				}
				ids.add(palette.computeIfAbsent(id, k -> palette.size()));
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("minX", qx0 * 4);
		o.addProperty("minZ", qz0 * 4);
		o.addProperty("res", 4);
		o.addProperty("width", w);
		o.addProperty("depth", d);
		JsonArray p = new JsonArray();
		palette.keySet().forEach(p::add);
		o.add("palette", p);
		o.add("ids", ids);
		return o;
	}
}
