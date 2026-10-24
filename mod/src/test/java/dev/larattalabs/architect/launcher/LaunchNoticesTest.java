package dev.larattalabs.architect.launcher;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.launcher.LaunchNotices.Notice;
import dev.larattalabs.architect.launcher.LauncherPlan.State;
import org.junit.jupiter.api.Test;

/** UI-2b: "Architect is ready" once a session; reconnect blips quiet; a repeated failure once a minute. */
class LaunchNoticesTest {
	@Test
	void readyOnlyOnTheFirstStart() {
		LaunchNotices n = new LaunchNotices();
		assertEquals(Notice.NONE, n.on(State.IDLE, State.STARTING, 0));
		assertEquals(Notice.READY, n.on(State.STARTING, State.RUNNING, 1_000));
		assertTrue(n.readyShown());
		// a flapping link: RUNNING -> STARTING (reconnecting) -> RUNNING, many times
		long t = 2_000;
		for (int i = 0; i < 20; i++) {
			assertEquals(Notice.NONE, n.on(State.RUNNING, State.STARTING, t));
			assertEquals(Notice.NONE, n.on(State.STARTING, State.RUNNING, t + 500));
			assertTrue(n.quiet(), "a reconnect within the debounce is a blip");
			t += 1_000;
		}
		// a long outage and back: still no second toast, but not a blip either
		n.on(State.RUNNING, State.STARTING, t);
		assertEquals(Notice.NONE, n.on(State.STARTING, State.RUNNING, t + LaunchNotices.DEBOUNCE_MS + 1));
		assertFalse(n.quiet());
	}

	@Test
	void theFirstRunningIsNeverQuiet() {
		LaunchNotices n = new LaunchNotices();
		n.on(State.IDLE, State.STARTING, 0);
		n.on(State.STARTING, State.RUNNING, 100);
		assertFalse(n.quiet());
	}

	@Test
	void failuresToastButNotTwiceAMinute() {
		LaunchNotices n = new LaunchNotices();
		assertEquals(Notice.CRASHED, n.on(State.STARTING, State.CRASHED, 0));
		n.on(State.CRASHED, State.STARTING, 1_000);
		assertEquals(Notice.NONE, n.on(State.STARTING, State.CRASHED, 2_000), "the same crash again within a minute");
		n.on(State.CRASHED, State.STARTING, 3_000);
		assertEquals(Notice.CRASHED, n.on(State.STARTING, State.CRASHED, 2_000 + LaunchNotices.REPEAT_MS), "a minute later it tells again");
		assertEquals(Notice.NODE_MISSING, n.on(State.IDLE, State.NODE_MISSING, 2_000 + LaunchNotices.REPEAT_MS + 1), "another failure tells at once");
	}

	@Test
	void readyAfterACrashStaysSilent() {
		LaunchNotices n = new LaunchNotices();
		n.on(State.STARTING, State.RUNNING, 0);
		n.on(State.RUNNING, State.CRASHED, 100_000);
		n.on(State.CRASHED, State.STARTING, 101_000);
		assertEquals(Notice.NONE, n.on(State.STARTING, State.RUNNING, 120_000), "ready toasts once a session");
	}
}
