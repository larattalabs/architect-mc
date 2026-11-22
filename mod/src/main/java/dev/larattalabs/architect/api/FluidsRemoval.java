package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (8c, since NEXT; feature {@code "flowingWater"}) Where a region's removal stands with its fluid bodies ({@link RegionView#fluidsRemoval}),
 * while it does: Steward's "the river is draining" line. Null on the view before the removal reaches the bodies and once they are
 * done.
 * <ul>
 * <li>{@code phase}: an open enum (unknown values are noted, not refused): {@code "draining"} (the sources are taken, the flow is dying:
 * the removal waits up to the settle bound with no fluid tick in any watch set), {@code "restoring"} (the stray pass puts every watched
 * cell the bodies made back to its before state; the solids come next), {@code "capped"} (the wait hit its cap, 2 x the bound, with
 * water that isn't the region's still running: the solids are restored anyway, and the {@code architect_mc:fluids} rows name the
 * foreign cells).</li>
 * <li>{@code until}: the game time (ticks) the current wait ends at the latest, or -1.</li>
 * <li>{@code ticksLeft}: game ticks from now to {@code until} (0 when past or none): 20 a second.</li>
 * <li>{@code heldAt} (slice 8cTb, since NEXT): with phase {@code "held"} (the removal's drain is held: a chunk it must read or write is not
 * loaded, or a save is in doubt; it finishes by itself), where, as {@code chunk x,z}; null otherwise. The region stays REMOVING.</li>
 * </ul>
 */
public record FluidsRemoval(String phase, long until, long ticksLeft, @Nullable String heldAt) {
	public FluidsRemoval {
		phase = phase == null ? "draining" : phase;
		ticksLeft = Math.max(0, ticksLeft);
	}

	/** The constructor without {@code heldAt} (null). */
	public FluidsRemoval(String phase, long until, long ticksLeft) {
		this(phase, until, ticksLeft, null);
	}
}
