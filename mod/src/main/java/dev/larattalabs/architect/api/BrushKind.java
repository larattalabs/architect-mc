package dev.larattalabs.architect.api;

/**
 * What a brush stroke does ({@link Regions#brush}, docs/CONTRACT.md "Phase 6c slice B" §3), inside its shape and after its mask:
 * <ul>
 * <li>{@code SMOOTH}: the surface moves toward its local integer mean; the edge stays pinned to the ground outside.</li>
 * <li>{@code ERODE}: thermal and stream touch-up; at most {@code strength} extra blocks of change per column.</li>
 * <li>{@code MELT}: exposed cells (at least 4 air neighbours of 6) removed, {@code strength} rounds: spikes and overhangs round off.</li>
 * <li>{@code BLEND}: the surface between the shape's centre and its edge relaxes, so a cut or fill at the centre meets the land.</li>
 * <li>{@code RAISE} / {@code LOWER}: {@code +/-strength} blocks at the centre, a smooth falloff to 0 at the edge; a fill takes the
 * pattern, else the subsurface under the surface block.</li>
 * <li>{@code OVERLAY}: the top {@code strength} cells of each column replaced by the pattern (else topsoil over subsoil).</li>
 * <li>{@code CAVE_CARVE}: a seeded worm from the centre, its floor levelled; it stops short of water, lava and unknown cells and
 * leaves nothing floating.</li>
 * </ul>
 * New values are only ever appended (a later slice adds the fluid kinds). Since 1.21.0.
 */
public enum BrushKind {
	SMOOTH, ERODE, MELT, BLEND, RAISE, LOWER, OVERLAY, CAVE_CARVE
}
