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
 *
 * <p>Since 1.2.0, design groups (docs/CONTRACT.md phase 4b "Design groups (A2, R9)"): {@link #requestGroup} makes up to 24
 * designs with one style bible; {@link SiteEvents#GROUP_UPDATED} / {@link SiteEvents#GROUP_DONE} report the group (each item's
 * own design also fires the DESIGN_ events). These need a helper with the {@code "designGroups"} feature.
 */
public interface Designs {
	/** Sends the request; completes with the design id once the sidecar acked it, or fails (helper not running, refused). */
	CompletableFuture<String> request(DesignRequest r);

	void cancel(String designId);

	Optional<Design> get(String designId);

	/** Designs requested with {@code owner} (null: all designs the helper reports), newest first. */
	List<Design> list(@Nullable String owner);

	/** Starts a design group; completes with the group id ({@code g<n>}) once the sidecar acked it. Since 1.2.0. */
	CompletableFuture<String> requestGroup(GroupRequest r);

	/** A group with its addressable items. Since 1.2.0. */
	Optional<Group> group(String groupId);

	/**
	 * The groups of {@code owner} (null: all), including the ones that finished while the caller was away (kept across game
	 * restarts). Newest first. Since 1.2.0.
	 */
	List<Group> listGroups(@Nullable String owner);

	/** Cancels a group: queued items are cancelled, running ones stopped; finished items stay. Since 1.2.0. */
	CompletableFuture<Void> cancelGroup(String groupId);

	/**
	 * Raises a group's hard budget to {@code budgetUsd} (above what it spent). A group paused at its soft budget stays paused:
	 * {@link #resumeGroup} next. Since 1.2.0.
	 */
	CompletableFuture<Void> extendGroup(String groupId, double budgetUsd);

	/** Resumes a group paused at its soft budget ({@link Group.Status#PAUSED_BUDGET}). Since 1.2.0. */
	CompletableFuture<Void> resumeGroup(String groupId);

	/** What the group would probably cost and take ({@code design.estimate}), before submitting it. Since 1.2.0. */
	CompletableFuture<Estimate> estimate(GroupRequest r);

	/** What one design would probably cost and take. Since 1.2.0. */
	CompletableFuture<Estimate> estimate(DesignRequest r);
}
