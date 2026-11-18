package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (8b, Steward's S-8b-6/8) The typed home of a districts region's {@code architect_mc:land} ext ({@link RegionView#land}): the land it takes
 * outside its town's claim (the district's to own) and inside it, as column runs. Since 1.69.0.
 *
 * @param version the land record's version (1; 2 once the region has had a revision)
 * @param outside the columns outside the town's claim
 * @param inside the columns inside it (the join's cells in the town's claim)
 * @param standingRemoved when the town it was built beside was removed (epoch ms), or null
 */
public record RegionLand(int version, List<Run> outside, List<Run> inside, @Nullable Long standingRemoved) {
	public RegionLand {
		outside = List.copyOf(outside);
		inside = List.copyOf(inside);
	}

	/** One row's columns: {@code z}, from {@code x0} to {@code x1} (inclusive, {@code x0 <= x1}). */
	public record Run(int z, int x0, int x1) {
	}
}
