package dev.larattalabs.architect.api;

import java.util.List;

/**
 * Whether a construction target waits for materials (C25, docs/CONTRACT.md phase 6c slice Y §6). Filled by slice Y2; in 1.18.0
 * {@link Stockpile#waiting} is empty. Since 1.18.0.
 *
 * @param targetId the site, road or delta site
 * @param waiting building, not paused, its crate or stockpile present, and for at least 100 ticks it placed no cell while some
 *                loaded frontier cell was unaffordable
 * @param waitingSince the game time at the start edge (0 when not waiting)
 * @param nextNeeded the shortfalls in build order (at most 8)
 * @param moreUnits the units of the omitted ones
 */
public record SiteWait(String targetId, boolean waiting, long waitingSince, List<ItemCount> nextNeeded, int moreUnits) {
	public SiteWait {
		nextNeeded = nextNeeded == null ? List.of() : List.copyOf(nextNeeded);
	}
}
