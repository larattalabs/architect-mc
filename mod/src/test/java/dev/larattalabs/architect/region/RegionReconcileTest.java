package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * (C23; x-resume (f), docs/FAST-CHECKS.md P1) The world-start reconcile of a region whose removal record was left REMOVING: every
 * combination of the region's state, its group id, a running removal of the group and the group's persisted state. The in-game (f1)
 * and (f2) cases (group removed: REMOVED; group active after a failed restore: PARTIAL) run at release (x-resume-full).
 */
class RegionReconcileTest {
	@Test
	void theReconcileTable() {
		String[] groupStates = {SiteGroupRec.REMOVED, SiteGroupRec.ACTIVE, SiteGroupRec.REMOVING, null};
		for (RegionState st : RegionState.values()) {
			for (String gid : new String[] {"g1", null}) {
				for (boolean running : new boolean[] {false, true}) {
					for (String gs : groupStates) {
						RegionState want = st != RegionState.REMOVING || gid == null || running ? null
							: SiteGroupRec.REMOVED.equals(gs) ? RegionState.REMOVED : RegionState.PARTIAL;
						assertEquals(want, RegionsImpl.reconcileEnd(st, gid, () -> running, () -> gs), st + " group " + gid + " running " + running + " " + gs);
					}
				}
			}
		}
	}

	@Test
	void f1GroupRemovedEndsRemovedAndF2GroupActiveEndsPartial() {
		assertEquals(RegionState.REMOVED, RegionsImpl.reconcileEnd(RegionState.REMOVING, "g", () -> false, () -> SiteGroupRec.REMOVED), "(f1)");
		assertEquals(RegionState.PARTIAL, RegionsImpl.reconcileEnd(RegionState.REMOVING, "g", () -> false, () -> SiteGroupRec.ACTIVE), "(f2)");
		assertNull(RegionsImpl.reconcileEnd(RegionState.REMOVING, "g", () -> true, () -> SiteGroupRec.REMOVED), "a running removal ends it itself");
		assertNull(RegionsImpl.reconcileEnd(RegionState.PLACED, "g", () -> false, () -> SiteGroupRec.REMOVED), "only REMOVING changes");
	}

	@Test
	void theRunningAndGroupLookupsAreAskedOnlyForARemovingRegionWithAGroup() {
		AtomicInteger asked = new AtomicInteger();
		RegionsImpl.reconcileEnd(RegionState.PLACED, "g", () -> asked.incrementAndGet() < 0, () -> {
			asked.incrementAndGet();
			return null;
		});
		RegionsImpl.reconcileEnd(RegionState.REMOVING, null, () -> asked.incrementAndGet() < 0, () -> {
			asked.incrementAndGet();
			return null;
		});
		assertEquals(0, asked.get());
	}
}
