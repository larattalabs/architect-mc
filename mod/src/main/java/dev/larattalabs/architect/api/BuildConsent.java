package dev.larattalabs.architect.api;

import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A request's consent to write over player builds (docs/CONTRACT.md "Phase 6c slice PT" §6): only the builds it names explicitly
 * (an alias resolves to its survivor), and for each named build the actor must be one of its placers (at least 10% of its cells)
 * or hold permission level 2. Unnamed builds still refuse; {@code force} never overrides a build (N-PT-6). Steward's change
 * requests carry the asking player as the actor (S-PT-3). Since PT.
 */
public record BuildConsent(Set<String> buildIds, @Nullable UUID actor) {
	public BuildConsent {
		buildIds = Set.copyOf(buildIds);
	}
}
