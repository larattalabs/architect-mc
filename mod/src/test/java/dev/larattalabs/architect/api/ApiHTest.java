package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * API 1.34.0, a placeholder the coordinator renumbers at merge (docs/CONTRACT.md "Phase 6c slice H" §12): no new records or methods; the
 * features regionFluids and fluidVolumes (sidecar region.fluids) and wetWrites (sidecar region.wet); the IR kinds fluid and volume:fluids.
 */
class ApiHTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.fluids")).containsAll(List.of("regionFluids", "fluidVolumes")));
		assertTrue(ApiRules.features(2, List.of("region.wet")).contains("wetWrites"));
		assertFalse(ApiRules.features(2, List.of("region.tunnels")).contains("regionFluids"), "a T3 helper has no fluids");
		assertFalse(ApiRules.features(2, List.of("region.wet")).contains("fluidVolumes"), "wet writes alone bring no fluid volumes");
		assertFalse(ApiRules.features(1, List.of("region.fluids", "region.wet")).contains("regionFluids"), "protocol 1 has no helper features");
	}

	@Test
	void versionsAndKinds() {
		assertEquals("1.34.0", ArchitectApi.VERSION);
		assertEquals("0.35.1", IrStale.KIT_VERSION);
		assertTrue(IrStale.KINDS_FORMAT2.containsAll(List.of("fluid", "volume:fluids")));
		assertEquals(List.of("fluid", "volume:fluids"), IrStale.KINDS_FORMAT2.subList(IrStale.KINDS_FORMAT2.size() - 2, IrStale.KINDS_FORMAT2.size()), "appended at the end");
	}
}
