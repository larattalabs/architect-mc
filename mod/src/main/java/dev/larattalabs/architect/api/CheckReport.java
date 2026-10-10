package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * A region plan's macro checker report (docs/CONTRACT.md "# Phase 6b contract" §3.2, kit/REGIONS.md "The checker report"): the
 * rules M1-M14 (plus {@code M3:floating_spur}) run over the virtual world (plan survey + frozen volumes + the IR). Errors are
 * M1, M13 and M14's uniqueness; everything else is a warning. {@code ok} is "no errors". The full JSON ({@code report.json}:
 * metrics per rule, the stage prefixes, timings) stays in the plan dir; {@link RegionPlan#report()},
 * {@link Regions#check} and {@link SiteEvents#REGION_CHECKED} carry this summary. Since 1.9.0.
 */
public record CheckReport(boolean ok, int errors, int warnings, List<Finding> findings) {
	public CheckReport {
		findings = List.copyOf(findings);
	}

	/**
	 * One finding: the rule ({@code M1}..{@code M14}, {@code M3:floating_spur}), its severity ({@code error} | {@code warning}),
	 * the part and stage it is about (null: the whole plan), how many cells or items it counts, up to 20 sample positions, and
	 * the message. Findings are sorted by (rule, part, stage).
	 */
	public record Finding(String rule, String severity, @Nullable String part, @Nullable String stage, int count, List<BlockPos> sample, String message) {
		public Finding {
			sample = List.copyOf(sample);
		}

		/** Whether this finding is an error (a plan with one is not {@code ok}). */
		public boolean error() {
			return "error".equals(severity);
		}
	}

	/** The findings of {@code rule} (exact, or a sub-rule such as {@code M3:floating_spur} for {@code M3}). */
	public List<Finding> of(String rule) {
		return findings.stream().filter(f -> f.rule().equals(rule) || f.rule().startsWith(rule + ":")).toList();
	}
}
