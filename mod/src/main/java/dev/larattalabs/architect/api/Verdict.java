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
 * @param box the template's box; {@code restoreBox} the box its snapshot covers (absent when it could not be planned)
 */
public record Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
	Optional<BoundingBox> restoreBox) {
	public Verdict {
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
		bom = Map.copyOf(bom);
	}

	public boolean ok() {
		return refusals.isEmpty();
	}
}
