package dev.larattalabs.architect.api;

/**
 * How a placement is built.
 * <ul>
 * <li>{@code AUTO}: the world's survival toggle (on: a construction site, off: instant).</li>
 * <li>{@code INSTANT}: built at once. In a survival-toggle world it needs an {@code actor} with permission level 2; no actor,
 * or one without it, is refused {@link Reason#NOT_ALLOWED} (no free builds by an entity or a mod on its own).</li>
 * <li>{@code CONSTRUCTION}: a construction site fed through its crate, in any world (it costs the player items, so it
 * needs no permission even with the toggle off).</li>
 * </ul>
 */
public enum Mode {
	AUTO, INSTANT, CONSTRUCTION
}
