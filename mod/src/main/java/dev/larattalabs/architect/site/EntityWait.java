package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import org.jspecify.annotations.Nullable;

/**
 * (slice LR2-FIX) A restore that clears what it pops ({@link Sites.Drops}) waits until the entities of every chunk it looks at are loaded and
 * visible. {@code Drops} reads item entities through {@code getEntitiesOfClass}, which walks only accessible entity sections: before a chunk's
 * entities load (a restore rolled forward at world start, or a job resumed with no player near), its {@code before} snapshot misses a player's
 * own items there (a later clear then takes them) and its clears miss what the write pops (one item minted: the LR-2s restart pop).
 *
 * <p>One rule: no {@code Drops} snapshot or write of a gated restore while any chunk of its drop area (its box inflated by 1, as {@code Drops}
 * reads it) has entities not loaded or not visible. A restore that has to wait takes a loading ticket on those chunks ({@link ChunkTickets},
 * the placement ticket, so the counts stay one per chunk), so the wait ends without a player near. A one-tick write lets go
 * {@link #RELEASE_TICKS} after it passed (past {@code Drops}' later pass); a job that writes over ticks ({@code keep}) lets go when it ends. A
 * wait no one retried for {@link #STALE_TICKS} lets go by itself. Tickets are not saved: a world stop drops them, and the next start waits again.
 * Server thread.
 */
public final class EntityWait {
	/** The world side (a seam for tests). */
	public interface World {
		/** Whether {@code chunk}'s entities are loaded and its entity sections accessible. */
		boolean ready(long chunk);

		ChunkTickets.Source tickets();

		String dimension();

		int now();
	}

	/** Ticks a one-tick write's ticket is kept after it passed: past {@code Drops}' later pass (3 ticks). */
	static final int RELEASE_TICKS = 5;
	/** Ticks after which a wait that was not retried lets its ticket go (its owner gave up, or was resolved another way). */
	static final int STALE_TICKS = 1200;

	private static final class Held {
		final String dimension;
		final List<Long> chunks;
		final ChunkTickets.Source source;
		final boolean keep;
		int touched;
		int releaseAt = -1;

		Held(String dimension, List<Long> chunks, ChunkTickets.Source source, boolean keep, int now) {
			this.dimension = dimension;
			this.chunks = chunks;
			this.source = source;
			this.keep = keep;
			this.touched = now;
		}
	}

	private static final Map<String, Held> HELD = new HashMap<>();

	private EntityWait() {
	}

	/** The chunks (packed) of {@code box}'s drop area: the box inflated by 1, as {@code Sites.Drops} reads it. */
	public static List<Long> chunks(Anchors.Bounds box) {
		List<Long> out = new ArrayList<>();
		for (int cx = (box.minX() - 1) >> 4; cx <= (box.maxX() + 1) >> 4; cx++) {
			for (int cz = (box.minZ() - 1) >> 4; cz <= (box.maxZ() + 1) >> 4; cz++) {
				out.add(ChunkPos.pack(cx, cz));
			}
		}
		return out;
	}

	/** The first chunk of {@code chunks} that is not ready, or null when every one is. */
	static @Nullable Long notReady(World w, List<Long> chunks) {
		for (long c : chunks) {
			if (!w.ready(c)) {
				return c;
			}
		}
		return null;
	}

	/**
	 * Whether {@code key}'s restore may snapshot and write now. Not ready: its ticket is taken (once per key; a retry only renews it) and it waits.
	 * Ready: a one-tick write's ticket goes {@link #RELEASE_TICKS} later; a {@code keep} one stays until {@link #release}.
	 */
	static boolean ready(World w, String key, List<Long> chunks, boolean keep) {
		Long missing = notReady(w, chunks);
		Held h = HELD.get(key);
		if (missing == null) {
			if (h != null && !h.keep) {
				h.releaseAt = w.now() + RELEASE_TICKS;
			}
			return true;
		}
		if (h == null) {
			ChunkTickets.acquire(w.dimension(), chunks, w.tickets());
			HELD.put(key, new Held(w.dimension(), List.copyOf(chunks), w.tickets(), keep, w.now()));
			Architect.LOGGER.info("Restore {} waits for the entities of {} chunk(s) (e.g. chunk {}, {}) to load; a ticket holds them", key, chunks.size(),
				ChunkPos.getX(missing), ChunkPos.getZ(missing));
		} else {
			h.touched = w.now();
			h.releaseAt = -1;
		}
		return false;
	}

	/**
	 * {@code snapshot} taken only once {@code key}'s chunks are ready; otherwise it throws ("entities not loaded"), so a txn's W holds and is
	 * retried next tick, nothing snapshot and nothing written.
	 */
	static <T> T gated(World w, String key, List<Long> chunks, Supplier<T> snapshot) {
		if (!ready(w, key, chunks, false)) {
			Long missing = notReady(w, chunks);
			throw new IllegalStateException("entities not loaded" + (missing == null ? "" : " at chunk " + ChunkPos.getX(missing) + "," + ChunkPos.getZ(missing)));
		}
		return snapshot.get();
	}

	/** {@link #gated} over {@code box}'s drop area in {@code level}. */
	public static <T> T gated(ServerLevel level, String key, Anchors.Bounds box, Supplier<T> snapshot) {
		return gated(world(level), key, chunks(box), snapshot);
	}

	/** {@link #ready} over {@code box}'s drop area in {@code level}. */
	public static boolean ready(ServerLevel level, String key, Anchors.Bounds box, boolean keep) {
		return ready(world(level), key, chunks(box), keep);
	}

	/** {@code key}'s ticket goes now (a job that writes over ticks ended, or broke). */
	public static void release(String key) {
		Held h = HELD.remove(key);
		if (h != null) {
			ChunkTickets.release(h.dimension, h.chunks, h.source);
		}
	}

	/** Each server tick: tickets past their release, and waits no one retried for {@link #STALE_TICKS}, let go. */
	static void tick(int now) {
		for (Iterator<Map.Entry<String, Held>> it = HELD.entrySet().iterator(); it.hasNext();) {
			Map.Entry<String, Held> e = it.next();
			Held h = e.getValue();
			boolean due = h.releaseAt >= 0 && now >= h.releaseAt;
			boolean stale = !h.keep && h.releaseAt < 0 && now - h.touched > STALE_TICKS;
			if (due || stale) {
				if (stale) {
					Architect.LOGGER.warn("Restore {}: its entity wait was not retried for {} ticks; its ticket goes", e.getKey(), STALE_TICKS);
				}
				it.remove();
				ChunkTickets.release(h.dimension, h.chunks, h.source);
			}
		}
	}

	/** The keys holding a ticket (tests). */
	static int held() {
		return HELD.size();
	}

	/** A world stop: vanilla's tickets go with the world (ChunkTickets resets its counts). */
	static void reset() {
		HELD.clear();
	}

	static World world(ServerLevel level) {
		return new World() {
			@Override
			public boolean ready(long chunk) {
				return level.areEntitiesLoaded(chunk) && EntityVisibilityView.accessible(level, chunk);
			}

			@Override
			public ChunkTickets.Source tickets() {
				return Batches.source(level);
			}

			@Override
			public String dimension() {
				return Sites.dimensionId(level);
			}

			@Override
			public int now() {
				return level.getServer().getTickCount();
			}
		};
	}
}
