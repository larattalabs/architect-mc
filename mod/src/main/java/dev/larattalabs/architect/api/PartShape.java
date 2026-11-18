package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (8b LY, feature {@code "regionLayout"}) One plan part's shape for a settlement map ({@link RegionLayout#parts}). Since 1.69.0.
 *
 * @param part the plan part id: equal to {@link PartBuild#part} for a survival region's built part, so a shape takes its status colour
 * @param kind the plan/0 kind ({@code connector.rope_bridge}, {@code route}, {@code tile}, {@code lot}, {@code form.hollow_mountain},
 *             {@code relief}, {@code __lamps__}, ...); appended only
 * @param stage the part's stage, or null
 * @param box the part's world box
 * @param ends a connector's from and to, or a route's polyline (at most {@link #MAX_ENDS} points, simplified); empty otherwise
 * @param revision the rid of the revision that added it (0: the realised plan's)
 * @param lot the lot it is ({@code kind} {@code lot}) or belongs to, or null
 * @param targets its construction targets (site and road ids, {@link PartBuild#targets}); empty in creative or before put-down
 */
public record PartShape(String part, String kind, @Nullable String stage, BoundingBox box, List<BlockPos> ends, int revision, @Nullable String lot,
	List<String> targets) {
	/** The most points a route's polyline keeps. */
	public static final int MAX_ENDS = 64;

	public PartShape {
		ends = ends == null ? List.of() : List.copyOf(ends);
		targets = targets == null ? List.of() : List.copyOf(targets);
	}
}
