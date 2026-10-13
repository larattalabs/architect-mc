package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * (6c P0) A resolved approval artifact ({@link Regions#artifact}; docs/CONTRACT.md "Phase 6c slice P0" §6): its sha (over its
 * canonical JSON, with no ids, timestamps or paths), its body (the frozen plan and inputs, the compiled region's IR and tile shas,
 * each part's answer, geometry and cost, provisional lots' cost ranges and fit boxes, the dropped parts), the region plan it came
 * from, the owners pinning it and the regions realised from it. A removed artifact is a tombstone: {@code removed}, its
 * {@code removedAt}, no body. Since 1.23.0.
 */
public record PlanArtifact(String artifactSha, @Nullable JsonObject body, String planId, Set<String> pinnedBy, Set<String> regions, boolean removed,
	long removedAt) {
	public PlanArtifact {
		pinnedBy = pinnedBy == null ? Set.of() : Set.copyOf(pinnedBy);
		regions = regions == null ? Set.of() : Set.copyOf(regions);
	}
}
