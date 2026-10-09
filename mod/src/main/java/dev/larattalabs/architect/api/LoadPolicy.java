package dev.larattalabs.architect.api;

/**
 * Whether a survey or a batch may load chunks.
 * <ul>
 * <li>{@link #LOADED_ONLY} (the default): only chunks already loaded are read; the rest are reported missing (a batch item
 * waits for a player to load them).</li>
 * <li>{@link #LOAD_BOUNDED(int)}: loads (generating if needed) at most {@code maxChunks} chunks that were not loaded, and lets
 * them unload again afterwards; chunks past the bound are reported missing.</li>
 * <li>{@link #GENERATED_ONLY(int)} (since 1.8.0): like {@code LOAD_BOUNDED}, but a chunk that was never fully generated is
 * never ticketed and never generated: a batch item waits {@link Reason#NOT_GENERATED} (run {@code Regions.prepare}), a survey
 * reports it missing. Region realise uses it by default.</li>
 * </ul>
 * A batch whose policy holds tickets ({@link #loads()}) refuses an item that could never get its chunks under the bound at
 * queue time with {@link Reason#CHUNK_BOUND} (since 1.8.0) instead of letting it time out.
 *
 * @param generate whether chunks that were never generated may be generated (true for {@code LOAD_BOUNDED}; since 1.8.0)
 */
public record LoadPolicy(int maxChunks, boolean generate) {
	public static final LoadPolicy LOADED_ONLY = new LoadPolicy(0);

	public LoadPolicy {
		maxChunks = Math.max(0, maxChunks);
	}

	/** The 1.7.0 constructor: {@code generate} is true. */
	public LoadPolicy(int maxChunks) {
		this(maxChunks, true);
	}

	@SuppressWarnings("checkstyle:MethodName")
	public static LoadPolicy LOAD_BOUNDED(int maxChunks) {
		return new LoadPolicy(maxChunks);
	}

	/** Since 1.8.0. */
	@SuppressWarnings("checkstyle:MethodName")
	public static LoadPolicy GENERATED_ONLY(int maxChunks) {
		return new LoadPolicy(Math.max(1, maxChunks), false);
	}

	public boolean loads() {
		return maxChunks > 0;
	}

	/** Whether chunks never generated may be generated (since 1.8.0): false for {@link #GENERATED_ONLY} and {@link #LOADED_ONLY}. */
	public boolean generates() {
		return maxChunks > 0 && generate;
	}
}
