package dev.larattalabs.architect.api;

import net.minecraft.world.item.Item;

/** An item and a count (since 1.15.0): one entry of {@link SiteWait#nextNeeded()}. */
public record ItemCount(Item item, int count) {
}
