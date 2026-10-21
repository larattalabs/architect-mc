package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (fix/drain-holders) A group removal's planned undo survives the queue file: saved before R2 is submitted, read back on a load, so a stop
 * between the commit and the save after it resumes under the committed undo (the in-game kill test is tools/gate6ch.mjs rmcrash, R2q).
 * An old queue file without it reads as before.
 */
class GroupsPlannedTest {
	@Test
	void plannedRoundTrips() {
		Groups.Removal r = new Groups.Removal("g1", null, "test:h", false);
		r.sites.addAll(List.of("a", "b"));
		r.planned = "u:group-g1:123";
		r.plannedSites.addAll(List.of("b", "a"));
		Groups.Removal back = Groups.Removal.fromJson(r.toJson());
		assertEquals("u:group-g1:123", back.planned);
		assertEquals(List.of("b", "a"), back.plannedSites);
		assertNull(back.undo);
	}

	@Test
	void anOldQueueFileHasNoPlannedUndo() {
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		r.sites.add("a");
		var o = r.toJson();
		assertFalse(o.has("planned"));
		Groups.Removal back = Groups.Removal.fromJson(o);
		assertNull(back.planned);
		assertEquals(List.of(), back.plannedSites);
	}
}
