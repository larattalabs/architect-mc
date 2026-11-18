package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.larattalabs.architect.api.RemovalStop;
import dev.larattalabs.architect.api.RemovalStopCause;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (S-DRS-1) Every stop of a whole-group removal carries its typed cause, and its text stays what Steward parses today (" was not
 * started: ", "a player stayed in ", "COVERED: ", "Move these out of "); the group's stop is NOT_STARTED when untouched, else PARTIAL.
 */
class RemovalStopCauseTest {
	private static final Map<String, Integer> NONE = Map.of();

	@Test
	void aRefusedSave() {
		Groups.Removed r = Groups.Removed.saveRefused("g1", "a chunk write was not durable", NONE);
		assertEquals(List.of("the removal of group g1 was not started: a chunk write was not durable"), r.blockers(), "the text is unchanged");
		assertEquals(RemovalStopCause.SAVE_REFUSED, r.stopCause());
	}

	@Test
	void aPlayerInTheBox() {
		Groups.Removed r = Groups.Removed.waitedOut("s4", true, NONE);
		assertEquals(List.of("a player stayed in s4 for 10 minutes"), r.blockers());
		assertEquals(RemovalStopCause.PLAYER_IN_BOX, r.stopCause());
		Groups.Removed p = Groups.Removed.waitedOut("s4", false, NONE);
		assertEquals(List.of("s4 is still being placed"), p.blockers());
		assertEquals(RemovalStopCause.OTHER, p.stopCause());
	}

	@Test
	void covered() {
		Groups.Removed r = Groups.Removed.covered(List.of("s9", "s10"), NONE);
		assertEquals(List.of("COVERED: s9, s10 cover cells of the sites"), r.blockers());
		assertEquals(RemovalStopCause.COVERED, r.stopCause());
	}

	@Test
	void cargoAndThingsInTheBox() {
		Groups.Removed c = Groups.Removed.blocked("s2", List.of("chest at 1, 2, 3 holds cargo"), true, NONE);
		assertEquals(List.of(Sites.blockersMessage("s2", List.of("chest at 1, 2, 3 holds cargo"))), c.blockers());
		assertEquals(RemovalStopCause.CARGO, c.stopCause());
		Groups.Removed t = Groups.Removed.blocked("s2", List.of("a wolf"), false, NONE);
		assertEquals(RemovalStopCause.THINGS_IN_BOX, t.stopCause());
	}

	@Test
	void anUntypedStopIsOtherAndARemovalHasNone() {
		assertEquals(RemovalStopCause.OTHER, new Groups.Removed(false, List.of("the journal could not be read (x)"), NONE).stopCause());
		assertNull(new Groups.Removed(true, List.of(), NONE).stopCause());
	}

	@Test
	void theGroupsStop() {
		Groups.Stop s = Groups.stopOf(Groups.Removed.saveRefused("g1", "x", NONE), true);
		assertEquals(new Groups.Stop(RemovalStop.NOT_STARTED, RemovalStopCause.SAVE_REFUSED), s);
		assertEquals(RemovalStop.PARTIAL, Groups.stopOf(Groups.Removed.covered(List.of("a"), NONE), false).stop());
		assertNull(Groups.stopOf(new Groups.Removed(true, List.of(), NONE), true), "a removal that removed the group clears the stop");
	}

	@Test
	void theGroupViewNormalisesItsCause() {
		var g = new dev.larattalabs.architect.api.SiteGroup("g", null, null, List.of(), List.of(), dev.larattalabs.architect.api.SiteGroup.State.ACTIVE,
			java.util.Optional.empty(), java.util.Optional.empty());
		assertEquals(RemovalStop.NONE, g.removalStop());
		assertNull(g.removalStopCause());
		var h = new dev.larattalabs.architect.api.SiteGroup("g", null, null, List.of(), List.of(), dev.larattalabs.architect.api.SiteGroup.State.ACTIVE,
			java.util.Optional.empty(), java.util.Optional.empty(), RemovalStop.NOT_STARTED, null);
		assertEquals(RemovalStopCause.OTHER, h.removalStopCause(), "a stop is never untyped");
	}
}
