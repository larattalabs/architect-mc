package dev.larattalabs.architect.api;

import java.util.Map;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.world.item.Item;

/**
 * A group's stockpile (R6, {@link Sites#stock}): what its shared crate was given, what it holds as credit (stock no site
 * still needs as is), and the outstanding bill of materials per construction site and in total. Since 1.4.0.
 *
 * @param delivered every item booked into the group's crate(s) since the sites were placed
 * @param credit items held that no unbuilt cell needs as they are (left over from equivalents, or past what is needed)
 * @param outstandingBySite per construction site still building, the items its unbuilt cells cost
 * @param outstanding the sum of {@code outstandingBySite}
 * @param crate the shared crate's cell (absent without one)
 */
public record Stock(String groupId, Map<Item, Integer> delivered, Map<Item, Integer> credit, Map<String, Map<Item, Integer>> outstandingBySite,
	Map<Item, Integer> outstanding, Optional<BlockPos> crate) {
	public Stock {
		delivered = Map.copyOf(delivered);
		credit = Map.copyOf(credit);
		outstandingBySite = Map.copyOf(outstandingBySite);
		outstanding = Map.copyOf(outstanding);
	}
}
