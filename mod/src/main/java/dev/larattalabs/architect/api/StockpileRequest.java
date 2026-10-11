package dev.larattalabs.architect.api;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;

/**
 * {@link Sites#createStockpile} (C24): the owner's stockpile in one dimension, with the cells its crates go on (each into air or
 * a replaceable block, outside every standing site's restore box and every protected area of another owner; at most
 * {@link Limits#STOCKPILE_CRATES}). Since 1.18.0.
 *
 * @param owner {@code <modid>:<thing>} (required)
 * @param dimension the stockpile's one dimension (S-Y-6)
 * @param crates crate cells; those already crates of the stockpile are skipped (idempotent)
 */
public record StockpileRequest(String owner, ResourceKey<Level> dimension, List<BlockPos> crates) {
	public StockpileRequest {
		crates = crates == null ? List.of() : List.copyOf(crates);
	}
}
