package dev.larattalabs.architect.api;

import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * (slice T4R-D) One owed part of a removal's result ({@link RemoveResult#owedParts()}): the owed key, its recipient (an owner id, a player's
 * UUID, or {@code architect:unclaimed}), its reason ({@link Owed#reason()}: {@code player_blocks}, {@code crate_settle}, {@code group_refund},
 * {@code cargo}, ...) and the amount the removal booked under it. Immutable: snapshotted before the removal finished, never changed by a
 * later collect or credit. Since NEXT.
 */
public record OwedPart(String key, String recipient, String reason, Map<Item, Integer> items) {
	public OwedPart {
		items = Map.copyOf(items);
	}
}
