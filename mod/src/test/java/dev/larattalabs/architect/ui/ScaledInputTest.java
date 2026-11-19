package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.screen.ScaledInput;
import dev.larattalabs.labui.ui.TextScale;
import org.junit.jupiter.api.Test;

/**
 * (PR2) The text-scaled screens' input handlers measure at the scale their draw uses (so a click in a field lands on the character
 * drawn under the pointer), and leave the scale as they found it. The hit itself needs a real Font: checked by eye in game.
 */
class ScaledInputTest {
	@Test
	void theHandlerSeesTheScaleAndItIsRestored() {
		assertEquals(1f, TextScale.activeFactor());
		float[] seen = new float[1];
		assertTrue(ScaledInput.at(1.5f, () -> {
			seen[0] = TextScale.activeFactor();
			return true;
		}));
		assertEquals(1.5f, seen[0], "measured at 150 % inside the handler");
		assertEquals(1f, TextScale.activeFactor(), "restored after");
	}

	@Test
	void restoredOnAThrowAndNested() {
		assertThrows(IllegalStateException.class, () -> ScaledInput.at(1.25f, () -> {
			throw new IllegalStateException();
		}));
		assertEquals(1f, TextScale.activeFactor());
		ScaledInput.at(1.5f, () -> ScaledInput.at(1.5f, () -> true)); // a subclass handler calling the wrapped super
		assertEquals(1f, TextScale.activeFactor());
	}

	@Test
	void theOwnerIsTheOneTheScreensDrawUnder() {
		assertEquals("architect_mc", ScaledInput.OWNER);
	}
}
