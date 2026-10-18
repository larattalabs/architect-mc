package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * API 1.33.0 (v0.36.0, the T3 batch; docs/CONTRACT.md "Phase 6c slice T3" §8): no new records, methods or
 * IR kinds; the features bridgeConnectors (sidecar region.bridges), tunnelConnectors and planCheckVolumes (sidecar region.tunnels).
 */
class ApiT3Test {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.bridges")).contains("bridgeConnectors"));
		assertTrue(ApiRules.features(2, List.of("region.tunnels")).containsAll(List.of("tunnelConnectors", "planCheckVolumes")));
		assertFalse(ApiRules.features(2, List.of("region.rope")).contains("bridgeConnectors"), "a K1 helper has no bridges");
		assertFalse(ApiRules.features(2, List.of("region.bridges")).contains("planCheckVolumes"), "bridges alone bring no volume pass");
		assertFalse(ApiRules.features(1, List.of("region.bridges", "region.tunnels")).contains("bridgeConnectors"), "protocol 1 has no helper features");
	}
}
