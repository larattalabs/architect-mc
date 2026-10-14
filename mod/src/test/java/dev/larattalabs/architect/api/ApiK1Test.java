package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * API 1.30.0 placeholder (docs/CONTRACT.md "Phase 7a slice K1" §8): no new records, methods or IR kinds; the features
 * wallConnectors (sidecar region.walls), ropeBridges and autoConnector (sidecar region.rope).
 */
class ApiK1Test {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.walls")).contains("wallConnectors"));
		assertTrue(ApiRules.features(2, List.of("region.rope")).containsAll(List.of("ropeBridges", "autoConnector")));
		assertFalse(ApiRules.features(2, List.of("region.boundary")).contains("wallConnectors"), "a D2 helper has no walls");
		assertFalse(ApiRules.features(2, List.of("region.walls")).contains("autoConnector"), "walls alone bring no auto connector");
		assertFalse(ApiRules.features(1, List.of("region.walls", "region.rope")).contains("wallConnectors"), "protocol 1 has no helper features");
	}
}
