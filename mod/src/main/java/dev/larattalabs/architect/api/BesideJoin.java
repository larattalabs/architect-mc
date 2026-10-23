package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.jspecify.annotations.Nullable;

/**
 * (6c D3, D-S4) The join a dry beside check found ({@link BesideVerdict#join}; docs/CONTRACT.md "Phase 6c slice D3" §7): the standing
 * region it meets, the junction's kind ({@code "end"}: a street end, continuing its line; {@code "side"}: a T at a street's side), the
 * search step that found it ({@code "seam"}: D1's, inside the claim's seam; {@code "reach"}: into the town's claim), the street road
 * it meets, the street end's node (an end only), the junction cell (the join's end, its feet), the join's facing there (away from the
 * street), its written columns and how many of them lie in the town's claim. Since NEXT.
 */
public record BesideJoin(String region, String kind, String step, String road, @Nullable String node, BlockPos at, Direction facing, int cells,
	int insideCells) {
}
