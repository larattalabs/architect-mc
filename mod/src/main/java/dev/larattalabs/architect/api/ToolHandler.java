package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.concurrent.CompletableFuture;

/**
 * Answers a mod-provided tool call of a job (at most 256 KB of JSON; Architect puts a bigger answer in a blob and names it in
 * the result). A failed future (or a throw) gives the agent the error's message.
 *
 * <p>Handlers run on the server thread, unless the tool is {@code readOnly} ({@link JobSpec.Tool#readOnly()}) AND the handler
 * says it is {@link #threadSafe()}: then it runs on a worker thread, so a slow read does not stall a tick.
 */
@FunctionalInterface
public interface ToolHandler {
	CompletableFuture<JsonElement> call(String jobId, JsonObject input);

	/**
	 * Whether this handler may run off the server thread (for {@code readOnly} tools only). Default false. Since 1.1.0; a
	 * lambda gets it through {@link #threadSafe(ToolHandler)}.
	 */
	default boolean threadSafe() {
		return false;
	}

	/** {@code h}, declared thread-safe ({@link #threadSafe()} true). Since 1.1.0. */
	static ToolHandler threadSafe(ToolHandler h) {
		return new ToolHandler() {
			@Override
			public CompletableFuture<JsonElement> call(String jobId, JsonObject input) {
				return h.call(jobId, input);
			}

			@Override
			public boolean threadSafe() {
				return true;
			}
		};
	}
}
