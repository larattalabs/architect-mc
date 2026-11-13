package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RegionState;
import org.junit.jupiter.api.Test;

/**
 * (slice RU, docs/CONTRACT.md RV §8) Which busy region an undo cancels rather than refuses: only a survival region's head revision still
 * writing ({@code revising <rid>}, PLACING). The rest (creative, another operation, a stale busy) refuse OVERLAP_BUSY as before.
 */
class RevisionCancelRUTest {
	private static RegionRec region(boolean survival, String busy, RegionState state, int headPos, String revState) {
		RegionRec rec = new RegionRec("rg1", "p", "s", null, new JsonObject(), "minecraft:overworld", new int[] {0, -64, 0, 10, 319, 10}, 1L);
		if (survival) {
			JsonObject sv = new JsonObject();
			sv.addProperty("on", true);
			rec.survival = sv;
		}
		Revisions.Rev r = new Revisions.Rev();
		r.rid = 2;
		r.position = 1;
		r.state = revState;
		rec.revisions.add(r);
		rec.position = headPos;
		rec.busy = busy;
		rec.state = state;
		return rec;
	}

	@Test
	void survivalHeadStillWritingIsCancelled() {
		RegionRec rec = region(true, "revising 2", RegionState.PLACING, 1, "PLACING");
		assertSame(rec.revisions.get(0), Revisions.writingToCancel(rec));
		// (the rid is read leniently: a busy with spaces)
		rec.busy = "revising  2 ";
		assertSame(rec.revisions.get(0), Revisions.writingToCancel(rec));
		// accepted, not yet installed (a stop between): cancelled too, its batch none yet
		assertSame(rec.revisions.get(0), Revisions.writingToCancel(region(true, "revising 2", RegionState.PLACING, 1, "ACCEPTED")));
	}

	@Test
	void everythingElseStaysBusy() {
		assertNull(Revisions.writingToCancel(region(false, "revising 2", RegionState.PLACING, 1, "PLACING")), "creative: OVERLAP_BUSY as before");
		assertNull(Revisions.writingToCancel(region(true, "undoing u1", RegionState.PLACED, 1, "UNDOING")), "an undo runs");
		assertNull(Revisions.writingToCancel(region(true, null, RegionState.PLACED, 1, "PLACED")), "not busy: the ordinary preflight");
		assertNull(Revisions.writingToCancel(region(true, "revising 2", RegionState.REMOVING, 1, "PLACING")), "a removal supersedes");
		assertNull(Revisions.writingToCancel(region(true, "revising 3", RegionState.PLACING, 1, "PLACING")), "no such revision");
		assertNull(Revisions.writingToCancel(region(true, "revising x", RegionState.PLACING, 1, "PLACING")), "an unreadable rid");
		assertNull(Revisions.writingToCancel(region(true, "revising 2", RegionState.PLACING, 2, "PLACING")), "not the head");
		assertNull(Revisions.writingToCancel(region(true, "revising 2", RegionState.PLACING, 1, "UNDONE")), "not standing");
		assertEquals(0, Revisions.parseRid("x"));
	}
}
