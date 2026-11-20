package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.RemovalFinished;
import dev.larattalabs.architect.api.RemoveResult;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** (slice T4c) The group pieces: cargo keys per placement, the held removal's persisted state, RemovalFinished. */
class T4cGroupsTest {
	/** PL-gpt2 3: a target id placed again never reuses an earlier placement's cargo key; the same placement's retry does. */
	@Test
	void cargoKeysArePerPlacement() {
		long cell = 12345L;
		assertNotEquals(Groups.cargoKey("t7", 100L, cell), Groups.cargoKey("t7", 200L, cell));
		assertEquals(Groups.cargoKey("t7", 100L, cell), Groups.cargoKey("t7", 100L, cell));
		assertTrue(Groups.cargoKey("t7", 100L, cell).startsWith(Stockpiles.CARGO_PREFIX));
	}

	/** A held decided removal keeps its revision and its held state across a restart (the queue file). */
	@Test
	void aHeldRemovalPersists() {
		Groups.Removal r = new Groups.Removal("g1", "s2", null, true);
		r.revisionId = 4;
		r.heldDecided = true;
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals(4, back.revisionId);
		assertTrue(back.heldDecided);
	}

	/** REMOVAL_FINISHED's payload: the kind, the stage, the revision and the full result (owed included). */
	@Test
	void removalFinishedCarriesKindStageAndRevision() {
		RemovalFinished f = new RemovalFinished(RemovalFinished.GROUP, "g1", "s2", 4, new RemoveResult(true, List.of(), Map.of(), 3, 0, Map.of(), List.of(),
			List.of("k1")));
		assertEquals("group", f.kind());
		assertEquals(4, f.revisionId());
		assertEquals(List.of("k1"), f.result().owed());
	}
}
