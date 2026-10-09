package dev.larattalabs.architect.region;

import dev.larattalabs.architect.Architect;
import it.unimi.dsi.fastutil.longs.Long2ByteOpenHashMap;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.visitors.CollectFields;
import net.minecraft.nbt.visitors.FieldSelector;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.status.ChunkStatus;

/**
 * Whether a chunk was ever fully generated, without loading it (phase 6a, CONTRACT "Knowing a chunk is generated without
 * loading it"; verified on 26.3, artifacts/gate6a/chunkstatus.md):
 * <ol>
 * <li>in memory: {@code ChunkMap.getLatestStatus(key)} is {@code FULL} (a chunk being generated or loaded right now that has
 * not reached FULL falls through to the disk);</li>
 * <li>on disk: the chunk's {@code Status} field read with the IO worker's {@code scanChunk} and a {@link CollectFields}
 * visitor that stops after the one field. {@code IOWorker.scanChunk} answers from a pending (unsaved) store first, so a chunk
 * generated and unloaded but not yet written is seen too. A region file's location table alone is not enough: a FULL chunk's
 * neighbours are saved as proto chunks at partial statuses (structure starts .. initialize_light).</li>
 * </ol>
 * Answers are cached per dimension: GENERATED for good (a chunk never goes back), NOT_GENERATED until {@link #forget} (prepare
 * generates it) or a re-query. Lookups on the server thread never block: an unknown chunk answers {@link State#UNKNOWN} and
 * starts a scan off the server thread. Measured cost: see {@link #stats()}.
 */
public final class ChunkGen {
	public enum State { GENERATED, NOT_GENERATED, UNKNOWN }

	private static final byte YES = 1;
	private static final byte NO = 2;
	private static final byte PENDING = 3;
	private static final Map<String, Long2ByteOpenHashMap> CACHE = new HashMap<>();
	/** Scan answers, applied on the server thread (the cache is the server thread's). */
	private static final ConcurrentLinkedQueue<Object[]> ANSWERS = new ConcurrentLinkedQueue<>();
	private static final AtomicLong SCANS = new AtomicLong();
	private static final AtomicLong SCAN_NANOS = new AtomicLong();

	private ChunkGen() {
	}

	/** The state of one chunk now; UNKNOWN starts a scan (call again a tick later). Server thread. */
	public static State state(ServerLevel level, long chunk) {
		drain();
		String dim = dev.larattalabs.architect.site.Sites.dimensionId(level);
		Long2ByteOpenHashMap m = CACHE.computeIfAbsent(dim, d -> new Long2ByteOpenHashMap());
		byte b = m.get(chunk);
		if (b == YES) {
			return State.GENERATED;
		}
		ChunkStatus s = level.getChunkSource().chunkMap.getLatestStatus(chunk);
		if (s == ChunkStatus.FULL) {
			m.put(chunk, YES);
			return State.GENERATED;
		}
		if (b == NO) {
			return State.NOT_GENERATED;
		}
		if (b == PENDING) {
			return State.UNKNOWN;
		}
		m.put(chunk, PENDING);
		scan(level, dim, chunk);
		return State.UNKNOWN;
	}

	/** The same, off the server thread, as a future (for prepare's bookkeeping and the DevBridge's measurement). */
	public static CompletableFuture<Boolean> query(ServerLevel level, long chunk) {
		long t0 = System.nanoTime();
		CollectFields f = new CollectFields(new FieldSelector(StringTag.TYPE, "Status"));
		return level.getChunkSource().chunkMap.chunkScanner().scanChunk(ChunkPos.unpack(chunk), f).thenApply(v -> {
			SCANS.incrementAndGet();
			SCAN_NANOS.addAndGet(System.nanoTime() - t0);
			return f.getResult() instanceof CompoundTag t && "minecraft:full".equals(t.getStringOr("Status", ""));
		});
	}

	private static void scan(ServerLevel level, String dim, long chunk) {
		query(level, chunk).whenComplete((yes, ex) -> {
			if (ex != null) {
				Architect.LOGGER.warn("Could not read the status of chunk {} in {}: {}", ChunkPos.unpack(chunk), dim, ex.toString());
			}
			ANSWERS.add(new Object[] {dim, chunk, ex == null && Boolean.TRUE.equals(yes)});
		});
	}

	private static void drain() {
		Object[] a;
		while ((a = ANSWERS.poll()) != null) {
			Long2ByteOpenHashMap m = CACHE.computeIfAbsent((String) a[0], d -> new Long2ByteOpenHashMap());
			long c = (Long) a[1];
			if (m.get(c) != YES) {
				m.put(c, (Boolean) a[2] ? YES : NO);
			}
		}
	}

	/** Forget a NOT_GENERATED answer (prepare made the chunk, or something else may have). */
	public static void forget(ServerLevel level, long chunk) {
		Long2ByteOpenHashMap m = CACHE.get(dev.larattalabs.architect.site.Sites.dimensionId(level));
		if (m != null && m.get(chunk) != YES) {
			m.remove(chunk);
		}
	}

	/** Mark a chunk generated (a chunk that reached FULL by generation or load). */
	public static void generated(String dimension, long chunk) {
		CACHE.computeIfAbsent(dimension, d -> new Long2ByteOpenHashMap()).put(chunk, YES);
	}

	/** {scans, mean microseconds per scan} since the world started. */
	public static double[] stats() {
		long n = SCANS.get();
		return new double[] {n, n == 0 ? 0 : SCAN_NANOS.get() / 1e3 / n};
	}

	public static void reset() {
		CACHE.clear();
		ANSWERS.clear();
		SCANS.set(0);
		SCAN_NANOS.set(0);
	}
}
