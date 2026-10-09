package dev.larattalabs.architect.site;

import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * Architect's chunk tickets, reference counted per dimension and chunk (phase 6a, the 4e timeout fix).
 *
 * <p>Vanilla keeps one ticket per (type, level) and chunk: adding an equal ticket again only resets it, and one removal drops
 * it. The 4e queue gave every item and job its own radius-0 tickets of one type, so when two of them shared a chunk the first
 * to finish removed the other's ticket too. The other kept "holding" its tickets in its own books while the chunk unloaded
 * (or never loaded), waited {@code NOT_LOADED} with the batch's budget in its hands, and timed out after 600 s: the 11
 * {@code TIMED_OUT} lots of 4e's 1000x1000 run (artifacts/gate6a/timeouts.md). Here the vanilla ticket is added when a chunk's
 * count goes 0 -> 1 and removed when it goes 1 -> 0. Server thread.
 */
public final class ChunkTickets {
	/** The world side: the vanilla ticket of one chunk (a seam for tests). */
	public interface Source {
		void add(long chunk);

		void remove(long chunk);
	}

	private static final Map<String, Long2IntOpenHashMap> COUNTS = new HashMap<>();

	private ChunkTickets() {
	}

	/** One more holder of each chunk; the vanilla ticket goes on when a chunk had none. */
	public static void acquire(String dimension, Collection<Long> chunks, Source s) {
		Long2IntOpenHashMap m = COUNTS.computeIfAbsent(dimension, d -> new Long2IntOpenHashMap());
		for (long c : chunks) {
			if (m.addTo(c, 1) == 0) {
				s.add(c);
			}
		}
	}

	/** One holder less of each chunk; the vanilla ticket goes when the last holder lets go. */
	public static void release(String dimension, Collection<Long> chunks, Source s) {
		Long2IntOpenHashMap m = COUNTS.get(dimension);
		if (m == null) {
			return;
		}
		for (long c : chunks) {
			int was = m.get(c);
			if (was <= 0) {
				continue;
			}
			if (was == 1) {
				m.remove(c);
				s.remove(c);
			} else {
				m.put(c, was - 1);
			}
		}
	}

	/** The holders of a chunk (tests and the DevBridge). */
	public static int count(String dimension, long chunk) {
		Long2IntOpenHashMap m = COUNTS.get(dimension);
		return m == null ? 0 : m.get(chunk);
	}

	/** Chunks with at least one holder. */
	public static int held() {
		return COUNTS.values().stream().mapToInt(Long2IntOpenHashMap::size).sum();
	}

	/** A world stop: vanilla's tickets go with the world (they are not saved), and so do the counts. */
	public static void reset() {
		COUNTS.clear();
	}
}
