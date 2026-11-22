package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Busy;
import dev.larattalabs.architect.api.RemovalFinished;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.apiimpl.ApiEvents;
import dev.larattalabs.architect.placement.Anchors;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * (REL-v0910 fix round, P2-2; row RELF-busy-identity) Ported from the release reviewer's {@code Rel0910ApiProbe}. A whole region's removal
 * runs as its backing group {@code regionG}'s; its one REMOVAL_FINISHED is kind {@code region}, id {@code region1}. Red at 68d2b065: a caller
 * it blocks gets {@code Busy(REMOVAL_IN_PROGRESS, regionG, group)} (and a waiting region's ticket {@code WAITING_BEHIND regionG group}), an
 * identity no event ever names: a caller following the blocker-specific retry contract waits for good. The rule now: a group's or stage's
 * Busy names exactly what its REMOVAL_FINISHED names (one function, {@code ApiEvents.finishedRegion}), and {@code Busy.finishedBy} says
 * which event ends the wait.
 */
class RelFixBusyIdentityTest {
	static final String DIM = "minecraft:overworld";

	Map<String, SiteGroupRec> saved;

	@SuppressWarnings("unchecked")
	@BeforeEach
	void setUp() throws Exception {
		Field f = Sites.class.getDeclaredField("groups");
		f.setAccessible(true);
		saved = (Map<String, SiteGroupRec>) f.get(null);
		JsonObject ext = new JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, "region1");
		f.set(null, Map.of("regionG", new SiteGroupRec("regionG", "o", ext, List.of(), List.of(), SiteGroupRec.ACTIVE, false, null, null, 0L), "plainG",
			new SiteGroupRec("plainG", "o", new JsonObject(), List.of(), List.of(), SiteGroupRec.ACTIVE, false, null, null, 0L)));
	}

	@AfterEach
	void reset() throws Exception {
		Field f = Sites.class.getDeclaredField("groups");
		f.setAccessible(true);
		f.set(null, saved);
	}

	static RemovalFinished event(String group, String stage) {
		String region = stage == null ? dev.larattalabs.architect.apiimpl.Views.regionOfGroupPublic(group) : null;
		return ApiEvents.finishedOf(group, stage, null, region, new RemoveResult(true, List.of(), Map.of()));
	}

	static boolean finishedBy(Busy b, RemovalFinished f) throws Exception {
		Method m = null;
		try {
			m = Busy.class.getMethod("finishedBy", RemovalFinished.class);
		} catch (NoSuchMethodException e) {
			// red: no stated rule matching a blocker to its completion event
		}
		assertNotNull(m, "RELF-busy-identity: Busy.finishedBy states which REMOVAL_FINISHED ends the wait");
		return (boolean) m.invoke(b, f);
	}

	static void matches(Busy b, RemovalFinished f, String what) throws Exception {
		System.out.println("ROW RELF-busy-identity: " + what + ": " + b + " / event kind=" + f.kind() + " id=" + f.id() + " stage=" + f.stage());
		String kind = b.blockingKind().equals("stage") ? RemovalFinished.GROUP : b.blockingKind().equals("road") ? RemovalFinished.SITE : b.blockingKind();
		String id = b.blockingKind().equals("stage") ? f.id() + "/" + f.stage() : f.id();
		assertEquals(f.kind(), kind, "RELF-busy-identity: " + what + ": the blocker's kind is its event's");
		assertEquals(id, b.blockingId(), "RELF-busy-identity: " + what + ": the blocker's id is its event's");
		assertTrue(finishedBy(b, f), "RELF-busy-identity: " + what + ": its event ends the wait");
	}

	@Test
	void aRegionsRemovalIsNamedAsItsCompletionEventNamesIt() throws Exception {
		System.out.println("ROW RELF-busy-identity (unit)");
		Anchors.Bounds box = new Anchors.Bounds(0, 64, 0, 2, 66, 2);
		Busy region = new RemovalAreas.Area(DIM, box, "removal of region group", "group:regionG").busyOrDefault();
		matches(region, event("regionG", null), "a region's removal in progress");
		assertEquals("o", region.blockingOwner(), "its owner");
		// a waiting region's FIFO ticket (another caller blocked behind it)
		Groups.Removal t = new Groups.Removal("regionG", null, null, false);
		t.ticket = true;
		t.sites.add("t1");
		com.google.gson.JsonArray roads = new com.google.gson.JsonArray();
		roads.add(RelFixOwnAttemptTest.road("t1", 0).toJson());
		Infras.load(roads);
		Field rf = Groups.class.getDeclaredField("REMOVALS");
		rf.setAccessible(true);
		@SuppressWarnings("unchecked")
		java.util.Collection<Groups.Removal> removals = (java.util.Collection<Groups.Removal>) rf.get(null);
		removals.add(t);
		try {
			Busy waiting = null;
			for (RemovalAreas.Area a : RemovalAreas.heldAreas(null, null, true, false)) {
				if (a.busy() != null && a.busy().kind() == Busy.Kind.WAITING_BEHIND) {
					waiting = a.busy();
				}
			}
			assertNotNull(waiting, "fixture: the ticket's area");
			matches(waiting, event("regionG", null), "a waiting region's ticket");
			matches(ticketBusy(t), event("regionG", null), "the one function naming it");
		} finally {
			removals.remove(t);
			Infras.load(new com.google.gson.JsonArray());
		}
		// a plain group and a stage keep their identities (they already matched their events)
		matches(new RemovalAreas.Area(DIM, box, "g", "group:plainG").busyOrDefault(), event("plainG", null), "a plain group");
		Busy stage = new RemovalAreas.Area(DIM, box, "s", "group:regionG/streets").busyOrDefault();
		matches(stage, event("regionG", "streets"), "a region group's stage");
		assertFalse(finishedBy(region, event("regionG", "streets")), "a stage's event does not end a region's wait");
		assertFalse(finishedBy(stage, event("regionG", null)), "nor a region's event a stage's");
	}

	static Busy ticketBusy(Groups.Removal t) throws Exception {
		Method m = null;
		for (Method x : RemovalAreas.class.getDeclaredMethods()) {
			if (x.getName().equals("groupBusy")) {
				m = x;
			}
		}
		assertNotNull(m, "RELF-busy-identity: one function names a group's or stage's removal (RemovalAreas.groupBusy)");
		m.setAccessible(true);
		return (Busy) m.invoke(null, Busy.Kind.WAITING_BEHIND, t.group, t.stage, "o");
	}
}
