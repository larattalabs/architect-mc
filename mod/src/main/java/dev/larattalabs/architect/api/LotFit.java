package dev.larattalabs.architect.api;

import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@link Sites#fitToLot}: where and how a design sits on a lot. Nothing is placed; pass {@code origin} and {@code rotation}
 * into a {@link PlaceRequest} (or a batch item). Since 1.4.0.
 *
 * @param origin the rotated box's minimum corner
 * @param rotation the entrance faces the street
 * @param box the template's box there
 * @param predictedRestoreBox the restore box for the actual terrain (template box, approach strip, one row below the lowest
 *                            written cell); absent when the spot could not be planned (not loaded, or the lot is too small)
 * @param verdict the normal {@link Sites#check} at that origin and rotation; {@link Reason#LOT_TOO_SMALL} when the footprint
 *                does not fit the lot after rotation and setback
 * @param recommendedLot (1.12.0) the smallest lot that holds this fit: from the street-edge row to the back of the footprint,
 *                       the footprint's width, the y span of the lot passed in. {@code fitToLot} on it gives the same origin and
 *                       rotation. On {@link Reason#LOT_TOO_SMALL}, the lot the design would need, anchored on the street edge
 *                       (it reaches past the lot given). The 1.4.0 constructor gives {@code box}.
 */
public record LotFit(BlockPos origin, Rotation rotation, BoundingBox box, Optional<BoundingBox> predictedRestoreBox, Verdict verdict,
	BoundingBox recommendedLot) {
	/** The 1.4.0 constructor ({@code recommendedLot}: the template box). */
	public LotFit(BlockPos origin, Rotation rotation, BoundingBox box, Optional<BoundingBox> predictedRestoreBox, Verdict verdict) {
		this(origin, rotation, box, predictedRestoreBox, verdict, box);
	}

	public boolean ok() {
		return verdict.ok();
	}
}
