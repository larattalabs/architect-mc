package dev.larattalabs.architect.api;

import java.util.Locale;
import org.jspecify.annotations.Nullable;

/**
 * {@code critique.mode} (docs/CONTRACT.md "Phase 5a contract", "Opt-in vs default"): {@link #OFF} (the API default),
 * {@link #REPORT} (one critic call, no revision: scores and issues for about $0.1) or {@link #LOOP} (revise on the verdict until
 * it ships, a round cap, a budget or the clock stops it, then install the best round). Since 1.6.0. {@link #POLISH} (1.7.0): round
 * 0, a report, then targeted polish steps confined to the parts the issues name ({@code maxRevisions} means {@code maxSteps}).
 */
public enum CritiqueMode {
	OFF, REPORT, LOOP, POLISH;

	public String wire() {
		return name().toLowerCase(Locale.ROOT);
	}

	/** {@code off | report | loop}; anything else (or null) is OFF. */
	public static CritiqueMode of(@Nullable String s) {
		if (s == null) {
			return OFF;
		}
		return switch (s.toLowerCase(Locale.ROOT)) {
			case "report" -> REPORT;
			case "loop" -> LOOP;
			case "polish" -> POLISH;
			default -> OFF;
		};
	}
}
