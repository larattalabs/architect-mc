package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Whether a construction target (a building site or a construction road) waits for materials, and for what ({@link Sites#waiting},
 * {@link SiteView#siteWait()}, {@link SiteEvents#SITE_WAITING}); since 1.15.0.
 *
 * @param targetId the site or road id
 * @param waiting building, not paused, its crate present, and for at least 100 ticks in a row it placed no cell while a frontier
 *                cell (unbuilt, supported, in a loaded chunk) was unaffordable. A target held only by a player in a cell, an unloaded
 *                chunk or a pause is not waiting for materials. Once true it holds until a cell is placed or the target is paused,
 *                built or removed
 * @param waitingSince the world's game time (ticks) when {@code waiting} began; 0 when not waiting. Saved with the world, so the
 *                     time survives a restart
 * @param nextNeeded the items the target lacks, in build order (an item enters the list at the first cell its available stock cannot
 *                   pay), at most 8; each {@code count} is that item's whole shortfall for the target. Filled whenever any shortfall
 *                   exists, waiting or not
 * @param moreUnits the units of the shortfalls beyond the first 8 entries; the counts plus {@code moreUnits} equal the target's
 *                  outstanding bill minus what is available to it
 * @param blocked (M5 FK, since 1.59.0) why the target waits on something other than materials, else null: {@link #FILL_BLOCKED}, a declared
 *                container of a filled-container entry is not empty at its fill (it is never filled over cargo), so the target waits
 *                ({@code waiting} true) until it is emptied
 * @param blockedCells (M5 FK, since 1.59.0) the world cells that hold it back ({@link #FILL_BLOCKED}: the declared containers that are not
 *                     empty); empty when {@code blocked} is null
 */
public record SiteWait(String targetId, boolean waiting, long waitingSince, List<ItemCount> nextNeeded, int moreUnits, @Nullable String blocked,
	List<BlockPos> blockedCells) {
	/** (M5 FK, since 1.59.0) {@link #blocked}: a declared container is not empty at the fill. */
	public static final String FILL_BLOCKED = "fill_blocked";

	public SiteWait {
		nextNeeded = nextNeeded == null ? List.of() : List.copyOf(nextNeeded);
		blockedCells = blockedCells == null ? List.of() : List.copyOf(blockedCells);
	}

	/** The 1.15.0 shape: not blocked. */
	public SiteWait(String targetId, boolean waiting, long waitingSince, List<ItemCount> nextNeeded, int moreUnits) {
		this(targetId, waiting, waitingSince, nextNeeded, moreUnits, null, List.of());
	}
}
