package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.labui.ui.ConfirmArm;
import org.junit.jupiter.api.Test;

/** SAFETY: when a placement takes Enter twice, and how that composes with force and Place on top. */
class PlaceConfirmTest {
	@Test
	void bigByCountAtTheThreshold() {
		assertFalse(PlaceConfirm.big(999, 0, 1000));
		assertTrue(PlaceConfirm.big(1000, 0, 1000), "at the threshold it asks");
		assertTrue(PlaceConfirm.big(2340, 0, 1000));
		assertFalse(PlaceConfirm.big(2340, 0, 5000), "a raised threshold");
	}

	@Test
	void bigWhenItReplacesNonTerrainBlocks() {
		assertTrue(PlaceConfirm.big(12, 1, 1000), "one block of the player's is enough");
		assertFalse(PlaceConfirm.big(12, 0, 1000));
	}

	@Test
	void thresholdIsSane() {
		assertEquals(1000, PlaceConfirm.threshold(0));
		assertEquals(1000, PlaceConfirm.threshold(-5));
		assertEquals(1, PlaceConfirm.threshold(1));
		assertEquals(250, PlaceConfirm.threshold(250));
		assertTrue(PlaceConfirm.big(1000, 0, 0), "a broken threshold falls back to the default, never to 'never ask'");
	}

	@Test
	void terrainAndTreesAreNotReplaced() {
		assertFalse(PlaceConfirm.replaces(TerrainFit.NATURAL), "grass, dirt, stone: cleared by design");
		assertFalse(PlaceConfirm.replaces(TerrainFit.TREE), "a log");
		assertFalse(PlaceConfirm.replaces(TerrainFit.TREE | TerrainFit.LEAVES), "leaves");
		assertFalse(PlaceConfirm.replaces(TerrainFit.FILLABLE), "air");
		assertFalse(PlaceConfirm.replaces(TerrainFit.FILLABLE | TerrainFit.NATURAL), "a fern");
		assertFalse(PlaceConfirm.replaces(TerrainFit.BLOCK_ENTITY), "a chest is a refusal (force), not this confirm");
		assertTrue(PlaceConfirm.replaces(0), "planks, glass, a player's wall");
		assertTrue(PlaceConfirm.replaces(TerrainFit.ROAD), "a road's surface");
	}

	@Test
	void smallCleanPlacementIsOneEnter() {
		assertEquals(PlaceConfirm.Step.PLACE, PlaceConfirm.enter(false, false, false, false, false));
	}

	@Test
	void bigReadyPlacementConfirms() {
		assertEquals(PlaceConfirm.Step.CONFIRM, PlaceConfirm.enter(true, false, false, false, false));
	}

	@Test
	void refusalsAndTheirSecondPressNeverStack() {
		// a refusal-to-be goes to the server at once: it says why and may arm force or Place on top
		assertEquals(PlaceConfirm.Step.PLACE, PlaceConfirm.enter(true, true, false, false, false));
		// Place on top's Enter and force's Shift+Enter already are the deliberate second press
		assertEquals(PlaceConfirm.Step.PLACE, PlaceConfirm.enter(true, false, true, false, false));
		assertEquals(PlaceConfirm.Step.PLACE, PlaceConfirm.enter(true, false, false, true, true));
		// force armed but plain Enter (no Shift): still the big confirm
		assertEquals(PlaceConfirm.Step.CONFIRM, PlaceConfirm.enter(true, false, false, true, false));
	}

	@Test
	void prompts() {
		assertEquals("Press Enter again to place 2,340 blocks (4)", PlaceConfirm.prompt(false, 2340, 0, 4));
		assertEquals("Press Enter again to place 12 blocks, replacing 1 that isn't terrain (5)", PlaceConfirm.prompt(false, 12, 1, 5));
		assertEquals("Press Enter again to move it here: 2,340 blocks (3)", PlaceConfirm.prompt(true, 2340, 0, 3));
		assertEquals("Ready: Enter twice places it (2,340 blocks)", PlaceConfirm.readyLine(false, 2340, 0));
		assertEquals("Ready: Enter twice places it (replaces 3 blocks that aren't terrain)", PlaceConfirm.readyLine(false, 40, 3));
		assertEquals("1,000", PlaceConfirm.count(1000));
	}

	/** The arm the placement uses (lab-ui ConfirmArm, keyed on the exact site): repeat-safe, a 300 ms floor, a 5 s window, moved = new key. */
	@Test
	void armIsRepeatSafeAndKeyedOnTheSite() {
		ConfirmArm arm = new ConfirmArm(PlaceConfirm.WINDOW_MS);
		String here = "cabin|4,64,12|0|null|false";
		assertEquals(ConfirmArm.Result.ARMED, arm.pressByKey(here, 1_000, false));
		assertEquals(ConfirmArm.Result.IGNORED, arm.pressByKey(here, 1_050, true), "a held Enter (OS repeat) never places");
		assertEquals(ConfirmArm.Result.IGNORED, arm.pressByKey(here, 1_100, false), "a double tap within 300 ms never places");
		assertEquals(5, arm.secondsLeft(1_000));
		assertEquals(ConfirmArm.Result.CONFIRMED, arm.pressByKey(here, 1_400, false));
		// moved: the key differs, so the old arm never confirms the new spot
		assertEquals(ConfirmArm.Result.ARMED, arm.pressByKey(here, 2_000, false));
		assertEquals(ConfirmArm.Result.ARMED, arm.pressByKey("cabin|5,64,12|0|null|false", 2_500, false));
		assertFalse(arm.armed(here, 2_600));
		// the window runs out after 5 s
		assertEquals(ConfirmArm.Result.ARMED, arm.pressByKey(here, 10_000, false));
		assertEquals(ConfirmArm.Result.ARMED, arm.pressByKey(here, 15_001, false), "too late: arms again instead of placing");
	}
}
