package dev.larattalabs.architect.api;

/**
 * What a placement does where it overlaps a standing site (docs/CONTRACT.md phase 4e "Overlap"). Since 1.5.0.
 * <ul>
 * <li>{@code REFUSE} (the default: null, or a 1.4.0 caller): 4d's behaviour, any overlap refuses {@link Reason#OVERLAP}. An
 * entrance approach stopped by a road is not an overlap (it writes nothing there).</li>
 * <li>{@code LAYER}: the new site goes on top: its {@code before} at shared cells is what the world shows (the lower site's
 * blocks), and removal works in any order. Refused {@link Reason#OVERLAP_BUSY} (temporary: a queued item waits) over a site
 * still placing, building or being removed; {@link Reason#OVERLAP_OWNED} over another owner's site unless forced;
 * {@link Reason#LAYER_DEPTH} past 8 layers.</li>
 * </ul>
 * New values are only ever appended.
 */
public enum OverlapPolicy {
	REFUSE, LAYER
}
