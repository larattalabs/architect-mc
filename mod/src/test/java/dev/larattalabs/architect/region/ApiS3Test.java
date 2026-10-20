package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Phase 6c slice S3 (docs/CONTRACT.md "Phase 6c slice S3" §5): API 1.40.0 (placeholder; the coordinator renumbers) with no new records,
 * methods, reasons or IR kinds; the features {@code terracedZones} (an S3 helper, {@code region.terracedZones}: plan/0's {@code terraces}
 * member) and {@code scenarioS3} ({@code region.monastery}: its kit bundles the {@code terraced_monastery} program).
 */
class ApiS3Test {
	@Test
	void version() {
		// later slices bump both; S3's placeholders (API 1.40.0, kit 0.41.0) are the floor
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.40.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.41.0") >= 0, IrStale.KIT_VERSION);
	}

	@Test
	void features() {
		Set<String> s3 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.planCheck", "region.districts", "region.terracedZones", "region.monastery"));
		assertTrue(s3.contains("terracedZones") && s3.contains("scenarioS3"));
		assertTrue(s3.contains("districtsPass") && s3.contains("planCheck"), "S3 composes D1 and P0");
		Set<String> d1 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.districts"));
		assertFalse(d1.contains("terracedZones") || d1.contains("scenarioS3"), "a helper without the member or the program has neither");
		assertFalse(ApiRules.features(1, List.of("region.terracedZones", "region.monastery")).contains("scenarioS3"), "protocol 1 has no sidecar features");
	}

	@Test
	void noNewKind() {
		for (String k : List.of("terrace", "terraces", "monastery", "s3")) {
			assertFalse(IrStale.KINDS_FORMAT2.contains(k), "S3 adds no format-2 kind: " + k);
		}
	}
}
