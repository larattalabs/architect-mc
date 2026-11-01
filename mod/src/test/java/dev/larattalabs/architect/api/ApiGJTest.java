package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a GJ; docs/CONTRACT.md "Phase 7a slice GJ" §9): the feature gateJoins (sidecar region.plan.gateJoin); no new records,
 * methods or reasons (BesideJoin unchanged: the gate is in the IR and the land, GateJoinTest).
 */
class ApiGJTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.plan.gateJoin")).contains("gateJoins"));
		assertFalse(ApiRules.features(2, List.of("region.plan.besideReach")).contains("gateJoins"), "a D3 helper has no gate joins");
		assertFalse(ApiRules.features(1, List.of("region.plan.gateJoin")).contains("gateJoins"), "protocol 1 has no helper features");
	}
}
