package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Objects;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * (7c) A request to {@link Sites#placeConnector}: a single 7a connector outside any region, between two points a player marks (or from
 * a site house's port to ground) (docs/CONTRACT.md "Phase 7c" §2, slice CX, §7.8, N-7b-1). Frozen by the 7c foundation; built by slice
 * CX (feature {@code "placeConnector"}). Since NEXT.
 *
 * @param kind the connector's plan/0 kind, such as {@code rope_bridge}, {@code ladder}, {@code catwalk}, {@code rock_stair}
 * @param from the first end (world cell)
 * @param to the second end (world cell)
 * @param styleId the Style its blocks come from, or null (the default)
 * @param params the kind's own members, as its plan/0 def has them; null is empty
 * @param mode the placement mode
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}})
 */
public record ConnectorRequest(String kind, BlockPos from, BlockPos to, @Nullable String styleId, JsonObject params, Mode mode, String opKey) {
	public ConnectorRequest {
		Objects.requireNonNull(kind, "kind");
		Objects.requireNonNull(from, "from");
		Objects.requireNonNull(to, "to");
		Objects.requireNonNull(mode, "mode");
		Objects.requireNonNull(opKey, "opKey");
		params = params == null ? new JsonObject() : params;
	}
}
