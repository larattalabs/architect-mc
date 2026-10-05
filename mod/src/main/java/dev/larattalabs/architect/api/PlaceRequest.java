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
 */
public record PlaceRequest(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation, Mode mode,
	@Nullable String owner, JsonObject ext, boolean force, @Nullable ServerPlayer actor) {
	public PlaceRequest {
		ext = ext == null ? new JsonObject() : ext;
		mode = mode == null ? Mode.AUTO : mode;
		rotation = rotation == null ? Rotation.NONE : rotation;
	}

	/** A request with the defaults: AUTO mode, no owner, no ext, no force, no actor. */
	public static PlaceRequest of(String blueprintId, ServerLevel level, BlockPos origin, Rotation rotation) {
		return new PlaceRequest(blueprintId, level, origin, rotation, Mode.AUTO, null, new JsonObject(), false, null);
	}
}
