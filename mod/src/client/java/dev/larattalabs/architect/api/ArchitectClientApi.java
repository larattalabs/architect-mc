package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/** Architect's client-side API (client thread). Part of the {@link ArchitectApi#VERSION} contract. */
public interface ArchitectClientApi {
	/** The most cells drawn per composite key; layers past it draw as box outlines. Since 1.3.0. */
	int COMPOSITE_MAX_CELLS = 200_000;
	/** Layers further than this (blocks, from the camera to the layer's box) draw as box outlines. Since 1.3.0. */
	int COMPOSITE_FULL_DISTANCE = 160;

	static ArchitectClientApi get() {
		return dev.larattalabs.architect.client.api.ClientApiImpl.INSTANCE;
	}

	/**
	 * Shows {@code blueprintId} as a locked ghost at {@code origin} (the rotated box's minimum corner, as {@link PlaceRequest})
	 * with the HUD verdict until {@link #clearPreview()}: the placement ghost without the keys (nothing can be placed from it).
	 * Replaces any placement or preview in progress. Singleplayer only; throws {@link IllegalArgumentException} with a
	 * player-facing message (unknown design, not in a world).
	 */
	void preview(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style);

	/** Removes the preview (a no-op when none is shown; a placement the player started is left alone). */
	void clearPreview();

	/** Whether a preview is shown. */
	boolean previewing();

	/**
	 * Shows {@code layers} under {@code key}, replacing what that key showed (docs/CONTRACT.md "Phase 4c contract" and "4c review
	 * folded in" item 6): massings, delta ghosts, a settlement's site plan. Several keys show at once (by convention
	 * {@code <modid>:<thing>}). A preview only: no HUD verdict, no keys, nothing can be placed from it.
	 * <ul>
	 * <li>At most {@link #COMPOSITE_MAX_CELLS} cells per key, counted in layer order: a layer past the cap, or further than
	 * {@link #COMPOSITE_FULL_DISTANCE} blocks from the camera, draws as its box outline in its style's colour.</li>
	 * <li>The layers' meshes are built once, off the client thread; a layer appears a moment after the call.</li>
	 * <li>Composites clear when the player leaves the world. Client-only: a server-side mod sends its layers over its own
	 * packet and calls this on the client.</li>
	 * </ul>
	 * Client thread. Throws {@link IllegalArgumentException} for an unknown blueprint or massing id (nothing changes then), or
	 * when not in a world. Since 1.3.0.
	 */
	void previewComposite(String key, List<PreviewLayer> layers);

	/** Removes what {@code key} shows (a no-op for an unknown key). Client thread. Since 1.3.0. */
	void clearComposite(String key);

	/** The keys showing a composite now. Client thread. Since 1.3.0. */
	Set<String> compositeKeys();
}
