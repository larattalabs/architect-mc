package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** SITE_PROGRESS fires at most once per second (20 ticks) per site, and only when something was built. */
class ProgressRateTest {
	@Test
	void atMostOncePerSecond() {
		assertFalse(Builder.progressDue(100, 5, 110, 9), "10 ticks after the last one");
		assertTrue(Builder.progressDue(100, 5, 120, 9));
		assertFalse(Builder.progressDue(100, 9, 400, 9), "nothing new built");
		assertTrue(Builder.progressDue(Long.MIN_VALUE / 2, 0, 1, 1), "the first one");
	}
}
