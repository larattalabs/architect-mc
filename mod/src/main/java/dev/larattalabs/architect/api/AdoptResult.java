package dev.larattalabs.architect.api;

import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * What {@link Sites#adopt} made (docs/CONTRACT.md "Phase 6c slice PT2"): the new site and its library entry at version 1, the build
 * it stands on, the box of the captured cells, the captured cells (blocks and the column-filled air), the air among them, the block
 * entities (inventories never captured), the cells left void inside the box (natural cells, fluids, other players' blocks, open
 * columns), the front and whether it was guessed (no entrance: SQ-PT2-1). Since PT2.
 */
public record AdoptResult(String siteId, String entryId, int version, String buildId, BoundingBox box, int cells, int airCells, int blockEntities,
	int skipped, Direction front, boolean frameGuessed) {
}
