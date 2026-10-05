package dev.larattalabs.architect.batch;

import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * Where a group's shared crate goes when the batch names no {@code crateAt} (docs/CONTRACT.md phase 4d, R6): next to the
 * first construction site's approach end, in a cell that lies outside every item's (predicted) restore box, so no later lot
 * of the batch ever snapshots or overwrites it. Pure.
 */
public final class CratePlacement {
	/** How far out (in cells along the approach) the search goes. */
	public static final int MAX_STEPS = 8;

	private CratePlacement() {
	}

	/**
	 * The crate cell, or null when none is free within {@link #MAX_STEPS}. Tried in order, for k = 0..MAX_STEPS: one cell to the
	 * right of the walking line, then one to the left, at {@code k + 1} cells beyond the approach end (the way the single-site
	 * crate goes), each at the end's feet height.
	 *
	 * @param end the approach's last cell at feet height (or the cell in front of the entrance when there is no approach)
	 * @param out the outward step (dx, dz) of the entrance
	 * @param boxes every item's restore box (predicted), inclusive
	 */
	public static int @Nullable [] choose(int[] end, int[] out, List<Anchors.Bounds> boxes) {
		int[] right = {-out[1], out[0]};
		for (int k = 0; k <= MAX_STEPS; k++) {
			for (int side : new int[] {1, -1}) {
				int x = end[0] + out[0] * (k + 1) + right[0] * side;
				int z = end[2] + out[1] * (k + 1) + right[1] * side;
				int y = end[1];
				if (boxes.stream().noneMatch(b -> b.contains(x, y, z))) {
					return new int[] {x, y, z};
				}
			}
		}
		return null;
	}
}
