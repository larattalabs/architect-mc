package dev.larattalabs.architect.api;

/**
 * One step of a placed site's history (docs/CONTRACT.md phase 5b): the version it reached, when, how, and whether it can still
 * be journal-undone. {@code revertible} is false for every delta built as a construction delta, permanently (a later toggle
 * change to INSTANT never makes it undoable: that would put back refunded blocks), and for a version folded into the base;
 * such a version is reached again only by a forward delta. Since 1.7.0.
 */
public record SiteVersion(int version, long appliedAt, Kind kind, boolean revertible) {
	/** New values are only ever appended. */
	public enum Kind {
		PLACED, DELTA, REVERT, FORWARD
	}
}
