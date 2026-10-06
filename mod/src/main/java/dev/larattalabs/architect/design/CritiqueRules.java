package dev.larattalabs.architect.design;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.Estimate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The pure rules behind the phase 5a UI (docs/CONTRACT.md "Phase 5a contract", "UI"): the Design tab's and the set dialog's
 * "Critique and revise" toggle and its revisions choice, the estimate with and without critique, a design's rounds in the
 * Designs tab, an entry's scores and open issues in the Library, and the Library's "Critique" action. Tested without a game.
 */
public final class CritiqueRules {
	/** The toggle's default: off (the coordinator's decision on N1; a settings toggle may turn it on later). */
	public static final boolean DEFAULT_ON = false;
	/** The revisions a player picks from. */
	public static final List<Integer> REVISION_CHOICES = List.of(1, 2);
	public static final int DEFAULT_REVISIONS = 2;
	/** A report critique's cost before the helper answers an estimate (the critic seed, $0.04-0.15). */
	public static final double REPORT_SEED_LOW = 0.04;
	public static final double REPORT_SEED_HIGH = 0.15;
	/** The score dimensions in the order they are shown; others (bible, set, interior, extra criteria) follow. */
	public static final List<String> DIMENSIONS = List.of("silhouette", "legibility", "craft", "materials", "brief", "bible", "set", "interior");

	private CritiqueRules() {
	}

	/** {@code maxRevisions} as the UI allows it: 1 or 2 (anything else is the default). */
	public static int revisions(int n) {
		return REVISION_CHOICES.contains(n) ? n : DEFAULT_REVISIONS;
	}

	/** The {@code critique} a request or a group gets from the toggle: null when off or when the helper has no critique loop. */
	public static @Nullable JsonObject spec(boolean on, int maxRevisions, boolean helperHasCritique) {
		if (!on || !helperHasCritique) {
			return null;
		}
		JsonObject o = new JsonObject();
		o.addProperty("mode", "loop");
		o.addProperty("maxRevisions", revisions(maxRevisions));
		return o;
	}

	/** {@code {mode: "report"}}: the Library's "Critique" action. */
	public static JsonObject reportSpec() {
		JsonObject o = new JsonObject();
		o.addProperty("mode", "report");
		return o;
	}

	/** Why the Library's "Critique" action is off for an entry (null: it is on). */
	public static @Nullable String reportRefusal(boolean bundled, boolean imported, boolean helperHasReport, boolean connected) {
		if (!connected) {
			return "the design helper is not running";
		}
		if (!helperHasReport) {
			return "the helper has no report critiques (phase 5a)";
		}
		if (bundled) {
			return "a bundled design is read-only";
		}
		return null;
	}

	private static String usd(double lo, double hi) {
		return String.format(Locale.ROOT, "$%.2f-%.2f", lo, hi);
	}

	private static String min(double lo, double hi) {
		return String.format(Locale.ROOT, "%s-%s min", trim(lo), trim(hi));
	}

	private static String trim(double v) {
		return v == Math.rint(v) ? Integer.toString((int) v) : String.format(Locale.ROOT, "%.1f", v);
	}

	/**
	 * The estimate line: "about $0.80-2.50, 4-10 min" and, when its critique figures are set, " · with critique $0.84-4.75,
	 * 4.5-22 min" (the design figures plus the critique's).
	 */
	public static String estimateLine(Estimate e) {
		String base = "about " + usd(e.usdLow(), e.usdHigh()) + ", " + min(e.minutesLow(), e.minutesHigh());
		if (!e.critique()) {
			return base;
		}
		return base + " · with critique " + usd(e.withCritiqueUsdLow(), e.withCritiqueUsdHigh()) + ", " + min(e.withCritiqueMinutesLow(), e
			.withCritiqueMinutesHigh());
	}

	/** The Library's "Critique" action label with its estimate: "Critique (~$0.04-0.15)". */
	public static String reportLabel(@Nullable Estimate e) {
		double lo = e != null && e.critique() ? e.critiqueUsdLow() : REPORT_SEED_LOW;
		double hi = e != null && e.critique() ? e.critiqueUsdHigh() : REPORT_SEED_HIGH;
		return "Critique (~" + usd(lo, hi) + ")";
	}

	private static String score(double v) {
		return Double.isNaN(v) ? "-" : String.format(Locale.ROOT, "%.1f", v);
	}

	/** A short state for a list row or a set item: "critique 7.4, shipped", "critiquing round 1", "critique: critic failed". */
	public static String brief(Critique c) {
		if (!c.ended()) {
			int n = c.rounds().isEmpty() ? Math.max(0, c.best()) : c.rounds().get(c.rounds().size() - 1).n();
			return c.pending().map(p -> "revise".equals(p) ? "revising after round " + n : "critiquing round " + n).orElse("critiquing round " + n)
				+ (c.scored() ? " (best " + score(c.overall()) + ")" : "");
		}
		if (c.mode() == dev.larattalabs.architect.api.CritiqueMode.REPORT && c.scored()) {
			return "report " + score(c.overall());
		}
		return c.scored() ? "critique " + score(c.overall()) + ", " + c.end().label() : "critique: " + c.end().label();
	}

	/** The end line of the Designs tab: "Critique: shipped at round 1 (7.4)", "Critique: ended (max revisions), best round 2 (6.8)". */
	public static String endLine(Critique c) {
		boolean report = c.mode() == dev.larattalabs.architect.api.CritiqueMode.REPORT;
		String mode = report ? "Report" : "Critique";
		if (!c.ended()) {
			return mode + ": " + brief(c);
		}
		if (report && c.scored()) {
			// a report is one critic call: no loop ended, it scored
			return "Report: scored " + score(c.overall()) + (c.bestRound().map(Critique.Round::ship).orElse(false) ? ", would ship" : "");
		}
		String at = c.best() >= 0 ? "round " + c.best() + (c.scored() ? " (" + score(c.overall()) + ")" : "") : "round 0";
		if (c.end() == Critique.EndReason.SHIP) {
			return mode + ": shipped at " + at;
		}
		return mode + ": ended (" + c.end().label() + "), best " + at;
	}

	/**
	 * One line per round: "round 0  5.6  2 issues", "round 1  7.4  ship  1 issue  ★ best", "round 2  check failed: ...". The best
	 * round is marked with a star; a round without a verdict says why (or "waiting for the critic").
	 */
	public static List<String> roundLines(Critique c) {
		List<String> out = new ArrayList<>();
		for (Critique.Round r : c.rounds()) {
			StringBuilder b = new StringBuilder("round ").append(r.n()).append("  ");
			if (r.scored()) {
				b.append(score(r.overall()));
				if (r.ship()) {
					b.append("  ships");
				}
				int n = r.issues().isEmpty() ? r.issueCount() : r.issues().size();
				b.append("  ").append(n).append(n == 1 ? " issue" : " issues");
				if (!r.resolved().isEmpty()) {
					b.append(", ").append(r.resolved().size()).append(" resolved");
				}
			} else if (r.error().isPresent()) {
				b.append(r.error().get());
			} else {
				b.append(c.ended() ? "not scored" : "waiting for the critic");
			}
			if (r.n() == c.best() && (c.ended() || r.scored())) {
				b.append("  ★ best");
			}
			out.add(b.toString());
		}
		return out;
	}

	/** The scores in a fixed order: "silhouette 8 · legibility 7 · craft 7 · materials 7 · brief 8". */
	public static String scoresLine(Map<String, Integer> scores) {
		List<String> keys = new ArrayList<>(scores.keySet());
		keys.sort(Comparator.comparingInt((String k) -> DIMENSIONS.indexOf(k) < 0 ? DIMENSIONS.size() : DIMENSIONS.indexOf(k)));
		List<String> parts = new ArrayList<>();
		for (String k : keys) {
			parts.add(k + " " + scores.get(k));
		}
		return String.join(" · ", parts);
	}

	/** The open issues, worst first: "P1 roof (iso): the roof hides the walls → lower the eaves". */
	public static List<String> issueLines(List<Critique.Issue> issues) {
		List<Critique.Issue> sorted = new ArrayList<>(issues);
		sorted.sort(Comparator.comparing(Critique.Issue::priority));
		List<String> out = new ArrayList<>();
		for (Critique.Issue i : sorted) {
			String where = (i.part() == null ? "whole building" : i.part()) + (i.view().isEmpty() ? "" : " (" + i.view() + ")");
			out.add(i.priority().name() + " " + where + ": " + i.what() + (i.fix().isEmpty() ? "" : " → " + i.fix()));
		}
		return out;
	}
}
