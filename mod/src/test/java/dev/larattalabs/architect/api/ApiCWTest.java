package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a CW; docs/CONTRACT.md "Phase 7a slice CW" §7): no new records, methods, reasons or IR kinds; the feature catwalks
 * (sidecar region.catwalks).
 */
class ApiCWTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.catwalks")).contains("catwalks"));
		assertFalse(ApiRules.features(2, List.of("region.bridges")).contains("catwalks"), "a T3 helper has no catwalks");
		assertFalse(ApiRules.features(1, List.of("region.catwalks")).contains("catwalks"), "protocol 1 has no helper features");
	}
}
