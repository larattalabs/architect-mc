package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (docs/CONTRACT.md "Phase 7a slice CL" §8): no new records, methods or IR kinds; the feature climbConnectors (sidecar
 * region.climbs: plan/0's connector.stair, connector.switchback and connector.ladder).
 */
class ApiCLTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.climbs")).contains("climbConnectors"));
		assertFalse(ApiRules.features(2, List.of("region.bridges")).contains("climbConnectors"), "a T3 helper has no climbs");
		assertFalse(ApiRules.features(1, List.of("region.climbs")).contains("climbConnectors"), "protocol 1 has no helper features");
	}
}
