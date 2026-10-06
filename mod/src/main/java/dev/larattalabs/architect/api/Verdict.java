package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@link Sites#check}: what {@link Sites#place} would do.
 *
 * @param construction whether it would become a construction site (the mode resolved against the world's toggle)
 * @param bom for a construction site, the template's bill of materials (foundation and approach come on top once placed;
 *            the crate screen shows the exact one); empty for an instant placement
 * @param box the template's box; {@code restoreBox} the box its snapshot covers (absent when it could not be planned); for a
 *            road or cell site ({@link Sites#checkRoad}, {@link Sites#checkCells}) both are the box of the cells it changes
 * @param overlaps (1.5.0) the standing sites its restore box overlaps, per site
 * @param cells (1.5.0) a road's or cell site's cell count (0 for a building)
 */
public record Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
	Optional<BoundingBox> restoreBox, List<Overlap> overlaps, int cells) {
	public Verdict {
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
		bom = Map.copyOf(bom);
		overlaps = List.copyOf(overlaps);
	}

	/** The 1.4.0 constructor. */
	public Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
		Optional<BoundingBox> restoreBox) {
		this(refusals, notes, construction, bom, box, restoreBox, List.of(), 0);
	}

	public boolean ok() {
		return refusals.isEmpty();
	}
}
