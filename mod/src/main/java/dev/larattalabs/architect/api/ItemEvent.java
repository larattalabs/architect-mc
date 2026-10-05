package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Optional;

/**
 * What {@link SiteEvents#ITEM_PLACED}, {@link SiteEvents#ITEM_FAILED} and {@link SiteEvents#ITEM_WAITING} carry: the batch, the
 * item key and its merged ext (so a caller maps the item back to its lot), the site once there is one, and for a failure or a
 * wait the typed reason. Since 1.4.0.
 */
public record ItemEvent(String batchId, String itemKey, JsonObject ext, Optional<String> siteId, Optional<Reason> reason, String message) {
	public ItemEvent {
		ext = ext == null ? new JsonObject() : ext;
		message = message == null ? "" : message;
	}
}
