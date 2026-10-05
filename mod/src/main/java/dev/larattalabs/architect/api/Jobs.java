package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * Claude jobs (R2, protocol 2; docs/CONTRACT.md "Jobs"). Calls are thread-safe; futures and tool handlers run on the server
 * thread. Tool handlers are registered globally per (owner, tool name) at mod init, never per run: a job that resumes
 * after a restart re-sends its pending tool call and the handler registered in the new JVM answers it.
 */
public interface Jobs {
	/** Starts a job; completes with its id once the sidecar acked it. */
	CompletableFuture<String> run(JobSpec spec);

	void cancel(String jobId);

	Optional<Job> get(String jobId);

	/** Jobs of {@code owner} (null: all), including the ones that finished while the caller was away. */
	List<Job> list(@Nullable String owner);

	/** Registers the handler of a mod-provided tool, globally per {@code (owner, name)}. */
	void registerTool(String owner, String name, ToolHandler h);

	/** False when there is no sidecar link (the helper is not running, no client) or it does not speak protocol 2. */
	boolean available();
}
