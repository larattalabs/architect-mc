package dev.larattalabs.architect.api;

import java.util.List;

/**
 * (M5 GP) How {@link Designs#fromProgram} and {@link Designs#variant} fail when the caller's program is refused: {@link Reason#PROGRAM_REFUSED}
 * with the kit checker's errors as typed findings ({@link #report()}: {@link CheckReport.Finding#rule()}, severity {@code error}, the
 * checker's message; {@code part}, {@code stage} and {@code sample} are empty). Nothing was installed.
 *
 * <p>{@link #detail()}:
 * <ul>
 * <li>a checker refusal: the first finding's rule. {@code reserved} (the design writes one of the lot's reserved cells), {@code size},
 * {@code sidecar} (the program's Blueprint fields, e.g. a profile rule it can't meet), {@code structure}, {@code blocks} (a non-vanilla
 * or malformed block), {@code anchors}, {@code massing}, or {@code check} (any other checker rule: the message names it);</li>
 * <li>{@code params}: a value outside the program's own schema (its {@code export const params}); {@code palette}: a bible or palette
 * the program can't take (or a bible that is gone);</li>
 * <li>{@code program}: the program threw, has no default export or is too long, or it tried to reach outside its sandbox (files outside
 * its scratch, the network, a child process); {@code timeout}: it ran out of the plan's time; {@code sandbox}: this helper's Node has
 * no permission model;</li>
 * <li>{@code program_stale}: a variant's entry's kept source ({@code program/source.mjs}) is not the program it recorded (its sha);
 * {@code not_given}: a variant of an entry that was not made by {@link Designs#fromProgram} (its variants are
 * {@link Library#makeVariant}).</li>
 * </ul>
 * Since 1.55.0.
 */
public class ProgramRefused extends ArchitectRefused {
	private final CheckReport report;

	public ProgramRefused(String message, String detail, List<CheckReport.Finding> findings) {
		super(Reason.PROGRAM_REFUSED, message, detail);
		List<CheckReport.Finding> f = findings == null ? List.of() : List.copyOf(findings);
		this.report = new CheckReport(false, (int) f.stream().filter(CheckReport.Finding::error).count(), (int) f.stream().filter(x -> !x.error()).count(), f);
	}

	/** The checker's findings (at most 50, in the checker's order). */
	public CheckReport report() {
		return report;
	}
}
