package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
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
 */
public record GroupRequest(String name, String bible, @Nullable Integer bibleVersion, @Nullable String owner, JsonObject ext,
	@Nullable Integer concurrency, @Nullable Double budgetUsd, List<Item> items) {
	/** The most items a group holds. */
	public static final int MAX_ITEMS = 24;

	public GroupRequest {
		ext = ext == null ? new JsonObject() : ext;
		items = items == null ? List.of() : List.copyOf(items);
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
