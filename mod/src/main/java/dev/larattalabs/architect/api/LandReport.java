package dev.larattalabs.architect.api;

import java.util.List;

/**
 * (6d LC) The answer of {@link Regions#landCheck} (docs/CONTRACT.md "Phase 6d slice LC"): what has changed in a standing region since it
 * was built, part by part and lot by lot. It reads and never writes, and attributes only what the records prove: a block a player placed
 * is the player's (6c PT recorded it); a missing or changed block is just changed (who removed a block is never known).
 * {@code position}: the region's revision head (0 before any revision). {@code parts}: one row per part that holds a cell on top, by
 * name. {@code lots}: one row per lot site of the region (empty when a part was asked). {@code cellsChecked}: the cells read from the
 * world (in loaded chunks); {@code unloaded}: the cells of chunks that were not loaded (counted, never loaded or read). {@code ms}: the
 * call's wall time (recorded, not judged). Since NEXT.
 */
public record LandReport(String region, int position, List<PartLand> parts, List<LotLand> lots, long cellsChecked, long unloaded, long ms) {
	public LandReport {
		parts = List.copyOf(parts);
		lots = List.copyOf(lots);
	}
}
