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
 * @param breakdown (since 1.10.0) the cost and time per stage ({@link Breakdown#EMPTY} from an older helper)
 * @param seq (since 1.10.0) goes up only on a real transition (status, reason, wave, the awaiting set; an item's status, stage,
 *     entry, massing version or rounds), never for cost or step text; 0 from an older helper. GROUP_UPDATED fires only when it grew.
 * @param lastAction (since 1.10.0) what the last transition was: {@code created, item_started, item_done, item_failed,
 *     massing_ready, awaiting_approval, approved, redirected, paused_budget, extended, resumed, held_usage, usage_reset, cancelled,
 *     done, failed}; "" from an older helper
 * @param opKey (since 1.10.0) the caller's operation key ({@link GroupRequest#opKey}), if it was sent with one
 */
public record Group(String id, String name, BiblePin bible, Optional<String> owner, JsonObject ext, int concurrency, Optional<Double> budgetUsd,
	double softBudgetFraction, Status status, Optional<String> reason, List<Item> items, int wave, int done, int failed, Cost cost,
	long usageLimitUntil, long createdAt, long updatedAt, boolean massingFirst, GroupRequest.ApprovalUi approvalUi, int maxRedirects,
	Optional<JsonElement> context, List<String> awaiting, Breakdown breakdown, long seq, String lastAction, Optional<String> opKey) {
	public Group {
		items = List.copyOf(items);
		ext = ext == null ? new JsonObject() : ext;
		approvalUi = approvalUi == null ? GroupRequest.ApprovalUi.ARCHITECT : approvalUi;
		context = context == null ? Optional.empty() : context;
		awaiting = awaiting == null ? List.of() : List.copyOf(awaiting);
		breakdown = breakdown == null ? Breakdown.EMPTY : breakdown;
		lastAction = lastAction == null ? "" : lastAction;
		opKey = opKey == null ? Optional.empty() : opKey;
	}

	/** The 1.3.0 constructor (no breakdown, seq, lastAction or opKey). */
	public Group(String id, String name, BiblePin bible, Optional<String> owner, JsonObject ext, int concurrency, Optional<Double> budgetUsd,
		double softBudgetFraction, Status status, Optional<String> reason, List<Item> items, int wave, int done, int failed, Cost cost,
		long usageLimitUntil, long createdAt, long updatedAt, boolean massingFirst, GroupRequest.ApprovalUi approvalUi, int maxRedirects,
		Optional<JsonElement> context, List<String> awaiting) {
		this(id, name, bible, owner, ext, concurrency, budgetUsd, softBudgetFraction, status, reason, items, wave, done, failed, cost, usageLimitUntil,
			createdAt, updatedAt, massingFirst, approvalUi, maxRedirects, context, awaiting, Breakdown.EMPTY, 0, "", Optional.empty());
	}

	/**
	 * The cost per kind, derived from {@link #breakdown}: {@code bible}, {@code massing}, {@code detail} (its first rounds and
	 * repairs) and {@code critique}. Since 1.10.0; empty from an older helper.
	 */
	public Map<String, Double> costByKind() {
		return breakdown.costByKind();
	}

	/**
	 * A group's cost and time per stage (since 1.10.0; docs/CONTRACT.md 6c slice 0a §7).
	 * <ul>
	 * <li>{@code BIBLE}: the job(s) that made the pinned bible version ({@link #bibleJobIds}), counted in the first group of the same
	 * owner that pins that version; later groups show it as 0;</li>
	 * <li>{@code MASSING}: the first round of each massing; {@code DETAIL}: the first design round of each detail pass;</li>
	 * <li>{@code REPAIR}: rounds 2 and later, of massings and details; {@code CRITIQUE}: critic calls and loop revisions;</li>
	 * <li>{@code QUEUED} and {@code USAGE_HOLD}: time only.</li>
	 * </ul>
	 * {@code Line.ms} is summed item time.
	 *
	 * @param totalUsd {@link Group#cost} plus the bible line
	 * @param wallMs the group's wall time so far
	 * @param firstDetailedMs the time to the first detailed item (0 until there is one)
	 * @param bibleJobIds the bible jobs the bible line counts (so a caller tracking {@link BibleJob} cost does not count them twice)
	 */
	public record Breakdown(Map<Stage, Line> stages, double totalUsd, long wallMs, long firstDetailedMs, List<String> bibleJobIds) {
		public static final Breakdown EMPTY = new Breakdown(Map.of(), 0, 0, 0, List.of());

		public Breakdown {
			stages = stages == null ? Map.of() : Map.copyOf(stages);
			bibleJobIds = bibleJobIds == null ? List.of() : List.copyOf(bibleJobIds);
		}

		/** The line of a stage (zero when absent). */
		public Line line(Stage s) {
			return stages.getOrDefault(s, Line.ZERO);
		}

		/** bible, massing, detail (DETAIL + REPAIR) and critique, in USD; empty when there are no lines. */
		public Map<String, Double> costByKind() {
			if (stages.isEmpty()) {
				return Map.of();
			}
			Map<String, Double> m = new java.util.LinkedHashMap<>();
			m.put("bible", line(Stage.BIBLE).usd());
			m.put("massing", line(Stage.MASSING).usd());
			m.put("detail", line(Stage.DETAIL).usd() + line(Stage.REPAIR).usd());
			m.put("critique", line(Stage.CRITIQUE).usd());
			return java.util.Collections.unmodifiableMap(m);
		}

		/** New values are only ever appended. */
		public enum Stage { BIBLE, MASSING, DETAIL, REPAIR, CRITIQUE, QUEUED, USAGE_HOLD }

		/** One stage: its cost, its summed item time and how many passes, rounds or calls it counts. */
		public record Line(double usd, long ms, int count) {
			public static final Line ZERO = new Line(0, 0, 0);
		}
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
	 * @param critique (since 1.6.0) its design's critique. Filled from the item's design record when this game has it (every
	 *     round in full, as {@link Design#critique()}); otherwise from the item's summary, whose {@code rounds} is only a count:
	 *     then {@link Critique#rounds()} is empty, {@code scores} and {@code openIssues} are empty, and the best round's number,
	 *     the end reason and the overall are set. Empty when critique is off
	 */
	public record Item(String itemKey, JsonObject ext, String designId, Optional<String> entryId, Design.Status status, String step, Cost cost,
		int wave, GroupRequest.Role role, String model, String type, Optional<String> name, Optional<String> error, Optional<Stage> stage,
		Optional<MassingRef> massing, int rounds, List<String> designIds, Optional<Critique> critique) {
		public Item {
			ext = ext == null ? new JsonObject() : ext;
			stage = stage == null ? Optional.empty() : stage;
			massing = massing == null ? Optional.empty() : massing;
			designIds = designIds == null ? List.of() : List.copyOf(designIds);
			critique = critique == null ? Optional.empty() : critique;
		}

		/** The 1.3.0 constructor (no critique). */
		public Item(String itemKey, JsonObject ext, String designId, Optional<String> entryId, Design.Status status, String step, Cost cost, int wave,
			GroupRequest.Role role, String model, String type, Optional<String> name, Optional<String> error, Optional<Stage> stage,
			Optional<MassingRef> massing, int rounds, List<String> designIds) {
			this(itemKey, ext, designId, entryId, status, step, cost, wave, role, model, type, name, error, stage, massing, rounds, designIds,
				Optional.empty());
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
