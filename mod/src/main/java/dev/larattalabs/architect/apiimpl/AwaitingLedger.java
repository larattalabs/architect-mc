package dev.larattalabs.architect.apiimpl;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * When {@code GROUP_AWAITING_APPROVAL} fires (docs/CONTRACT.md "4c review folded in" item 1): a group is awaiting approval
 * and one of its awaiting items waits with a massing version not reported before for that group. So it fires on the change
 * to awaiting_approval and again after a redirect finished (the item's massing has a new version), but never for a partial
 * approval (the remaining items were reported), a reconnect's snapshot or a restart (the tokens are persisted by the
 * caller). A group is keyed {@code id@createdAt}; a token is {@code itemKey=massingId@version} ({@link Wire4c#awaitingTokens}).
 * Not thread-safe (the caller synchronizes). Internal.
 */
public final class AwaitingLedger {
	/** How many tokens to remember. */
	public static final int KEEP = 2000;

	private final Set<String> seen = new LinkedHashSet<>();

	/** Seeds the reported tokens (from disk). */
	public void restore(Collection<String> keys) {
		seen.addAll(keys);
		trim();
	}

	/** The reported tokens, oldest first (to save). */
	public List<String> keys() {
		return List.copyOf(seen);
	}

	/**
	 * Whether the event fires for a group with these awaiting tokens now (empty = not awaiting); remembers them. True when at
	 * least one token is new for the group.
	 */
	public boolean fire(String groupKey, List<String> tokens) {
		boolean any = false;
		for (String t : tokens) {
			any |= seen.add(groupKey + "|" + t);
		}
		if (any) {
			trim();
		}
		return any;
	}

	/** Whether {@link #fire} would fire (nothing is remembered). */
	public boolean pending(String groupKey, List<String> tokens) {
		return tokens.stream().anyMatch(t -> !seen.contains(groupKey + "|" + t));
	}

	private void trim() {
		while (seen.size() > KEEP) {
			seen.remove(seen.iterator().next());
		}
	}
}
