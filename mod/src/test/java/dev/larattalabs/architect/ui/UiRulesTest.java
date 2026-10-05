package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.ui.UiRules.EnterAction;
import java.util.List;
import org.junit.jupiter.api.Test;

class UiRulesTest {
	/** Regression B1 / C6: a normal launcher pauses, dev runs and the DevBridge keep the world running. */
	@Test
	void screensPauseOutsideDevRuns() {
		assertTrue(UiRules.screensPause(false, false, null), "everyday play pauses");
		assertFalse(UiRules.screensPause(true, false, null), "gradlew runClient keeps running (QA)");
		assertFalse(UiRules.screensPause(false, true, null), "ARCHITECT_DEV=1 keeps running (QA)");
		assertTrue(UiRules.screensPause(true, true, true), "ARCHITECT_PAUSE=1 wins");
		assertFalse(UiRules.screensPause(false, false, false), "ARCHITECT_PAUSE=0 wins");
	}

	/** One Enter rule: single-line Enter sends; multi-line Enter is a new line and Ctrl+Enter sends. */
	@Test
	void oneEnterRule() {
		assertEquals(EnterAction.SEND, UiRules.enter(false, false, false));
		assertEquals(EnterAction.SEND, UiRules.enter(false, true, false), "Ctrl+Enter sends everywhere");
		assertEquals(EnterAction.NEWLINE, UiRules.enter(false, false, true));
		assertEquals(EnterAction.NEWLINE, UiRules.enter(true, false, false));
		assertEquals(EnterAction.NEWLINE, UiRules.enter(true, false, true));
		assertEquals(EnterAction.SEND, UiRules.enter(true, true, false));
		assertArrayEquals(new String[] {"Ctrl+Enter", "send", "Enter", "new line"}, UiRules.enterHints(true));
		assertEquals("Enter", UiRules.enterHints(false)[0]);
	}

	@Test
	void secondPressWindow() {
		assertFalse(UiRules.secondPress(0, 1000, 3000), "never armed");
		assertTrue(UiRules.secondPress(1000, 2500, 3000));
		assertFalse(UiRules.secondPress(1000, 4001, 3000), "expired");
		assertFalse(UiRules.secondPress(5000, 4000, 3000), "clock went backwards");
	}

	/** Regression (review): a held Ctrl+Enter (OS repeat) or a quick double press never confirms a merge. */
	@Test
	void keyConfirmNeedsFreshPressAfterDelay() {
		long armed = 10_000;
		assertFalse(UiRules.keyConfirmReady(armed, armed + 100, false), "double press within 300 ms");
		assertFalse(UiRules.keyConfirmReady(armed, armed + 600, true), "OS repeat of the held key");
		assertTrue(UiRules.keyConfirmReady(armed, armed + UiRules.KEY_CONFIRM_MS, false));
		assertFalse(UiRules.keyConfirmReady(0, armed, false), "never armed");
	}

	/** Regression (review): repeats are presses without a release; keys held at open are ignored until released. */
	@Test
	void keyRepeatTracking() {
		UiRules.KeyRepeat r = new UiRules.KeyRepeat();
		assertFalse(r.press(257, true), "first press");
		assertTrue(r.press(257, true), "OS repeat");
		r.release(257);
		assertFalse(r.press(257, true), "fresh press after release");
		r.heldAtOpen(335);
		assertTrue(r.press(335, true), "held since the screen opened");
		r.release(335);
		assertFalse(r.press(335, true));
		assertFalse(r.press(257, false), "synthetic presses (DevBridge) are never repeats");
		assertFalse(r.press(257, false));
		assertTrue(r.press(335, true));
		r.reset();
		assertFalse(r.press(335, true), "a release missed while another screen was open does not stick");
	}
}
