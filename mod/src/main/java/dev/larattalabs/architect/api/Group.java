package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Locale;
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
 */
public record Group(String id, String name, BiblePin bible, Optional<String> owner, JsonObject ext, int concurrency, Optional<Double> budgetUsd,
	double softBudgetFraction, Status status, Optional<String> reason, List<Item> items, int wave, int done, int failed, Cost cost,
	long usageLimitUntil, long createdAt, long updatedAt) {
	public Group {
		items = List.copyOf(items);
		ext = ext == null ? new JsonObject() : ext;
	}

	/**
	 * {@code queued | running | held_usage | paused_budget | done | failed | cancelled}. DONE: every item ended and at least
	 * one is done; FAILED: none is. DONE, FAILED and CANCELLED are final.
	 */
	public enum Status {
		QUEUED, RUNNING, HELD_USAGE, PAUSED_BUDGET, DONE, FAILED, CANCELLED, UNKNOWN;

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

	/**
	 * One design of the group.
	 *
	 * @param ext the item's ext as requested
	 * @param designId its design ({@link Designs#get}, {@link SiteEvents#DESIGN_DONE})
	 * @param entryId the library entry, once done
	 * @param wave 0 = an anchor
	 * @param model the model it designs with
	 */
	public record Item(String itemKey, JsonObject ext, String designId, Optional<String> entryId, Design.Status status, String step, Cost cost,
		int wave, GroupRequest.Role role, String model, String type, Optional<String> name, Optional<String> error) {
		public Item {
			ext = ext == null ? new JsonObject() : ext;
		}
	}
}
