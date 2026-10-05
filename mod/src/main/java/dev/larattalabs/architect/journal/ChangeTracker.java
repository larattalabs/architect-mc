package dev.larattalabs.architect.journal;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * Change tracking for captures that are not written in the same tick (docs/CONTRACT.md "Phase 4e contract", "Capture in one
 * tick"): from the first slice of a capture until its commit is durable, a hook on chunk block changes
 * ({@code LevelChunkMixin}) records every changed position inside the reserved sections; those positions are captured again
 * before the blocks are written, so the capture equals a one-tick capture taken then. Server thread.
 */
public final class ChangeTracker {
	private static final List<ChangeTracker> ACTIVE = new ArrayList<>();
	/** Section keys any tracker reserves, per level (a fast test for every block change). */
	private static final java.util.Map<Level, LongOpenHashSet> RESERVED = new java.util.IdentityHashMap<>();

	final Level level;
	final LongOpenHashSet sections;
	final LongOpenHashSet changed = new LongOpenHashSet();

	private ChangeTracker(Level level, LongOpenHashSet sections) {
		this.level = level;
		this.sections = sections;
	}

	/** Starts tracking block changes in these sections of {@code level}. */
	public static ChangeTracker start(Level level, Iterable<Long> sectionKeys) {
		LongOpenHashSet s = new LongOpenHashSet();
		sectionKeys.forEach(s::add);
		ChangeTracker t = new ChangeTracker(level, s);
		ACTIVE.add(t);
		RESERVED.computeIfAbsent(level, l -> new LongOpenHashSet()).addAll(s);
		return t;
	}

	/** Stops tracking. */
	public void stop() {
		ACTIVE.remove(this);
		LongOpenHashSet r = new LongOpenHashSet();
		for (ChangeTracker t : ACTIVE) {
			if (t.level == level) {
				r.addAll(t.sections);
			}
		}
		if (r.isEmpty()) {
			RESERVED.remove(level);
		} else {
			RESERVED.put(level, r);
		}
	}

	/** The positions changed since the last call (and forgets them). */
	public long[] drain() {
		long[] out = changed.toLongArray();
		changed.clear();
		return out;
	}

	public boolean dirty() {
		return !changed.isEmpty();
	}

	/** {@code LevelChunkMixin}: a block changed. */
	public static void changed(Level level, BlockPos pos) {
		if (RESERVED.isEmpty()) {
			return;
		}
		LongOpenHashSet r = RESERVED.get(level);
		if (r == null) {
			return;
		}
		long key = Sections.key(pos.getX() >> 4, pos.getY() >> 4, pos.getZ() >> 4);
		if (!r.contains(key)) {
			return;
		}
		for (ChangeTracker t : ACTIVE) {
			if (t.level == level && t.sections.contains(key)) {
				t.changed.add(pos.asLong());
			}
		}
	}

	/** World stop. */
	public static void reset() {
		ACTIVE.clear();
		RESERVED.clear();
	}
}
