package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;

/**
 * The outcome of {@link Sites#place}: placed with a site id and notes, or refused with every typed reason.
 *
 * @param skipped (1.12.0) a partial road's dropped spans ({@link RoadRequest#partial}); empty otherwise
 */
public record PlaceResult(boolean placed, Optional<String> siteId, List<Refusal> refusals, List<String> notes, List<RoadSpan> skipped) {
	public PlaceResult {
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
		skipped = skipped == null ? List.of() : List.copyOf(skipped);
	}

	/** The 1.0 constructor (nothing skipped). */
	public PlaceResult(boolean placed, Optional<String> siteId, List<Refusal> refusals, List<String> notes) {
		this(placed, siteId, refusals, notes, List.of());
	}
}
