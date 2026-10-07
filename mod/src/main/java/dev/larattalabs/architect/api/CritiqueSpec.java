package dev.larattalabs.architect.api;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * How a design is critiqued (docs/CONTRACT.md "Phase 5a contract", "Protocol (2, additive)" {@code CritiqueSpec}): after the
 * design renders, a cheaper critic (claude-sonnet-5-5) looks at fixed renders, the blueprint summary, the brief and the bible and
 * returns scores and issues; in {@link CritiqueMode#LOOP} the designer revises on that verdict. Null fields take the helper's
 * defaults. The constructor validates (an {@link IllegalArgumentException} names the field); {@link #builder} is the usual way to
 * make one. Needs a helper with the {@code "critique"} feature (report on a library entry: {@code "critiqueReport"}). Since 1.6.0.
 *
 * @param mode off, report or loop
 * @param maxRevisions 0-3 revisions in a loop; null = 2 (a massing: 1)
 * @param model the critic model; null = the helper's {@code critique.model} (claude-sonnet-5-5)
 * @param effort {@code low | medium | high}; null = medium
 * @param budgetUsd a cap on the loop's own spend (critic calls plus revisions), 0 < x <= 1000; null = 1.0x round 0's cost (the
 *     loop at most doubles a design's cost)
 * @param maxMinutes the loop ends at the first round boundary after this many minutes (0 < x <= 240); null = 15
 * @param shipScore ship when the mean score reaches it (1-10), no score is below it minus 2 and there is no P0; null = 7.0
 * @param views the critic's views ({@link #VIEWS}), no duplicates; empty = every view
 * @param neighbours send finished siblings' renders (a group item); null = true in groups
 * @param extraCriteria up to 3 extra rubric lines (1-200 characters each), each scored on its own
 */
public record CritiqueSpec(CritiqueMode mode, @Nullable Integer maxRevisions, @Nullable String model, @Nullable String effort, @Nullable Double budgetUsd,
	@Nullable Double maxMinutes, @Nullable Double shipScore, List<String> views, @Nullable Boolean neighbours, List<String> extraCriteria) {
	/** The fixed critic views ({@code render.mjs --views}); phase 6 adds {@code section}. */
	public static final List<String> VIEWS = List.of("iso", "iso_back", "front", "top", "cutaway");
	public static final List<String> EFFORTS = List.of("low", "medium", "high");
	public static final int MAX_REVISIONS = 3;
	public static final int MAX_EXTRA_CRITERIA = 3;
	public static final int MAX_CRITERION = 200;
	private static final Pattern MODEL = Pattern.compile("[A-Za-z0-9._:@/\\[\\]-]{1,100}");

	/** Critique off (the API default). */
	public static final CritiqueSpec OFF = new CritiqueSpec(CritiqueMode.OFF, null, null, null, null, null, null, List.of(), null, List.of());

	public CritiqueSpec {
		mode = mode == null ? CritiqueMode.OFF : mode;
		views = views == null ? List.of() : List.copyOf(views);
		List<String> ec = new ArrayList<>();
		for (String c : extraCriteria == null ? List.<String>of() : extraCriteria) {
			ec.add(c == null ? "" : c.strip());
		}
		extraCriteria = List.copyOf(ec);
		model = model == null || model.isBlank() ? null : model.strip();
		String why = problem(maxRevisions, model, effort, budgetUsd, maxMinutes, shipScore, views, extraCriteria);
		if (why != null) {
			throw new IllegalArgumentException(why);
		}
	}

	/** Why these fields are not a valid spec (null: they are). Pure. */
	static @Nullable String problem(@Nullable Integer maxRevisions, @Nullable String model, @Nullable String effort, @Nullable Double budgetUsd,
		@Nullable Double maxMinutes, @Nullable Double shipScore, List<String> views, List<String> extraCriteria) {
		if (maxRevisions != null && (maxRevisions < 0 || maxRevisions > MAX_REVISIONS)) {
			return "critique maxRevisions is 0 to " + MAX_REVISIONS + " (got " + maxRevisions + ")";
		}
		if (model != null && !MODEL.matcher(model).matches()) {
			return "critique model is not a model id: " + model;
		}
		if (effort != null && !EFFORTS.contains(effort)) {
			return "critique effort is low, medium or high (got " + effort + ")";
		}
		if (budgetUsd != null && (!(budgetUsd > 0) || budgetUsd > 1000)) {
			return "critique budgetUsd is above 0 and at most 1000 (got " + budgetUsd + ")";
		}
		if (maxMinutes != null && (!(maxMinutes > 0) || maxMinutes > 240)) {
			return "critique maxMinutes is above 0 and at most 240 (got " + maxMinutes + ")";
		}
		if (shipScore != null && !(shipScore >= 1 && shipScore <= 10)) {
			return "critique shipScore is 1 to 10 (got " + shipScore + ")";
		}
		Set<String> seen = new HashSet<>();
		for (String v : views) {
			if (!VIEWS.contains(v)) {
				return "critique view " + v + " is not one of " + String.join(", ", VIEWS);
			}
			if (!seen.add(v)) {
				return "critique view " + v + " is listed twice";
			}
		}
		if (extraCriteria.size() > MAX_EXTRA_CRITERIA) {
			return "at most " + MAX_EXTRA_CRITERIA + " extra criteria (got " + extraCriteria.size() + ")";
		}
		for (String c : extraCriteria) {
			if (c.isEmpty() || c.length() > MAX_CRITERION) {
				return "an extra criterion is 1 to " + MAX_CRITERION + " characters (got " + c.length() + ")";
			}
		}
		return null;
	}

	/** A loop with the helper's defaults. */
	public static CritiqueSpec loop() {
		return builder(CritiqueMode.LOOP).build();
	}

	/** A loop with at most {@code maxRevisions} revisions. */
	public static CritiqueSpec loop(int maxRevisions) {
		return builder(CritiqueMode.LOOP).maxRevisions(maxRevisions).build();
	}

	/** One critic call, no revision. */
	public static CritiqueSpec report() {
		return builder(CritiqueMode.REPORT).build();
	}

	public boolean on() {
		return mode != CritiqueMode.OFF;
	}

	public static Builder builder(CritiqueMode mode) {
		return new Builder(mode);
	}

	/** A copy in a builder. */
	public Builder toBuilder() {
		Builder b = new Builder(mode);
		b.maxRevisions = maxRevisions;
		b.model = model;
		b.effort = effort;
		b.budgetUsd = budgetUsd;
		b.maxMinutes = maxMinutes;
		b.shipScore = shipScore;
		b.views.addAll(views);
		b.neighbours = neighbours;
		b.extraCriteria.addAll(extraCriteria);
		return b;
	}

	/** Builds a {@link CritiqueSpec}; {@link #build} validates. Not thread-safe. */
	public static final class Builder {
		private CritiqueMode mode;
		private @Nullable Integer maxRevisions;
		private @Nullable String model;
		private @Nullable String effort;
		private @Nullable Double budgetUsd;
		private @Nullable Double maxMinutes;
		private @Nullable Double shipScore;
		private final List<String> views = new ArrayList<>();
		private @Nullable Boolean neighbours;
		private final List<String> extraCriteria = new ArrayList<>();

		private Builder(CritiqueMode mode) {
			this.mode = mode;
		}

		public Builder mode(CritiqueMode m) {
			mode = m;
			return this;
		}

		public Builder maxRevisions(@Nullable Integer n) {
			maxRevisions = n;
			return this;
		}

		public Builder model(@Nullable String m) {
			model = m;
			return this;
		}

		public Builder effort(@Nullable String e) {
			effort = e;
			return this;
		}

		public Builder budgetUsd(@Nullable Double usd) {
			budgetUsd = usd;
			return this;
		}

		public Builder maxMinutes(@Nullable Double min) {
			maxMinutes = min;
			return this;
		}

		public Builder shipScore(@Nullable Double s) {
			shipScore = s;
			return this;
		}

		/** Replaces the views (empty = every view). */
		public Builder views(List<String> vs) {
			views.clear();
			views.addAll(vs);
			return this;
		}

		public Builder neighbours(@Nullable Boolean on) {
			neighbours = on;
			return this;
		}

		public Builder extraCriterion(String c) {
			extraCriteria.add(c);
			return this;
		}

		/** Replaces the extra criteria. */
		public Builder extraCriteria(List<String> cs) {
			extraCriteria.clear();
			extraCriteria.addAll(cs);
			return this;
		}

		/** The spec; throws {@link IllegalArgumentException} naming the first invalid field. */
		public CritiqueSpec build() {
			return new CritiqueSpec(mode, maxRevisions, model, effort, budgetUsd, maxMinutes, shipScore, views, neighbours, extraCriteria);
		}
	}
}
