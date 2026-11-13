package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7c TC) The template catalogue on the mod side: {@code scenarioTemplates} comes with the helper's {@code region.templates} (never
 * without it), and the pick's affordance window: the claim's columns (a centred 256-column window of a larger claim), from 48 under the
 * lowest surveyed ground (or water floor) to 24 over the highest top, clamped to the level.
 */
class ApiTCTest {
	@Test
	void scenarioTemplatesFollowsTheHelper() {
		assertEquals("region.templates", RegionDesigns.TEMPLATES_FEATURE);
		assertTrue(ApiRules.features(2, List.of("job.run", "region.design", RegionDesigns.TEMPLATES_FEATURE)).contains("scenarioTemplates"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.design", "plan.bigForms")).contains("scenarioTemplates"));
		assertFalse(ApiRules.features(0, List.of(RegionDesigns.TEMPLATES_FEATURE)).contains("scenarioTemplates"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("scenarioTemplates"));
	}

	private static Columns cols(int w, int d, int ground, int top, int waterFloor) {
		Columns c = new Columns(0, 0, w, d, 1);
		for (int k = 0; k < w * d; k++) {
			c.set(k, ground, top, ground, 0);
		}
		c.set(1, ground, ground, waterFloor, Columns.WATER); // one water column, its floor deeper
		c.set(2, 0, 0, 0, Columns.MISSING); // a missing column counts for nothing
		return c;
	}

	@Test
	void theAffordanceWindowCoversTheClaimAndTheHallDepth() {
		BoundingBox claim = new BoundingBox(100, 0, 200, 291, 0, 391); // 192x192
		BoundingBox b = RegionDesigns.affordanceBox(cols(8, 8, 90, 110, 80), claim, -64, 319);
		assertEquals(new BoundingBox(100, 80 - 48, 200, 291, 110 + 24, 391), b);
	}

	@Test
	void aLargeClaimGetsACentredWindowAndTheLevelClampsY() {
		BoundingBox claim = new BoundingBox(0, 0, 0, 399, 0, 299); // 400x300
		BoundingBox b = RegionDesigns.affordanceBox(cols(4, 4, -40, 300, -40), claim, -64, 319);
		assertEquals(new BoundingBox(72, -64, 22, 72 + 255, 319, 22 + 255), b);
	}

	@Test
	void noLoadedColumnNoWindow() {
		Columns c = new Columns(0, 0, 3, 3, 1);
		assertNull(RegionDesigns.affordanceBox(c, new BoundingBox(0, 0, 0, 2, 0, 2), -64, 319));
	}
}
