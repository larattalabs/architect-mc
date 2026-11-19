package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.RemovalStopCause;
import dev.larattalabs.architect.api.RevisionView;
import dev.larattalabs.architect.site.Groups;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** (RVC, Steward's 8bS-1) A revision's wait carries its typed stop cause; saved with the record; null when not waiting. */
class RevisionStopCauseTest {
	private static Revisions.Rev rev() {
		Revisions.Rev r = new Revisions.Rev();
		r.rid = 2;
		r.position = 1;
		r.state = "UNDOING";
		return r;
	}

	private static Revisions.Rev back(Revisions.Rev r) {
		return Revisions.Rev.fromJson(JsonParser.parseString(r.toJson().toString()).getAsJsonObject());
	}

	@Test
	void eachCauseMapsFromTheStageRemoval() {
		for (RemovalStopCause c : RemovalStopCause.values()) {
			Groups.Removed res = new Groups.Removed("blocker " + c, Map.of(), c);
			assertEquals(c, Revisions.undoStopCause(res), c.name());
		}
		assertEquals(RemovalStopCause.OTHER, Revisions.undoStopCause(new Groups.Removed(false, List.of("x"), Map.of())), "an untyped stop is OTHER");
		assertEquals(RemovalStopCause.OTHER, Revisions.undoStopCause(null), "a failed undo is OTHER");
		assertEquals(RemovalStopCause.OTHER, Revisions.undoStopCause(new Groups.Removed(true, List.of(), Map.of())), "the undoFail hook is OTHER");
	}

	@Test
	void eachCauseRoundTripsAndReachesTheView() {
		for (RemovalStopCause c : RemovalStopCause.values()) {
			Revisions.Rev r = rev();
			r.waitFor("undo u1 waits: the removal of group g was not started: r.0.0.mca", c);
			JsonObject wire = r.toJson();
			assertEquals(c.name(), wire.get("removalStopCause").getAsString(), "the saved shape");
			Revisions.Rev b = back(r);
			assertEquals(c, b.waitingCause, c.name());
			assertEquals("undo u1 waits: the removal of group g was not started: r.0.0.mca", b.waiting, "the text unchanged");
			assertEquals(c, b.view().removalStopCause());
			assertEquals(b.waiting, b.view().waiting());
		}
	}

	@Test
	void nullWhenNotWaiting() {
		Revisions.Rev r = rev();
		assertNull(r.view().removalStopCause());
		r.waitFor("undo u1 waits: x", RemovalStopCause.SAVE_REFUSED);
		r.waitFor(null, null);
		assertNull(r.waitingCause);
		assertFalse(r.toJson().has("removalStopCause"), "no wait, no key");
		assertNull(back(r).view().removalStopCause());
		r.waitFor("a wait typed by nothing", null);
		assertFalse(r.toJson().has("removalStopCause"), "an untyped wait saves as before");
		assertEquals(RemovalStopCause.OTHER, back(r).view().removalStopCause(), "any other wait is OTHER");
	}

	@Test
	void legacyRecordReadsOther() {
		Revisions.Rev r = rev();
		r.waitFor("undo u1 waits: x", RemovalStopCause.PLAYER_IN_BOX);
		JsonObject old = r.toJson();
		old.remove("removalStopCause");
		assertEquals(RemovalStopCause.OTHER, Revisions.Rev.fromJson(old).view().removalStopCause(), "a record saved before the cause");
		old.addProperty("removalStopCause", "A_LATER_CAUSE");
		assertEquals(RemovalStopCause.OTHER, Revisions.Rev.fromJson(old).view().removalStopCause(), "an unknown name");
	}

	@Test
	void oldConstructorsStillWork() {
		RevisionView v15 = new RevisionView(1, 1, 0, "p", "sha", "UNDOING", 0L, List.of(), List.of(), List.of(), 0L, null, false, "undo u1 waits: x",
			List.of("s1"));
		assertEquals(RemovalStopCause.OTHER, v15.removalStopCause(), "waiting, no typed cause: OTHER");
		assertEquals(List.of("s1"), v15.sites());
		RevisionView v14 = new RevisionView(1, 1, 0, "p", "sha", "PLACED", 0L, List.of(), List.of(), List.of(), 0L, null, false, null);
		assertNull(v14.removalStopCause());
		assertEquals(List.of(), v14.sites());
		RevisionView v16 = new RevisionView(1, 1, 0, "p", "sha", "PLACED", 0L, List.of(), List.of(), List.of(), 0L, null, false, null, List.of(),
			RemovalStopCause.CARGO);
		assertNull(v16.removalStopCause(), "not waiting: null even if given");
	}
}
