package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * How to remove a site.
 *
 * @param force remove a site owned by someone other than {@code requester}. It does not override blockers: the player's
 *              things in the box always refuse an API remove.
 * @param requester who asks ({@code <modid>:<thing>} by convention); null = the player. A site whose owner differs needs force.
 * @param covered (1.5.0) what to do with cells another site covers: null = KEEP (hand-down)
 */
public record RemoveOptions(boolean force, @Nullable String requester, @Nullable CoveredPolicy covered) {
	/** The 1.4.0 constructor (covered cells: KEEP). */
	public RemoveOptions(boolean force, @Nullable String requester) {
		this(force, requester, null);
	}
}
