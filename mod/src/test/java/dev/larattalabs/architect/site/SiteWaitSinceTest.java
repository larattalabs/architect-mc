package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** (8b BS, S-8b-1) waitingSince is stable while a wait changes kind: the earlier of the latch's and the typed wait's start. */
class SiteWaitSinceTest {
	@Test
	void stableAcrossKinds() {
		assertEquals(400L, SiteWaits.sinceOf(400L, 0L), "materials alone");
		assertEquals(400L, SiteWaits.sinceOf(400L, 900L), "materials since 400, then capped at 900: still 400");
		assertEquals(900L, SiteWaits.sinceOf(0L, 900L), "capped at 900 before the latch starts");
		assertEquals(900L, SiteWaits.sinceOf(1000L, 900L), "then the latch starts at 1000 (100 ticks on): still 900");
		assertEquals(0L, SiteWaits.sinceOf(0L, 0L));
	}
}
