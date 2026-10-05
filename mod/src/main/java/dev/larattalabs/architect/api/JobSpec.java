package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A job (docs/CONTRACT.md "Jobs (R2): protocol 2", {@code JobSpec}).
 *
 * @param kind {@code "structured"} or {@code "agent"}
 * @param model null = the sidecar's default
 * @param effort {@code low | medium | high | xhigh}, or null
 * @param schema the JSON schema a structured job's answer must validate against
 * @param tools mod-provided tools (their handlers are registered with {@link Jobs#registerTool})
 * @param budgetUsd a hard stop enforced by the sidecar, or null
 * @param blobs blob ids copied into the job's scratch dir
 */
public record JobSpec(String kind, String prompt, @Nullable String system, @Nullable String model, @Nullable String effort,
	@Nullable JsonObject schema, List<Tool> tools, @Nullable Double budgetUsd, @Nullable Integer maxTurns, @Nullable String owner,
	@Nullable String tag, @Nullable String group, JsonObject ext, List<String> blobs) {
	public JobSpec {
		tools = tools == null ? List.of() : List.copyOf(tools);
		blobs = blobs == null ? List.of() : List.copyOf(blobs);
		ext = ext == null ? new JsonObject() : ext;
	}

	/**
	 * A mod-provided tool.
	 *
	 * @param timeoutMs how long the client may take to answer (default 60 s; the clock pauses while the game is paused)
	 * @param readOnly the handler may run off the server thread
	 */
	public record Tool(String name, String description, JsonObject inputSchema, @Nullable Long timeoutMs, boolean readOnly) {
	}
}
