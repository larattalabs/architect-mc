package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The queue's pure rules (docs/CONTRACT.md phase 4d): batch checks and stages, ordering, cancel semantics, growing a group. */
class BatchRulesTest {
	private static BatchRules.ItemSpec item(String key, String stage, String... after) {
		return new BatchRules.ItemSpec(key, stage, List.of(after));
	}

	private static QItem q(String key, String stage, int x, String... after) {
		return new QItem(key, stage, List.of(after), "cabin", "minecraft:overworld", x, 64, 0, 0, false, new JsonObject(), null, false, false);
	}

	private static QBatch batch(boolean proximity, QItem... items) {
		List<String> stages = new ArrayList<>();
		for (QItem i : items) {
			if (!stages.contains(i.stage)) {
				stages.add(i.stage);
			}
		}
		return new QBatch("b1", null, new JsonObject(), "g1", List.of(items), stages, 12000, 0, proximity, false, false, false, null, 1L);
	}

	// ------------------------------------------------------------------ plan

	@Test
	void unstagedItemsFormTheBatchStageFirst() {
		BatchRules.StagePlan p = BatchRules.plan("b3", List.of(item("a", null), item("b", "walls"), item("c", null)),
			List.of(new BatchRules.StageSpec("roofs", List.of())), List.of(), false, null, null);
		assertEquals(List.of("b3", "roofs", "walls"), p.stages());
		assertEquals(Map.of("a", "b3", "b", "walls", "c", "b3"), p.stageOf());
	}

	@Test
	void stagesListedOnTheBatchAndOnItemsAgree() {
		BatchRules.StagePlan p = BatchRules.plan("b1", List.of(item("a", null), item("b", "two")),
			List.of(new BatchRules.StageSpec("one", List.of("a")), new BatchRules.StageSpec("two", List.of("b"))), List.of(), false, null, null);
		assertEquals(List.of("one", "two"), p.stages());
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", "two")),
			List.of(new BatchRules.StageSpec("one", List.of("a"))), List.of(), false, null, null), "an item in two stages");
	}

	@Test
	void badBatchesAreRefused() {
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(), List.of(), List.of(), false, null, null));
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", null), item("a", null)), List.of(), List.of(), false,
			null, null), "duplicate key");
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", null, "zz")), List.of(), List.of(), false, null, null),
			"unknown after");
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", null, "a")), List.of(), List.of(), false, null, null),
			"self");
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", null, "b"), item("b", null, "c"), item("c", null, "a")),
			List.of(), List.of(), false, null, null), "cycle");
		IllegalArgumentException later = assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1",
			List.of(item("a", "one", "b"), item("b", "two")), List.of(), List.of(), false, null, null));
		assertTrue(later.getMessage().contains("later stage"), later.getMessage());
		assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b1", List.of(item("a", null)),
			List.of(new BatchRules.StageSpec("s", List.of()), new BatchRules.StageSpec("s", List.of())), List.of(), false, null, null), "stage twice");
	}

	@Test
	void growingAGroup() {
		// appending: new stage names go after the group's, must be unique, and the owner must match
		BatchRules.StagePlan p = BatchRules.plan("b2", List.of(item("x", "four")), List.of(), Set.of("one", "two", "three"), true, "steward_mc:s/1",
			"steward_mc:s/1");
		assertEquals(List.of("four"), p.stages());
		IllegalArgumentException dup = assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b2", List.of(item("x", "two")), List.of(),
			Set.of("one", "two"), true, null, null));
		assertTrue(dup.getMessage().contains("already exists"), dup.getMessage());
		IllegalArgumentException owner = assertThrows(IllegalArgumentException.class, () -> BatchRules.plan("b2", List.of(item("x", null)), List.of(),
			Set.of(), true, "steward_mc:s/1", "other_mod:x"));
		assertTrue(owner.getMessage().contains("owned by steward_mc:s/1"), owner.getMessage());
		// the player's group (owner null) takes the player's batch
		BatchRules.plan("b2", List.of(item("x", null)), List.of(), Set.of("b1"), true, null, null);
	}

	@Test
	void afterMayPointIntoAnEarlierStageOrTheSameOne() {
		BatchRules.plan("b1", List.of(item("a", "one"), item("b", "two", "a"), item("c", "two", "b")), List.of(), List.of(), false, null, null);
	}

	// ------------------------------------------------------------------ order

	@Test
	void listOrderWithoutProximity() {
		QBatch b = batch(false, q("a", "s", 50), q("b", "s", 0), q("c", "s", 10));
		assertSame(b.item("a"), BatchRules.next(b, "s", true, 0, i -> i.x));
		b.item("a").status = QItem.Status.PLACED;
		assertSame(b.item("b"), BatchRules.next(b, "s", true, 0, i -> i.x));
	}

	@Test
	void nearestFirstWithTiesInListOrder() {
		QBatch b = batch(true, q("a", "s", 50), q("b", "s", 10), q("c", "s", 10), q("d", "s", 30));
		assertSame(b.item("b"), BatchRules.next(b, "s", true, 0, i -> i.x), "nearest; b before c (list order)");
		b.item("b").status = QItem.Status.PLACED;
		assertSame(b.item("c"), BatchRules.next(b, "s", true, 0, i -> i.x));
	}

	@Test
	void afterDependenciesComeFirst() {
		QBatch b = batch(true, q("a", "s", 50), q("b", "s", 0, "a"));
		assertSame(b.item("a"), BatchRules.next(b, "s", true, 0, i -> i.x), "b is nearer but comes after a");
		b.item("a").status = QItem.Status.PLACED;
		assertSame(b.item("b"), BatchRules.next(b, "s", true, 0, i -> i.x));
		QBatch c = batch(false, q("a", "s", 0), q("b", "s", 0, "a"));
		c.item("a").fail("LAVA", "lava");
		assertNull(BatchRules.next(c, "s", true, 0, i -> 0));
		assertSame(c.item("a"), BatchRules.failedDependency(c, c.item("b")));
	}

	@Test
	void onlyTheRunningApprovedStagePlacesOneItemAtATime() {
		QBatch b = batch(false, q("a", "one", 0), q("b", "two", 0));
		assertNull(BatchRules.next(b, "one", false, 0, i -> 0), "planned: waits for approval");
		assertNull(BatchRules.next(b, null, true, 0, i -> 0), "no running stage");
		assertNull(BatchRules.next(b, "other_batch_stage", true, 0, i -> 0), "another batch's stage runs first");
		assertSame(b.item("a"), BatchRules.next(b, "one", true, 0, i -> 0));
		assertSame(b.item("b"), BatchRules.next(b, "two", true, 0, i -> 0));
		b.item("a").status = QItem.Status.PLACING;
		assertNull(BatchRules.next(b, "two", true, 0, i -> 0), "one item places at a time per batch");
	}

	@Test
	void waitingItemsAreRetriedWhenDueAndOthersGoMeanwhile() {
		QBatch b = batch(false, q("a", "s", 0), q("b", "s", 0));
		b.item("a").status = QItem.Status.WAITING;
		b.item("a").nextCheck = 40;
		assertSame(b.item("b"), BatchRules.next(b, "s", true, 20, i -> 0), "a waits; b goes");
		b.item("b").status = QItem.Status.PLACED;
		assertNull(BatchRules.next(b, "s", true, 39, i -> 0));
		assertSame(b.item("a"), BatchRules.next(b, "s", true, 40, i -> 0));
	}

	// ------------------------------------------------------------------ cancel

	@Test
	void cancelKeepsPlacedDropsQueuedAndLeavesThePlacingOneToRollBack() {
		QBatch b = batch(false, q("a", "s", 0), q("b", "s", 0), q("c", "s", 0), q("d", "s", 0));
		b.item("a").status = QItem.Status.PLACED;
		b.item("b").status = QItem.Status.PLACING;
		b.item("d").status = QItem.Status.WAITING;
		List<QItem> dropped = BatchRules.cancel(b, "cancelled");
		assertEquals(List.of(b.item("c"), b.item("d")), dropped);
		assertEquals(QItem.Status.PLACED, b.item("a").status);
		assertEquals(QItem.Status.PLACING, b.item("b").status, "rolled back by the caller");
		assertEquals("CANCELLED", b.item("c").reason);
		assertTrue(b.cancelling);
		assertNull(BatchRules.next(b, "s", true, 0, i -> 0), "nothing new starts while cancelling");
		b.item("b").fail("CANCELLED", "rolled back");
		assertTrue(BatchRules.allDone(b));
	}

	@Test
	void skippingAStageDropsItsItems() {
		QBatch b = batch(false, q("a", "one", 0), q("b", "two", 0), q("c", "two", 0));
		assertEquals(2, BatchRules.skip(b, "two").size());
		assertEquals(QItem.Status.QUEUED, b.item("a").status);
		assertEquals(QItem.Status.FAILED, b.item("c").status);
		assertEquals(List.of(0, 2, 2), List.of(BatchRules.counts(b, "two")[0], BatchRules.counts(b, "two")[1], BatchRules.counts(b, "two")[2]));
	}
}
