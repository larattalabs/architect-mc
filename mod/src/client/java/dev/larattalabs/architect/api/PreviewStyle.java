package dev.larattalabs.architect.api;

/**
 * How {@link ArchitectClientApi#preview} and a {@link PreviewLayer} draw. Later minor versions may add styles.
 *
 * <p>{@link ArchitectClientApi#preview} draws every style as {@link #GHOST}. In a composite ({@link ArchitectClientApi#previewComposite},
 * since 1.3.0) each style has its own tint, so several read at once.
 */
public enum PreviewStyle {
	/** The placement ghost: the translucent building in its block colours (a composite layer: without conflicts or the HUD verdict). */
	GHOST,
	/** A massing: its masses in their (bible) colours washed towards slate blue, with the layer's box outlined. Since 1.3.0. */
	MASSING,
	/** Cells a change adds: green. Since 1.3.0. */
	ADDED,
	/** Cells a change removes: red outlines on their faces (and a faint red fill). Since 1.3.0. */
	REMOVED,
	/** Cells a change replaces: amber. Since 1.3.0. */
	CHANGED,
	/** Cells of a delta the player changed, which a KEEP delta leaves as they are: yellow outlines. Since 1.7.0. */
	KEPT
}
