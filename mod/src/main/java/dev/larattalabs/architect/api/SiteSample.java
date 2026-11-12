package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;

/**
 * (7b) {@link Survey#site}: a lot's site, sampled and analysed. Since NEXT.
 *
 * @param volume the frozen volume of the lot box plus 8 cells on every side
 * @param affordances what the analysis found in it, best first
 * @param proposed a frame for the requested fit, when the analysis finds one
 */
public record SiteSample(Volume volume, List<Affordance> affordances, Optional<SiteFrame> proposed) {
	public SiteSample {
		affordances = affordances == null ? List.of() : List.copyOf(affordances);
		proposed = proposed == null ? Optional.empty() : proposed;
	}
}
