package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (DR) What {@link Sites#diagnose} found. {@code planId} names the scope, the journal's commit state and every finding's cells as found:
 * {@link Sites#repair} takes it and refuses {@link Reason#REPAIR_STALE} when any of that changed. {@code unread}: entries not read in this
 * call (the 256-chunk budget); {@code continuation} reads on from there (null: all read). Since 1.65.0.
 */
public record Diagnosis(DiagnoseScope scope, String planId, List<RepairFinding> findings, int unread, @Nullable String continuation) {
	public Diagnosis {
		findings = List.copyOf(findings);
	}

	/** Whether nothing was found (and everything was read). */
	public boolean clean() {
		return findings.isEmpty() && unread == 0;
	}
}
