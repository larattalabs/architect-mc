package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A design request (docs/CONTRACT.md "Protocol" {@code DesignRequest}, plus review 1's fields).
 *
 * @param type a building type ({@code house, cabin, cottage, tower, shop, tavern, barn, smithy, chapel, gatehouse, custom})
 * @param maxSize x/z 7..96, y 6..64
 * @param remix a library id to remix, or null
 * @param owner, ext, model, budgetUsd sent to the sidecar only when it speaks protocol 2; owner and ext are kept by the mod
 *              either way ({@link Designs#list}, ext copied into the new entry)
 * @param bible, group reserved for phase 4b, ignored until then
 */
public record DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
	@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
	@Nullable String bible, @Nullable String group) {
	public DesignRequest {
		features = features == null ? List.of() : List.copyOf(features);
		ext = ext == null ? new JsonObject() : ext;
	}
}
