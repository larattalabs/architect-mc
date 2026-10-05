package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Optional;

/**
 * A job as the sidecar reports it ({@code job.upsert}).
 *
 * @param spec the spec as sent (the prompt cut at 2000 chars)
 * @param status {@code queued | running | waiting_tool | held | done | failed | cancelled}
 * @param result structured: the validated JSON; agent: {@code {text, json?}}. A result over 256 KB comes in a blob
 *     ({@code resultBlob}); Architect reads it back into {@code result} before {@code JOB_DONE} when it can
 * @param error failed: why ({@code "budget"} when the budget stopped it)
 * @param resultBlob the blob that holds a result over 256 KB (since 1.1.0)
 */
public record Job(String id, JsonObject spec, String status, String step, Optional<JsonElement> result, Optional<String> error, Cost cost,
	long createdAt, long updatedAt, Optional<String> resultBlob) {
	/** The 1.0.0 constructor (no {@code resultBlob}). */
	public Job(String id, JsonObject spec, String status, String step, Optional<JsonElement> result, Optional<String> error, Cost cost,
		long createdAt, long updatedAt) {
		this(id, spec, status, step, result, error, cost, createdAt, updatedAt, Optional.empty());
	}

	public boolean finished() {
		return "done".equals(status) || "failed".equals(status) || "cancelled".equals(status);
	}

	/** The spec's {@code owner}, if any. Since 1.1.0. */
	public Optional<String> owner() {
		return spec.has("owner") && spec.get("owner").isJsonPrimitive() ? Optional.of(spec.get("owner").getAsString()) : Optional.empty();
	}
}
