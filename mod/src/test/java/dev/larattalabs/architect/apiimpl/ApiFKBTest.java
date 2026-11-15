package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Limits;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (FK-b) Module-provided fill items on the API side: {@code fillProvided} comes with the helper's {@code design.fillProvided} (never without
 * it, never Java-only); the allow-list is the petrified oak slab, unmodifiable (the kit mirrors it: fk.test).
 */
class ApiFKBTest {
	@Test
	void fillProvidedFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "design.program", "design.fill", "design.fillProvided")).contains("fillProvided"));
		assertFalse(ApiRules.features(2, List.of("job.run", "design.program", "design.fill")).contains("fillProvided"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("fillProvided"));
	}

	@Test
	void theAllowListIsThePetrifiedSlab() {
		assertEquals(Set.of("minecraft:petrified_oak_slab"), Limits.FILL_PROVIDED_ITEMS);
		assertThrows(UnsupportedOperationException.class, () -> Limits.FILL_PROVIDED_ITEMS.add("minecraft:stone"));
	}
}
