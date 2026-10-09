package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * A placement.
 *
 * @param origin the rotated box's minimum corner (as the placement ghost reports it)
 * @param mode see {@link Mode}: INSTANT in a survival-toggle world needs an {@code actor} with permission level 2
 * @param owner {@code <modid>:<thing>} by convention; null = the player's own site
 * @param ext namespaced extra data stored on the site (null reads as empty)
 * @param force overwrite block entities in the box (they come back on remove), as the UI's force confirm
 * @param actor the player on whose behalf it is placed (permission checks), or null for a mod on its own
 * @param overlap (1.5.0) what to do where it overlaps a standing site: null = REFUSE (or, in a batch, the batch's policy)
 * @param pathStyle (1.9.0) a road-surface block id (e.g. {@code minecraft:stone_bricks}) that styles the entrance approach, as a
 *        region lot's is (docs/CONTRACT.md "6b addition: region lot entrances"): the path is this block, joins the nearest standing
 *        road cell (a 4e road site or a region path's walk surface) within the approach's maximum length and then takes that
 *        road's block (when it is a full solid block); an entrance that opens onto a road within 1 cell gets no approach; with no
 *        road in reach the approach keeps its default length, in this block. The fill below it stays the design's foundation.
 *        Null (the default, and every older constructor) = the design's own approach, exactly as before. A bare id gets
 *        {@code minecraft:}; a block that does not exist is refused ({@code OTHER}).
 */
public record PlaceRequest(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation, Mode mode,
	@Nullable String owner, JsonObject ext, boolean force, @Nullable ServerPlayer actor, @Nullable OverlapPolicy overlap,
	@Nullable String pathStyle) {
	public PlaceRequest {
		ext = ext == null ? new JsonObject() : ext;
		mode = mode == null ? Mode.AUTO : mode;
		rotation = rotation == null ? Rotation.NONE : rotation;
		if (pathStyle != null) {
			pathStyle = pathStyle.strip().toLowerCase(java.util.Locale.ROOT);
			if (pathStyle.isEmpty()) {
				pathStyle = null;
			} else if (pathStyle.indexOf(':') < 0) {
				pathStyle = "minecraft:" + pathStyle;
			}
		}
	}

	/** The 1.5.0 constructor (no path style: the design's own approach). */
	public PlaceRequest(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation, Mode mode, @Nullable String owner, JsonObject ext,
		boolean force, @Nullable ServerPlayer actor, @Nullable OverlapPolicy overlap) {
		this(blueprintId, level, origin, rotation, mode, owner, ext, force, actor, overlap, null);
	}

	/** The 1.4.0 constructor (no overlap policy: REFUSE). */
	public PlaceRequest(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation, Mode mode, @Nullable String owner, JsonObject ext,
		boolean force, @Nullable ServerPlayer actor) {
		this(blueprintId, level, origin, rotation, mode, owner, ext, force, actor, null, null);
	}

	/** A request with the defaults: AUTO mode, no owner, no ext, no force, no actor. */
	public static PlaceRequest of(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation) {
		return new PlaceRequest(blueprintId, level, origin, rotation, Mode.AUTO, null, new JsonObject(), false, null, null, null);
	}

	/** The same request with an overlap policy. Since 1.5.0. */
	public PlaceRequest withOverlap(@Nullable OverlapPolicy policy) {
		return new PlaceRequest(blueprintId, level, origin, rotation, mode, owner, ext, force, actor, policy, pathStyle);
	}

	/** The same request with a path style ({@link #pathStyle}; null = the design's own approach). Since 1.9.0. */
	public PlaceRequest withPathStyle(@Nullable String style) {
		return new PlaceRequest(blueprintId, level, origin, rotation, mode, owner, ext, force, actor, overlap, style);
	}
}
