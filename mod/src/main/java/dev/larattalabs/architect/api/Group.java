package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * A design group as the sidecar reports it ({@code group.upsert}; docs/CONTRACT.md "4b review folded in" items 1, 3 and 8).
 * Its items are addressable: each carries the caller's {@code itemKey} and {@code ext}, and the library entry once done.
 * Finished items are installed as soon as they are done (partial results are usable). Since 1.2.0.
 *
 * @param bible the bible and the version it was pinned to
 * @param budgetUsd the group's hard budget, if any
 * @param softBudgetFraction at this fraction of the budget nothing new starts ({@link Status#PAUSED_BUDGET})
 * @param reason why it is paused, failed or cancelled ("budget", the soft-budget message, ...)
 * @param wave the wave running now (0 = the anchors), or -1
 * @param done the items done; {@code failed} the items failed or cancelled
 * @param cost the sum of the items' costs
 * @param usageLimitUntil when a usage limit holds it ({@link Status#HELD_USAGE}): when it resets (epoch ms), else 0
 * @param done the items detailed and done (an item whose massing waits for approval is not done)
 * @param massingFirst (since 1.3.0) every item gets a massing first ({@link GroupRequest#massingFirst})
 * @param approvalUi (since 1.3.0) who approves its massings
 * @param maxRedirects (since 1.3.0) redirect rounds per item (0 when not massingFirst)
 * @param context (since 1.3.0) the group's context, as requested
 * @param awaiting (since 1.3.0) the items waiting for {@link Designs#approveGroup} (their massing is done)
 */
public record Group(String id, String name, BiblePin bible, Optional<String> owner, JsonObject ext, int concurrency, Optional<Double> budgetUsd,
	double softBudgetFraction, Status status, Optional<String> reason, List<Item> items, int wave, int done, int failed, Cost cost,
	long usageLimitUntil, long createdAt, long updatedAt, boolean massingFirst, GroupRequest.ApprovalUi approvalUi, int maxRedirects,
	Optional<JsonElement> context, List<String> awaiting) {
	public Group {
		items = List.copyOf(items);
		ext = ext == null ? new JsonObject() : ext;
		approvalUi = approvalUi == null ? GroupRequest.ApprovalUi.ARCHITECT : approvalUi;
		context = context == null ? Optional.empty() : context;
		awaiting = awaiting == null ? List.of() : List.copyOf(awaiting);
	}

	/** The 1.2.0 constructor (not massingFirst). */
	public Group(String id, String name, BiblePin bible, Optional<String> owner, JsonObject ext, int concurrency, Optional<Double> budgetUsd,
		double softBudgetFraction, Status status, Optional<String> reason, List<Item> items, int wave, int done, int failed, Cost cost,
		long usageLimitUntil, long createdAt, long updatedAt) {
		this(id, name, bible, owner, ext, concurrency, budgetUsd, softBudgetFraction, status, reason, items, wave, done, failed, cost, usageLimitUntil,
			createdAt, updatedAt, false, GroupRequest.ApprovalUi.ARCHITECT, 0, Optional.empty(), List.of());
	}

	/**
	 * {@code queued | running | held_usage | paused_budget | awaiting_approval | done | failed | cancelled}. DONE: every item
	 * ended and at least one is done; FAILED: none is. DONE, FAILED and CANCELLED are final. AWAITING_APPROVAL (since 1.3.0,
	 * massingFirst): an item's massing waits for {@link Designs#approveGroup} and no massing of the group is still designing.
	 */
	public enum Status {
		QUEUED, RUNNING, HELD_USAGE, PAUSED_BUDGET, AWAITING_APPROVAL, DONE, FAILED, CANCELLED, UNKNOWN;

		public boolean isFinal() {
			return this == DONE || this == FAILED || this == CANCELLED;
		}

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}

		public static Status of(String s) {
			try {
				return s == null ? UNKNOWN : valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}
	}

	public boolean finished() {
		return status.isFinal();
	}

	/** The item with this key. */
	public Optional<Item> item(String itemKey) {
		return items.stream().filter(i -> i.itemKey().equals(itemKey)).findFirst();
	}

	/** {@code massing | approval | detail}: where a massingFirst item is (since 1.3.0). */
	public enum Stage {
		MASSING, APPROVAL, DETAIL;

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}

		public static Optional<Stage> of(@org.jspecify.annotations.Nullable String s) {
			if (s == null) {
				return Optional.empty();
			}
			try {
				return Optional.of(valueOf(s.toUpperCase(Locale.ROOT)));
			} catch (IllegalArgumentException e) {
				return Optional.empty();
			}
		}
	}

	/**
	 * What {@link Designs#approveGroup} started (since 1.3.0).
	 *
	 * @param approved itemKey -> the detail design
	 * @param redirected itemKey -> the redirect's massing job and the new massing version
	 * @param cancelled the items dropped
	 */
	public record Approval(String groupId, Map<String, String> approved, Map<String, Redirected> redirected, List<String> cancelled) {
		public Approval {
			approved = Map.copyOf(approved);
			redirected = Map.copyOf(redirected);
			cancelled = List.copyOf(cancelled);
		}
	}

	/** A redirect started by {@link Designs#approveGroup} or {@link Designs#redirectMassing}: the massing job and the version it makes. */
	public record Redirected(String designId, int version) {
	}

	/**
	 * One design of the group.
	 *
	 * @param ext the item's ext as requested
	 * @param designId its design ({@link Designs#get}, {@link SiteEvents#DESIGN_DONE})
	 * @param entryId the library entry, once done
	 * @param wave 0 = an anchor
	 * @param model the model it designs with
	 * @param designId the item's latest design (its massing job, a redirect or the detail pass)
	 * @param status the latest design's status: DONE at stage APPROVAL means its massing is done and waits for approval
	 * @param stage (since 1.3.0, massingFirst) massing: its massing or a redirect is designing; approval: it waits for
	 *     {@link Designs#approveGroup}; detail: its detail pass. Empty when the group is not massingFirst
	 * @param massing (since 1.3.0) the item's massing (the latest version)
	 * @param rounds (since 1.3.0) redirect rounds so far (at most the group's maxRedirects)
	 * @param designIds (since 1.3.0) every design of the item, oldest first (massings, redirects, the detail)
	 */
	public record Item(String itemKey, JsonObject ext, String designId, Optional<String> entryId, Design.Status status, String step, Cost cost,
		int wave, GroupRequest.Role role, String model, String type, Optional<String> name, Optional<String> error, Optional<Stage> stage,
		Optional<MassingRef> massing, int rounds, List<String> designIds) {
		public Item {
			ext = ext == null ? new JsonObject() : ext;
			stage = stage == null ? Optional.empty() : stage;
			massing = massing == null ? Optional.empty() : massing;
			designIds = designIds == null ? List.of() : List.copyOf(designIds);
		}

		/** The 1.2.0 constructor (no massing pass). */
		public Item(String itemKey, JsonObject ext, String designId, Optional<String> entryId, Design.Status status, String step, Cost cost, int wave,
			GroupRequest.Role role, String model, String type, Optional<String> name, Optional<String> error) {
			this(itemKey, ext, designId, entryId, status, step, cost, wave, role, model, type, name, error, Optional.empty(), Optional.empty(), 0,
				List.of(designId));
		}

		/** Whether its massing is done and waits for approval (since 1.3.0). */
		public boolean awaitingApproval() {
			return stage.orElse(null) == Stage.APPROVAL && status == Design.Status.DONE;
		}

		/** Whether the item is finished as a building: done with no stage, or done in its detail stage (since 1.3.0). */
		public boolean detailed() {
			return status == Design.Status.DONE && (stage.isEmpty() || stage.get() == Stage.DETAIL);
		}
	}
}
