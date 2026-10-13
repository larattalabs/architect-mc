package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Phase 6c slice T2 (docs/CONTRACT.md "Phase 6c slice T2" §1): API 1.22.0 with no new records or methods; the feature
 * {@code routePass} with a T2 helper ({@code region.route}); no new IR kind (routes are roads, stairs and columns).
 */
class ApiT2Test {
	@Test
	void version() {
		// later slices bump both; T2's placeholders are the floor
		String[] v = ArchitectApi.VERSION.split("\\."), k = IrStale.KIT_VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 22, ArchitectApi.VERSION);
		assertTrue(Integer.parseInt(k[0]) == 0 && Integer.parseInt(k[1]) >= 24, IrStale.KIT_VERSION);
	}

	@Test
	void features() {
		Set<String> t2 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover", "region.passes", "region.route"));
		assertTrue(t2.contains("routePass"));
		assertTrue(t2.contains("planPasses"));
		Set<String> t1 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover", "region.passes"));
		assertFalse(t1.contains("routePass"), "a T1 helper has no route pass");
	}

	@Test
	void noNewKind() {
		assertFalse(IrStale.KINDS_FORMAT2.contains("route"), "routes need no format-2 kind");
		assertTrue(IrStale.KINDS_FORMAT2.contains("relief"), "T1's relief kind is kept");
	}
}
