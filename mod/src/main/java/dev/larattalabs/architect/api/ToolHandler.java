package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.concurrent.CompletableFuture;

/** Answers a mod-provided tool call of a job (at most 256 KB of JSON; bigger results go in a blob). */
@FunctionalInterface
public interface ToolHandler {
	CompletableFuture<JsonElement> call(String jobId, JsonObject input);
}
