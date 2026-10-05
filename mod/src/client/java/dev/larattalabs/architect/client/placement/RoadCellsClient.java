package dev.larattalabs.architect.client.placement;

import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.survival.SiteNet;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.util.HashMap;
import java.util.Map;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;

/**
 * The client's copy of the standing roads' surface cells near the player ({@code architect_mc:road_cells}, phase 4e): the
 * ghost's approach adapter flags them {@code TerrainFit.ROAD}, so the ghost draws an approach that stops at a road. The
 * placement verdict stays the server's. Client thread.
 */
public final class RoadCellsClient {
	private static final Map<String, Long2ObjectOpenHashMap<long[]>> BY_DIM = new HashMap<>();

	private RoadCellsClient() {
	}

	public static void init() {
		ClientPlayNetworking.registerGlobalReceiver(SiteNet.RoadCells.TYPE, (p, ctx) -> accept(p));
		ClientPlayConnectionEvents.DISCONNECT.register((h, mc) -> BY_DIM.clear());
	}

	static void accept(SiteNet.RoadCells p) {
		Long2ObjectOpenHashMap<long[]> m = BY_DIM.computeIfAbsent(p.dimension(), d -> new Long2ObjectOpenHashMap<>());
		for (int i = 0; i < p.keys().length; i++) {
			int[] c = p.cells().get(i);
			if (c.length == 0) {
				m.remove(p.keys()[i]);
				continue;
			}
			long[] bits = new long[64];
			for (int idx : c) {
				bits[idx >> 6] |= 1L << (idx & 63);
			}
			m.put(p.keys()[i], bits);
		}
	}

	/** Whether (x, y, z) in {@code dimension} is a road surface cell the server told this client about. */
	public static boolean road(String dimension, int x, int y, int z) {
		Long2ObjectOpenHashMap<long[]> m = BY_DIM.get(dimension);
		if (m == null || m.isEmpty()) {
			return false;
		}
		long[] bits = m.get(Sections.key(x >> 4, y >> 4, z >> 4));
		int i = (y & 15) << 8 | (z & 15) << 4 | x & 15;
		return bits != null && (bits[i >> 6] & 1L << (i & 63)) != 0;
	}

	/** How many road sections this client knows (DevBridge). */
	public static int sections() {
		return BY_DIM.values().stream().mapToInt(Map::size).sum();
	}
}
