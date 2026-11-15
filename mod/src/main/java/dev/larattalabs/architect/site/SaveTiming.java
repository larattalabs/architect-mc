package dev.larattalabs.architect.site;

/**
 * (SS) Where a save with the world spends its time: vanilla's world save split into its parts by a timing-only mixin
 * ({@code SaveTimingMixin}), plus the stockpiles' own parts. Only on while {@link Stockpiles} times a save (an explicit save with the world,
 * or an autosave between its BEFORE_SAVE and AFTER_SAVE). Server thread only; nothing here changes what is saved.
 */
public final class SaveTiming {
	public static final int OTHER = 0, PLAYERS = 1, DATA = 2, CHUNKS = 3, POI = 4, UNLOADS = 5, IO = 6, ENTITIES = 7, LEVEL_DAT = 8, BOOKS = 9,
		WRITE = 10;
	static final String[] NAMES = {"other", "players", "data", "chunks", "poi", "unloads", "io", "entities", "leveldat", "books", "write"};

	private static boolean on;
	private static int phase;
	private static long last;
	private static final long[] NANOS = new long[NAMES.length];
	private static int chunksSaved;

	private SaveTiming() {
	}

	static void start() {
		java.util.Arrays.fill(NANOS, 0);
		chunksSaved = 0;
		phase = OTHER;
		last = System.nanoTime();
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
		b.append(" | chunksSaved ").append(chunksSaved);
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

	static double ms(int p) {
		return NANOS[p] / 1e6;
	}

	static int chunksSaved() {
		return chunksSaved;
	}
}
