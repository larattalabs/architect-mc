package dev.larattalabs.architect.api;

import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * One named part in a blueprint delta: its status, the cells added (labelled with it in the new version), removed (in the old)
 * and changed (in either), and its box in each version in design coordinates (null where it does not exist). Since 1.7.0.
 */
public record PartDelta(String name, PartStatus status, int added, int removed, int changed, @Nullable BoundingBox boxFrom,
	@Nullable BoundingBox boxTo) {
}
