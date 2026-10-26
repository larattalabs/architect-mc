package dev.larattalabs.architect.site;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Predicate;
import org.jspecify.annotations.Nullable;

/**
 * Slice SAFETY: the sites each player placed in this session, newest first (pure, unit-tested in {@code LastPlacedTest}), for
 * the "Undo last placement" key and the "Placed" line's one-click [Undo]. Only Architect's own player paths record here (the
 * ghost's Enter and {@code /architect place}); sites another mod places through the API never do. {@link #latest} skips
 * entries whose site is gone, was replaced by another site under the same id, or that another mod has owned since (the
 * caller's predicate), so the key never reaches a site that isn't the player's own.
 */
public final class LastPlaced {
	/** How many placements per player are remembered. */
	static final int DEPTH = 64;

	/** The server's record (the world's session: cleared when a server starts or stops). */
	public static final LastPlaced INSTANCE = new LastPlaced();

	/** A placement: the site id and its {@code placedAt} (so an id reused later never matches). */
	public record Entry(String site, long placedAt) {
	}

	private final Map<String, Deque<Entry>> byPlayer = new HashMap<>();

	public synchronized void record(String player, String site, long placedAt) {
		Deque<Entry> d = byPlayer.computeIfAbsent(player, k -> new ArrayDeque<>());
		d.removeIf(e -> e.site().equals(site));
		d.addFirst(new Entry(site, placedAt));
		while (d.size() > DEPTH) {
			d.removeLast();
		}
	}

	/**
	 * The player's newest placement that still holds ({@code stillOurs}), or null. Entries above it that no longer hold are
	 * dropped (a removed site is never undone twice).
	 */
	public synchronized @Nullable Entry latest(String player, Predicate<Entry> stillOurs) {
		Deque<Entry> d = byPlayer.get(player);
		if (d == null) {
			return null;
		}
		while (!d.isEmpty()) {
			Entry e = d.peekFirst();
			if (stillOurs.test(e)) {
				return e;
			}
			d.removeFirst();
		}
		return null;
	}

	public synchronized void clear() {
		byPlayer.clear();
	}
}
