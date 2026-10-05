package dev.larattalabs.architect.api;

/**
 * A site's state: built (instant, or a finished construction site), a construction site still building, or (1.4.0) an instant
 * placement whose cells are still being written over ticks ({@code PLACING}; its {@code built} / {@code queued} count the cells).
 * New values are only ever appended.
 */
public enum State {
	BUILT, BUILDING, PLACING
}
