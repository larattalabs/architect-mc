package dev.larattalabs.architect.api;

/**
 * Whether a survey may load chunks.
 * <ul>
 * <li>{@link #LOADED_ONLY} (the default): only chunks already loaded are read; the rest are reported missing.</li>
 * <li>{@link #LOAD_BOUNDED(int)}: loads (generating if needed) at most {@code maxChunks} chunks that were not loaded, and lets
 * them unload again afterwards; chunks past the bound are reported missing.</li>
 * </ul>
 */
public record LoadPolicy(int maxChunks) {
	public static final LoadPolicy LOADED_ONLY = new LoadPolicy(0);

	public LoadPolicy {
		maxChunks = Math.max(0, maxChunks);
	}

	@SuppressWarnings("checkstyle:MethodName")
	public static LoadPolicy LOAD_BOUNDED(int maxChunks) {
		return new LoadPolicy(maxChunks);
	}

	public boolean loads() {
		return maxChunks > 0;
	}
}
