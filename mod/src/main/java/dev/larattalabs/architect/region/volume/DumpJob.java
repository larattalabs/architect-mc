package dev.larattalabs.architect.region.volume;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.region.RegionStore;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * DevBridge {@code dev.region.dump}: the ARWD file of a box (the realised world for the scenario metrics), read one chunk column
 * per slice on the server thread (3 ms a tick), unloaded chunks read as air with light 0 and counted; encoded, gzipped and
 * written (fsync, rename) off the thread. Dev only.
 */
public final class DumpJob {
	public static final long BUDGET_NANOS = 3_000_000L;
	/** The most cells one dump may hold. */
	public static final long MAX_CELLS = 64_000_000L;
	private static final List<DumpJob> JOBS = new ArrayList<>();

	final ServerLevel level;
	final int[] box;
	final boolean light;
	final Path file;
	final CompletableFuture<Map<String, Object>> future = new CompletableFuture<>();
	final int w;
	final int d;
	final int h;
	final int[] cells;
	final byte @org.jspecify.annotations.Nullable [] lights;
	final List<String> palette = new ArrayList<>();
	final Map<String, Integer> index = new HashMap<>();
	final IdentityHashMap<BlockState, Integer> memo = new IdentityHashMap<>();
	final List<Long> chunks = new ArrayList<>();
	int next;
	int unloaded;
	int ticks;
	long maxTick;
	final long started = System.nanoTime();

	DumpJob(ServerLevel level, int[] box, boolean light, Path file) {
		this.level = level;
		this.box = box;
		this.light = light;
		this.file = file;
		w = box[3] - box[0] + 1;
		d = box[5] - box[2] + 1;
		h = box[4] - box[1] + 1;
		cells = new int[Math.toIntExact((long) w * d * h)];
		lights = light ? new byte[cells.length] : null;
		for (int cx = box[0] >> 4; cx <= box[3] >> 4; cx++) {
			for (int cz = box[2] >> 4; cz <= box[5] >> 4; cz++) {
				chunks.add(ChunkPos.pack(cx, cz));
			}
		}
		idx("minecraft:air");
	}

	public static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(s -> step());
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
			JOBS.forEach(j -> j.future.completeExceptionally(new IllegalStateException("the world closed")));
			JOBS.clear();
		});
	}

	/** Starts a dump; completes with {file, cells, bytes, palette, ms, ticks, maxTickMs, unloadedChunks}. Server thread. */
	public static CompletableFuture<Map<String, Object>> start(ServerLevel level, int[] box, boolean light, Path file) {
		long n = (long) (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
		if (n > MAX_CELLS || n <= 0) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("the dump is " + n + " cells (1.." + MAX_CELLS + ")"));
		}
		DumpJob j = new DumpJob(level, box, light, file);
		JOBS.add(j);
		return j.future;
	}

	int idx(String s) {
		Integer i = index.get(s);
		if (i == null) {
			i = palette.size();
			palette.add(s);
			index.put(s, i);
		}
		return i;
	}

	private static void step() {
		if (JOBS.isEmpty()) {
			return;
		}
		long end = System.nanoTime() + BUDGET_NANOS;
		DumpJob j = JOBS.get(0);
		long t0 = System.nanoTime();
		try {
			while (j.next < j.chunks.size() && System.nanoTime() < end) {
				j.read(j.chunks.get(j.next++));
			}
		} catch (RuntimeException e) {
			JOBS.remove(0);
			j.future.completeExceptionally(e);
			return;
		}
		j.ticks++;
		j.maxTick = Math.max(j.maxTick, System.nanoTime() - t0);
		if (j.next >= j.chunks.size()) {
			JOBS.remove(0);
			CompletableFuture.runAsync(j::finish);
		}
	}

	private void read(long ck) {
		LevelChunk c = level.getChunkSource().getChunkNow(ChunkPos.getX(ck), ChunkPos.getZ(ck));
		int cx = ChunkPos.getX(ck);
		int cz = ChunkPos.getZ(ck);
		int x0 = Math.max(box[0], cx << 4);
		int x1 = Math.min(box[3], (cx << 4) + 15);
		int z0 = Math.max(box[2], cz << 4);
		int z1 = Math.min(box[5], (cz << 4) + 15);
		if (c == null) {
			unloaded++;
			return; // air (index 0), light 0
		}
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		for (int x = x0; x <= x1; x++) {
			for (int z = z0; z <= z1; z++) {
				int base = ((x - box[0]) * d + (z - box[2])) * h;
				for (int y = box[1]; y <= box[4]; y++) {
					mp.set(x, y, z);
					BlockState s = c.getBlockState(mp);
					Integer k = memo.get(s);
					if (k == null) {
						k = idx(BlockStateParser.serialize(s));
						memo.put(s, k);
					}
					cells[base + (y - box[1])] = k;
					if (lights != null) {
						lights[base + (y - box[1])] = (byte) level.getBrightness(LightLayer.BLOCK, mp);
					}
				}
			}
		}
	}

	private void finish() {
		try {
			byte[] raw = Arwd.encode(box, palette, cells, lights);
			byte[] gz = Arvx.gzip(raw);
			RegionStore.write(file, gz);
			Map<String, Object> o = new java.util.LinkedHashMap<>();
			o.put("file", file.toString());
			o.put("cells", (long) cells.length);
			o.put("bytes", gz.length);
			o.put("rawBytes", raw.length);
			o.put("sha", Arvx.sha256(raw));
			o.put("palette", palette.size());
			o.put("light", light);
			o.put("unloadedChunks", unloaded);
			o.put("ms", (System.nanoTime() - started) / 1e6);
			o.put("ticks", ticks);
			o.put("maxTickMs", maxTick / 1e6);
			future.complete(o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Dump failed", e);
			future.completeExceptionally(e);
		}
	}
}
