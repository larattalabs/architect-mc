package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * API 1.13.0 (docs/CONTRACT.md phase 6c slice V §8): no new records or methods; V travels in the program id and params,
 * LotSpec.ext, RegionPlan.notes and siteplan.json. The features come with a V helper ({@code region.keepOut}).
 */
class Api113Test {
	@Test
	void version() {
		assertEquals("1.13.0", ArchitectApi.VERSION);
	}

	@Test
	void featuresComeWithAVHelper() {
		Set<String> v = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut"));
		for (String f : List.of("planKeepOut", "flatVillage", "regionGraph", "villagerMover")) {
			assertTrue(v.contains(f), f);
		}
		Set<String> old = ApiRules.features(2, List.of("region.plan", "region.tiles"));
		for (String f : List.of("planKeepOut", "flatVillage", "regionGraph", "villagerMover")) {
			assertFalse(old.contains(f), f);
		}
		assertFalse(ApiRules.features(1, List.of("region.keepOut")).contains("flatVillage"), "protocol 1 carries no helper features");
	}
}
