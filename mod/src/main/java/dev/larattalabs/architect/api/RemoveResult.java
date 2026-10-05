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
 * @param restored (1.5.0) cells the undo wrote back
 * @param kept (1.5.0) CELL cells the player changed since: left as they are
 * @param handedDown (1.5.0) cells covered by a site that stays, per covering site id: they stay its blocks until it goes
 * @param cascaded (1.5.0) the covering sites a {@code CASCADE} removed first, top-down
 */
public record RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund, int restored, int kept, Map<String, Integer> handedDown,
	List<String> cascaded) {
	public RemoveResult {
		blockers = List.copyOf(blockers);
		refund = Map.copyOf(refund);
		handedDown = Map.copyOf(handedDown);
		cascaded = List.copyOf(cascaded);
	}

	/** The 1.4.0 constructor. */
	public RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund) {
		this(removed, blockers, refund, 0, 0, Map.of(), List.of());
	}
}
