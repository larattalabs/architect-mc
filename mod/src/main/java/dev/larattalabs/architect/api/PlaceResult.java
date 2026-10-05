package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;

/** The outcome of {@link Sites#place}: placed with a site id and notes, or refused with every typed reason. */
public record PlaceResult(boolean placed, Optional<String> siteId, List<Refusal> refusals, List<String> notes) {
	public PlaceResult {
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
	}
}
