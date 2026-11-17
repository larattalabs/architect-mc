package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.jspecify.annotations.Nullable;

/**
 * (slice T0 review P1-3; TXN review 3 item 5) A chunk (or entity, or POI) save that failed stays <b>owed</b> until a later write of the same
 * chunk to the same storage succeeds. Vanilla forgets it: {@code ChunkMap.save} marks the chunk saved before it serializes it, and
 * {@code IOWorker} drops the pending write before it runs it, so a failure leaves no dirty chunk, no pending future and no uncovered region
 * write. The mixins ({@code ChunkDebtMixin}, {@code IOWorkerDebtMixin}, {@code ChunkSaveFailMixin}) only report here:
 * <ul>
 * <li>a failed region write ({@code IOWorker.runStore}) keeps its snapshot and a way to submit it again: {@link #retry} resubmits it at the head
 * of every barrier's chunk step, and a load of that chunk is served the snapshot ({@link #snapshot}), never the older file;</li>
 * <li>a failed serialization ({@code MinecraftServer.reportChunkSaveFailure}, which every storage reports to) has no snapshot: the loaded chunk
 * is marked unsaved again, so the barrier's flushed save rewrites it;</li>
 * <li>{@link #owed} is not empty: the barrier refuses (no ledger over a chunk the disk does not hold).</li>
 * </ul>
 * Known limit: a chunk whose <i>serialization</i> failed and that unloads before the next barrier has no snapshot and is not in memory: when it
 * loads again from the older file its debt turns stale (every barrier refuses, logged) until an operator clears it. Any thread; the world's
 * state is forgotten when it closes.
 */
public final class ChunkDebt {
	/** One owed chunk of one storage. */
	static final class Debt {
		final String key;
		volatile @Nullable Object snapshot;
		volatile @Nullable Runnable resubmit;
		/** (no snapshot) marks the loaded chunk unsaved again, so the next flushed save rewrites it; run by {@link #retry}, never inside a save. */
		volatile @Nullable Runnable remark;
		volatile String why;
		/** Loaded from the older file while owed without a snapshot: the change is gone, no later write pays it (only {@link #forgiveAll}). */
		volatile boolean stale;

		Debt(String key, @Nullable Object snapshot, @Nullable Runnable resubmit, String why) {
			this.key = key;
			this.snapshot = snapshot;
			this.resubmit = resubmit;
			this.why = why;
		}
	}

	static final Map<String, Debt> OWED = new ConcurrentHashMap<>();
	static final AtomicLong FAILED = new AtomicLong(), PAID = new AtomicLong(), RESUBMITTED = new AtomicLong(), SERVED = new AtomicLong();
	/** (TEST, dev.stockpile.barrier failChunkWrite) the next region writes that fail as if the disk refused them. */
	public static final AtomicInteger FAIL_WRITES = new AtomicInteger();

	private ChunkDebt() {
	}

	/** The key of a chunk in a storage ({@code storage}: the storage's level, dimension and type). */
	public static String key(String storage, int x, int z) {
		return storage + " [" + x + ", " + z + "]";
	}

	/** (TEST seam) Whether this write is to fail (dev.stockpile.barrier failChunkWrite). */
	public static boolean failNext() {
		return FAIL_WRITES.get() > 0 && FAIL_WRITES.getAndDecrement() > 0;
	}

	/** A region write failed: owed with its snapshot and a resubmission. */
	public static void writeFailed(String key, @Nullable Object snapshot, @Nullable Runnable resubmit, String why) {
		FAILED.incrementAndGet();
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				return new Debt(k, snapshot, resubmit, why);
			}
			d.snapshot = snapshot;
			d.resubmit = resubmit;
			d.why = why;
			return d;
		});
		Architect.LOGGER.error("Chunk durability: the write of {} failed ({}); owed (no ledger is published) until a later write of it succeeds", key, why);
	}

	/** A save failed (reported by vanilla): owed; a snapshot an earlier report kept stays. */
	public static void saveFailed(String key, String why) {
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				FAILED.incrementAndGet();
				return new Debt(k, null, null, why);
			}
			return d;
		});
	}

	/**
	 * A save failed before a snapshot reached the IO worker (a serialization failure): owed, and {@code remark} (marks the loaded chunk unsaved)
	 * runs at the next barrier's {@link #retry}. Not at once: a flushed save that keeps saving the chunks it finds unsaved would loop on it.
	 */
	public static void remark(String key, Runnable remark, String why) {
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				FAILED.incrementAndGet();
				d = new Debt(k, null, null, why);
			}
			d.remark = remark;
			return d;
		});
	}

	/** The key of a chunk of a vanilla storage. */
	public static String key(net.minecraft.world.level.chunk.storage.RegionStorageInfo info, net.minecraft.world.level.ChunkPos pos) {
		return key(info.level() + "/" + info.dimension().identifier() + "/" + info.type(), pos.x(), pos.z());
	}

	/** A write of the chunk reached its region file: the debt is paid, unless it is stale. */
	public static void written(String key) {
		if (OWED.isEmpty()) {
			return;
		}
		Debt d = OWED.get(key);
		if (d != null && !d.stale && OWED.remove(key, d)) {
			PAID.incrementAndGet();
			Architect.LOGGER.info("Chunk durability: {} written again; its debt is paid", key);
		}
	}

	/**
	 * A load of this chunk: the snapshot a failed write left (the load is served it, never the older file), or null. An owed chunk without a
	 * snapshot is read from the older file: its debt turns stale (no later write of the reloaded chunk pays it; every barrier refuses).
	 */
	public static @Nullable Object snapshot(String key) {
		if (OWED.isEmpty()) {
			return null;
		}
		Debt d = OWED.get(key);
		if (d == null) {
			return null;
		}
		Object s = d.snapshot;
		if (s != null) {
			SERVED.incrementAndGet();
		} else if (!d.stale) {
			d.stale = true;
			Architect.LOGGER.error("Chunk durability: {} loads from its older file while its failed save is owed without a snapshot; the debt stays (no ledger is"
				+ " published) until an operator clears it", key);
		}
		return s;
	}

	/** (dev, operator: dev.stockpile.barrier forgive) forget every debt; answers how many. */
	public static int forgiveAll() {
		int n = OWED.size();
		OWED.clear();
		return n;
	}

	/**
	 * Every owed write with a snapshot submitted again (the flushed save that follows waits for it), and every loaded chunk whose save failed
	 * without one marked unsaved again (that save rewrites it). Server thread, before the barrier's flushed save. Answers how many.
	 */
	public static int retry() {
		int n = 0;
		for (Debt d : List.copyOf(OWED.values())) {
			Runnable r = d.resubmit != null ? d.resubmit : d.remark;
			if (r != null) {
				try {
					r.run();
					n++;
					RESUBMITTED.incrementAndGet();
				} catch (RuntimeException e) {
					Architect.LOGGER.error("Chunk durability: {} could not be submitted again", d.key, e);
				}
			}
		}
		return n;
	}

	/** The owed chunks, each with why. */
	public static List<String> owed() {
		List<String> out = new ArrayList<>();
		OWED.values().forEach(d -> out.add(d.key + " (" + d.why + (d.stale ? ", stale" : d.snapshot == null ? ", no snapshot" : "") + ")"));
		return out;
	}

	/** The world closed: what is still owed is lost with it (logged). */
	public static void worldClosed() {
		if (!OWED.isEmpty()) {
			Architect.LOGGER.error("Chunk durability: the world closed with {} chunk write(s) never written: {}", OWED.size(), owed());
		}
		OWED.clear();
		FAIL_WRITES.set(0);
	}

	/** (dev) the counters. */
	static com.google.gson.JsonObject devJson() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("owed", OWED.size());
		o.addProperty("failed", FAILED.get());
		o.addProperty("paid", PAID.get());
		o.addProperty("resubmitted", RESUBMITTED.get());
		o.addProperty("served", SERVED.get());
		return o;
	}
}
