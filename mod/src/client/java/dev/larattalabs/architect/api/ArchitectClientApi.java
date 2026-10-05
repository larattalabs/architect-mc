package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/** Architect's client-side API (client thread). Part of the {@link ArchitectApi#VERSION} contract. */
public interface ArchitectClientApi {
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
}
