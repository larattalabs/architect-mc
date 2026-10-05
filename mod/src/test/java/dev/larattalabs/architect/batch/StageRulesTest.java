package dev.larattalabs.architect.batch;

import static dev.larattalabs.architect.api.Stage.State.APPROVED;
import static dev.larattalabs.architect.api.Stage.State.PARTIAL;
import static dev.larattalabs.architect.api.Stage.State.PLACED;
import static dev.larattalabs.architect.api.Stage.State.PLACING;
import static dev.larattalabs.architect.api.Stage.State.PLANNED;
import static dev.larattalabs.architect.api.Stage.State.SKIPPED;
import static dev.larattalabs.architect.api.Stage.State.UNDONE;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.Stage;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The stage state machine (docs/CONTRACT.md phase 4d "Stages"). */
class StageRulesTest {
	private static final List<String> NAMES = List.of("one", "two", "three");

	@Test
	void transitions() {
		assertEquals(APPROVED, StageRules.approve(PLANNED));
		assertEquals(APPROVED, StageRules.approve(APPROVED), "approving twice is harmless");
		assertThrows(IllegalStateException.class, () -> StageRules.approve(PLACED));
		assertEquals(SKIPPED, StageRules.skip(PLANNED));
		assertEquals(SKIPPED, StageRules.skip(APPROVED));
		assertThrows(IllegalStateException.class, () -> StageRules.skip(PLACING));
		assertEquals(PLACING, StageRules.start(APPROVED));
		assertThrows(IllegalStateException.class, () -> StageRules.start(PLANNED));
		assertEquals(PLACED, StageRules.finish(3, 3));
		assertEquals(PARTIAL, StageRules.finish(2, 3));
		assertEquals(PARTIAL, StageRules.finish(0, 3));
		assertEquals(SKIPPED, StageRules.cancelled(PLANNED, 0));
		assertEquals(PARTIAL, StageRules.cancelled(PLACING, 1));
		assertEquals(SKIPPED, StageRules.cancelled(PLACING, 0));
		assertEquals(PLACED, StageRules.cancelled(PLACED, 2));
		for (Stage.State s : Stage.State.values()) {
			assertEquals(s == PLACED || s == PARTIAL || s == SKIPPED || s == UNDONE, s.terminal(), s.name());
		}
	}

	@Test
	void theRunningStageIsTheFirstUnfinished() {
		assertEquals(0, StageRules.running(List.of(PLANNED, APPROVED, PLANNED)));
		assertEquals(1, StageRules.running(List.of(PLACED, APPROVED, PLANNED)));
		assertEquals(2, StageRules.running(List.of(PLACED, SKIPPED, PLANNED)), "skipping 2 lets 3 go");
		assertEquals(-1, StageRules.running(List.of(PLACED, SKIPPED, UNDONE)));
	}

	@Test
	void theGateSequence() {
		// approve 1, skip 2, place 3, undo 3, then undo 1; undoing 1 while 3 is placed is refused
		List<Stage.State> s = List.of(PLACED, SKIPPED, PLACED);
		String refused = StageRules.undoRefusal(NAMES, s, 0, false);
		assertNotNull(refused);
		assertTrue(refused.contains("three"), refused);
		assertNull(StageRules.undoRefusal(NAMES, s, 0, true), "force");
		assertNull(StageRules.undoRefusal(NAMES, s, 2, false));
		assertNull(StageRules.undoRefusal(NAMES, List.of(PLACED, SKIPPED, UNDONE), 0, false));
		assertNotNull(StageRules.undoRefusal(NAMES, List.of(PLACED, SKIPPED, PLACING), 0, true), "a placing later stage refuses even forced");
		assertNotNull(StageRules.undoRefusal(NAMES, List.of(PLANNED, PLANNED, PLANNED), 0, false), "nothing to undo");
		assertNull(StageRules.undoRefusal(NAMES, List.of(PARTIAL, PLANNED, PLANNED), 0, false), "a partial stage undoes");
	}

	@Test
	void reorderMovesPlannedStagesOnly() {
		assertEquals(List.of("one", "three", "two"), StageRules.reorder(NAMES, List.of(PLACED, PLANNED, PLANNED), List.of("three", "two")));
		assertEquals(List.of("three", "two", "one"), StageRules.reorder(NAMES, List.of(PLANNED, APPROVED, PLANNED), List.of("three", "one")),
			"approved two keeps its place");
		assertThrows(IllegalArgumentException.class, () -> StageRules.reorder(NAMES, List.of(PLACED, PLANNED, PLANNED), List.of("three", "one")));
		assertThrows(IllegalArgumentException.class, () -> StageRules.reorder(NAMES, List.of(PLACED, PLANNED, PLANNED), List.of("three")));
		assertThrows(IllegalArgumentException.class, () -> StageRules.reorder(NAMES, List.of(PLACED, PLANNED, PLANNED), List.of("two", "two")));
	}
}
