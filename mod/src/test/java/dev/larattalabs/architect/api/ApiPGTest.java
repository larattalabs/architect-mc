package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Since NEXT (slice PG; docs/CONTRACT.md "Slice PG" rule 8): the feature passageJoins (sidecar region.plan.passageJoin); no new records. */
class ApiPGTest {
	@Test
	void passageJoinsFeature() {
		assertTrue(ApiRules.features(2, List.of("region.plan.passageJoin")).contains("passageJoins"));
		assertFalse(ApiRules.features(2, List.of("region.plan.gateJoin")).contains("passageJoins"), "a GJ helper has no passage joins");
		assertFalse(ApiRules.features(1, List.of("region.plan.passageJoin")).contains("passageJoins"), "protocol 1 has no helper features");
	}
}
