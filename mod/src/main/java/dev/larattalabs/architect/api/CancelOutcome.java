package dev.larattalabs.architect.api;

import java.util.Optional;

/**
 * What {@link Designs#cancelDesign} found and did (since NEXT, 7a K3; a helper with {@code "design.opKeys"}).
 *
 * @param kind {@link Kind#CANCELLED}, {@link Kind#ALREADY_FINAL} or {@link Kind#UNKNOWN}
 * @param design the design as it ended, with its final {@link Design#cost()}: status CANCELLED for {@link Kind#CANCELLED}, DONE or
 *     FAILED for {@link Kind#ALREADY_FINAL}; empty for {@link Kind#UNKNOWN}. A DONE design is reported only once its entry's new
 *     version is installed and loaded on the server (the moment {@link SiteEvents#DESIGN_DONE} fires)
 */
public record CancelOutcome(Kind kind, Optional<Design> design) {
	public CancelOutcome {
		design = design == null ? Optional.empty() : design;
	}

	/** New values are only ever appended. */
	public enum Kind {
		/**
		 * The design is cancelled and the helper confirmed that nothing more is spent on it: its running designer turn has stopped
		 * (its process is gone) and its internal calls (critic, polish, region pick) have ended. A design that was already cancelled
		 * answers this again (a retry), after the same check.
		 */
		CANCELLED,
		/** The design had already finished, DONE or FAILED: nothing was changed. */
		ALREADY_FINAL,
		/** The helper has no such design. */
		UNKNOWN
	}
}
