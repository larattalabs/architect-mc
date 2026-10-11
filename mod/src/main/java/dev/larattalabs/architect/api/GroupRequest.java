package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.List;
import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * A design group ({@code design.group}, docs/CONTRACT.md phase 4b "Design groups (A2, R9)" and "4b review folded in"): up to
 * 24 designs made with one style bible, so they read as one place, several at a time. Since 1.2.0.
 *
 * @param name the group's name (shown in the Designs tab), up to 60 characters
 * @param bible the bible every item designs with (an id; a built-in one is a palette preset name)
 * @param bibleVersion the bible version, or null = its latest (the sidecar pins it when the group starts)
 * @param owner by convention {@code <modid>:<thing>}; null = the player
 * @param concurrency designs of this group running at once (1-6), or null = 3; the sidecar's {@code designConcurrency}
 *     caps all groups together
 * @param budgetUsd a hard cap on the group's total (queued items are cancelled with error "budget" when reached; at
 *     {@code softBudgetFraction} (0.8) nothing new starts: {@link Group.Status#PAUSED_BUDGET}), or null
 * @param massingFirst (since 1.3.0, a helper with {@code "massing"}) every item gets a massing first (in waves); then the
 *     group is {@link Group.Status#AWAITING_APPROVAL} and {@link SiteEvents#GROUP_AWAITING_APPROVAL} fires; approve, redirect
 *     or cancel items with {@link Designs#approveGroup}. Massings and redirects count toward the budget
 * @param approvalUi (since 1.3.0) who approves: {@link ApprovalUi#ARCHITECT} (Architect's UI shows the massings and an
 *     Approve / Redirect bar; the default when null) or {@link ApprovalUi#OWNER} (no bar: only
 *     {@link Designs#approveGroup(String, List, java.util.Map, List, String)} naming the group's {@code owner} counts)
 * @param maxRedirects (since 1.3.0) redirect rounds per item, 0-10; null = the helper's default (3)
 * @param context (since 1.3.0) text (at most 4000 characters, a {@link JsonPrimitive}) or a JSON object (at most 4000 as JSON)
 *     that goes into every item's brief, massing and detail: a concept card, the site and purpose, neighbour lots, the street
 * @param critique (since 1.6.0, a helper with {@code "critique"}) the items' default critique (an item's own
 *     {@link Item#critique} wins); null or OFF = none (the default: Architect never loops a whole group by default). With
 *     massingFirst it applies to the detail passes
 * @param opKey (since 1.10.0) the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}), scoped by (owner, kind, opKey); a null
 *     owner means the player. Sending again with the same key and the same body returns the first operation and starts no new
 *     work (in any state); with a different body the future fails {@link ArchitectRefused} {@link Reason#OP_KEY_CONFLICT}.
 *     Bodies are compared by the sha256 of the request's canonical JSON without the key. Kept as long as the record, and at
 *     least 30 days after it is final. See {@link Designs#groupByKey}.
 * @param copyCap (since 1.11.0, a helper with {@code "copies"}) placements per design, 1-3 (default 3): of an item with
 *     {@link Item#count} n, every copyCap-th placement starts a new archetype (an original) and the others are $0 copies of the
 *     archetype before them; 1 = all originals. A landmark's extra count is always originals
 * @param smallBySize (since 1.11.0, {@code "smallEffort"}) an item whose request's maxSize footprint fits 11 x 9 either way is
 *     small ({@link Item.Effort#AUTO}): it skips the group-default report critique and runs the bounded SMALL detail pass. An
 *     item's explicit effort wins
 */
public record GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext,
	@Nullable Integer concurrency, @Nullable Double budgetUsd, List<Item> items, boolean massingFirst, @Nullable ApprovalUi approvalUi,
	@Nullable Integer maxRedirects, @Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String opKey, int copyCap,
	boolean smallBySize) {
	/** The default {@link #copyCap}. */
	public static final int DEFAULT_COPY_CAP = 3;

	/** The 1.10.0 constructor (copyCap 3, no smallBySize). */
	public GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext, @Nullable Integer concurrency,
		@Nullable Double budgetUsd, List<Item> items, boolean massingFirst, @Nullable ApprovalUi approvalUi, @Nullable Integer maxRedirects,
		@Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String opKey) {
		this(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, critique, opKey,
			DEFAULT_COPY_CAP, false);
	}

	/** A copy with this copyCap (1-3). Since 1.11.0. */
	public GroupRequest withCopyCap(int cap) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, critique,
			opKey, cap, smallBySize);
	}

	/** A copy with the 11 x 9 small rule on or off. Since 1.11.0. */
	public GroupRequest withSmallBySize(boolean on) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, critique,
			opKey, copyCap, on);
	}

	/** The 1.6.0 constructor (no opKey). */
	public GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext, @Nullable Integer concurrency,
		@Nullable Double budgetUsd, List<Item> items, boolean massingFirst, @Nullable ApprovalUi approvalUi, @Nullable Integer maxRedirects,
		@Nullable JsonElement context, @Nullable CritiqueSpec critique) {
		this(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, critique, null);
	}

	/** A copy with an operation key. Since 1.10.0. */
	public GroupRequest withOpKey(@Nullable String key) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, critique,
			key, copyCap, smallBySize);
	}

	/** The most items a group holds. */
	public static final int MAX_ITEMS = 24;
	/** The most redirect rounds per item. */
	public static final int MAX_REDIRECTS = 10;

	public GroupRequest {
		ext = ext == null ? new JsonObject() : ext;
		items = items == null ? List.of() : List.copyOf(items);
		if (context != null && context.isJsonNull()) {
			context = null;
		}
		if (critique != null && !critique.on()) {
			critique = null;
		}
		if (copyCap < 1 || copyCap > 3) {
			copyCap = DEFAULT_COPY_CAP;
		}
	}

	/** The 1.3.0 constructor (no critique). */
	public GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext, @Nullable Integer concurrency,
		@Nullable Double budgetUsd, List<Item> items, boolean massingFirst, @Nullable ApprovalUi approvalUi, @Nullable Integer maxRedirects,
		@Nullable JsonElement context) {
		this(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, null);
	}

	/** The 1.2.0 constructor (no massing pass, no context). */
	public GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext, @Nullable Integer concurrency,
		@Nullable Double budgetUsd, List<Item> items) {
		this(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, false, null, null, null);
	}

	/** A copy with massings first ({@code approvalUi} null = architect, {@code maxRedirects} null = the default). Since 1.3.0. */
	public GroupRequest withMassingFirst(@Nullable ApprovalUi ui, @Nullable Integer redirects) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, true, ui, redirects, context, critique, opKey, copyCap,
			smallBySize);
	}

	/** A copy with a context text (null or blank = none). Since 1.3.0. */
	public GroupRequest withContext(@Nullable String text) {
		return withContext(text == null || text.isBlank() ? null : new JsonPrimitive(text));
	}

	/** A copy with a context: a JSON object, or text as a {@link JsonPrimitive}. Since 1.3.0. */
	public GroupRequest withContext(@Nullable JsonElement ctx) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, ctx, critique, opKey,
			copyCap, smallBySize);
	}

	/** A copy whose items are critiqued as {@code spec} by default (null or OFF = none). Since 1.6.0. */
	public GroupRequest critique(@Nullable CritiqueSpec spec) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, context, spec, opKey,
			copyCap, smallBySize);
	}

	/** Who approves a massingFirst group's massings. Since 1.3.0. */
	public enum ApprovalUi {
		ARCHITECT, OWNER;

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}

		public static ApprovalUi of(@Nullable String s) {
			return "owner".equalsIgnoreCase(s) ? OWNER : ARCHITECT;
		}
	}

	/** {@code landmark} designs with the landmark model (claude-opus-5-5), {@code ordinary} with claude-sonnet-5-5. */
	public enum Role {
		LANDMARK, ORDINARY;

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}

		public static Role of(@Nullable String s) {
			return "landmark".equalsIgnoreCase(s) ? LANDMARK : ORDINARY;
		}
	}

	/**
	 * One design of the group.
	 *
	 * @param itemKey the caller's key, unique in the group ({@code [A-Za-z0-9_.:/-]{1,100}}); null = {@code item<n>}. It comes
	 *     back on {@link Group.Item} with the request's {@code ext}, across restarts
	 * @param request the design (its {@code bible} and {@code group} are ignored: the group sets them; {@code model},
	 *     {@code owner}, {@code budgetUsd} and {@code ext} are per item)
	 * @param role landmark or ordinary (the default model)
	 * @param wave the wave (1-8, default 1): a wave starts when every item of the earlier waves has ended, and its items get
	 *     the earlier waves' renders as neighbours; null = 1
	 * @param anchor designed first (wave 0)
	 * @param critique (since 1.6.0) this item's critique; it wins over the group's. Null = the request's own
	 *     {@link DesignRequest#critique()} when set, else the group's. {@link CritiqueSpec#OFF} turns it off for this item
	 * @param count (since 1.11.0, {@code "copies"}) placements of this item, 1-24 (default 1): the item expands into
	 *     {@code <key>}, {@code <key>#2} ... {@code <key>#n} on {@link Group#items()} (see {@link GroupRequest#copyCap()})
	 * @param copyOf (since 1.11.0) this item is a $0 copy of that item's archetype and counts toward its copyCap; refused with
	 *     {@link Reason#COPY_REFUSED} (detail landmark, unknown, self, cap)
	 * @param effort (since 1.11.0, {@code "smallEffort"}) AUTO (small by the 11 x 9 rule when the group sets smallBySize),
	 *     STANDARD or SMALL (2 design rounds, 40 turns each at effort medium, $1.50 over the pass; a cap hit fails the item)
	 */
	public record Item(@Nullable String itemKey, DesignRequest request, Role role, @Nullable Integer wave, boolean anchor, @Nullable CritiqueSpec critique,
		int count, @Nullable String copyOf, Effort effort) {
		public Item {
			role = role == null ? Role.ORDINARY : role;
			count = Math.max(1, count);
			effort = effort == null ? Effort.AUTO : effort;
		}

		/** The 1.6.0 constructor (one placement, AUTO effort). */
		public Item(@Nullable String itemKey, DesignRequest request, Role role, @Nullable Integer wave, boolean anchor, @Nullable CritiqueSpec critique) {
			this(itemKey, request, role, wave, anchor, critique, 1, null, Effort.AUTO);
		}

		/** A copy placed {@code n} times (1-24). Since 1.11.0. */
		public Item count(int n) {
			return new Item(itemKey, request, role, wave, anchor, critique, n, copyOf, effort);
		}

		/** A copy that is a $0 copy of item {@code key}'s archetype. Since 1.11.0. */
		public Item copyOf(@Nullable String key) {
			return new Item(itemKey, request, role, wave, anchor, critique, count, key, effort);
		}

		/** A copy with this effort. Since 1.11.0. */
		public Item effort(Effort e) {
			return new Item(itemKey, request, role, wave, anchor, critique, count, copyOf, e);
		}

		/** A group item's effort (C8). Since 1.11.0. */
		public enum Effort {
			AUTO, STANDARD, SMALL;

			public String wire() {
				return name().toLowerCase(Locale.ROOT);
			}

			public static Effort of(@Nullable String s) {
				return "small".equalsIgnoreCase(s) ? SMALL : "standard".equalsIgnoreCase(s) ? STANDARD : AUTO;
			}
		}

		/** The 1.2.0 constructor (the group's critique). */
		public Item(@Nullable String itemKey, DesignRequest request, Role role, @Nullable Integer wave, boolean anchor) {
			this(itemKey, request, role, wave, anchor, null);
		}

		/** A copy with its own critique (null = the group's, {@link CritiqueSpec#OFF} = none). Since 1.6.0. */
		public Item critique(@Nullable CritiqueSpec spec) {
			return new Item(itemKey, request, role, wave, anchor, spec, count, copyOf, effort);
		}

		/** An ordinary item in wave 1. */
		public static Item of(@Nullable String itemKey, DesignRequest request) {
			return new Item(itemKey, request, Role.ORDINARY, null, false);
		}
	}
}
