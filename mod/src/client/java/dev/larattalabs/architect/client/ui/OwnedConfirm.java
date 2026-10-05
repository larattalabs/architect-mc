package dev.larattalabs.architect.client.ui;

import dev.larattalabs.architect.site.Site;
import java.util.function.BiConsumer;
import org.jspecify.annotations.Nullable;

/**
 * The second confirmation before the UI removes a site another mod owns (docs/CONTRACT.md phase 4a, R5): the first click
 * explains whose it is and arms; a second click on the same site within {@link #WINDOW_MS} goes ahead. Client thread.
 */
public final class OwnedConfirm {
	public static final long WINDOW_MS = 10_000;
	private static @Nullable String armed;
	private static long armedAt;

	private OwnedConfirm() {
	}

	/** "owned by steward_mc" (the mod id part of the owner), or null for the player's own site. */
	public static @Nullable String label(Site s) {
		if (s.owner() == null) {
			return null;
		}
		int colon = s.owner().indexOf(':');
		return "owned by " + (colon > 0 ? s.owner().substring(0, colon) : s.owner());
	}

	/** Whether this site is armed (the next click removes it). */
	public static boolean armed(Site s) {
		return s.owner() != null && s.id().equals(armed) && System.currentTimeMillis() - armedAt <= WINDOW_MS;
	}

	/**
	 * True when the removal may go ahead: the player's own site, or the second click on an owned one. Otherwise arms and tells
	 * the player through {@code say(message, isError)}.
	 */
	public static boolean ask(Site s, BiConsumer<String, Boolean> say) {
		if (s.owner() == null) {
			return true;
		}
		if (armed(s)) {
			armed = null;
			return true;
		}
		armed = s.id();
		armedAt = System.currentTimeMillis();
		say.accept(s.id() + " is " + label(s) + " (" + s.owner() + "); removing it may break that mod's plans. Click Remove again to remove it", true);
		return false;
	}

	public static void reset() {
		armed = null;
	}
}
