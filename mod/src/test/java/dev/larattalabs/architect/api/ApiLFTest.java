package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a LF; docs/CONTRACT.md "Phase 7a slice LF" §7): the feature liftConnectors (sidecar region.lifts); no new records, methods
 * or reasons (the IR kind bubbleColumns and the StillOurs row: RegionFluidsLFTest, StillOursLFTest).
 */
class ApiLFTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.lifts")).contains("liftConnectors"));
		assertFalse(ApiRules.features(2, List.of("region.rockStairs")).contains("liftConnectors"), "an RK helper has no lifts");
		assertFalse(ApiRules.features(1, List.of("region.lifts")).contains("liftConnectors"), "protocol 1 has no helper features");
	}
}
