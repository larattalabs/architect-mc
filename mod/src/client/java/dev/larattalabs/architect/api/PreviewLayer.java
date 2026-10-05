package dev.larattalabs.architect.api;

import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;
import org.jspecify.annotations.Nullable;

/**
 * One layer of a composite preview ({@link ArchitectClientApi#previewComposite}, docs/CONTRACT.md "Phase 4c contract"). Since
 * 1.3.0.
 *
 * @param blueprintId a library entry id, or a massing id ({@code <gameDir>/architect/massings/<id>/}, its latest version; a
 *     specific version as {@code <id>@<version>}). A library entry wins over a massing of the same id
 * @param origin where the rotated template's minimum corner goes (as {@link PlaceRequest} and {@link ArchitectClientApi#preview})
 * @param rotation the template's rotation
 * @param style the tint
 * @param onlyCells null = every cell the template writes; else only these, in <b>template coordinates</b> (unrotated, as the
 *     template stores them, {@code 0..size-1}): the cells a delta adds, removes or changes. A listed cell the template writes
 *     as air is drawn too (in the style's colour)
 */
public record PreviewLayer(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style, @Nullable Set<BlockPos> onlyCells) {
	public PreviewLayer {
		rotation = rotation == null ? Rotation.NONE : rotation;
		style = style == null ? PreviewStyle.GHOST : style;
		onlyCells = onlyCells == null ? null : Set.copyOf(onlyCells);
	}

	/** Every cell of {@code blueprintId}. */
	public static PreviewLayer of(String blueprintId, BlockPos origin, Rotation rotation, PreviewStyle style) {
		return new PreviewLayer(blueprintId, origin, rotation, style, null);
	}
}
