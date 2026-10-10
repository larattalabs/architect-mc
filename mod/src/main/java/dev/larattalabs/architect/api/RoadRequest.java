package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * A road along a polyline ({@link Sites#placeRoad}, docs/CONTRACT.md phase 4e "Roads as sites"). Since 1.5.0.
 *
 * @param points 2-256 waypoints; each {@code y} is a ground hint (the ground is searched from {@code y + 8} down to
 *               {@code y - 8}); between them a 4-connected supercover line in x/z
 * @param width 1-5 (default 3), centred on the line; an even width puts the extra cell on the right of the direction of travel
 * @param surface null = automatic (dirt path on the dirt family, gravel on supported sand or stone, packed mud otherwise and on
 *                mud), else a vanilla block id
 * @param slab null = automatic (the half-step slab), else a vanilla slab id
 * @param lanterns a fence post with a lantern beside the walkway, the first 6 blocks out, then every 12
 * @param shallowDecks 1-deep water gets an oak slab deck in the air above it (else those cells are skipped and noted)
 * @param mode INSTANT only in 4e (survival roads are not in 4e); the same actor rules as buildings
 * @param partial (1.12.0) drop the failing waypoint segments ({@link RoadSpan}) and place the rest as one road with gaps (one
 *                journal entry, one undo); {@link PlaceResult#skipped} lists them. Nothing left refuses with the first span.
 *                NOT_LOADED still refuses the whole road
 */
public record RoadRequest(ServerLevel level, List<BlockPos> points, int width, @Nullable String surface, @Nullable String slab, boolean lanterns,
	boolean shallowDecks, Mode mode, @Nullable String owner, JsonObject ext, @Nullable ServerPlayer actor, boolean force, boolean partial) {
	public RoadRequest {
		points = List.copyOf(points);
		width = width <= 0 ? 3 : width;
		mode = mode == null ? Mode.AUTO : mode;
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The 1.5.0 constructor (not partial). */
	public RoadRequest(ServerLevel level, List<BlockPos> points, int width, @Nullable String surface, @Nullable String slab, boolean lanterns,
		boolean shallowDecks, Mode mode, @Nullable String owner, JsonObject ext, @Nullable ServerPlayer actor, boolean force) {
		this(level, points, width, surface, slab, lanterns, shallowDecks, mode, owner, ext, actor, force, false);
	}

	/** A width-3 automatic road without lanterns or decks, no owner or actor. */
	public static RoadRequest of(ServerLevel level, List<BlockPos> points) {
		return new RoadRequest(level, points, 3, null, null, false, false, Mode.AUTO, null, new JsonObject(), null, false, false);
	}

	/** The same request, partial or not (1.12.0). */
	public RoadRequest withPartial(boolean p) {
		return new RoadRequest(level, points, width, surface, slab, lanterns, shallowDecks, mode, owner, ext, actor, force, p);
	}
}
