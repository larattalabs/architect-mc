package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * Building design requests (the Design tab's pipeline, {@code design.request} over the mod's sidecar link). Thread-safe;
 * futures complete on the server thread. Progress and the result arrive as {@link SiteEvents#DESIGN_UPDATED} and
 * {@link SiteEvents#DESIGN_DONE}; when a design is done its library entry is loaded and carries the request's {@code ext}.
 * Remix = a request with {@code remix} set.
 */
public interface Designs {
	/** Sends the request; completes with the design id once the sidecar acked it, or fails (helper not running, refused). */
	CompletableFuture<String> request(DesignRequest r);

	void cancel(String designId);

	Optional<Design> get(String designId);

	/** Designs requested with {@code owner} (null: all designs the helper reports), newest first. */
	List<Design> list(@Nullable String owner);
}
