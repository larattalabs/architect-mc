package dev.larattalabs.architect.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.client.help.GuideModel;
import dev.larattalabs.architect.client.help.GuideModel.Event;
import dev.larattalabs.architect.client.help.GuideModel.State;
import dev.larattalabs.architect.client.help.GuideModel.Step;
import dev.larattalabs.labui.ui.WordingLint;
import org.junit.jupiter.api.Test;

/** (PR F1) The guided first build: offered once, never auto-starts, each step on the real action, the survival path, pause, decline. */
class GuideModelTest {
	@Test
	void creativePath() {
		GuideModel g = new GuideModel(State.NEW, null, false);
		assertNull(g.card("R", "Enter", "Z", "green"), "nothing before the offer");
		g.on(Event.SCREEN_OPENED_NO_SITES, null);
		assertEquals(State.OFFERED, g.state());
		assertEquals(3, g.card("R", "Enter", "Z", "green").buttons().size());
		assertFalse(g.on(Event.PICKED, "cabin"), "it never starts on its own");
		g.on(Event.START, null);
		assertFalse(g.on(Event.PICKED, "tower"), "another design is not the step");
		assertTrue(g.on(Event.PICKED, "cabin"));
		assertEquals(Step.PLACE, g.step());
		g.on(Event.PLACING, "cabin");
		assertEquals(Step.MOVE_ROTATE, g.step());
		assertTrue(g.card("G", "Enter", "Z", "green").body().contains("press G"), "the live rotate key");
		g.on(Event.ROTATED, null);
		g.on(Event.VERDICT_REFUSED, null);
		assertEquals(Step.READ_OUTLINE, g.step());
		assertTrue(g.card("R", "Enter", "Z", "green").body().contains("dashed"));
		g.on(Event.VERDICT_OK, null);
		g.on(Event.PLACED, null);
		assertEquals(Step.UNDO_OR_KEEP, g.step());
		assertEquals("Step 6 of 6", g.card("R", "Enter", "Z", "green").title());
		assertTrue(g.card("R", "Enter", "Z", "green").body().startsWith("Press Z twice"));
		g.on(Event.UNDONE, null);
		assertEquals(State.CLOSING, g.state());
		g.on(Event.CLOSE, null);
		assertEquals(State.DONE, g.state());
		assertFalse(g.on(Event.SCREEN_OPENED_NO_SITES, null), "asked once");
	}

	@Test
	void survivalAddsTheCrate() {
		GuideModel g = new GuideModel(State.RUNNING, Step.ENTER, true);
		assertTrue(g.card("R", "Enter", "Z", "green").body().contains("construction site"));
		g.on(Event.PLACED, null);
		assertEquals(Step.OPEN_CRATE, g.step());
		assertEquals("Step 6 of 7", g.card("R", "Enter", "Z", "green").title());
		g.on(Event.CRATE_OPENED, null);
		assertEquals(Step.UNDO_OR_KEEP, g.step());
		g.on(Event.KEEP, null);
		assertEquals(State.CLOSING, g.state());
	}

	@Test
	void notNowAsksAgainDeclineNeverEscPausesRestart() {
		GuideModel g = new GuideModel(State.NEW, null, false);
		g.on(Event.SCREEN_OPENED_NO_SITES, null);
		g.on(Event.NOT_NOW, null);
		assertEquals(State.NEW, g.state());
		assertFalse(g.on(Event.SCREEN_OPENED_NO_SITES, null), "not now: not again this session");
		g = new GuideModel(State.NEW, null, false); // the next session (stored as new)
		g.on(Event.SCREEN_OPENED_NO_SITES, null);
		assertEquals(State.OFFERED, g.state());
		g.on(Event.DECLINE, null);
		assertEquals(State.DECLINED, g.state());
		assertFalse(g.on(Event.SCREEN_OPENED_NO_SITES, null));
		g.on(Event.RESTART, null);
		assertEquals(State.RUNNING, g.state());
		g.on(Event.ESC, null);
		assertEquals(State.PAUSED, g.state());
		assertFalse(g.on(Event.PICKED, "cabin"), "paused: actions don't advance it");
		g.on(Event.RESUME, null);
		assertTrue(g.on(Event.PICKED, "cabin"));
	}

	@Test
	void placingEarlySkipsAhead() {
		GuideModel g = new GuideModel(State.RUNNING, Step.MOVE_ROTATE, false);
		g.on(Event.PLACED, null);
		assertEquals(Step.UNDO_OR_KEEP, g.step());
	}

	@Test
	void cardWordingFollowsTheRule() {
		GuideModel g = new GuideModel(State.RUNNING, Step.PICK_CABIN, true);
		for (Step s : Step.values()) {
			g = new GuideModel(State.RUNNING, s, true);
			assertTrue(WordingLint.breaks(g.card("R", "Enter", "Z", "green").body()).isEmpty(), s.name());
			assertTrue(g.card("R", "Enter", "Z", "green").body().length() <= 90, s + " fits a card line or two");
		}
	}
}
