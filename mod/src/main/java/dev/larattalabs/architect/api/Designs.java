package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
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
 *
 * <p>Since 1.3.0, massings (docs/CONTRACT.md "Phase 4c contract"; a helper with the {@code "massing"} feature): a request with
 * {@link DesignRequest#massing(boolean) massing} makes a coarse volume design ({@link SiteEvents#MASSING_DONE}), a request
 * {@link DesignRequest#fromMassing(String) fromMassing} details it, {@link #redirectMassing} makes a new version from notes; a
 * {@link GroupRequest#massingFirst massingFirst} group waits for {@link #approveGroup}
 * ({@link SiteEvents#GROUP_AWAITING_APPROVAL}).
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

	// ------------------------------------------------------------------ 1.3.0: massings

	/**
	 * The latest version of a massing this game knows (from {@code massing.upsert}, the helper's snapshot and its full list,
	 * fetched on every connect; persisted in {@code <gameDir>/architect/api-massings.json}). Empty once deleted or collected.
	 * Since 1.3.0.
	 */
	Optional<Massing> massing(String massingId);

	/**
	 * One version of a massing, when this game has seen it (every version installed while the game was connected, plus the
	 * latest version of each massing on every connect). Since 1.3.0.
	 */
	Optional<Massing> massing(String massingId, int version);

	/** The latest version of each massing of {@code owner} (null: all), newest first. Since 1.3.0. */
	List<Massing> listMassings(@Nullable String owner);

	/**
	 * A new version of a massing from its latest one plus {@code notes} ({@code massing.redirect}); completes at the ack with
	 * the massing job and the version it makes. A group's massing goes through the group's rules (a redirect round of its
	 * item; with approvalUi owner, use {@link #redirectMassing(String, String, String)} with the group's owner). Since 1.3.0.
	 */
	default CompletableFuture<Group.Redirected> redirectMassing(String massingId, String notes) {
		return redirectMassing(massingId, notes, null);
	}

	/** {@link #redirectMassing(String, String)} as {@code owner} (a group massing with approvalUi owner needs the group's owner). Since 1.3.0. */
	CompletableFuture<Group.Redirected> redirectMassing(String massingId, String notes, @Nullable String owner);

	/**
	 * Deletes a massing and every version of it now ({@code massing.delete}); completes with the versions deleted. Refused while
	 * a job makes or details it, or while its group is not final. Since 1.3.0.
	 */
	CompletableFuture<List<Integer>> deleteMassing(String massingId);

	/**
	 * A massingFirst group's approval ({@code group.approve}): the {@code approve} items start their detail pass (bound to their
	 * latest massing version), each {@code redirect} item (itemKey -> notes) gets a new massing version, the {@code cancel}
	 * items are dropped. Validated as a whole (nothing happens when any part is refused: an unknown or not-waiting item, a
	 * redirect past maxRedirects, a spent budget). A group with approvalUi owner refuses this form: use
	 * {@link #approveGroup(String, List, Map, List, String)} with its owner. Since 1.3.0.
	 */
	default CompletableFuture<Group.Approval> approveGroup(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel) {
		return approveGroup(groupId, approve, redirect, cancel, null);
	}

	/** {@link #approveGroup(String, List, Map, List)} as {@code owner} (must be the group's owner when its approvalUi is owner). Since 1.3.0. */
	CompletableFuture<Group.Approval> approveGroup(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel,
		@Nullable String owner);
}
