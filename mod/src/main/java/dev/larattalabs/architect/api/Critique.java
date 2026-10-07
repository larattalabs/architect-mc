package dev.larattalabs.architect.api;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import org.jspecify.annotations.Nullable;

/**
 * A design's critique (docs/CONTRACT.md "Phase 5a contract", "The critique loop"): its rounds, the round that installs, why the
 * loop ended, and the best round's scores and open issues. The sidecar decides ship, not the model: {@code overall} is the mean
 * of the present scores, and a round ships when it reaches {@code shipScore}, no score is below {@code shipScore - 2} and there is
 * no P0. Since 1.6.0.
 *
 * <p>Where it comes from: {@link Design#critique()} (the design record, every round in full, also while the loop runs),
 * {@link Group.Item#critique()} (the summary a group item carries: rounds as a count, see there) and
 * {@link Library.Entry#critique()} (the entry's {@code critique.json}, else its blueprint JSON's {@code critique}).
 *
 * @param rounds every round so far, round 0 first (round 0 is the design as checked and rendered; each revision adds one)
 * @param best the round that installs (or installed), or -1 when none is known yet
 * @param end why the loop ended; null while it runs ({@link #ended()})
 * @param overall the best round's overall (mean score), or {@link Double#NaN} when it was not scored (the critic failed)
 * @param scores the best round's scores: {@code silhouette, legibility, craft, materials, brief} plus {@code bible, set,
 *     interior} and extra criteria when they apply, 1-10
 * @param openIssues the best round's issues (worst first)
 * @param critic the critic calls' cost (an entry's {@code critique.json} has dollars only)
 * @param revise the revision turns' cost
 * @param mode report or loop
 * @param pending what the loop does next ({@code critic} or {@code revise}); empty once it ended
 * @param stale a library entry's verdict whose entry revision (a hash of its {@code .nbt}) no longer matches the entry: it
 *     describes an older version of the entry and is not reused (docs/CONTRACT.md "Changes from Steward's review of 5a", SHOULD 3)
 */
public record Critique(List<Round> rounds, int best, @Nullable EndReason end, double overall, Map<String, Integer> scores, List<Issue> openIssues,
	Cost critic, Cost revise, CritiqueMode mode, Optional<String> pending, boolean stale) {
	public Critique {
		rounds = rounds == null ? List.of() : List.copyOf(rounds);
		scores = scores == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(scores));
		openIssues = openIssues == null ? List.of() : List.copyOf(openIssues);
		critic = critic == null ? Cost.NONE : critic;
		revise = revise == null ? Cost.NONE : revise;
		mode = mode == null ? CritiqueMode.LOOP : mode;
		pending = pending == null ? Optional.empty() : pending;
	}

	/** The contract's shape: a loop, nothing pending, not stale. */
	public Critique(List<Round> rounds, int best, @Nullable EndReason end, double overall, Map<String, Integer> scores, List<Issue> openIssues,
		Cost critic, Cost revise) {
		this(rounds, best, end, overall, scores, openIssues, critic, revise, CritiqueMode.LOOP, Optional.empty(), false);
	}

	/** Whether the loop has ended ({@link #end} is set). */
	public boolean ended() {
		return end != null;
	}

	/** Whether the best round has a score. */
	public boolean scored() {
		return !Double.isNaN(overall);
	}

	/** The best round, when it is listed. */
	public Optional<Round> bestRound() {
		return rounds.stream().filter(r -> r.n() == best).findFirst();
	}

	/** The critic's and the revisions' cost together, in dollars. */
	public double usd() {
		return critic.usd() + revise.usd();
	}

	/** A copy marked stale (or not). */
	public Critique withStale(boolean s) {
		return new Critique(rounds, best, end, overall, scores, openIssues, critic, revise, mode, pending, s);
	}

	/**
	 * Why the loop ended (docs/CONTRACT.md "Stopping"). {@link #UNKNOWN} is a reason this API version does not know (a newer
	 * helper).
	 */
	public enum EndReason {
		/** the sidecar's ship rule held */
		SHIP,
		/** {@code maxRevisions} revisions done, then a last critic call scored the final round */
		MAX_REVISIONS,
		/** the next revision plus critic would not fit a cap (not a failure: the best round installs) */
		BUDGET,
		/** the loop ran {@code maxMinutes} */
		TIME,
		/** a revision scored at least 1.0 below the best round so far */
		REGRESSED,
		/** a revision failed the check after its fix turns */
		CHECK_FAILED,
		/** the critic call failed twice */
		CRITIC_FAILED,
		/** critique was off */
		OFF,
		UNKNOWN;

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}

		/** The wire name ({@code max_revisions}, ...); null stays null; an unknown name is UNKNOWN. */
		public static @Nullable EndReason of(@Nullable String s) {
			if (s == null) {
				return null;
			}
			try {
				return valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}

		/** For a person: "shipped", "max revisions", ... */
		public String label() {
			return this == SHIP ? "shipped" : wire().replace('_', ' ');
		}
	}

	/** P0 = a player would call it broken; P1 = clearly worse than it should be; P2 = polish. */
	public enum Priority {
		P0, P1, P2;

		public static Priority of(@Nullable String s) {
			if ("P0".equalsIgnoreCase(s)) {
				return P0;
			}
			return "P1".equalsIgnoreCase(s) ? P1 : P2;
		}
	}

	/**
	 * One issue of a verdict.
	 *
	 * @param part a named part of the blueprint, or null for the whole building
	 * @param view the view it shows in ({@code iso, iso_back, front, top, cutaway})
	 * @param what what is wrong (at most 200 characters)
	 * @param fix what to change (at most 200 characters)
	 */
	public record Issue(Priority priority, @Nullable String part, String view, String what, String fix) {
		public Issue {
			priority = priority == null ? Priority.P2 : priority;
			view = view == null ? "" : view;
			what = what == null ? "" : what;
			fix = fix == null ? "" : fix;
		}
	}

	/**
	 * One round: round 0 is the design as checked and rendered, each revision one more.
	 *
	 * @param n the round number
	 * @param verdict the model's own verdict ({@code ship | iterate}); null without a critic answer (the sidecar decides ship)
	 * @param overall the mean of its scores, or {@link Double#NaN} when not scored
	 * @param issues its issues (empty in an entry's {@code critique.json}, which keeps only their count: {@link #issueCount})
	 * @param resolved indexes into the previous round's issues the critic marked resolved
	 * @param ship the sidecar's ship rule held
	 * @param usd this round's critic call plus the revision that made it
	 * @param ms the wall time of the revision and the critic call
	 * @param kept it passed the check and is kept in the scratch dir (a candidate to install)
	 * @param issueCount how many issues it had
	 * @param summary the critic's summary (at most 300 characters)
	 * @param error why it has no verdict (check failed, critic failed)
	 * @param notes notes such as an unknown part name that became null
	 */
	public record Round(int n, @Nullable String verdict, double overall, Map<String, Integer> scores, List<Issue> issues, List<Integer> resolved,
		boolean ship, double usd, long ms, boolean kept, int issueCount, Optional<String> summary, Optional<String> error, List<String> notes) {
		public Round {
			scores = scores == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(scores));
			issues = issues == null ? List.of() : List.copyOf(issues);
			resolved = resolved == null ? List.of() : List.copyOf(resolved);
			summary = summary == null ? Optional.empty() : summary;
			error = error == null ? Optional.empty() : error;
			notes = notes == null ? List.of() : List.copyOf(notes);
		}

		/** Whether the critic scored it. */
		public boolean scored() {
			return !Double.isNaN(overall);
		}
	}
}
