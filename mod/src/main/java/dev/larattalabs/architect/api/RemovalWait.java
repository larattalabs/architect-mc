package dev.larattalabs.architect.api;

/**
 * (slice T4R-D, Steward's A7b) A group, region or revision removal waiting on its FIFO ticket ({@link SiteGroup#removalWait()},
 * {@link RegionView#removalWait()}, {@link RevisionView#removalWait()}): {@code cause} {@link RemovalStopCause#WAITING_BEHIND}, what it waits
 * behind, and since when (server tick). It goes on by itself once the blocker finishes; after {@code MAX_WAIT} with no progress ahead it
 * stops with {@link RemovalStopCause#WAITING_BEHIND}. Since 1.72.0.
 */
public record RemovalWait(RemovalStopCause cause, Busy blocking, long sinceTick) {
}
