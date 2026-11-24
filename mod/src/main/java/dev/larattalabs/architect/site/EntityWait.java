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
 * <p>One rule: no {@code Drops} snapshot or write of a gated restore while any chunk vanilla's entity query searches for its drop area (its
 * box inflated by 1, as {@code Drops} reads it, plus the query's 2-block margin: an entity centred in a neighbouring chunk whose bounding box
 * reaches in is found too) has entities not loaded or not visible; and every gated restore holds a loading ticket on those chunks from its
 * gate until its drop cleanup is past ({@link ChunkTickets}, the placement ticket, so the counts stay one per chunk), ready or not, so a player
 * leaving can't hide them in between and a wait ends without a player near. A one-tick write lets go {@link #RELEASE_TICKS} after it passed
 * (past {@code Drops}' later pass); a job that writes over ticks ({@code keep}) lets go when it retires ({@link #guard}: done, broken or
 * thrown; {@link #release} on a cancel). A wait no one retried for {@link #STALE_TICKS} lets go by itself. A live synchronous restore refuses
 * ({@link #requireLive}, NOT_LOADED, retryable) instead of waiting. Tickets are not saved: a world stop drops them, and the next start waits
 * again. Server thread.
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
		final String base;
		final String dimension;
		final List<Long> chunks;
		final ChunkTickets.Source source;
		boolean keep;
		int touched;
		int releaseAt = -1;

		Held(String base, String dimension, List<Long> chunks, ChunkTickets.Source source, boolean keep, int now) {
			this.base = base;
			this.dimension = dimension;
			this.chunks = chunks;
			this.source = source;
			this.keep = keep;
			this.touched = now;
		}
	}

	/** The leases, by {@link Lease}: one per caller key, dimension and footprint (fix-check P2-2). */
	private static final Map<Lease, Held> HELD = new HashMap<>();
	/** The last server tick seen ({@link #tick} and {@link #ready}): the clock a retirement's delayed release counts from. */
	private static int clock;

	/**
	 * (fix-check P2-2; final-check P2) A lease is one caller key over one dimension and one footprint: a removal refused under KEEP and retried
	 * as CASCADE (more chunks), or a site moved twice in a row to equal-size footprints, gets a lease of its own, never another footprint's
	 * tickets with its own checks. The footprint is the complete sorted chunk list, compared chunk by chunk (no checksum: two different
	 * rectangles never share a lease).
	 */
	record Lease(String key, String dimension, List<Long> chunks) {
	}

	static Lease leaseKey(String key, String dimension, List<Long> chunks) {
		return new Lease(key, dimension, chunks.stream().sorted().toList());
	}

	private EntityWait() {
	}

	/** Vanilla's entity query margin in x and z ({@code EntitySectionStorage.forEachAccessibleNonEmptySection}: the box grown by 2.0). */
	static final int QUERY_MARGIN = 2;

	/**
	 * The chunks (packed) vanilla's entity query searches for {@code box}'s drop area: the area is {@code Occupancy.aabb(box).inflate(1)}, x in
	 * [minX - 1, maxX + 2), and the query walks sections from floor(minX - 1 - 2) to floor(maxX + 2 + 2).
	 */
	public static List<Long> chunks(Anchors.Bounds box) {
		List<Long> out = new ArrayList<>();
		int m = 1 + QUERY_MARGIN;
		for (int cx = (box.minX() - m) >> 4; cx <= (box.maxX() + 1 + m) >> 4; cx++) {
			for (int cz = (box.minZ() - m) >> 4; cz <= (box.maxZ() + 1 + m) >> 4; cz++) {
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
	 * Whether {@code key}'s restore may snapshot and write now. Its ticket is taken on the first call, ready or not (once per key; a retry
	 * renews it). Not ready: it waits. Ready: a one-tick write's ticket goes {@link #RELEASE_TICKS} later; a {@code keep} one stays until its
	 * job retires.
	 */
	static boolean ready(World w, String key, List<Long> chunks, boolean keep) {
		clock = w.now();
		Long missing = notReady(w, chunks);
		Lease lease = leaseKey(key, w.dimension(), chunks);
		Held h = HELD.get(lease);
		if (h == null) {
			// the same caller key's waiting leases on another footprint were refused attempts (nothing snapshot, nothing written): they go now; a
			// lease past its write (its cleanup window, or a job's) stays until its own release
			for (Iterator<Map.Entry<Lease, Held>> it = HELD.entrySet().iterator(); it.hasNext();) {
				Held o = it.next().getValue();
				if (o.base.equals(key) && !o.keep && o.releaseAt < 0) {
					it.remove();
					ChunkTickets.release(o.dimension, o.chunks, o.source);
				}
			}
			ChunkTickets.acquire(w.dimension(), chunks, w.tickets());
			h = new Held(key, w.dimension(), List.copyOf(chunks), w.tickets(), keep, w.now());
			HELD.put(lease, h);
			if (missing != null) {
				Architect.LOGGER.info("Restore {} waits for the entities of {} chunk(s) (e.g. chunk {}, {}) to load; a ticket holds them", key,
					chunks.size(), ChunkPos.getX(missing), ChunkPos.getZ(missing));
			}
		}
		h.touched = w.now();
		if (missing == null) {
			if (!h.keep) {
				h.releaseAt = w.now() + RELEASE_TICKS;
			}
			return true;
		}
		h.releaseAt = -1;
		return false;
	}

	/**
	 * A job's step under its entity wait: when the step ends the job (true) or throws, {@code key}'s leases retire (the one retirement path of
	 * a job that writes over ticks: Placement drops a job that threw without {@code aborted}). (fix-check P1-1) Retired, not released: its
	 * last write's {@code Drops} clear runs again 3 ticks later, so the tickets stay {@link #RELEASE_TICKS} past the retirement.
	 */
	public static boolean guard(String key, java.util.function.BooleanSupplier step) {
		boolean done = true;
		try {
			done = step.getAsBoolean();
			return done;
		} finally {
			if (done) {
				retire(key);
			}
		}
	}

	/** {@code key}'s leases go {@link #RELEASE_TICKS} after the last tick seen (past a final write's delayed {@code Drops} clear). */
	static void retire(String key) {
		for (Held h : HELD.values()) {
			if (h.base.equals(key)) {
				h.keep = false;
				int at = clock + RELEASE_TICKS;
				h.releaseAt = h.releaseAt < 0 ? at : Math.max(h.releaseAt, at);
			}
		}
	}

	/**
	 * A live synchronous restore's admission: ready, its ticket kept past its cleanup; not ready, it is refused NOT_LOADED (retryable: the
	 * ticket taken now loads the entities) before any snapshot or change.
	 */
	static void requireLive(World w, String key, List<Long> chunks, String what) throws Sites.SiteException {
		if (!ready(w, key, chunks, false)) {
			Long missing = notReady(w, chunks);
			throw new Sites.SiteException(dev.larattalabs.architect.api.Reason.NOT_LOADED, what + " waits for the entities around it to load" + (missing
				== null ? "" : " (chunk " + ChunkPos.getX(missing) + "," + ChunkPos.getZ(missing) + ")") + "; nothing was changed, try again in a moment");
		}
	}

	/** {@link #requireLive} over {@code box}'s drop area in {@code level}. */
	public static void requireLive(ServerLevel level, String key, Anchors.Bounds box, String what) throws Sites.SiteException {
		requireLive(world(level), key, chunks(box), what);
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

	/** {@code key}'s leases go now (a job cancelled before it wrote). */
	public static void release(String key) {
		for (Iterator<Map.Entry<Lease, Held>> it = HELD.entrySet().iterator(); it.hasNext();) {
			Held h = it.next().getValue();
			if (h.base.equals(key)) {
				it.remove();
				ChunkTickets.release(h.dimension, h.chunks, h.source);
			}
		}
	}

	/** Each server tick: tickets past their release, and waits no one retried for {@link #STALE_TICKS}, let go. */
	static void tick(int now) {
		clock = now;
		for (Iterator<Map.Entry<Lease, Held>> it = HELD.entrySet().iterator(); it.hasNext();) {
			Map.Entry<Lease, Held> e = it.next();
			Held h = e.getValue();
			boolean due = h.releaseAt >= 0 && now >= h.releaseAt;
			boolean stale = !h.keep && h.releaseAt < 0 && now - h.touched > STALE_TICKS;
			if (due || stale) {
				if (stale) {
					Architect.LOGGER.warn("Restore {}: its entity wait was not retried for {} ticks; its ticket goes", h.base, STALE_TICKS);
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
