package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;

/**
 * (8b CK) Two marked ends of a connector ({@link ArchitectClientApi#markConnector}): its kind, the ends and the kind's params as the player
 * set them (the F-cycle's choices). Since NEXT.
 */
public record MarkedLink(String kind, BlockPos from, BlockPos to, JsonObject params) {
	public MarkedLink {
		params = params == null ? new JsonObject() : params;
	}
}
