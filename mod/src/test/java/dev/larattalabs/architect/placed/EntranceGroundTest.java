package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * C34b: a door is an entrance "at its ground" (§4). On the ground that is within 2 of the median ground surface round it, as
 * before; a build lifted off the ground (Steward's hut at y 100 over a flat world's ground at -61) is judged by its own lowest
 * row, so the door standing on its floor is its entrance. Claimed and tracked builds share this rule (Builds.Comp.stats).
 */
class EntranceGroundTest {
	@Test
	void onTheGroundAsBefore() {
		int g = -61; // the ground block; the floor row at -60, the door's lower half at -59
		assertTrue(Builds.entranceAt(-59, g, -60), "a door on a floor on the ground");
		assertTrue(Builds.entranceAt(-60, g, -60), "a door in the floor row");
		assertFalse(Builds.entranceAt(-57, g, -60), "an upper storey's door of a build on the ground stays no entrance");
		assertTrue(Builds.entranceAt(500, Integer.MIN_VALUE, 0), "no ground found: it counts");
	}

	@Test
	void liftedBuildByItsOwnBase() {
		int g = -61;
		assertTrue(Builds.entranceAt(101, g, 100), "Steward's hut at y 100: the door on its floor");
		assertTrue(Builds.entranceAt(102, g, 100));
		assertFalse(Builds.entranceAt(104, g, 100), "a door 4 above the lifted build's lowest row");
		assertFalse(Builds.entranceAt(-57, g, -59), "a build one row above the ground is not lifted: the ground rule");
		assertTrue(Builds.entranceAt(-56, g, -58), "lifted by 3: its own base");
	}
}
