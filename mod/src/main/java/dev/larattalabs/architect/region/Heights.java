package dev.larattalabs.architect.region;

import dev.larattalabs.architect.Architect;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * The frozen pre-region heightfield (CONTRACT D3, §3 "Streaming" step 1): one {@code ARSV} shard per tile
 * ({@code heights/<tx>.<tz>.bin}, the tile's own 64x64 columns). A column is surveyed once, the first time a window that needs
 * it is frozen, and written to the shard of the tile that owns it before any region write can touch it (H0: write, fsync,
 * rename, read back). A column, once frozen, never changes. Shards are written on one I/O thread, one freeze at a time.
 */
public final class Heights {
	public static final int TILE = 64;
	public static final int MARGIN = 8;
	public static final int WINDOW = TILE + 2 * MARGIN;
	private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect heights");
		t.setDaemon(true);
		return t;
	});
	/** region id -> tile key -> shard (loaded or new). Server thread. */
	private static final Map<String, Map<Long, Columns>> SHARDS = new HashMap<>();

	private Heights() {
	}

	static long key(int tx, int tz) {
		return (long) tx << 32 | tz & 0xffffffffL;
	}

	/** The shard of tile (tx, tz): from disk, else a new one with every column missing. */
	public static Columns shard(Path world, String region, int tx, int tz) {
		Map<Long, Columns> m = SHARDS.computeIfAbsent(region, r -> new HashMap<>());
		Columns c = m.get(key(tx, tz));
		if (c == null) {
			try {
				byte[] a = RegionStore.read(RegionStore.shard(world, region, tx, tz));
				c = a == null ? new Columns(TILE * tx, TILE * tz, TILE, TILE, 1) : Columns.decode(a);
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Region {}: heights shard {},{} unreadable ({}); surveyed again", region, tx, tz, e.toString());
				c = new Columns(TILE * tx, TILE * tz, TILE, TILE, 1);
			}
			m.put(key(tx, tz), c);
		}
		return c;
	}

	/** Columns (x, z) of [x0..x1] x [z0..z1] that are not frozen yet. */
	public static int missing(Path world, String region, int x0, int z0, int x1, int z1) {
		int n = 0;
		for (int tx = Math.floorDiv(x0, TILE); tx <= Math.floorDiv(x1, TILE); tx++) {
			for (int tz = Math.floorDiv(z0, TILE); tz <= Math.floorDiv(z1, TILE); tz++) {
				Columns s = shard(world, region, tx, tz);
				for (int x = Math.max(x0, TILE * tx); x <= Math.min(x1, TILE * tx + TILE - 1); x++) {
					for (int z = Math.max(z0, TILE * tz); z <= Math.min(z1, TILE * tz + TILE - 1); z++) {
						if (s.missing(s.at(x, z))) {
							n++;
						}
					}
				}
			}
		}
		return n;
	}

	/** A tile's window (80x80), assembled from its shards; null when a column is still missing. */
	public static @Nullable Columns window(Path world, String region, int tx, int tz) {
		Columns w = new Columns(TILE * tx - MARGIN, TILE * tz - MARGIN, WINDOW, WINDOW, 1);
		for (int sx = tx - 1; sx <= tx + 1; sx++) {
			for (int sz = tz - 1; sz <= tz + 1; sz++) {
				w.copyFrom(shard(world, region, sx, sz));
			}
		}
		return w.missingCount() == 0 ? w : null;
	}

	/**
	 * Freezes the not-yet-frozen columns of a box (a tile's window, or a lot or road's box + 8), over ticks. {@link #step}
	 * surveys from loaded chunks until the deadline; then the touched shards are written off the server thread.
	 */
	public static final class Freeze {
		private final Path world;
		private final String region;
		private final int x0;
		private final int z0;
		private final int x1;
		private final int z1;
		private int cx;
		private int cz;
		private final Set<Long> touched = new LinkedHashSet<>();
		private @Nullable CompletableFuture<Void> writing;
		private boolean surveyed;
		public int columns;

		public Freeze(Path world, String region, int x0, int z0, int x1, int z1) {
			this.world = world;
			this.region = region;
			this.x0 = x0;
			this.z0 = z0;
			this.x1 = x1;
			this.z1 = z1;
			this.cx = x0 >> 4;
			this.cz = z0 >> 4;
		}

		/** The chunks it reads. */
		public List<Long> chunks() {
			List<Long> out = new ArrayList<>();
			for (int x = x0 >> 4; x <= x1 >> 4; x++) {
				for (int z = z0 >> 4; z <= z1 >> 4; z++) {
					out.add(net.minecraft.world.level.ChunkPos.pack(x, z));
				}
			}
			return out;
		}

		/**
		 * Surveys chunk by chunk until {@code deadline}. Returns 1 when frozen and written (H0), 0 to call again, -1 when a chunk is
		 * not loaded (the caller waits), -2 when the shard write failed.
		 */
		public int step(ServerLevel level, long deadline) {
			if (writing != null) {
				if (!writing.isDone()) {
					return 0;
				}
				return writing.isCompletedExceptionally() ? -2 : 1;
			}
			while (!surveyed) {
				LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
				if (c == null) {
					return -1;
				}
				int bx0 = Math.max(x0, cx << 4);
				int bx1 = Math.min(x1, (cx << 4) + 15);
				int bz0 = Math.max(z0, cz << 4);
				int bz1 = Math.min(z1, (cz << 4) + 15);
				for (int x = bx0; x <= bx1; x++) {
					for (int z = bz0; z <= bz1; z++) {
						int tx = Math.floorDiv(x, TILE);
						int tz = Math.floorDiv(z, TILE);
						Columns s = shard(world, region, tx, tz);
						int k = s.at(x, z);
						if (s.missing(k)) {
							s.survey(k, c, x, z);
							touched.add(key(tx, tz));
							columns++;
						}
					}
				}
				cz++;
				if (cz > z1 >> 4) {
					cz = z0 >> 4;
					cx++;
					if (cx > x1 >> 4) {
						surveyed = true;
						break;
					}
				}
				if (System.nanoTime() >= deadline) {
					return 0;
				}
			}
			if (touched.isEmpty()) {
				return 1;
			}
			Map<Path, byte[]> out = new HashMap<>();
			for (long k : touched) {
				int tx = (int) (k >> 32);
				int tz = (int) k;
				out.put(RegionStore.shard(world, region, tx, tz), shard(world, region, tx, tz).encode());
			}
			writing = CompletableFuture.runAsync(() -> {
				for (var e : out.entrySet()) {
					try {
						RegionStore.writeChecked(e.getKey(), e.getValue());
					} catch (IOException ex) {
						throw new java.io.UncheckedIOException(ex);
					}
				}
			}, IO);
			return 0;
		}
	}

	/** A world stop or a region removed: the cache goes (the files stay with the region). */
	public static void forget(@Nullable String region) {
		if (region == null) {
			SHARDS.clear();
		} else {
			SHARDS.remove(region);
		}
	}
}
