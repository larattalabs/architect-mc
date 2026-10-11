package dev.larattalabs.architect.api;

import net.minecraft.world.item.Item;

/** An item and a count ({@link SiteWait#nextNeeded}). Since 1.18.0. */
public record ItemCount(Item item, int count) {
}
