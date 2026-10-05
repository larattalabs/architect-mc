package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import org.jspecify.annotations.Nullable;

/**
 * A caller's own cell list placed as a site ({@link Sites#placeCells}, docs/CONTRACT.md phase 4e "Cell sites"): pad flattening,
 * and later the write path region programs stream into. Since 1.5.0.
 *
 * @param kind namespaced ({@code steward_mc:terrain}); the site's {@link SiteView#kind} is {@code cells:<kind>}
 * @param policy BOX (always restore) or CELL (restore where the world still holds the written block)
 * @param cells at most 1,000,000 ({@link Reason#TOO_LARGE} above: split into several requests of one group)
 * @param naturalOnly a cell whose current block is not natural terrain, air or water, or holds a block entity, is skipped and
 *                    noted (the default)
 * @param overlap per cell against standing sites; LAYER over BOX sites is allowed
 * @param mode INSTANT only in 4e: CONSTRUCTION is refused {@link Reason#NOT_ALLOWED}, as is INSTANT where it is not allowed
 *             (a survival-toggle world that is not creative)
 */
public record CellsRequest(ServerLevel level, String kind, Policy policy, List<CellWrite> cells, boolean naturalOnly, @Nullable OverlapPolicy overlap,
	Mode mode, @Nullable String owner, JsonObject ext, @Nullable ServerPlayer actor, boolean force) {
	public CellsRequest {
		cells = List.copyOf(cells);
		policy = policy == null ? Policy.CELL : policy;
		mode = mode == null ? Mode.AUTO : mode;
		ext = ext == null ? new JsonObject() : ext;
	}

	/** A CELL-policy, natural-only, REFUSE request with no owner or actor. */
	public static CellsRequest of(ServerLevel level, String kind, List<CellWrite> cells) {
		return new CellsRequest(level, kind, Policy.CELL, cells, true, null, Mode.AUTO, null, new JsonObject(), null, false);
	}
}
