package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a K3; docs/CONTRACT.md "Phase 7a slice K3" §8): no new records, methods, reasons or IR kinds; the feature wallLots
 * (sidecar region.walls.lots).
 */
class ApiK3Test {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.walls.lots")).contains("wallLots"));
		assertFalse(ApiRules.features(2, List.of("region.walls", "region.walls.walk", "region.walls.along")).contains("wallLots"), "a K1/K2 helper has no wallLots");
		assertFalse(ApiRules.features(1, List.of("region.walls.lots")).contains("wallLots"), "protocol 1 has no helper features");
	}
}
