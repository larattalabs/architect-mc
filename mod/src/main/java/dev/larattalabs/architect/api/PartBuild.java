package dev.larattalabs.architect.api;

import java.util.List;

/**
 * One plan part of a survival region's build ({@link RegionBuild#parts}). Since 1.38.0.
 *
 * @param part the plan part id (a bundled program's IR part; a shared route's first connector; {@code __lamps__} for the route lamps)
 * @param state {@code waiting} (nothing built yet), {@code building} or {@code built}
 * @param targets the part's construction targets (cell sites, ids for {@link Sites#setFeedOrder}, {@link Sites#pause} and
 *                {@link Sites#waiting})
 * @param cells the targets' cells (paid and held; (8a) staged terrain cells are in {@code terrainCells}, not here)
 * @param built of them, built
 * @param freeCells the part's cells written at once in the free pass
 * @param terrainCells (8a, feature {@code terrainConstruction}) the part's staged terrain cells: a survival region's land (relief, pads'
 *                     cut and fill, forms, scatter and stamps) built over time, free (docs/CONTRACT.md "Phase 8a" §6). 0 with none, in a
 *                     creative region. Its staged targets are among {@code targets}. Since NEXT.
 * @param terrainBuilt of them, built. While {@code state} is {@code building}, Steward's NPC avoids the part's box
 *                     (S-8a-1). Since NEXT.
 */
public record PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells, long terrainCells, long terrainBuilt) {
	public PartBuild {
		targets = List.copyOf(targets);
	}

	/** The 1.38.0 shape: no staged terrain ({@link #terrainCells} and {@link #terrainBuilt} 0). */
	public PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells) {
		this(part, state, targets, cells, built, freeCells, 0, 0);
	}
}
