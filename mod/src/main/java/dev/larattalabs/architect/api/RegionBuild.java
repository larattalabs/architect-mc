package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * A survival region's build ({@link RegionView#build}; docs/CONTRACT.md "Phase 6c slice RS" §8, §12, Steward's S-RS-1 and S-RS-3): a
 * survival region's land is shaped at once and for free, and every block it builds is a construction target fed from its owner's
 * stockpile. {@link RegionState#PLACED} means every target is put down and every body has settled; {@code done} means it is fully
 * built. Since 1.38.0.
 *
 * @param built every construction target of the region (its tiles' targets, its lots, its 4e roads) is BUILT
 * @param done built, and the region is PLACED (every body settled): fully built (Steward reports "built" on it)
 * @param percent paid cells built over paid cells, 0 to 100 (100 with no paid cell): cheap to poll
 * @param outstanding what the region's targets still need, summed (their stockpile bills)
 * @param parts per plan part with held or paid cells (in the plan's order of first target): its state and targets
 */
public record RegionBuild(boolean built, boolean done, double percent, Map<Item, Integer> outstanding, List<PartBuild> parts) {
	public RegionBuild {
		outstanding = Map.copyOf(outstanding);
		parts = List.copyOf(parts);
	}
}
