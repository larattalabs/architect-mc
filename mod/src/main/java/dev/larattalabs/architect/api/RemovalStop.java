package dev.larattalabs.architect.api;

/**
 * How a region's last removal stopped ({@link RegionView#removalStop()}). Since 1.67.0 (feature {@code "removalStop"}).
 * <ul>
 * <li>{@link #NONE}: no removal stopped since the region's last removal began (or none ever ran).</li>
 * <li>{@link #NOT_STARTED}: it stopped before it wrote anything (refused, a blocker, the stockpile ledger not saved): every site stands as
 * it did, nothing was refunded, and the region keeps the state it had ({@code PLACED}, ...), never {@code PARTIAL}.</li>
 * <li>{@link #PARTIAL}: it stopped after it began taking the region down (its undo committed, or its fluid bodies drained): the region is
 * {@code PARTIAL}; a later removal resumes it.</li>
 * </ul>
 * Append-only.
 */
public enum RemovalStop {
	NONE, NOT_STARTED, PARTIAL
}
