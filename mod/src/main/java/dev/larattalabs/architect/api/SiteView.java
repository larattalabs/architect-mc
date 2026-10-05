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
 * @param ext a copy of the site's ext
 * @param box the template's box; {@code restoreBox} adds the foundation, the approach and one row below
 * @param built for a construction site, the queued cells built so far; for an instant site, {@code queued}
 * @param queued for a construction site, every queued cell; 0 for an instant site
 */
public record SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
	Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued) {
}
