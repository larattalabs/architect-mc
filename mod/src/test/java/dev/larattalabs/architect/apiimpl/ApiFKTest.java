package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Limits;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (M5 FK, S-M5-3) Filled containers on the API side: the feature name {@code filledContainers} comes with the helper's {@code design.fill}
 * (never without it, never Java-only), and the bounds are Steward's (64 containers, 64 lock cells per entry), the same as the kit's
 * (kit/lib/fill.mjs).
 */
class ApiFKTest {
	@Test
	void filledContainersFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "design.program", "design.fill")).contains("filledContainers"));
		assertFalse(ApiRules.features(2, List.of("job.run", "design.program")).contains("filledContainers"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("filledContainers"));
	}

	@Test
	void theBoundsAreSteward() {
		assertEquals(64, Limits.FILL_CONTAINERS_MAX);
		assertEquals(64, Limits.FILL_LOCKS_MAX);
	}
}
