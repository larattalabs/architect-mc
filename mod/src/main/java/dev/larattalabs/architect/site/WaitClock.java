package dev.larattalabs.architect.site;

import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * (8b review P2-4) One canonical start per waiting target: the tick its first wait of any kind (materials, bill_cap, fill_blocked,
 * txn_held) began, kept while any wait holds it, saved with the world and read back, so {@code SiteWait.waitingSince} never jumps when the
 * wait changes kind or the world restarts. Freed only when no wait of any kind holds the target. Internal.
 */
final class WaitClock {
	private final Map<String, Long> start = new ConcurrentHashMap<>();

	/** A wait holds {@code id}, its own kind's start {@code own} (0: unknown): the canonical start (the earliest seen while held). */
	long held(String id, long own) {
		if (own <= 0) {
			return of(id);
		}
		return start.merge(id, own, Math::min);
	}

	/** No wait of any kind holds {@code id} any more. */
	void free(String id) {
		start.remove(id);
	}

	/** The canonical start, 0 when none. */
	long of(String id) {
		return start.getOrDefault(id, 0L);
	}

	/** Every held start (the file's {@code waits}). */
	Map<String, Long> saved() {
		return new TreeMap<>(start);
	}

	/** Read back from the file. */
	void load(Map<String, Long> m) {
		start.clear();
		m.forEach((k, v) -> {
			if (v != null && v > 0) {
				start.put(k, v);
			}
		});
	}

	void clear() {
		start.clear();
	}
}
