package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A placed site, as seen through the API (a snapshot; it does not follow later changes).
 *
 * @param owner null = the player's own site
 * @param ext a copy of the site's ext (for a batch item: the batch's ext merged with the item's, item keys win)
 * @param box the template's box; {@code restoreBox} adds the foundation, the approach and one row below
 * @param built for a construction site, the queued cells built so far; while {@code PLACING}, the cells written so far; for
 *              an instant site, {@code queued}
 * @param queued for a construction site, every queued cell; while {@code PLACING}, every cell the placement writes; 0 for an
 *               instant site
 * @param group (1.4.0) the site group it belongs to, or null
 * @param batchId (1.4.0) the batch that placed it, or null
 * @param itemKey (1.4.0) its item key in that batch, or null
 */
public record SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
	Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued, @Nullable String group, @Nullable String batchId,
	@Nullable String itemKey) {
	/** The 1.1.0 constructor (no group, batch or item key). */
	public SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
		Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued) {
		this(id, blueprintId, owner, ext, box, restoreBox, rotation, dimension, state, built, queued, null, null, null);
	}
}
