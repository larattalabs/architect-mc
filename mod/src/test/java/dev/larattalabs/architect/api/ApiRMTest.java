package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Since NEXT (docs/CONTRACT.md "Phase 7c" §3 row 8, slice RM): region M15's feature, advertised only with the helper's. */
class ApiRMTest {
	@Test
	void regionM15AdvertisedOnlyWithTheHelpersFeature() {
		Set<String> on = ApiRules.features(2, List.of("job.run", "region.m15"));
		assertTrue(on.contains("regionM15"));
		assertFalse(on.contains("region.m15"), "the sidecar name maps to the stable one");
		assertFalse(ApiRules.features(2, List.of("job.run")).contains("regionM15"));
		assertFalse(ApiRules.features(1, List.of("region.m15")).contains("regionM15"), "protocol 1 advertises no sidecar feature");
		assertFalse(ApiRules.JAVA_FEATURES.contains("regionM15"));
	}
}
