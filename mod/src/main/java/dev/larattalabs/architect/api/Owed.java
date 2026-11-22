package dev.larattalabs.architect.api;

import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

/**
 * (slice T2b) An owed collectible: items Architect owes {@code recipient} that could not go back into a stock (instead of dropping them
 * as item entities). Collected with {@link Sites#collectOwed}, or credited into the recipient's stockpile with
 * {@link Sites#creditOwedToStock}; it never expires. Since 1.72.0.
 *
 * @param key the source's semantic key, stable for the entry's whole life (e.g. {@code crate:<owner>@x,y,z/<siteKey>})
 * @param recipient a player UUID string, or an owner id ({@code steward_mc:settlement/<id>})
 * @param dimension and {@code at}: the source cell (the former crate cell); stable API values
 * @param items what is still owed (the item type the {@link Stockpile} ledger uses)
 * @param reason {@code "crate_settle"}, {@code "crate_putback"} or {@code "group_refund"} (later kinds appended); stable API values
 * @param createdTick the server's tick count when it was owed ({@link Sites#owed} orders by it)
 * @param createdWall the wall clock (epoch ms) then
 * @param site the target (site or road) id the entry came from, or null when none is known
 * @param region that target's region id, or null
 */
public record Owed(String key, String recipient, ResourceKey<Level> dimension, BlockPos at, Map<Item, Integer> items, String reason, long createdTick,
	long createdWall, @org.jspecify.annotations.Nullable String site, @org.jspecify.annotations.Nullable String region) {
	public Owed {
		items = Map.copyOf(items);
	}

	/** Without {@code site} and {@code region} (both null). */
	public Owed(String key, String recipient, ResourceKey<Level> dimension, BlockPos at, Map<Item, Integer> items, String reason, long createdTick,
		long createdWall) {
		this(key, recipient, dimension, at, items, reason, createdTick, createdWall, null, null);
	}
}
