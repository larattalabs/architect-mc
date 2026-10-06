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
 * @param images (since 1.6.0, a helper with {@code "jobImages"}) PNG or JPEG blobs ({@link Jobs#putBlob}, at most 5 MB each) sent
 *     to the model as image content blocks before the prompt text, each after its label; at most {@link #MAX_IMAGES}
 */
public record JobSpec(String kind, String prompt, @Nullable String system, @Nullable String model, @Nullable String effort,
	@Nullable JsonObject schema, List<Tool> tools, @Nullable Double budgetUsd, @Nullable Integer maxTurns, @Nullable String owner,
	@Nullable String tag, @Nullable String group, JsonObject ext, List<String> blobs, List<ImageRef> images) {
	/** The most images a job takes (since 1.6.0). */
	public static final int MAX_IMAGES = 8;

	public JobSpec {
		tools = tools == null ? List.of() : List.copyOf(tools);
		blobs = blobs == null ? List.of() : List.copyOf(blobs);
		ext = ext == null ? new JsonObject() : ext;
		images = images == null ? List.of() : List.copyOf(images);
		if (images.size() > MAX_IMAGES) {
			throw new IllegalArgumentException("a job takes at most " + MAX_IMAGES + " images (got " + images.size() + ")");
		}
	}

	/** The 1.1.0 constructor (no images). */
	public JobSpec(String kind, String prompt, @Nullable String system, @Nullable String model, @Nullable String effort, @Nullable JsonObject schema,
		List<Tool> tools, @Nullable Double budgetUsd, @Nullable Integer maxTurns, @Nullable String owner, @Nullable String tag, @Nullable String group,
		JsonObject ext, List<String> blobs) {
		this(kind, prompt, system, model, effort, schema, tools, budgetUsd, maxTurns, owner, tag, group, ext, blobs, List.of());
	}

	/** A copy with these images (at most {@link #MAX_IMAGES}). Since 1.6.0. */
	public JobSpec images(List<ImageRef> refs) {
		return new JobSpec(kind, prompt, system, model, effort, schema, tools, budgetUsd, maxTurns, owner, tag, group, ext, blobs, refs);
	}

	/**
	 * An image of a job (since 1.6.0).
	 *
	 * @param blob a blob id from {@link Jobs#putBlob} (a PNG or JPEG)
	 * @param label what it shows, 1-200 characters (sent before the image)
	 */
	public record ImageRef(String blob, String label) {
		public ImageRef {
			if (blob == null || blob.isBlank()) {
				throw new IllegalArgumentException("an image needs a blob id");
			}
			label = label == null ? "" : label.strip();
			if (label.isEmpty() || label.length() > 200) {
				throw new IllegalArgumentException("an image label is 1 to 200 characters");
			}
		}
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
