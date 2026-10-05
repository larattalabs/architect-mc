package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * Claude jobs (R2, protocol 2; docs/CONTRACT.md "Jobs"). Calls are thread-safe; futures and tool handlers run on the server
 * thread (a {@code readOnly} tool's thread-safe handler on a worker, see {@link ToolHandler#threadSafe()}). Tool handlers
 * are registered globally per (owner, tool name) at mod init, never per run: a job that resumes after a restart re-sends its
 * pending tool call and the handler registered in the new JVM answers it.
 *
 * <p>Results arrive as {@code JOB_UPDATED} / {@code JOB_DONE} events ({@link SiteEvents}), on the server thread. DONE fires
 * once per job, also for a job that finished while no world was loaded (when the next one loads).
 */
public interface Jobs {
	/** Starts a job; completes with its id once the sidecar acked it, or fails (not {@link #available()}, refused). */
	CompletableFuture<String> run(JobSpec spec);

	void cancel(String jobId);

	Optional<Job> get(String jobId);

	/** Jobs of {@code owner} (null: all), including the ones that finished while the caller was away. Newest first. */
	List<Job> list(@Nullable String owner);

	/** Registers the handler of a mod-provided tool, globally per {@code (owner, name)}. A job's tools are its spec's owner's. */
	void registerTool(String owner, String name, ToolHandler h);

	/** True when the sidecar link is up, speaks protocol 2 and runs jobs; false otherwise (no helper, no client, protocol 1). */
	boolean available();

	/**
	 * Uploads a JSON blob (a survey sample, ...) for jobs to read: a JobSpec's {@code blobs} copies it into the job's scratch
	 * dir as {@code blobs/<id>.json}. Completes with the blob id on the server thread. Up to 64 MB; kept 7 days. Since 1.1.0.
	 *
	 * @param kind a short tag, {@code [a-z0-9_.:-]{1,40}} (e.g. {@code "survey"})
	 * @param owner by convention {@code <modid>:<thing>}, or null
	 */
	CompletableFuture<String> putBlob(String kind, @Nullable String owner, JsonElement data);

	/** Uploads a binary blob ({@code blobs/<id>.bin} in a job's scratch dir), in chunks of 1 MB. Since 1.1.0. */
	CompletableFuture<String> putBlob(String kind, @Nullable String owner, byte[] data);
}
