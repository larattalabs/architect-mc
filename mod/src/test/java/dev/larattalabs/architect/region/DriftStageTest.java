package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.batch.StageRules;
import org.junit.jupiter.api.Test;

/** The per-stage drift check's baseline (Steward S2) and the stage hold it uses (phase 6a). */
class DriftStageTest {
	@Test
	void baselinePrefersWhatTheRegionBuiltThenFrozenThenPlan() {
		Columns after = new Columns(0, 0, 64, 64, 1);
		Columns frozen = new Columns(0, 0, 64, 64, 1);
		Columns plan = new Columns(-8, -8, 20, 20, 4); // the plan survey at resolution 4
		after.set(after.at(4, 4), 70, 70, 70, 0); // a pad the region built
		frozen.set(frozen.at(4, 4), 64, 64, 64, 0);
		frozen.set(frozen.at(8, 8), 65, 65, 65, 0);
		plan.set(plan.at(4, 4), 63, 63, 63, 0);
		plan.set(plan.at(8, 8), 63, 63, 63, 0);
		plan.set(plan.at(12, 12), 66, 66, 66, 0);
		int[] from = new int[3];
		assertEquals(70, Drift.expected(after, frozen, plan, 4, 4, from), "built: the region's own post-write height");
		assertEquals(65, Drift.expected(after, frozen, plan, 8, 8, from), "not built yet: the frozen pre-region height");
		assertEquals(66, Drift.expected(after, frozen, plan, 12, 12, from), "neither: the plan survey");
		assertEquals(Drift.NONE, Drift.expected(after, frozen, plan, 13, 12, from), "off the plan grid and never frozen: not sampled");
		assertEquals(Drift.NONE, Drift.expected(after, frozen, null, 20, 20, from));
		assertArrayEquals(new int[] {1, 1, 1}, from);
	}

	@Test
	void holdSendsAnUnstartedStageBackToPlanned() {
		assertEquals(Stage.State.PLANNED, StageRules.hold(Stage.State.APPROVED));
		assertEquals(Stage.State.PLANNED, StageRules.hold(Stage.State.PLANNED));
		assertEquals(Stage.State.APPROVED, StageRules.approve(StageRules.hold(Stage.State.APPROVED)), "an approval continues it");
		assertThrows(IllegalStateException.class, () -> StageRules.hold(Stage.State.PLACING));
		assertThrows(IllegalStateException.class, () -> StageRules.hold(Stage.State.PLACED));
	}
}
