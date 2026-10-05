package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * The outcome of {@link Sites#remove}.
 *
 * @param blockers why it was not removed: the player's things in the box, the owner rule, a player standing in it, ...
 * @param refund in survival, every item the deconstruct dropped at the crate's cell: refunds for paid cells still standing,
 *               the player's own blocks found in the box, and the crate's stock and credit. Empty for an instant site.
 */
public record RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund) {
	public RemoveResult {
		blockers = List.copyOf(blockers);
		refund = Map.copyOf(refund);
	}
}
