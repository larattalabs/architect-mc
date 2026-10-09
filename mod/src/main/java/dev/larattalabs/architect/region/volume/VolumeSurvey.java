package dev.larattalabs.architect.region.volume;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Volume;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.region.ChunkGen;
import dev.larattalabs.architect.region.RegionStore;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * {@code Survey.volume} (docs/CONTRACT.md phase 6b §5): a box's cells classified, sliced on the server thread under the survey
 * budget (4a's {@code SurveyImpl.BUDGET_NANOS}, shared with {@code Survey.sample}: one chunk column at a time), reading section
 * palettes (a single-valued section costs one lookup; a section whose palette is all one class is filled without reading its
 * cells), then encoded (ARVX), gzipped, sha'd and frozen off the server thread:
 * <ul>
 * <li>MISSING: a chunk not read under the load policy (LOADED_ONLY: not loaded; GENERATED_ONLY(n): never generated, or past
 * the bound; LOAD_BOUNDED(n): past the bound);</li>
 * <li>OWNED: the top active journal entry's cell (guard {@code leaves} entries don't count), the entry id in the side table;</li>
 * <li>BLOCK_ENTITY: a block whose state has a block entity;</li>
 * <li>else {@link VoxelTable}'s class (not listed: PLAYER).</li>
 * </ul>
 * Cells outside the world's build height are AIR. Server thread except the encode.
 */
public final class VolumeSurvey {
	/**
	 * The most cells one volume (and one region's volumes together) may hold (CONTRACT §5 "16M cells per region (est.)"; gate item
	 * 7 measures the rate and bytes and sets the final value). {@code -Darchitect.volumeMaxCells} overrides it for measurements.
	 */
	public static final long MAX_CELLS = Long.getLong("architect.volumeMaxCells", 16_000_000L);
	/** Where standalone volumes freeze: {@code <world>/architect/volumes/<sha>.bin}. */
	public static final String STANDALONE_DIR = "architect/volumes";

	private static final List<Task> TASKS = new ArrayList<>();
	private static final ExecutorService ENCODE = Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect volume encode");
		t.setDaemon(true);
		return t;
	});

	/** Measurements of the last finished volume (DevBridge {@code dev.survey.volume}). */
	public record Measure(long cells, double ms, int ticks, double maxTickMs, double sampleMs, int bytes, double bytesPerCell, String file,
		int chunksLoaded) {
	}

	/** A finished volume: the API view, the uncompressed and frozen sizes, the file, the measurements. */
	public record Result(Volume volume, byte[] gz, Path file, Measure measure) {
	}

	private static final class Task {
		final ServerLevel level;
		final int[] box;
		final LoadPolicy load;
		final Path dir;
		final CompletableFuture<Result> future = new CompletableFuture<>();
		final int w;
		final int d;
		final int h;
		/** Class ordinal per cell: index ((x - minX) * d + (z - minZ)) * h + (y - minY). */
		final byte[] cells;
		/** OWNED cells: cell index -> entry id. */
		final Map<Integer, String> owners = new HashMap<>();
		final boolean[] missingCol;
		final List<Long> chunks = new ArrayList<>();
		int next;
		int loaded;
		boolean queried;
		final long started = System.nanoTime();
		long sampleNanos;
		int ticks;
		long maxTick;

		Task(ServerLevel level, int[] box, LoadPolicy load, Path dir) {
			this.level = level;
			this.box = box;
			this.load = load;
			this.dir = dir;
			w = box[3] - box[0] + 1;
			d = box[5] - box[2] + 1;
			h = box[4] - box[1] + 1;
			cells = new byte[Math.toIntExact((long) w * d * h)];
			missingCol = new boolean[w * d];
			for (int cx = box[0] >> 4; cx <= box[3] >> 4; cx++) {
				for (int cz = box[2] >> 4; cz <= box[5] >> 4; cz++) {
					chunks.add(ChunkPos.pack(cx, cz));
				}
			}
		}

		int idx(int x, int y, int z) {
			return ((x - box[0]) * d + (z - box[2])) * h + (y - box[1]);
		}
	}

	private VolumeSurvey() {
	}

	public static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
			for (Task t : TASKS) {
				t.future.completeExceptionally(new IllegalStateException("the world closed"));
			}
			TASKS.clear();
		});
	}

	/** The cells of a box. */
	public static long cells(BoundingBox b) {
		return (long) b.getXSpan() * b.getYSpan() * b.getZSpan();
	}

	/**
	 * Starts a volume of {@code box} frozen into {@code dir} ({@code <dir>/<sha>.bin}; null: the standalone dir). Any thread: it
	 * starts on the server thread.
	 */
	public static CompletableFuture<Result> start(ServerLevel level, BoundingBox box, LoadPolicy load, @Nullable Path dir) {
		if (cells(box) > MAX_CELLS) {
			return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.RegionRefused(Reason.REGION_LIMIT, "the volume is " + cells(box)
				+ " cells (at most " + MAX_CELLS + ")"));
		}
		MinecraftServer s = level.getServer();
		Path out = dir != null ? dir : s.getWorldPath(LevelResource.ROOT).resolve(STANDALONE_DIR);
		Task t = new Task(level, new int[] {box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ()}, load == null ? LoadPolicy.LOADED_ONLY
			: load, out);
		Runnable add = () -> TASKS.add(t);
		if (s.isSameThread()) {
			add.run();
		} else {
			s.execute(add);
		}
		return t.future;
	}

	public static boolean busy() {
		return !TASKS.isEmpty();
	}

	/** Called from the survey tick with the tick's remaining budget: reads chunk columns until {@code end}. Server thread. */
	public static void step(long end) {
		while (!TASKS.isEmpty() && System.nanoTime() < end) {
			Task t = TASKS.get(0);
			long t0 = System.nanoTime();
			try {
				if (!t.queried && !ready(t)) {
					t.ticks++;
					return; // GENERATED_ONLY: chunk status answers pending
				}
				while (t.next < t.chunks.size() && System.nanoTime() < end) {
					readChunk(t, t.chunks.get(t.next++));
				}
			} catch (RuntimeException e) {
				TASKS.remove(0);
				Architect.LOGGER.warn("Volume survey failed", e);
				t.future.completeExceptionally(e);
				continue;
			}
			long dt = System.nanoTime() - t0;
			t.sampleNanos += dt;
			t.ticks++;
			t.maxTick = Math.max(t.maxTick, dt);
			if (t.next >= t.chunks.size()) {
				TASKS.remove(0);
				finish(t);
			}
		}
	}

	/** GENERATED_ONLY: every unloaded chunk's generated status known (queried off the server thread, as Prepare does). */
	private static boolean ready(Task t) {
		if (t.load.generates() || !t.load.loads()) {
			t.queried = true;
			return true;
		}
		boolean all = true;
		for (long ck : t.chunks) {
			if (t.level.getChunkSource().getChunkNow(ChunkPos.getX(ck), ChunkPos.getZ(ck)) != null) {
				continue;
			}
			if (ChunkGen.state(t.level, ck) == ChunkGen.State.UNKNOWN) {
				ChunkGen.query(t.level, ck);
				all = false;
			}
		}
		t.queried = all;
		return all;
	}

	private static void readChunk(Task t, long ck) {
		int cx = ChunkPos.getX(ck);
		int cz = ChunkPos.getZ(ck);
		ServerLevel level = t.level;
		LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
		if (chunk == null && t.load.loads() && t.loaded < t.load.maxChunks() && (t.load.generates() || ChunkGen.state(level, ck)
			== ChunkGen.State.GENERATED)) {
			chunk = level.getChunk(cx, cz); // a short-lived ticket only (as Survey.sample)
			t.loaded++;
		}
		int x0 = Math.max(t.box[0], cx << 4);
		int x1 = Math.min(t.box[3], (cx << 4) + 15);
		int z0 = Math.max(t.box[2], cz << 4);
		int z1 = Math.min(t.box[5], (cz << 4) + 15);
		if (chunk == null) {
			for (int x = x0; x <= x1; x++) {
				for (int z = z0; z <= z1; z++) {
					t.missingCol[(x - t.box[0]) * t.d + (z - t.box[2])] = true;
					int base = t.idx(x, t.box[1], z);
					java.util.Arrays.fill(t.cells, base, base + t.h, (byte) VoxelClass.MISSING.ordinal());
				}
			}
			return;
		}
		VoxelTable table = VoxelTable.get();
		IdentityHashMap<BlockState, Byte> memo = new IdentityHashMap<>();
		int minY = level.getMinY();
		int maxY = level.getMaxY();
		int y0 = t.box[1];
		int y1 = t.box[4];
		for (int sy = y0 >> 4; sy <= y1 >> 4; sy++) {
			int ya = Math.max(y0, sy << 4);
			int yb = Math.min(y1, (sy << 4) + 15);
			byte uniform;
			LevelChunkSection sec = null;
			if (yb < minY || ya > maxY) {
				uniform = (byte) VoxelClass.AIR.ordinal();
			} else {
				sec = chunk.getSection(chunk.getSectionIndexFromSectionY(sy));
				uniform = uniformClass(sec, table, memo);
			}
			if (uniform >= 0) {
				for (int x = x0; x <= x1; x++) {
					for (int z = z0; z <= z1; z++) {
						int base = t.idx(x, ya, z);
						java.util.Arrays.fill(t.cells, base, base + (yb - ya + 1), uniform);
					}
				}
				continue;
			}
			for (int x = x0; x <= x1; x++) {
				for (int z = z0; z <= z1; z++) {
					int base = t.idx(x, ya, z);
					for (int y = ya; y <= yb; y++) {
						t.cells[base + (y - ya)] = classOf(sec.getBlockState(x & 15, y & 15, z & 15), table, memo);
					}
				}
			}
		}
		owned(t, x0, z0, x1, z1);
	}

	/** One class for the whole section (single-valued, all air, or every palette entry of one class), else -1. */
	static byte uniformClass(LevelChunkSection sec, VoxelTable table, IdentityHashMap<BlockState, Byte> memo) {
		if (sec.hasOnlyAir()) {
			return (byte) VoxelClass.AIR.ordinal();
		}
		var states = sec.getStates();
		if (states.bitsPerEntry() == 0) {
			return classOf(sec.getBlockState(0, 0, 0), table, memo);
		}
		byte[] one = {-2};
		states.forEachInPalette(st -> {
			byte c = classOf(st, table, memo);
			if (one[0] == -2) {
				one[0] = c;
			} else if (one[0] != c) {
				one[0] = -1;
			}
		});
		return one[0] < 0 ? -1 : one[0];
	}

	static byte classOf(BlockState s, VoxelTable table, IdentityHashMap<BlockState, Byte> memo) {
		Byte c = memo.get(s);
		if (c == null) {
			VoxelClass v = s.hasBlockEntity() ? VoxelClass.BLOCK_ENTITY : s.isAir() ? VoxelClass.AIR : table.of(s.getBlock());
			c = (byte) v.ordinal();
			memo.put(s, c);
		}
		return c;
	}

	/** OWNED: the top active entry (by layer) of each journal cell in the columns, guard leaves excluded. */
	private static void owned(Task t, int x0, int z0, int x1, int z1) {
		JournalStore store = WorldJournal.storeOrNull();
		if (store == null) {
			return;
		}
		String dim = dev.larattalabs.architect.site.Sites.dimensionId(t.level);
		for (int sy = t.box[1] >> 4; sy <= t.box[4] >> 4; sy++) {
			long key = Sections.key(x0 >> 4, sy, z0 >> 4);
			List<String> ids = store.inSection(dim, key);
			if (ids.isEmpty()) {
				continue;
			}
			Map<Integer, long[]> top = new HashMap<>(); // cell index in section -> {layer}
			Map<Integer, String> topId = new HashMap<>();
			for (String id : ids) {
				JournalStore.Meta m = store.meta(id);
				if (m == null || !m.active() || WorldJournal.LEAVES.equals(m.kind())) {
					continue;
				}
				SectionCells sc;
				try {
					sc = store.section(id, key);
				} catch (IOException e) {
					continue;
				}
				if (sc == null) {
					continue;
				}
				for (int k = 0; k < sc.size(); k++) {
					int i = sc.index(k);
					long layer = sc.layer(k);
					long[] have = top.get(i);
					if (have == null || layer > have[0] || layer == have[0] && id.compareTo(topId.get(i)) > 0) {
						top.put(i, new long[] {layer});
						topId.put(i, id);
					}
				}
			}
			for (Map.Entry<Integer, String> e : topId.entrySet()) {
				long pos = Sections.pos(key, e.getKey());
				int x = dev.larattalabs.architect.journal.Journal.x(pos);
				int y = dev.larattalabs.architect.journal.Journal.y(pos);
				int z = dev.larattalabs.architect.journal.Journal.z(pos);
				if (x < x0 || x > x1 || z < z0 || z > z1 || y < t.box[1] || y > t.box[4]) {
					continue;
				}
				int ci = t.idx(x, y, z);
				t.cells[ci] = (byte) VoxelClass.OWNED.ordinal();
				t.owners.put(ci, e.getValue());
			}
		}
	}

	/** Off the server thread: encode, gzip, sha, stats, freeze (write, fsync, rename, read back, sha). */
	private static void finish(Task t) {
		CompletableFuture.supplyAsync(() -> {
			try {
				return encodeAndFreeze(t);
			} catch (IOException e) {
				throw new java.util.concurrent.CompletionException(e);
			}
		}, ENCODE).whenComplete((r, e) -> {
			if (e != null) {
				t.future.completeExceptionally(e.getCause() != null ? e.getCause() : e);
			} else {
				t.future.complete(r);
			}
		});
	}

	private static Result encodeAndFreeze(Task t) throws IOException {
		Encoded enc = encode(t.box, t.cells, t.owners, t.missingCol);
		byte[] gz = Arvx.gzip(enc.raw);
		Path file = t.dir.resolve(enc.sha + ".bin");
		freeze(file, gz, enc.sha);
		long cells = (long) t.w * t.d * t.h;
		double ms = (System.nanoTime() - t.started) / 1e6;
		Measure m = new Measure(cells, ms, t.ticks, t.maxTick / 1e6, t.sampleNanos / 1e6, gz.length, gz.length / (double) cells, file.toString(), t.loaded);
		Volume v = new Volume(enc.sha, new BoundingBox(t.box[0], t.box[1], t.box[2], t.box[3], t.box[4], t.box[5]), "local:" + enc.sha, enc.counts,
			enc.missingColumns, enc.stats);
		return new Result(v, gz, file, m);
	}

	/**
	 * Writes a frozen volume: write, fsync, atomic rename, read back, gunzip, sha check. A file already there whose content checks
	 * out is kept (never rewritten).
	 */
	public static void freeze(Path file, byte[] gz, String sha) throws IOException {
		if (Files.isRegularFile(file)) {
			try {
				if (Arvx.sha256(Arvx.gunzip(Files.readAllBytes(file))).equals(sha)) {
					return;
				}
			} catch (IOException e) {
				// a bad file: written again below
			}
		}
		RegionStore.write(file, gz);
		byte[] back = Files.readAllBytes(file);
		if (!Arvx.sha256(Arvx.gunzip(back)).equals(sha)) {
			throw new IOException("read-back of " + file + " does not hash to " + sha);
		}
	}

	/** The encoded volume: the ARVX bytes, sha, counts per class, missing columns, stats. */
	public record Encoded(byte[] raw, String sha, Map<VoxelClass, Long> counts, int missingColumns, Volume.Stats stats) {
	}

	/** Pure: cells (index ((x * d) + z) * h + y, box-relative) -> ARVX + stats. */
	public static Encoded encode(int[] box, byte[] cells, Map<Integer, String> owners, boolean[] missingCol) {
		int w = box[3] - box[0] + 1;
		int d = box[5] - box[2] + 1;
		int h = box[4] - box[1] + 1;
		Arvx.Encoder e = new Arvx.Encoder(box);
		byte[] col = new byte[h];
		String[] own = new String[h];
		int missing = 0;
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < d; k++) {
				int c = i * d + k;
				if (missingCol[c]) {
					missing++;
					e.uniform(VoxelClass.MISSING);
					continue;
				}
				System.arraycopy(cells, c * h, col, 0, h);
				boolean anyOwned = false;
				for (int y = 0; y < h; y++) {
					if (col[y] == VoxelClass.OWNED.ordinal()) {
						own[y] = owners.get(c * h + y);
						anyOwned = true;
					}
				}
				e.column(col, anyOwned ? own : null);
				if (anyOwned) {
					java.util.Arrays.fill(own, null);
				}
			}
		}
		byte[] raw = e.finish();
		long[] cnt = e.counts();
		Map<VoxelClass, Long> counts = new java.util.EnumMap<>(VoxelClass.class);
		for (VoxelClass v : VoxelClass.values()) {
			counts.put(v, cnt[v.ordinal()]);
		}
		return new Encoded(raw, Arvx.sha256(raw), counts, missing, stats(w, d, h, cells, missingCol));
	}

	static boolean terrainSolid(int c) {
		return c == VoxelClass.ROCK.ordinal() || c == VoxelClass.SOIL.ordinal() || c == VoxelClass.LOOSE.ordinal() || c == VoxelClass.ICE.ordinal()
			|| c == VoxelClass.SNOW.ordinal();
	}

	/** Steward S-6b-6's summary numbers ({@link Volume.Stats}). Pure. */
	public static Volume.Stats stats(int w, int d, int h, byte[] cells, boolean[] missingCol) {
		int[] surface = new int[w * d];
		java.util.Arrays.fill(surface, -1);
		long tree = 0;
		long cave = 0;
		int overhang = 0;
		int surfaced = 0;
		int depth = Volume.Stats.OVERHANG_DEPTH;
		for (int c = 0; c < w * d; c++) {
			if (missingCol[c]) {
				continue;
			}
			int base = c * h;
			for (int y = 0; y < h; y++) {
				int v = cells[base + y];
				if (v == VoxelClass.LOG.ordinal() || v == VoxelClass.LEAVES.ordinal()) {
					tree++;
				}
			}
			int s = -1;
			for (int y = h - 1; y >= 0; y--) {
				if (terrainSolid(cells[base + y])) {
					s = y;
					break;
				}
			}
			surface[c] = s;
			if (s < 0) {
				continue;
			}
			surfaced++;
			boolean gap = false;
			for (int y = s - 1; y >= 0; y--) {
				int v = cells[base + y];
				if (!terrainSolid(v) && v != VoxelClass.OWNED.ordinal() && v != VoxelClass.PLAYER.ordinal() && v != VoxelClass.BLOCK_ENTITY.ordinal()) {
					if (y >= s - depth) {
						gap = true;
					} else if (v == VoxelClass.AIR.ordinal()) {
						cave++;
					}
				}
			}
			overhang += gap ? 1 : 0;
		}
		long slopeSum = 0;
		int steep = 0;
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < d; k++) {
				int s = surface[i * d + k];
				if (s < 0) {
					continue;
				}
				int m = 0;
				int[][] nb = {{i - 1, k}, {i + 1, k}, {i, k - 1}, {i, k + 1}};
				for (int[] n : nb) {
					if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= d) {
						continue;
					}
					int o = surface[n[0] * d + n[1]];
					if (o >= 0) {
						m = Math.max(m, Math.abs(o - s));
					}
				}
				slopeSum += m;
				steep += m >= Volume.Stats.STEEP ? 1 : 0;
			}
		}
		double n = Math.max(1, surfaced);
		return new Volume.Stats(surfaced, surfaced == 0 ? 0 : slopeSum / n, surfaced == 0 ? 0 : steep / n, surfaced == 0 ? 0 : overhang / n, tree, cave);
	}
}
