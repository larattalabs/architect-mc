package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a RK; docs/CONTRACT.md "Phase 7a slice RK" §7): no new records, methods, reasons or IR kinds; the feature rockStairs
 * (sidecar region.rockStairs).
 */
class ApiRKTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.rockStairs")).contains("rockStairs"));
		assertFalse(ApiRules.features(2, List.of("region.tunnels")).contains("rockStairs"), "a T3 helper has no rockStairs");
		assertFalse(ApiRules.features(1, List.of("region.rockStairs")).contains("rockStairs"), "protocol 1 has no helper features");
	}
}
