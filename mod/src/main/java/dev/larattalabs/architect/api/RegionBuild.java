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
 * @param terrainPerTick (8a, feature {@code terrainConstruction}) the world's effective staged-terrain rate, cells per tick shared by a region's staged terrain targets
 *                       ({@code terrainPerTick} in architect-world.json, default 16, clamped 1-64), so a caller can say "about N min" as
 *                       {@code (terrainCells - terrainBuilt) / (terrainPerTick * 20)} seconds while loaded (docs/CONTRACT.md "Phase 8a" §3,
 *                       §6). From 8a, {@code built}, {@code done} and {@code percent} count staged terrain cells with the paid ones
 *                       ({@code percent} = (paid built + terrain built) / (paid + terrain)). 0 from the old constructor (never divide by
 *                       it unchecked). Since NEXT.
 */
public record RegionBuild(boolean built, boolean done, double percent, Map<Item, Integer> outstanding, List<PartBuild> parts, int terrainPerTick) {
	public RegionBuild {
		outstanding = Map.copyOf(outstanding);
		parts = List.copyOf(parts);
	}

	/** The 1.38.0 shape: no terrain rate ({@link #terrainPerTick} 0). */
	public RegionBuild(boolean built, boolean done, double percent, Map<Item, Integer> outstanding, List<PartBuild> parts) {
		this(built, done, percent, outstanding, parts, 0);
	}
}
