package dev.larattalabs.architect.api;

/** A prepare's progress ({@link Regions#prepare}, {@code SiteEvents.PREPARE_PROGRESS}). Since 1.8.0. */
public record PrepareView(String planId, int chunksTotal, int chunksGenerated, int chunksMissing, State state) {
	public enum State { RUNNING, DONE, CANCELLED, FAILED }
}
