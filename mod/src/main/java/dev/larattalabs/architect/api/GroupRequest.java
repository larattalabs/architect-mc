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
 */
public record GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext,
	@Nullable Integer concurrency, @Nullable Double budgetUsd, List<Item> items, boolean massingFirst, @Nullable ApprovalUi approvalUi,
	@Nullable Integer maxRedirects, @Nullable JsonElement context) {
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
	}

	/** The 1.2.0 constructor (no massing pass, no context). */
	public GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext, @Nullable Integer concurrency,
		@Nullable Double budgetUsd, List<Item> items) {
		this(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, false, null, null, null);
	}

	/** A copy with massings first ({@code approvalUi} null = architect, {@code maxRedirects} null = the default). Since 1.3.0. */
	public GroupRequest withMassingFirst(@Nullable ApprovalUi ui, @Nullable Integer redirects) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, true, ui, redirects, context);
	}

	/** A copy with a context text (null or blank = none). Since 1.3.0. */
	public GroupRequest withContext(@Nullable String text) {
		return withContext(text == null || text.isBlank() ? null : new JsonPrimitive(text));
	}

	/** A copy with a context: a JSON object, or text as a {@link JsonPrimitive}. Since 1.3.0. */
	public GroupRequest withContext(@Nullable JsonElement ctx) {
		return new GroupRequest(name, bible, bibleVersion, owner, ext, concurrency, budgetUsd, items, massingFirst, approvalUi, maxRedirects, ctx);
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
	 */
	public record Item(@Nullable String itemKey, DesignRequest request, Role role, @Nullable Integer wave, boolean anchor) {
		public Item {
			role = role == null ? Role.ORDINARY : role;
		}

		/** An ordinary item in wave 1. */
		public static Item of(@Nullable String itemKey, DesignRequest request) {
			return new Item(itemKey, request, Role.ORDINARY, null, false);
		}
	}
}
