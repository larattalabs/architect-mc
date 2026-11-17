package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.jspecify.annotations.Nullable;

/**
 * (slice T0 review P1-3; TXN review 3 item 5; T0 review 2 findings 3 and 7) A chunk (or entity, or POI) save that failed stays <b>owed</b>
 * until a write of the same chunk to the same storage, <b>at least as new as the failed attempt</b>, succeeds. Vanilla forgets a failure:
 * {@code ChunkMap.save} marks the chunk saved before it serializes it, and {@code IOWorker} drops the pending write before it runs it. The
 * mixins ({@code IOWorkerDebtMixin}, {@code ChunkSaveFailMixin}, {@code ChunkMapDebtMixin}) only report here.
 * <ul>
 * <li><b>Order.</b> Every submission to an IO worker gets a sequence number ({@link #submitted}, through {@link Seqd}); the data a region write
 * writes carries the number of the submission it came from ({@link #pendingData}, {@link #writing}). A failure records the newest attempt
 * that failed; only a write numbered at or after it pays ({@link #written}). An older queued write never clears a newer failure.</li>
 * <li>A failed region write keeps its snapshot: {@link #retry} submits it again (with its own, older number) only when nothing newer for that
 * chunk was submitted since, so it never replaces a newer pending snapshot; a load is served the snapshot ({@link #snapshot}) under the same
 * rule.</li>
 * <li>A failed serialization has no snapshot. {@link #retry} marks the loaded chunk unsaved again (the barrier's flushed save rewrites it),
 * or, when it unloaded, serializes the chunk object kept with the debt and writes that; an unload of an owed chunk first marks it unsaved, so
 * its unload save rewrites it ({@code ChunkMapDebtMixin}). Only a reload from the older file while no snapshot can serve it turns the debt
 * stale (every barrier refuses until an operator clears it).</li>
 * <li>{@link #owed} is not empty: the barrier refuses, and no ordinary ledger save publishes ({@code Stockpiles.save}).</li>
 * </ul>
 * <b>One lock</b> (T0 review 3 findings 3, 4): every method that reads or changes the debts, the numbers or the pending data holds the
 * {@code ChunkDebt.class} monitor, as {@link PlayerSaves} does; a payment, a newer failure and a retry never interleave. Any thread; the
 * world's state is forgotten when it closes and when one opens.
 */
public final class ChunkDebt {
	/** One owed chunk of one storage. */
	static final class Debt {
		final String key;
		volatile @Nullable Object snapshot;
		/** The submission the snapshot came from; the newest attempt that failed. */
		volatile long snapSeq, failSeq;
		volatile @Nullable Runnable resubmit;
		/** (no snapshot) marks the loaded chunk unsaved again, or writes the kept chunk object; run by {@link #retry}, never inside a save. */
		volatile @Nullable Runnable remark;
		/** (T0 review 3 finding 8) re-serializes the chunk object kept from a synchronous failure: a reload is served it, never the older file. */
		volatile @Nullable Supplier<Object> reserialize;
		/** (T0 review 4 P1-1) the failSeq of the failure that kept that object: it is served only while no newer failure is owed. */
		volatile long keptSeq;
		volatile String why;
		/** Loaded from the older file while owed without a usable snapshot: the change is gone, no later write pays it ({@link #forgiveAll}). */
		volatile boolean stale;

		Debt(String key, String why, long failSeq) {
			this.key = key;
			this.why = why;
			this.failSeq = failSeq;
		}

		boolean usable() {
			return snapshot != null && snapSeq >= failSeq;
		}
	}

	/** (T0 review 4 P1-1) A newer failure than the one that kept the chunk object makes that object an older copy: it is dropped. */
	private static void dropOlderKept(Debt d) {
		if (d.reserialize != null && d.failSeq > d.keptSeq) {
			d.reserialize = null;
		}
	}

	/** A submission's data, numbered: the IO worker's supplier wrapped ({@code IOWorkerDebtMixin}). */
	public static final class Seqd<T> implements Supplier<T> {
		public final String key;
		public final long seq;
		private final Supplier<T> inner;

		public Seqd(String key, long seq, Supplier<T> inner) {
			this.key = key;
			this.seq = seq;
			this.inner = inner;
		}

		@Override
		public T get() {
			try {
				return inner.get();
			} catch (RuntimeException e) { // the async serialization failed: this attempt is owed
				serializationFailed(key, seq, String.valueOf(e));
				throw e;
			}
		}
	}

	static final Map<String, Debt> OWED = new ConcurrentHashMap<>();
	/** The newest submission per chunk not written yet; the number of the data pending per chunk (in the worker's map). */
	static final Map<String, Long> LATEST = new ConcurrentHashMap<>(), PENDING = new ConcurrentHashMap<>();
	static final AtomicLong SEQ = new AtomicLong();
	static final AtomicLong FAILED = new AtomicLong(), PAID = new AtomicLong(), RESUBMITTED = new AtomicLong(), SERVED = new AtomicLong();
	/** (TEST, dev.stockpile.barrier failChunkWrite) the next region writes that fail as if the disk refused them. */
	public static final AtomicInteger FAIL_WRITES = new AtomicInteger();
	/** (TEST seams, T0 review 3 findings 3 and 4) run inside the lock: before a write pays a debt, before a retry resubmits one. */
	static volatile @Nullable Runnable TEST_BEFORE_PAY, TEST_BEFORE_RESUBMIT;

	private ChunkDebt() {
	}

	/** The key of a chunk in a storage ({@code storage}: the storage's level, dimension and type). */
	public static String key(String storage, int x, int z) {
		return storage + " [" + x + ", " + z + "]";
	}

	/** The key of a chunk of a vanilla storage. */
	public static String key(net.minecraft.world.level.chunk.storage.RegionStorageInfo info, net.minecraft.world.level.ChunkPos pos) {
		return key(info.level() + "/" + info.dimension().identifier() + "/" + info.type(), pos.x(), pos.z());
	}

	/** (TEST seam) Whether this write is to fail (dev.stockpile.barrier failChunkWrite). */
	public static boolean failNext() {
		return FAIL_WRITES.get() > 0 && FAIL_WRITES.getAndDecrement() > 0;
	}

	/** A submission to the chunk's IO worker: its number ({@code seq}, a resubmission's own; 0 takes the next). */
	public static synchronized long submitted(String key, long seq) {
		long n = seq > 0 ? seq : SEQ.incrementAndGet();
		LATEST.merge(key, n, Math::max);
		return n;
	}

	/** The worker's pending data for the chunk is now submission {@code seq}'s. IO thread. */
	public static synchronized void pendingData(String key, long seq) {
		PENDING.put(key, seq);
	}

	/** A region write of the chunk starts: the number of the data it writes (0: unknown, it pays nothing). IO thread. */
	public static synchronized long writing(String key) {
		Long s = PENDING.remove(key);
		return s == null ? 0 : s;
	}

	/** A region write failed: owed with its snapshot (submission {@code seq}) and a resubmission. */
	public static synchronized void writeFailed(String key, @Nullable Object snapshot, long seq, @Nullable Runnable resubmit, String why) {
		FAILED.incrementAndGet();
		long fail = seq > 0 ? seq : SEQ.incrementAndGet();
		LATEST.remove(key, seq);
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				d = new Debt(k, why, fail);
			}
			d.failSeq = Math.max(d.failSeq, fail);
			dropOlderKept(d);
			if (seq >= d.snapSeq) { // the newest failed data is the one kept
				d.snapshot = snapshot;
				d.snapSeq = seq;
				d.resubmit = resubmit;
			}
			d.why = why;
			return d;
		});
		Architect.LOGGER.error("Chunk durability: the write of {} failed ({}); owed (no ledger is published) until a later write of it succeeds", key, why);
	}

	/** {@link #writeFailed(String, Object, long, Runnable, String)} of an unnumbered write. */
	public static synchronized void writeFailed(String key, @Nullable Object snapshot, @Nullable Runnable resubmit, String why) {
		writeFailed(key, snapshot, 0, resubmit, why);
	}

	/** An asynchronous serialization of submission {@code seq} failed: owed from that attempt on (an older snapshot no longer pays). */
	public static synchronized void serializationFailed(String key, long seq, String why) {
		FAILED.incrementAndGet();
		LATEST.remove(key, seq);
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				return new Debt(k, why, seq);
			}
			d.failSeq = Math.max(d.failSeq, seq);
			dropOlderKept(d);
			d.why = why;
			return d;
		});
	}

	/** A save failed (reported by vanilla): owed; a debt an earlier report recorded stays as it is. */
	public static synchronized void saveFailed(String key, String why) {
		OWED.computeIfAbsent(key, k -> {
			FAILED.incrementAndGet();
			return new Debt(k, why, SEQ.incrementAndGet());
		});
	}

	/**
	 * A save failed before a snapshot reached the IO worker: owed, and {@code remark} (marks the loaded chunk unsaved, or writes the kept chunk
	 * object) runs at the next barrier's {@link #retry}. Not at once: a flushed save that keeps saving the chunks it finds unsaved would loop on
	 * it. {@code newAttempt}: a synchronous serialization (an attempt newer than everything submitted so far).
	 */
	public static synchronized void remark(String key, Runnable remark, @Nullable Supplier<Object> reserialize, String why, boolean newAttempt) {
		remark(key, remark, why, newAttempt);
		Debt d = OWED.get(key);
		if (d != null && reserialize != null) {
			d.reserialize = reserialize;
			d.keptSeq = d.failSeq; // tagged with the failure that kept it
		}
	}

	/**
	 * (T0 review 4 P1-1) The kept chunk object's state, serialized now, when it is the newest owed attempt's (its tag equals the debt's
	 * failSeq); else null. The barrier's retry writes it for a chunk that unloaded ({@code ChunkMapDebtMixin}).
	 */
	public static synchronized @Nullable Object keptState(String key) {
		Debt d = OWED.get(key);
		if (d == null || d.reserialize == null || d.keptSeq != d.failSeq) {
			return null;
		}
		try {
			return d.reserialize.get();
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Chunk durability: {}'s kept chunk could not be serialized", key, e);
			return null;
		}
	}

	public static synchronized void remark(String key, Runnable remark, String why, boolean newAttempt) {
		long now = newAttempt ? SEQ.incrementAndGet() : 0;
		OWED.compute(key, (k, d) -> {
			if (d == null) {
				FAILED.incrementAndGet();
				d = new Debt(k, why, now > 0 ? now : SEQ.incrementAndGet());
			}
			d.failSeq = Math.max(d.failSeq, now);
			dropOlderKept(d); // an async failure (no object kept) after a kept one drops it too
			d.remark = remark;
			return d;
		});
	}

	/** {@link #remark(String, Runnable, String, boolean)} of a synchronous serialization failure. */
	public static synchronized void remark(String key, Runnable remark, String why) {
		remark(key, remark, why, true);
	}

	/** Whether the chunk is owed. */
	public static synchronized boolean owes(String key) {
		return !OWED.isEmpty() && OWED.containsKey(key);
	}

	/** A write of submission {@code seq} reached the region file: the debt is paid when that is at least as new as the failed attempt. */
	public static synchronized void written(String key, long seq) {
		if (seq > 0) {
			LATEST.remove(key, seq);
		}
		if (OWED.isEmpty()) {
			return;
		}
		Debt d = OWED.get(key);
		if (d != null && seq > 0 && seq >= d.keptSeq) {
			// (T0 review 4 P1-1) the chunk was saved since: the kept object is no longer its newest state. (T0 review 5 item 3) only a write at
			// least as new as the failure that kept it: an older queued write never discards the newer kept copy
			d.reserialize = null;
		}
		if (d != null && !d.stale && seq > 0 && seq >= d.failSeq) {
			Runnable t = TEST_BEFORE_PAY;
			if (t != null) {
				t.run();
			}
			if (d.failSeq > seq || OWED.get(key) != d) {
				return; // a newer failure arrived (only possible without the lock): it stays owed
			}
			OWED.remove(key);
			PAID.incrementAndGet();
			Architect.LOGGER.info("Chunk durability: {} written again; its debt is paid", key);
		}
	}

	/** An unnumbered write (its data's age unknown): it pays nothing. */
	public static synchronized void written(String key) {
		written(key, 0);
	}

	private static boolean newerSubmitted(String key, long seq) {
		Long l = LATEST.get(key);
		return l != null && l > seq;
	}

	/**
	 * A load of this chunk: the snapshot a failed write left (served instead of the older file), or null. Not when something newer for it was
	 * submitted since (the worker's pending data, newer, is read). An owed chunk with neither is read from the older file: its debt turns stale.
	 */
	public static synchronized @Nullable Object snapshot(String key) {
		if (OWED.isEmpty()) {
			return null;
		}
		Debt d = OWED.get(key);
		if (d == null) {
			return null;
		}
		if (d.usable() && !newerSubmitted(key, d.snapSeq)) {
			SERVED.incrementAndGet();
			return d.snapshot;
		}
		if (!d.usable() && d.reserialize != null && d.keptSeq == d.failSeq && !newerSubmitted(key, d.failSeq - 1)) {
			// (T0 review 3 finding 8) the chunk unloaded owed and loads again: served its kept object's state, never the older file. (T0 review
			// 4 P1-1) only while that object is the newest owed attempt's; served once (the snapshot carries it from now on)
			try {
				Object tag = d.reserialize.get();
				d.reserialize = null;
				if (tag != null) {
					d.snapshot = tag;
					d.snapSeq = d.keptSeq;
					SERVED.incrementAndGet();
					return tag;
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Chunk durability: {}'s kept chunk could not be serialized for its reload", key, e);
			}
		}
		if (!newerSubmitted(key, d.failSeq - 1) && !d.stale) {
			d.stale = true;
			Architect.LOGGER.error("Chunk durability: {} loads from its older file while its failed save is owed without a snapshot; the debt stays (no ledger is"
				+ " published) until an operator clears it", key);
		}
		return null;
	}

	/** (dev, operator: dev.stockpile.barrier forgive) forget every debt; answers how many. */
	public static synchronized int forgiveAll() {
		int n = OWED.size();
		OWED.clear();
		return n;
	}

	/**
	 * Every owed write with a current snapshot submitted again when nothing newer for that chunk was submitted since (the flushed save that
	 * follows waits for it); every other owed chunk re-marked or its kept object written ({@link Debt#remark}). Server thread, before the
	 * barrier's flushed save. Answers how many.
	 */
	public static synchronized int retry() {
		int n = 0;
		for (Debt d : List.copyOf(OWED.values())) {
			boolean resubmit = d.usable() && d.resubmit != null;
			if (resubmit) {
				Runnable t = TEST_BEFORE_RESUBMIT;
				if (t != null) {
					t.run();
				}
			}
			if (OWED.get(d.key) != d) {
				continue; // paid meanwhile (only possible without the lock): nothing to replay
			}
			Runnable r = resubmit && !newerSubmitted(d.key, d.snapSeq) ? d.resubmit : resubmit ? null : d.remark;
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
	public static synchronized List<String> owed() {
		List<String> out = new ArrayList<>();
		OWED.values().forEach(d -> out.add(d.key + " (" + d.why + (d.stale ? ", stale" : d.snapshot == null ? ", no snapshot" : !d.usable()
			? ", snapshot outdated" : "") + ")"));
		return out;
	}

	/** The world closed: what is still owed is lost with it (logged). */
	public static synchronized void worldClosed() {
		if (!OWED.isEmpty()) {
			Architect.LOGGER.error("Chunk durability: the world closed with {} chunk write(s) never written: {}", OWED.size(), owed());
		}
		OWED.clear();
		LATEST.clear();
		PENDING.clear();
		FAIL_WRITES.set(0);
	}

	/** (dev) the counters. */
	static synchronized com.google.gson.JsonObject devJson() {
		com.google.gson.JsonObject o = new com.google.gson.JsonObject();
		o.addProperty("owed", OWED.size());
		o.addProperty("failed", FAILED.get());
		o.addProperty("paid", PAID.get());
		o.addProperty("resubmitted", RESUBMITTED.get());
		o.addProperty("served", SERVED.get());
		o.addProperty("inFlight", LATEST.size());
		return o;
	}
}
