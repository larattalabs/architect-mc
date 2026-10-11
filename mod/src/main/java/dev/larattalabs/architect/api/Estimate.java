package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * What a design, a group or a bible job will probably cost and take ({@code design.estimate} / {@code bible.estimate},
 * docs/CONTRACT.md "4b review folded in" item 2): from the sidecar's measured per-model averages (rolling, seeded), the
 * concurrency and the current usage-limit state. Under the claude login the dollars are notional. Since 1.2.0.
 *
 * <p>Since 1.6.0 (docs/CONTRACT.md "Changes from Steward's review of 5a", SHOULD 1), a request with critique on gets the critique
 * as separate figures on top of the design figures (which never include it), in total and per item, so a caller can show "with
 * critique / without". Low = one critic call (it ships at once); high = the full loop, clipped by its cap.
 *
 * @param basis what it was computed from ("seed" values or "n measured" per model, the concurrency, a usage limit; since 1.6.0
 *     also the critique and its cap)
 * @param critique (since 1.6.0) whether the critique figures are set (critique was on for at least one design)
 * @param critiqueUsdLow (since 1.6.0) what the critique adds, low; 0 without critique
 * @param critiqueMinutesLow (since 1.6.0) the wall time the critique adds, low (a group: per wave, its slots counted)
 * @param polish (since 1.7.0) a polish estimate ({@link Designs#estimatePolish}): its figures are the polish fields (steps, fix
 *     turns, critic calls, a report when the entry's verdict is stale)
 * @param items (since 1.6.0) a group estimate's items, each with its design and critique figures; empty for one design (and from
 *     an older helper)
 */
public record Estimate(double usdLow, double usdHigh, double minutesLow, double minutesHigh, String basis, boolean critique, double critiqueUsdLow,
	double critiqueUsdHigh, double critiqueMinutesLow, double critiqueMinutesHigh, List<Item> items, boolean polish, double polishUsdLow,
	double polishUsdHigh, double polishMinutesLow, double polishMinutesHigh, Map<Kind, Item> byKind) {
	public Estimate {
		basis = basis == null ? "" : basis;
		items = items == null ? List.of() : List.copyOf(items);
		byKind = byKind == null ? Map.of() : Map.copyOf(byKind);
	}

	/** The 1.7.0 constructor (no lines per kind). */
	public Estimate(double usdLow, double usdHigh, double minutesLow, double minutesHigh, String basis, boolean critique, double critiqueUsdLow,
		double critiqueUsdHigh, double critiqueMinutesLow, double critiqueMinutesHigh, List<Item> items, boolean polish, double polishUsdLow,
		double polishUsdHigh, double polishMinutesLow, double polishMinutesHigh) {
		this(usdLow, usdHigh, minutesLow, minutesHigh, basis, critique, critiqueUsdLow, critiqueUsdHigh, critiqueMinutesLow, critiqueMinutesHigh, items,
			polish, polishUsdLow, polishUsdHigh, polishMinutesLow, polishMinutesHigh, Map.of());
	}

	/**
	 * The kinds of an {@link EstimateRequest} estimate's lines ({@link #byKind}; since 1.10.0): its key is the line's
	 * {@link Item#itemKey} too. New values are only ever appended.
	 */
	public enum Kind { BIBLE, ORIGINAL, ADAPTED, COPY, SMALL, CHANGE }

	/** The 1.6.0 constructor (no polish figures). */
	public Estimate(double usdLow, double usdHigh, double minutesLow, double minutesHigh, String basis, boolean critique, double critiqueUsdLow,
		double critiqueUsdHigh, double critiqueMinutesLow, double critiqueMinutesHigh, List<Item> items) {
		this(usdLow, usdHigh, minutesLow, minutesHigh, basis, critique, critiqueUsdLow, critiqueUsdHigh, critiqueMinutesLow, critiqueMinutesHigh, items,
			false, 0, 0, 0, 0);
	}

	/** The 1.2.0 constructor (no critique figures, no items). */
	public Estimate(double usdLow, double usdHigh, double minutesLow, double minutesHigh, String basis) {
		this(usdLow, usdHigh, minutesLow, minutesHigh, basis, false, 0, 0, 0, 0, List.of());
	}

	/** The design figures plus the critique, low (since 1.6.0). */
	public double withCritiqueUsdLow() {
		return usdLow + critiqueUsdLow;
	}

	/** The design figures plus the critique, high (since 1.6.0). */
	public double withCritiqueUsdHigh() {
		return usdHigh + critiqueUsdHigh;
	}

	public double withCritiqueMinutesLow() {
		return minutesLow + critiqueMinutesLow;
	}

	public double withCritiqueMinutesHigh() {
		return minutesHigh + critiqueMinutesHigh;
	}

	/** {@code "$0.80-2.50"} for a person. */
	public static String usd(double low, double high) {
		return String.format(Locale.ROOT, "$%.2f-%.2f", low, high);
	}

	/**
	 * One item of a group estimate (since 1.6.0).
	 *
	 * @param itemKey the item's key, when the helper sent it
	 * @param critique whether its critique figures are set
	 */
	public record Item(@Nullable String itemKey, double usdLow, double usdHigh, double minutesLow, double minutesHigh, boolean critique,
		double critiqueUsdLow, double critiqueUsdHigh, double critiqueMinutesLow, double critiqueMinutesHigh) {
	}
}
