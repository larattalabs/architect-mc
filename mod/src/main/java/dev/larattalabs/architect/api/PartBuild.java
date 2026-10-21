package dev.larattalabs.architect.api;

import java.util.List;

/**
 * One plan part of a survival region's build ({@link RegionBuild#parts}). Since 1.38.0.
 *
 * @param part the plan part id (a bundled program's IR part; a shared route's first connector; {@code __lamps__} for the route lamps)
 * @param state {@code waiting} (nothing built yet), {@code building} or {@code built}
 * @param targets the part's construction targets (cell sites, ids for {@link Sites#setFeedOrder}, {@link Sites#pause} and
 *                {@link Sites#waiting})
 * @param cells the targets' cells (paid and held)
 * @param built of them, built
 * @param freeCells the part's cells written at once in the free pass
 */
public record PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells) {
	public PartBuild {
		targets = List.copyOf(targets);
	}
}
