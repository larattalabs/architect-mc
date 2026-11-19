package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (8b LY, feature {@code "regionLayout"}) One plan part's shape for a settlement map ({@link RegionLayout#parts}). Since 1.69.0.
 *
 * <p>(LYW, feature {@code "layoutWalls"}; Since 1.70.0) {@code width}, {@code height}, {@code wall} and {@code wallAt}: a walled town's wall
 * and what stands on it. A wall ({@code connector.wall}) is one shape: its {@code ends} its line, each consecutive pair one straight run (a
 * closed wall's last point is its first again), {@code width} its thickness, {@code height} its height. Each gate opening is a shape of kind
 * {@code connector.gate} (a named gate part's id, else the wall's own gate id; a gatehouse's passage is {@code <lot>_passage}, its ends the
 * passage's front and back). A {@code corners: tower} wall's corner towers are kind {@code tower} ({@code <wall>_tower_<n>}). Towers and
 * gatehouses that are lots on the wall stay kind {@code lot}, with {@code wall} set and {@code wallAt} {@code corner}, {@code gate} or
 * {@code run}. A route's {@code width} is its road width, and a district's connecting route (its stairs and graded sections too) is kind
 * {@code route}.
 *
 * @param part the plan part id: equal to {@link PartBuild#part} for a survival region's built part, so a shape takes its status colour
 * @param kind the plan/0 kind ({@code connector.rope_bridge}, {@code route}, {@code tile}, {@code lot}, {@code form.hollow_mountain},
 *             {@code relief}, {@code __lamps__}, {@code connector.wall}, {@code connector.gate}, {@code tower}, ...); appended only
 * @param stage the part's stage, or null
 * @param box the part's world box
 * @param ends a connector's from and to, a route's or a wall's polyline (at most {@link #MAX_ENDS} points, simplified), a gate's opening
 *             (a passage's front and back); empty otherwise
 * @param revision the rid of the revision that added it (0: the realised plan's)
 * @param lot the lot it is ({@code kind} {@code lot}) or belongs to, or null
 * @param targets its construction targets (site and road ids, {@link PartBuild#targets}); empty in creative or before put-down
 * @param width (Since 1.70.0) a route's width, a wall's thickness, a gate's opening width; 0 when it has none
 * @param height (Since 1.70.0) a wall's height, a gate's opening height, a corner tower's; 0 when it has none
 * @param wall (Since 1.70.0) the wall it is ({@code connector.wall}) or stands on (a gate, a corner tower, a tower or gatehouse lot); null
 *             otherwise
 * @param wallAt (Since 1.70.0) where on its wall: {@code corner}, {@code gate} or {@code run} (a lot as the wall sited it; a gate is
 *               {@code gate}, a corner tower {@code corner}); null when {@code wall} is null or for the wall itself
 */
public record PartShape(String part, String kind, @Nullable String stage, BoundingBox box, List<BlockPos> ends, int revision, @Nullable String lot,
	List<String> targets, int width, int height, @Nullable String wall, @Nullable String wallAt) {
	/** The most points a route's polyline keeps. */
	public static final int MAX_ENDS = 64;

	public PartShape {
		ends = ends == null ? List.of() : List.copyOf(ends);
		targets = targets == null ? List.of() : List.copyOf(targets);
	}

	/** The 1.69.0 constructor: no width, height or wall. */
	public PartShape(String part, String kind, @Nullable String stage, BoundingBox box, List<BlockPos> ends, int revision, @Nullable String lot,
		List<String> targets) {
		this(part, kind, stage, box, ends, revision, lot, targets, 0, 0, null, null);
	}
}
