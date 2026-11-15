package dev.larattalabs.architect.site;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * (SS) What RegionFileFlushMixin knows about each region file object: its writes, the writes its last <b>successful</b> force covered, and
 * the obligations a close left behind. The mixin only delegates here, so the rules are unit-tested without Minecraft
 * ({@code RegionDurabilityTest}) and exercised with the mixins applied by {@code dev.stockpile.ss {probe}} (ps-crash).
 * <ul>
 * <li><b>Unknown at open.</b> A new object has covered nothing ({@code forcedAt = -1}): its first flush forces it, whatever an earlier
 * object for the same file did or failed to do.</li>
 * <li><b>Skip only a file known clean:</b> no write since a force that returned normally. A force that throws covers nothing.</li>
 * <li><b>A close owes until its force returns.</b> A close of an object with uncovered writes records its path as owed; only that close's
 * successful force, or a later object's successful force of the same file (fsync is per file, not per descriptor), clears it.</li>
 * <li><b>One barrier per world save.</b> On macOS a force is F_FULLFSYNC, which also flushes the drive's cache: vanilla's flushed save
 * relied on that for the player files it wrote just before (O_SYNC, not a device flush). When a storage's flush forced nothing in this
 * world save yet, one of its files is forced anyway ({@link #barrierNeeded}).</li>
 * <li><b>Before the ledger:</b> {@link #undurable} lists every live object of the given storage types with a write not covered, and every
 * owed path. A stockpile save with the world, and an autosave's ledger write, refuse to publish the ledger while it is not empty.</li>
 * </ul>
 * A file's writes and flushes run on its storage's IO worker, one task at a time; the counters are atomic or volatile anyway.
 */
public final class RegionDurability {
	/** One RegionFile object. */
	public static final class State {
		final Path path;
		final String type;
		final AtomicLong writes = new AtomicLong();
		volatile long forcedAt = -1; // unknown: nothing covered yet
		volatile long forcing = -1;
		final AtomicLong external = new AtomicLong(); // oversized chunks' .mcc payloads written
		volatile long externalForcedAt;
		volatile long externalForcing;

		State(Path path, String type) {
			this.path = path;
			this.type = type;
		}

		boolean covered() {
			return writes.get() == forcedAt || (forcedAt == -1 && writes.get() == 0);
		}
	}

	static final Set<State> LIVE = ConcurrentHashMap.newKeySet();
	/** A path whose close did not finish its force, with the storage type. */
	static final Map<Path, String> OWED = new ConcurrentHashMap<>();
	static final AtomicLong FORCED = new AtomicLong(), SKIPPED = new AtomicLong(), BARRIERS = new AtomicLong(), DIR_SYNCS = new AtomicLong(),
		FAILED = new AtomicLong();
	static volatile long epoch, forcedEpoch = -1;
	private static final ThreadLocal<Boolean> BARRIER = ThreadLocal.withInitial(() -> false);
	/** (TEST, the probe) the next force of this file fails as if the disk refused it. */
	static volatile Path failNextForce;

	private RegionDurability() {
	}

	public static State open(Path path, String type) {
		State s = new State(path, type);
		LIVE.add(s);
		return s;
	}

	public static void written(State s) {
		s.writes.incrementAndGet();
	}

	public static void externalWritten(State s) {
		s.external.incrementAndGet();
	}

	/** At a flush's head: true to skip its force (nothing written since a successful one). Else the force starts (forced() if it returns). */
	public static boolean skip(State s) throws IOException {
		long w = s.writes.get();
		if (w == s.forcedAt && !BARRIER.get() && !SaveTiming.forceAll) {
			SKIPPED.incrementAndGet();
			return true;
		}
		s.forcing = w;
		s.externalForcing = s.external.get();
		failIfAsked(s);
		return false;
	}

	/** At a forcing flush: an oversized chunk's .mcc was renamed into the directory since the last successful force. */
	public static boolean needsDirSync(State s) {
		return s.externalForcing != s.externalForcedAt;
	}

	public static void dirSynced() {
		DIR_SYNCS.incrementAndGet();
	}

	/** A flush's force returned normally. */
	public static void forced(State s) {
		s.forcedAt = s.forcing;
		s.externalForcedAt = s.externalForcing;
		forcedEpoch = epoch;
		OWED.remove(s.path);
		FORCED.incrementAndGet();
	}

	/** A close starts: the object leaves; uncovered writes become an obligation on its path until a force returns. */
	public static void closing(State s) {
		LIVE.remove(s);
		if (!s.covered() || s.external.get() != s.externalForcedAt) {
			OWED.put(s.path, s.type);
		}
	}

	/** Before a close's force (the TEST failure point). */
	public static void closeForcing(State s) throws IOException {
		failIfAsked(s);
	}

	/** A close's force returned normally. */
	public static void closeForced(State s) {
		OWED.remove(s.path);
		forcedEpoch = epoch;
	}

	private static void failIfAsked(State s) throws IOException {
		if (s.path.equals(failNextForce)) {
			failNextForce = null;
			FAILED.incrementAndGet();
			throw new IOException("(SS TEST) a force refused");
		}
	}

	/** A world save starts (saveAllChunks' head). */
	public static void saveStarted() {
		epoch++;
	}

	/** At a storage flush's end: no force returned in this world save yet, so one file is forced as the device barrier. */
	public static boolean barrierNeeded() {
		return forcedEpoch != epoch;
	}

	/** Runs {@code flush} as the barrier: the file's flush forces even when the file is known clean. */
	public static void barrier(IoRunnable flush) throws IOException {
		BARRIER.set(true);
		try {
			flush.run();
			BARRIERS.incrementAndGet();
		} finally {
			BARRIER.set(false);
		}
	}

	@FunctionalInterface
	public interface IoRunnable {
		void run() throws IOException;
	}

	/** The files of these storage types (prefixes: "chunk", "entities") with a write no successful force covered, and the owed paths. */
	public static List<String> undurable(String... types) {
		List<String> out = new ArrayList<>();
		for (State s : LIVE) {
			if (typed(s.type, types) && (!s.covered() || s.external.get() != s.externalForcedAt)) {
				out.add(s.type + " " + s.path.getFileName() + " (writes " + s.writes.get() + ", covered " + s.forcedAt + ")");
			}
		}
		OWED.forEach((p, t) -> {
			if (typed(t, types)) {
				out.add(t + " " + p.getFileName() + " (a close's force did not return)");
			}
		});
		return out;
	}

	private static boolean typed(String type, String[] types) {
		for (String t : types) {
			if (type.startsWith(t)) {
				return true;
			}
		}
		return false;
	}

	/** (tests) forget everything. */
	static void reset() {
		LIVE.clear();
		OWED.clear();
		epoch = 0;
		forcedEpoch = -1;
		failNextForce = null;
	}
}
