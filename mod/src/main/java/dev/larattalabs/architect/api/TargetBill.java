package dev.larattalabs.architect.api;

import java.util.Map;
import net.minecraft.world.item.Item;
import org.jspecify.annotations.Nullable;

/**
 * (8b BL, feature {@code "regionBill"}) One construction target's bill ({@link RegionBill#targets}, {@link Sites#targetBill}): what it
 * costs in all, what it has been paid and what it still needs. Survival only. Since NEXT.
 *
 * @param target the target id: equal to {@link SiteView#id} (a site or a road), the join to a building row
 * @param region its region, or null for a build outside any region
 * @param lot the lot it stands on, or null
 * @param part its plan part ({@link PartBuild#part}), or null outside a region
 * @param revision the rid of the revision that put it down (0: the realised plan's): a growth shares its region with older ops
 * @param total paid + outstanding
 * @param paid what its built cells took
 * @param outstanding what it still needs (its stockpile bill)
 */
public record TargetBill(String target, @Nullable String region, @Nullable String lot, @Nullable String part, int revision, Map<Item, Integer> total,
	Map<Item, Integer> paid, Map<Item, Integer> outstanding) {
	public TargetBill {
		total = Map.copyOf(total);
		paid = Map.copyOf(paid);
		outstanding = Map.copyOf(outstanding);
	}
}
