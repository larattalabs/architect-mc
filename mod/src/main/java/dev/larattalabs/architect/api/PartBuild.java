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
 *                     creative region. Its staged targets are among {@code targets}. Since 1.68.0.
 * @param terrainBuilt of them, built. While {@code state} is {@code building}, Steward's NPC avoids the part's box
 *                     (S-8a-1). Since 1.68.0.
 * @param status (8b BS, feature {@code "buildStatus"}; Since NEXT) its {@link BuildStatus}, never null: {@code built} when every target is
 *               built, else the winner by {@link BuildStatus#PRECEDENCE} of its targets' statuses and its items' waits (a terrain or stage
 *               wait, a bill cap), else {@code building}
 * @param lot (Since NEXT) the lot the part builds, or null
 */
public record PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells, long terrainCells, long terrainBuilt,
	BuildStatus status, @org.jspecify.annotations.Nullable String lot) {
	public PartBuild {
		targets = List.copyOf(targets);
		status = status == null ? BuildStatus.ofPartState(state) : status;
	}

	/** The 1.68.0 shape: the status from {@code state} alone, no lot. */
	public PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells, long terrainCells, long terrainBuilt) {
		this(part, state, targets, cells, built, freeCells, terrainCells, terrainBuilt, null, null);
	}

	/** The 1.38.0 shape: no staged terrain ({@link #terrainCells} and {@link #terrainBuilt} 0). */
	public PartBuild(String part, String state, List<String> targets, long cells, long built, long freeCells) {
		this(part, state, targets, cells, built, freeCells, 0, 0);
	}
}
