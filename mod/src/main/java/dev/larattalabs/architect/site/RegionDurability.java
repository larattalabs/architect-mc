package dev.larattalabs.architect.site;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
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
 * <li><b>A close owes until its force returns.</b> A close of an object with uncovered writes records its path as owed. Only that close's
 * successful force, a later object's successful force of the same file (fsync is per file, not per descriptor), or {@link #retryOwed}
 * (each stockpile ledger save reopens every owed path and forces it) clears it.</li>
 * <li><b>One barrier per world save.</b> On macOS a force is F_FULLFSYNC, which also flushes the drive's cache: vanilla's flushed save
 * relied on that for the player files it wrote just before (O_SYNC, not a device flush). When a storage's flush ends and no force that
 * <i>started</i> in this world save has returned, one of its files is forced anyway ({@link #barrierNeeded}).</li>
 * <li><b>Before the ledger:</b> {@link #undurable} lists every live object of the given storage types in this world with a write not
 * covered, and every owed path. A stockpile save with the world, and the world save's ledger write, refuse to publish while it is not
 * empty.</li>
 * <li><b>World scope:</b> only files under the running world's directory count; everything is forgotten when the world closes.</li>
 * <li><b>Forced here, not by vanilla</b> (slice T0 review P1-4, {@link #forceNew}): an oversized chunk's external {@code .mcc} payload and
 * its folder entry, and a new region file's (and new region folder's) entry. A chunk write that fails before it reaches the region file is
 * {@link ChunkDebt}'s: owed until a later write of that chunk succeeds.</li>
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
		volatile long forcingEpoch = -1, closeEpoch = -1;

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
	static final AtomicLong FORCED = new AtomicLong(), SKIPPED = new AtomicLong(), BARRIERS = new AtomicLong(), FAILED = new AtomicLong(),
		RETRIED = new AtomicLong();
	static volatile long epoch, forcedEpoch = -1;
	/** The running world's directory: only files under it count (null: every file). */
	static volatile Path world;
	private static final ThreadLocal<Boolean> BARRIER = ThreadLocal.withInitial(() -> false);
	/** (TEST, the probe) every force of these files fails as if the disk refused it, until removed. */
	static final Set<Path> FAILING = ConcurrentHashMap.newKeySet();

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

	/** At a flush's head: true to skip its force (nothing written since a successful one). Else the force starts (forced() if it returns). */
	public static boolean skip(State s) throws IOException {
		long w = s.writes.get();
		if (w == s.forcedAt && !BARRIER.get() && !SaveTiming.forceAll) {
			SKIPPED.incrementAndGet();
			return true;
		}
		s.forcing = w;
		s.forcingEpoch = epoch; // the save this force started in: a force from an earlier save never counts as this one's barrier
		failIfAsked(s.path);
		return false;
	}

	/** A flush's force returned normally. */
	public static void forced(State s) {
		s.forcedAt = s.forcing;
		credit(s.forcingEpoch);
		OWED.remove(s.path);
		FORCED.incrementAndGet();
	}

	/** A close starts: the object leaves; uncovered writes become an obligation on its path until a force returns. */
	public static void closing(State s) {
		LIVE.remove(s);
		if (!s.covered()) {
			OWED.put(s.path, s.type);
		}
	}

	/** Before a close's force (the TEST failure point). */
	public static void closeForcing(State s) throws IOException {
		s.closeEpoch = epoch;
		failIfAsked(s.path);
	}

	/** A close's force returned normally. */
	public static void closeForced(State s) {
		OWED.remove(s.path);
		credit(s.closeEpoch);
	}

	private static synchronized void credit(long startedIn) {
		if (startedIn > forcedEpoch) {
			forcedEpoch = startedIn;
		}
	}

	private static void failIfAsked(Path p) throws IOException {
		if (FAILING.contains(p)) {
			FAILED.incrementAndGet();
			throw new IOException("(SS TEST) a force refused: " + p);
		}
	}

	/**
	 * Before a stockpile ledger save: every owed path of this world reopened and forced (a transient failure clears once the disk recovers).
	 * Server thread; returns the paths that still could not be forced (each logged by the caller's refusal).
	 */
	public static List<String> retryOwed() {
		List<String> left = new ArrayList<>();
		for (Map.Entry<Path, String> e : List.copyOf(OWED.entrySet())) {
			Path p = e.getKey();
			if (!inWorld(p)) {
				continue;
			}
			long started = epoch;
			if (p.getFileName().toString().endsWith(".mcc") && !java.nio.file.Files.exists(p)) {
				OWED.remove(p, e.getValue()); // the chunk went back inline (the commit deleted its .mcc); the region file's write covers it
				continue;
			}
			try {
				failIfAsked(p);
				forcePath(p);
				OWED.remove(p, e.getValue());
				credit(started);
				RETRIED.incrementAndGet();
			} catch (IOException | RuntimeException x) {
				left.add(p + " (" + x.getClass().getSimpleName() + ": " + x.getMessage() + ")");
			}
		}
		return left;
	}

	/** A file forced, or a folder (its entries; slice T0: a new region file's or an oversized chunk's .mcc entry). */
	private static void forcePath(Path p) throws IOException {
		if (java.nio.file.Files.isDirectory(p)) {
			DurableFile.forceDir(p);
			return;
		}
		try (FileChannel c = FileChannel.open(p, StandardOpenOption.READ, StandardOpenOption.WRITE)) {
			c.force(true);
		}
	}

	/**
	 * (slice T0 review P1-4) A file or folder vanilla never forces, forced now: an oversized chunk's external {@code .mcc} payload (after its
	 * rename, with the region folder), a new region file's folder entry, a new region folder's entry in its parent. A force that fails leaves
	 * the path owed (as a close's), so {@link #undurable} lists it and {@link #retryOwed} retries it before each ledger save. Any thread.
	 */
	public static boolean forceNew(Path p, String type) {
		try {
			failIfAsked(p);
			forcePath(p);
			NEW_FORCED.incrementAndGet();
			return true;
		} catch (IOException | RuntimeException e) {
			OWED.put(p, type);
			dev.larattalabs.architect.Architect.LOGGER.error("Region durability: {} could not be forced ({}); owed until a ledger save's retry forces it", p,
				e.toString());
			return false;
		}
	}

	/** {@link #forceNew(Path, String)} with the storage type of a region file's state. */
	public static boolean forceNew(State s, Path p) {
		return forceNew(p, s.type);
	}

	/** (slice T0, dev) new files and folders forced by {@link #forceNew}. */
	static final AtomicLong NEW_FORCED = new AtomicLong();

	/** A world save starts (saveAllChunks' head). */
	public static void saveStarted() {
		epoch++;
	}

	/** At a storage flush's end: no force that started in this world save has returned yet, so one file is forced as the device barrier. */
	public static boolean barrierNeeded() {
		return forcedEpoch < epoch;
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

	/** The files of this world and these storage types (prefixes: "chunk", "entities") with a write no successful force covered, and the owed paths. */
	public static List<String> undurable(String... types) {
		List<String> out = new ArrayList<>();
		for (State s : LIVE) {
			if (typed(s.type, types) && inWorld(s.path) && !s.covered()) {
				out.add(s.type + " " + s.path + " (writes " + s.writes.get() + ", covered " + s.forcedAt + ")");
			}
		}
		OWED.forEach((p, t) -> {
			if (typed(t, types) && inWorld(p)) {
				out.add(t + " " + p + " (a force did not return: a close's, a new file's or folder's)");
			}
		});
		return out;
	}

	private static boolean inWorld(Path p) {
		Path w = world;
		return w == null || p.toAbsolutePath().normalize().startsWith(w);
	}

	private static boolean typed(String type, String[] types) {
		for (String t : types) {
			if (type.startsWith(t)) {
				return true;
			}
		}
		return false;
	}

	/** A world opens: only its files count from now on, and nothing from an earlier world is owed. */
	public static void worldOpened(Path dir) {
		OWED.clear();
		LIVE.removeIf(s -> !s.path.toAbsolutePath().normalize().startsWith(dir.toAbsolutePath().normalize()));
		world = dir.toAbsolutePath().normalize();
	}

	/** The world closed: everything forgotten. */
	public static void worldClosed() {
		OWED.clear();
		LIVE.clear();
		world = null;
		FAILING.clear();
	}

	/** (tests) forget everything. */
	static void reset() {
		worldClosed();
		epoch = 0;
		forcedEpoch = -1;
	}
}
