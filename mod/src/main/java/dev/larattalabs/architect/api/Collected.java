package dev.larattalabs.architect.api;

import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * (slice T2b) What {@link Sites#collectOwed} or {@link Sites#creditOwedToStock} did: {@code given} (into the player's inventory, or the
 * stock), and what {@code stillOwed} under the key (a full inventory takes only what fits). Since NEXT.
 */
public record Collected(String key, Map<Item, Integer> given, Map<Item, Integer> stillOwed, boolean replayed) {
	public Collected {
		given = Map.copyOf(given);
		stillOwed = Map.copyOf(stillOwed);
	}
}
