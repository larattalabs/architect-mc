package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * {@link Designs#extend}: a group's budget raised, and whether its soft budget pauses it again at once (docs/CONTRACT.md phase
 * 6c slice 0c §6). The extend happened either way; the caller decides whether to extend further or resume. Since 1.12.0.
 *
 * @param group the group as Architect last saw it (its budget may still read the old one until the helper's next update;
 *              null when Architect has no copy)
 * @param spentUsd what the group spent (the helper's figure at the extend; an older helper: the cached group's)
 * @param softLineUsd {@code budgetUsd × softBudgetFraction}: the spend at which dispatching pauses
 * @param pausesAgain {@code spentUsd ≥ softLineUsd} (the helper's own comparison: equality pauses)
 * @param minBudgetUsd the smallest whole-cent budget B with {@code spentUsd < B × softBudgetFraction}, in the helper's double
 *                     arithmetic: extending to it doesn't re-pause, one cent less does
 */
public record Extension(@Nullable Group group, double spentUsd, double softLineUsd, boolean pausesAgain, double minBudgetUsd) {
	/** The extension of a budget: the soft line, whether it pauses again, the minimal budget that doesn't. Pure. */
	public static Extension of(@Nullable Group group, double budgetUsd, double spentUsd, double softBudgetFraction) {
		double line = softBudgetFraction * budgetUsd;
		return new Extension(group, spentUsd, line, spentUsd >= line, minBudgetUsd(spentUsd, softBudgetFraction));
	}

	/**
	 * The smallest whole-cent budget B (as the double {@code cents / 100.0}, what the JSON number parses to) with
	 * {@code spentUsd < softBudgetFraction × B}. NaN for a fraction that isn't positive.
	 */
	public static double minBudgetUsd(double spentUsd, double softBudgetFraction) {
		if (!(softBudgetFraction > 0)) {
			return Double.NaN;
		}
		long cents = Math.max(1, (long) Math.floor(spentUsd / softBudgetFraction * 100.0) - 2);
		while (!(spentUsd < softBudgetFraction * (cents / 100.0))) {
			cents++;
		}
		while (cents > 1 && spentUsd < softBudgetFraction * ((cents - 1) / 100.0)) {
			cents--;
		}
		return cents / 100.0;
	}
}
