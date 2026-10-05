package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Job;
import dev.larattalabs.architect.api.JobSpec;
import dev.larattalabs.architect.api.Jobs;
import dev.larattalabs.architect.api.ToolHandler;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import org.jspecify.annotations.Nullable;

/**
 * {@link Jobs} until protocol 2's job messages exist: not available, {@link #run} refuses. Tool handlers are already kept
 * (globally per owner and name), so a mod can register them at init today. Internal.
 */
final class JobsStub implements Jobs {
	static final String NOT_YET = "jobs arrive with protocol 2";
	private final Map<String, ToolHandler> tools = new ConcurrentHashMap<>();

	@Override
	public CompletableFuture<String> run(JobSpec spec) {
		return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new UnsupportedOperationException(NOT_YET)));
	}

	@Override
	public void cancel(String jobId) {
	}

	@Override
	public Optional<Job> get(String jobId) {
		return Optional.empty();
	}

	@Override
	public List<Job> list(@Nullable String owner) {
		return List.of();
	}

	@Override
	public void registerTool(String owner, String name, ToolHandler h) {
		tools.put(owner + "/" + name, h);
	}

	/** The handler registered for {@code (owner, name)}, or null. */
	@Nullable ToolHandler tool(String owner, String name) {
		return tools.get(owner + "/" + name);
	}

	@Override
	public boolean available() {
		return false;
	}
}
