package dev.larattalabs.architect.api;

import java.util.List;

/**
 * A stage of a site group (Steward A5B-SPEC §6a): a named unit of a batch's items with its own state, approved, skipped,
 * reordered and undone as one. Since 1.4.0.
 *
 * @param items the item keys in it
 * @param sites its placed sites, in placement order
 * @param batchId the batch that added it
 */
public record Stage(String name, List<String> items, State state, List<String> sites, String batchId) {
	public Stage {
		items = List.copyOf(items);
		sites = List.copyOf(sites);
	}

	/**
	 * {@code PLANNED} (waits for approval), {@code APPROVED} (waits for the stages before it), {@code PLACING}, then
	 * {@code PLACED} (every item placed) or {@code PARTIAL} (some failed); {@code SKIPPED}; {@code UNDONE} (its sites were removed).
	 */
	public enum State {
		PLANNED, APPROVED, PLACING, PLACED, PARTIAL, SKIPPED, UNDONE;

		/** Whether the stage is finished: nothing more will be placed for it. */
		public boolean terminal() {
			return this == PLACED || this == PARTIAL || this == SKIPPED || this == UNDONE;
		}
	}
}
