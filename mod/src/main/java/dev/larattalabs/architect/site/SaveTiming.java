package dev.larattalabs.architect.site;

/**
 * (SS) Where a save with the world spends its time: vanilla's world save split into its parts by a timing-only mixin
 * ({@code SaveTimingMixin}), plus the stockpiles' own parts. Only on while {@link Stockpiles} times a save (an explicit save with the world,
 * or an autosave between its BEFORE_SAVE and AFTER_SAVE). Server thread only; nothing here changes what is saved.
 */
public final class SaveTiming {
	public static final int OTHER = 0, PLAYERS = 1, DATA = 2, CHUNKS = 3, POI = 4, UNLOADS = 5, IO = 6, ENTITIES = 7, LEVEL_DAT = 8, BOOKS = 9,
		WRITE = 10, WAIT = 11;
	static final String[] NAMES = {"other", "players", "data", "chunks", "poi", "unloads", "io", "entities", "leveldat", "books", "write", "wait"};

	private static boolean on;
	private static int phase;
	private static long last, started;
	private static final long[] NANOS = new long[NAMES.length];
	private static int chunksSaved;
	private static long forced0, skipped0;
	/** (SS) Region files forced (successful forces) and forces skipped (known clean), this session: RegionDurability's counters. */
	static final java.util.concurrent.atomic.AtomicLong FORCED = RegionDurability.FORCED, SKIPPED = RegionDurability.SKIPPED;
	private static long barriers0;
	/**
	 * (SS) Every region file forced at a flush, as vanilla does (RegionFileFlushMixin off): {@code -Darchitect.regionForceAll=true}, or the
	 * TEST switch {@code dev.stockpile.ps {forceAll}} (the gate's before case).
	 */
	public static volatile boolean forceAll = Boolean.getBoolean("architect.regionForceAll");
	/**
	 * (SS) A flushed save waits for every accessible chunk's pending futures, as vanilla does (ChunkSaveWaitMixin off):
	 * {@code -Darchitect.chunkWaitAll=true}, or the TEST switch {@code dev.stockpile.ps {waitAll}}.
	 */
	public static volatile boolean waitAll = Boolean.getBoolean("architect.chunkWaitAll");
	private static int waitsSkipped;
	/**
	 * (SS) Inside a stockpile save with the world (saveWithWorld, saveLedgerFirst): ChunkSaveWaitMixin skips waits only there, never in a
	 * vanilla save (/save-all, autosave, the stop's save). Server thread.
	 */
	public static volatile boolean explicit;

	private SaveTiming() {
	}

	static void start() {
		java.util.Arrays.fill(NANOS, 0);
		chunksSaved = 0;
		waitsSkipped = 0;
		forced0 = FORCED.get();
		skipped0 = SKIPPED.get();
		barriers0 = RegionDurability.BARRIERS.get();
		phase = OTHER;
		last = System.nanoTime();
		started = last;
		on = true;
	}

	/** A world save's head (saveAllChunks): an autosave or /save-all is timed from here to its ledger write (AFTER_SAVE). */
	public static void worldSave() {
		if (!on) {
			start();
		}
	}

	/** From now on the time counts to {@code p}. */
	public static void at(int p) {
		if (!on) {
			return;
		}
		long now = System.nanoTime();
		NANOS[phase] += now - last;
		last = now;
		phase = p;
	}

	/**
	 * (SS, ChunkSaveWaitMixin) A chunk whose save would write a change made in the world: a LevelChunk marked unsaved, or the LevelChunk an
	 * ImposterProtoChunk wraps (the imposter itself always reports clean). Anything else (a ProtoChunk loading or generating) holds no change
	 * the ledger describes.
	 */
	public static boolean hasChanges(net.minecraft.world.level.chunk.ChunkAccess c) {
		if (c instanceof net.minecraft.world.level.chunk.LevelChunk lc) {
			return lc.isUnsaved();
		}
		if (c instanceof net.minecraft.world.level.chunk.ImposterProtoChunk ip) {
			return ip.getWrapped().isUnsaved();
		}
		return false;
	}

	/** A flushed save's wait for a chunk with nothing unsaved, or still loading, skipped (server thread). */
	public static void waitSkipped() {
		WAITS_SKIPPED.incrementAndGet();
		if (on) {
			waitsSkipped++;
		}
	}

	static final java.util.concurrent.atomic.AtomicLong WAITS_SKIPPED = new java.util.concurrent.atomic.AtomicLong();

	/** A chunk copied for its write (ChunkMap.save returned true). */
	public static void chunkSaved() {
		if (on) {
			chunksSaved++;
		}
	}

	static boolean on() {
		return on;
	}

	/** Stops and returns the breakdown, "players 1.2 | chunks 3.4 (n 12) | ...", parts under 0.05 ms left out. */
	static String stop() {
		at(OTHER);
		on = false;
		StringBuilder b = new StringBuilder();
		for (int i = 1; i < NAMES.length; i++) {
			appendPart(b, i);
		}
		appendPart(b, OTHER);
		b.append(" | chunksSaved ").append(chunksSaved).append(" | forced ").append(FORCED.get() - forced0).append(" skipped ").append(SKIPPED.get() - skipped0)
			.append(" barriers ").append(RegionDurability.BARRIERS.get() - barriers0)
			.append(" | waitsSkipped ").append(waitsSkipped);
		if (forceAll) {
			b.append(" | forceAll");
		}
		if (waitAll) {
			b.append(" | waitAll");
		}
		return b.toString();
	}

	private static void appendPart(StringBuilder b, int i) {
		double ms = NANOS[i] / 1e6;
		if (ms < 0.05) {
			return;
		}
		if (!b.isEmpty()) {
			b.append(" | ");
		}
		b.append(NAMES[i]).append(' ').append(String.format(java.util.Locale.ROOT, "%.1f", ms));
	}

	/** When the timed save started (System.nanoTime). */
	static long started() {
		return started;
	}

	static double ms(int p) {
		return NANOS[p] / 1e6;
	}

	static int chunksSaved() {
		return chunksSaved;
	}
}
