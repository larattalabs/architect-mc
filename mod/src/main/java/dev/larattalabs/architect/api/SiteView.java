package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
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
 * @param kind (1.5.0) {@code building}, {@code road} or {@code cells:<kind>}; for a road or cell site {@code blueprintId} is the
 *             same string
 * @param policy (1.5.0) how its undo treats its cells (buildings BOX, roads CELL, cell sites as requested)
 * @param covers (1.5.0) the sites it lies on top of (any cell)
 * @param coveredBy (1.5.0) the sites lying on top of it (any cell)
 * @param region (1.8.0) the region it belongs to (a tile, road or lot of a realised region), or null
 */
public record SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
	Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued, @Nullable String group, @Nullable String batchId,
	@Nullable String itemKey, String kind, Policy policy, List<String> covers, List<String> coveredBy, int version, int headVersion, int deviations,
	boolean updating, @Nullable String region) {
	public SiteView {
		kind = kind == null ? "building" : kind;
		policy = policy == null ? Policy.BOX : policy;
		covers = covers == null ? List.of() : List.copyOf(covers);
		coveredBy = coveredBy == null ? List.of() : List.copyOf(coveredBy);
	}

	/** The 1.7.0 constructor (no region). */
	public SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
		Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued, @Nullable String group, @Nullable String batchId,
		@Nullable String itemKey, String kind, Policy policy, List<String> covers, List<String> coveredBy, int version, int headVersion, int deviations,
		boolean updating) {
		this(id, blueprintId, owner, ext, box, restoreBox, rotation, dimension, state, built, queued, group, batchId, itemKey, kind, policy, covers,
			coveredBy, version, headVersion, deviations, updating, null);
	}

	/** The 1.5.0 constructor (no versions: version and headVersion 1, no deviations, not updating). */
	public SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
		Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued, @Nullable String group, @Nullable String batchId,
		@Nullable String itemKey, String kind, Policy policy, List<String> covers, List<String> coveredBy) {
		this(id, blueprintId, owner, ext, box, restoreBox, rotation, dimension, state, built, queued, group, batchId, itemKey, kind, policy, covers,
			coveredBy, 1, 1, 0, false);
	}

	/** The 1.4.0 constructor (a building, BOX, nothing layered). */
	public SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
		Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued, @Nullable String group, @Nullable String batchId,
		@Nullable String itemKey) {
		this(id, blueprintId, owner, ext, box, restoreBox, rotation, dimension, state, built, queued, group, batchId, itemKey, "building", Policy.BOX,
			List.of(), List.of());
	}

	/** The 1.1.0 constructor (no group, batch or item key). */
	public SiteView(String id, String blueprintId, @Nullable String owner, JsonObject ext, BoundingBox box, BoundingBox restoreBox,
		Rotation rotation, ResourceKey<Level> dimension, State state, int built, int queued) {
		this(id, blueprintId, owner, ext, box, restoreBox, rotation, dimension, state, built, queued, null, null, null);
	}
}
