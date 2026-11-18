package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;
import org.jspecify.annotations.Nullable;

/**
 * (8b BL, feature {@code "regionBill"}) A survival region's bill ({@link Regions#bill}): total, paid and outstanding over its target-fed
 * pieces, a page of its targets' bills, its whole charges as item maps, and the owed entries attributed to it. Creative: empty maps.
 * Read-only, $0. Since NEXT.
 *
 * @param region the region id
 * @param owner its owner, or null
 * @param total paid + outstanding over every target (not only this page)
 * @param paid what its targets' built cells took
 * @param outstanding what its targets still need
 * @param charges the realise's whole charges, per piece ({@code fluids}, {@code mech:<lot>}), as item maps (not in {@code total})
 * @param targets this page of targets, ordered by target id
 * @param targetsTotal how many targets the region has
 * @param maxBill the realise's {@code maxBill}, or null
 * @param owed the owed entries' keys attributed to the region ({@code Owed.region}); empty until owed attribution ships
 * @param exact false where {@code outstanding} reads unloaded chunks or a drift source
 * @param notes why it is not exact, and what was read
 */
public record RegionBill(String region, @Nullable String owner, Map<Item, Integer> total, Map<Item, Integer> paid, Map<Item, Integer> outstanding,
	Map<String, Map<Item, Integer>> charges, List<TargetBill> targets, int targetsTotal, @Nullable Map<String, Integer> maxBill, List<String> owed,
	boolean exact, List<String> notes) {
	public RegionBill {
		total = Map.copyOf(total);
		paid = Map.copyOf(paid);
		outstanding = Map.copyOf(outstanding);
		charges = Map.copyOf(charges);
		targets = List.copyOf(targets);
		owed = owed == null ? List.of() : List.copyOf(owed);
		notes = notes == null ? List.of() : List.copyOf(notes);
	}
}
