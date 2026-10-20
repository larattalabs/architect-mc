package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * API 1.37.0 (the CU/IRR/VOC-c batch, v0.40.0; docs/CONTRACT.md "Phase 6c slice CU" §6): the feature {@code "weatheringOurs"}, always there (no record,
 * method or enum changes), and the versions.
 */
class ApiCuTest {
	@Test
	void versionsAndFeature() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.37.0") >= 0, ArchitectApi.VERSION);
		assertTrue(ApiRules.features(0, List.of()).contains("weatheringOurs"));
		assertTrue(ApiRules.features(2, List.of("job.run")).contains("weatheringOurs"));
		assertTrue(ApiRules.JAVA_FEATURES.contains("journal"));
	}
}
