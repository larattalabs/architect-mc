package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Optional;

/**
 * A job as the sidecar reports it ({@code job.upsert}).
 *
 * @param spec the spec as sent (the prompt cut at 2000 chars)
 * @param status {@code queued | running | waiting_tool | held | done | failed | cancelled}
 * @param result structured: the validated JSON; agent: the final text plus an optional JSON
 */
public record Job(String id, JsonObject spec, String status, String step, Optional<JsonElement> result, Optional<String> error, Cost cost,
	long createdAt, long updatedAt) {
	public boolean finished() {
		return "done".equals(status) || "failed".equals(status) || "cancelled".equals(status);
	}
}
