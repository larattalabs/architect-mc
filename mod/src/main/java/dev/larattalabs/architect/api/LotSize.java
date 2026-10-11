package dev.larattalabs.architect.api;

import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@link Sites#minLotSize}: the smallest lot {@link Sites#fitToLot} accepts for a design (docs/CONTRACT.md phase 6c slice 0c
 * §2). The same for every street side. Since 1.12.0.
 *
 * @param alongStreet the rotated footprint's width along the street
 * @param deep the rotated footprint's depth plus the setback (a lot of {@code alongStreet × deep} fits; one block less on
 *             either axis is {@link Reason#LOT_TOO_SMALL})
 * @param setback the setback used (the options' setback, else the approach length; 0 with approachIntoStreet)
 * @param frontMargin {@link OverlapMargin#front}: how far the restore box may grow past the front face (for planners; not part
 *                    of {@code deep}, as the restore box may already reach into the street)
 */
public record LotSize(int alongStreet, int deep, int setback, int frontMargin) {
	/**
	 * The minimal lot inside (or, when {@code lot} is smaller, around) {@code lot}, anchored as {@link Sites#fitToLot} anchors:
	 * on {@code lot}'s street edge, centred on its street-side span ({@code lo + floor((span - alongStreet) / 2)}), {@code deep}
	 * rows in from the street, at {@code lot}'s y span.
	 */
	public BoundingBox at(BoundingBox lot, Direction streetSide) {
		if (streetSide == null || streetSide.getAxis().isVertical()) {
			throw new IllegalArgumentException("streetSide must be north, east, south or west");
		}
		boolean alongX = streetSide == Direction.NORTH || streetSide == Direction.SOUTH;
		int lo = alongX ? lot.minX() : lot.minZ();
		int hi = alongX ? lot.maxX() : lot.maxZ();
		int a0 = lo + Math.floorDiv(hi - lo + 1 - alongStreet, 2);
		int a1 = a0 + alongStreet - 1;
		return switch (streetSide) {
			case NORTH -> new BoundingBox(a0, lot.minY(), lot.minZ(), a1, lot.maxY(), lot.minZ() + deep - 1);
			case SOUTH -> new BoundingBox(a0, lot.minY(), lot.maxZ() - deep + 1, a1, lot.maxY(), lot.maxZ());
			case WEST -> new BoundingBox(lot.minX(), lot.minY(), a0, lot.minX() + deep - 1, lot.maxY(), a1);
			default -> new BoundingBox(lot.maxX() - deep + 1, lot.minY(), a0, lot.maxX(), lot.maxY(), a1);
		};
	}
}
