package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A polish design's outcome (docs/CONTRACT.md phase 5b "End and install"): the version it started from, the version it installed
 * (null: none), its steps, why it ended and what it cost. Since 1.7.0.
 */
public record Polish(int fromVersion, @Nullable Integer installedVersion, List<Step> steps, End end, Cost cost) {
	public Polish {
		steps = List.copyOf(steps);
	}

	/**
	 * One targeted step: its number, the issue it targeted, the parts it was allowed to change, whether the critic accepted it,
	 * the critic's overall score of the result, the cells it changed, its cost and time, and why it failed (null when accepted).
	 */
	public record Step(int n, Critique.@Nullable Issue target, List<String> allowedParts, boolean accepted, @Nullable Double overall, int changedCells,
		Cost cost, long ms, @Nullable String failure) {
		public Step {
			allowedParts = List.copyOf(allowedParts);
		}
	}

	/** New values are only ever appended. */
	public enum End {
		POLISHED, NO_TARGET, NOT_RESOLVED, SCOPE_FAILED, CHECK_FAILED, BASE_DRIFT, BUDGET, TIME, CRITIC_FAILED
	}
}
