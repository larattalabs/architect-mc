package dev.larattalabs.architect.placement;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * The placement HUD's grouped verdict (UI-2b; pure, unit-tested in {@code VerdictSummaryTest}): instead of every refusal
 * joined on one line (cut off at the panel's edge), one headline, "Would be refused: 3 issues", and the issues as a detail
 * list the player expands with "?". One issue is named in the headline itself. Duplicates and blanks are dropped; the detail
 * keeps the order the checks gave.
 */
public record VerdictSummary(String headline, List<String> issues) {
	/** How many issues the expanded detail lists; the rest are counted on one "+N more" line. */
	public static final int MAX_DETAIL = 6;

	/** {@code prefix} e.g. "Would be refused" (the ghost's own checks) or "The server would refuse". */
	public static VerdictSummary of(String prefix, List<String> refusals) {
		LinkedHashSet<String> uniq = new LinkedHashSet<>();
		for (String r : refusals) {
			if (r != null && !r.isBlank()) {
				uniq.add(r.strip());
			}
		}
		List<String> issues = List.copyOf(uniq);
		String head = issues.isEmpty() ? prefix : issues.size() == 1 ? prefix + ": " + issues.get(0) : prefix + ": " + issues.size() + " issues";
		return new VerdictSummary(head, issues);
	}

	public int count() {
		return issues.size();
	}

	/** Whether there is anything to expand (more than the headline says). */
	public boolean expandable() {
		return issues.size() > 1;
	}

	/** The expanded lines: "• issue" each, at most {@value #MAX_DETAIL}, then "+N more" when cut. */
	public List<String> detail() {
		if (!expandable()) {
			return List.of();
		}
		List<String> out = new ArrayList<>();
		for (int i = 0; i < issues.size() && i < MAX_DETAIL; i++) {
			out.add("• " + issues.get(i));
		}
		if (issues.size() > MAX_DETAIL) {
			out.add("+" + (issues.size() - MAX_DETAIL) + " more");
		}
		return out;
	}
}
