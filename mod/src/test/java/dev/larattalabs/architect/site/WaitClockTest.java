package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * (8b review P2-4) waitingSince is one canonical start: a cap at 900 then the latch at 1000 reports 900, saves 900 and reports 900 after a
 * restart (the cap re-derived later); the cap clearing while the latch still waits keeps 900; only a target no wait holds starts over.
 */
class WaitClockTest {
	@Test
	void oneStartAcrossKindsAndARestart() {
		WaitClock c = new WaitClock();
		assertEquals(900L, c.held("s1", 900L), "capped at 900");
		assertEquals(900L, c.held("s1", 1000L), "the latch starts at 1000: still 900");
		assertEquals(900L, c.saved().get("s1"), "saved as reported");
		WaitClock after = new WaitClock();
		after.load(c.saved());
		assertEquals(900L, after.held("s1", 2000L), "after a restart the cap is re-derived at 2000: still 900");
		assertEquals(900L, after.held("s1", 1000L), "the cap clears, the latch still waits: still 900");
		after.free("s1");
		assertEquals(3000L, after.held("s1", 3000L), "a new wait after none: its own start");
		assertEquals(0L, after.of("s2"));
	}
}
