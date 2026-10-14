package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Phase 6c slice S2 (docs/CONTRACT.md "Phase 6c slice S2" §1): API 1.28.0 (v0.31.0) with no new records or methods; the feature
 * {@code scenarioS2} with an S2 helper ({@code region.outpost}: its kit bundles the {@code ice_outpost} program); no new IR kind.
 */
class ApiS2Test {
	@Test
	void version() {
		// later slices bump both; S2's versions (API 1.28.0, kit 0.29.0) are the floor
		String[] v = ArchitectApi.VERSION.split("\\."), k = IrStale.KIT_VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 28, ArchitectApi.VERSION);
		assertTrue(Integer.parseInt(k[0]) == 0 && Integer.parseInt(k[1]) >= 29, IrStale.KIT_VERSION);
	}

	@Test
	void features() {
		Set<String> s2 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.lightCover", "region.forms1", "region.passes",
			"region.scatter", "region.route", "region.outpost"));
		assertTrue(s2.contains("scenarioS2"));
		assertTrue(s2.contains("routePass") && s2.contains("formsIce") && s2.contains("reliefOp") && s2.contains("scatterOp"), "S2 composes T2, F1, T1 and F2");
		Set<String> t2 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.route"));
		assertFalse(t2.contains("scenarioS2"), "a helper without the outpost program has no scenarioS2");
		assertFalse(ApiRules.features(1, List.of("region.outpost")).contains("scenarioS2"), "protocol 1 has no sidecar features");
	}

	@Test
	void noNewKind() {
		for (String k : List.of("outpost", "s2", "keep")) {
			assertFalse(IrStale.KINDS_FORMAT2.contains(k), "S2 adds no format-2 kind: " + k);
		}
	}
}
