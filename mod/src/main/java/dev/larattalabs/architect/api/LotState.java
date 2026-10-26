package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * A region lot: its site once placed; {@code state} is {@code pad}, {@code queued}, {@code placed} or {@code failed:<reason>}. Since 1.8.0.
 *
 * <p>Since NEXT (6d RV): {@code removed} (its site removed alone, its pad standing: a refill builds it again), and {@code revision}, the rid
 * of the revision that added or last refilled it (0: the realised plan's).
 */
public record LotState(String id, @Nullable String siteId, String state, int revision) {
	/** The 1.8.0 constructor (revision 0). */
	public LotState(String id, @Nullable String siteId, String state) {
		this(id, siteId, state, 0);
	}
}
