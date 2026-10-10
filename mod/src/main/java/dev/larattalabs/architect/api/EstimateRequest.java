package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * A mix to estimate ({@link Designs#estimate(EstimateRequest)}; docs/CONTRACT.md 6c slice 0a §3). Since 1.10.0.
 *
 * @param group a group request whose items count as originals (added to {@code originals}), or null
 * @param originals new designs: a massing (with {@code massingFirst}), a detail pass and its report critique
 * @param adapted placed designs refitted to a new lot (seeded at one repair-sized turn, unmeasured until 7b)
 * @param copies copies of an existing design ($0 plus the variant build time)
 * @param newBible whether a new bible is made first
 * @param model the model of the originals' detail passes, or null for the helper's default
 * @param smallOriginals (since 1.11.0) SMALL originals: the bounded detail pass (2 rounds, 40 turns, medium, $1.50), seeded at
 *     $0.6-1.5 and 3-6 min. A group's items count by kind: its copies as COPY, its small items as SMALL
 */
public record EstimateRequest(@Nullable GroupRequest group, int originals, int adapted, int copies, boolean newBible, boolean massingFirst,
	boolean reportCritique, @Nullable String model, int smallOriginals) {
	/** The 1.10.0 constructor (no SMALL originals). */
	public EstimateRequest(@Nullable GroupRequest group, int originals, int adapted, int copies, boolean newBible, boolean massingFirst,
		boolean reportCritique, @Nullable String model) {
		this(group, originals, adapted, copies, newBible, massingFirst, reportCritique, model, 0);
	}
}
