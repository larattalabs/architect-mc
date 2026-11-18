package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8b BS) The vocabulary and its precedence, pinned: one fixture status per reason (pause included), the winner of every pair is the higher
 * of the table, a target's status from its state, wait, pause and removal; the old constructors never leave a status null; the cost.
 */
class BuildStatusTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static BuildStatus waiting(String why) {
		return new BuildStatus(BuildStatus.WAITING, why, "t1", null, 0, 5L, "", 0, null);
	}

	/** One status per row of the table, in the table's order. */
	private static List<BuildStatus> table() {
		List<BuildStatus> out = new ArrayList<>();
		out.add(BuildStatus.of(BuildStatus.REMOVING, 0));
		out.add(new BuildStatus(BuildStatus.FAILED, "failed:NO_ROOM", null, null, 0, 0, "", 0, null));
		out.add(BuildStatus.of(BuildStatus.PAUSED, 0));
		for (String r : List.of(BuildStatus.TXN_HELD, BuildStatus.APPROVAL, BuildStatus.STAGE, BuildStatus.TERRAIN, BuildStatus.BILL_CAP, BuildStatus.FILL_BLOCKED,
			BuildStatus.MATERIALS, BuildStatus.OCCUPIED, BuildStatus.PLAYER_IN_BOX, BuildStatus.NOT_LOADED)) {
			out.add(waiting(r));
		}
		for (String s : List.of(BuildStatus.REMOVED, BuildStatus.PLACING, BuildStatus.BUILDING, BuildStatus.PLANNED, BuildStatus.BUILT)) {
			out.add(BuildStatus.of(s, 0));
		}
		return out;
	}

	@Test
	void thePrecedenceTable() {
		assertEquals(List.of("removing", "failed", "paused", "txn_held", "approval", "stage", "terrain", "bill_cap", "fill_blocked", "materials", "occupied",
			"player_in_box", "not_loaded", "removed", "placing", "building", "planned", "built"), BuildStatus.PRECEDENCE, "the documented order");
		List<BuildStatus> t = table();
		for (int i = 0; i < t.size(); i++) {
			assertEquals(2 * i, t.get(i).rank(), t.get(i).toString());
			for (int j = i + 1; j < t.size(); j++) {
				assertEquals(t.get(i), BuildStatus.winner(t.get(i), t.get(j)), t.get(i).rank() + " over " + t.get(j).rank());
				assertEquals(t.get(i), BuildStatus.winner(t.get(j), t.get(i)));
			}
		}
	}

	@Test
	void anUntypedWaitRanksJustAboveBuilt() {
		BuildStatus u = new BuildStatus(BuildStatus.WAITING, null, null, null, 0, 0, "", 0, null);
		assertEquals(u, BuildStatus.winner(BuildStatus.of(BuildStatus.BUILT, 0), u));
		assertEquals(BuildStatus.of(BuildStatus.PLANNED, 0), BuildStatus.winner(u, BuildStatus.of(BuildStatus.PLANNED, 0)));
	}

	@Test
	void aTargetsStatus() {
		SiteWait mat = new SiteWait("s1", true, 400L, List.of(), 3);
		SiteWait cap = new SiteWait("s1", true, 400L, List.of(), 0, SiteWait.BILL_CAP, List.of(), "lot:a,region");
		SiteWait fill = new SiteWait("s1", true, 400L, List.of(), 0, SiteWait.FILL_BLOCKED, List.of());
		SiteWait txn = new SiteWait("s1", true, 400L, List.of(), 0, SiteWait.TXN_HELD, List.of());
		SiteWait idle = new SiteWait("s1", false, 0L, List.of(), 0);
		assertEquals(BuildStatus.BUILT, BuildStatus.ofTarget("s1", State.BUILT, null, false, false, 0).state(), "an instant site");
		assertEquals(BuildStatus.PLACING, BuildStatus.ofTarget("s1", State.PLACING, null, false, false, 0).state());
		assertEquals(BuildStatus.BUILDING, BuildStatus.ofTarget("s1", State.BUILDING, idle, false, false, 0).state());
		assertEquals(BuildStatus.PAUSED, BuildStatus.ofTarget("s1", State.BUILDING, mat, true, false, 0).state(), "a pause wins over materials");
		assertEquals(BuildStatus.REMOVING, BuildStatus.ofTarget("s1", State.BUILDING, mat, true, true, 0).state());
		BuildStatus m = BuildStatus.ofTarget("s1", State.BUILDING, mat, false, false, 2);
		assertEquals(List.of(BuildStatus.WAITING, BuildStatus.MATERIALS, "s1", 400L, 3, 2), List.of(m.state(), m.reason(), m.waitsOn(), m.since(), m.moreUnits(),
			m.revision()));
		BuildStatus c = BuildStatus.ofTarget("s1", State.BUILDING, cap, false, false, 3);
		assertEquals(List.of(BuildStatus.BILL_CAP, "s1", "lot:a,region", 3), List.of(c.reason(), c.waitsOn(), c.capScope(), c.revision()));
		assertEquals(400L, c.since(), "since == SiteWait.waitingSince whatever the kind");
		assertEquals(BuildStatus.FILL_BLOCKED, BuildStatus.ofTarget("s1", State.BUILDING, fill, false, false, 0).reason());
		assertEquals(BuildStatus.TXN_HELD, BuildStatus.ofTarget("s1", State.BUILDING, txn, false, false, 0).reason());
		assertNull(m.capScope());
	}

	@Test
	void statusIsNeverNull() {
		var box = new net.minecraft.world.level.levelgen.structure.BoundingBox(0, 0, 0, 1, 1, 1);
		var v = new SiteView("s", "bp", null, null, box, box, net.minecraft.world.level.block.Rotation.NONE, net.minecraft.world.level.Level.OVERWORLD,
			State.BUILT, 0, 0);
		assertEquals(BuildStatus.BUILT, v.status().state());
		assertEquals(BuildStatus.PLANNED, new LotState("a", null, "pad").status().state(), "a pad is planned");
		assertEquals(BuildStatus.PLANNED, new LotState("a", null, "queued").status().state());
		assertEquals(BuildStatus.REMOVED, new LotState("a", null, "removed", 1).status().state());
		LotState f = new LotState("a", null, "failed:NO_ROOM");
		assertEquals(List.of(BuildStatus.FAILED, "failed:NO_ROOM"), List.of(f.status().state(), f.status().reason()));
		assertEquals(BuildStatus.BUILT, new PartBuild("p", "built", List.of(), 1, 1, 0).status().state());
		assertEquals(BuildStatus.BUILDING, new PartBuild("p", "waiting", List.of(), 1, 0, 0).status().state(), "nothing built yet is building, not a wait");
		assertNotNull(new ItemEvent("b", "k", null, java.util.Optional.empty(), java.util.Optional.empty(), null).ext());
	}

	@Test
	void aViewHoldingAStatusStaysGsonSerialisable() {
		// RegionView was plain-Gson serialisable (dev.region.state, RegionPreviews' note); a status with needs keeps it so
		SiteWait mat = new SiteWait("s1", true, 400L, List.of(new ItemCount(net.minecraft.world.item.Items.STONE, 3)), 0);
		BuildStatus b = BuildStatus.ofTarget("s1", State.BUILDING, mat, false, false, 0);
		assertEquals(3, b.needs().get(net.minecraft.world.item.Items.STONE));
		String s = new com.google.gson.Gson().toJson(new LotState("a", "s1", "placed", 0, null, b));
		assertTrue(s.contains("\"materials\""), s);
	}

	@Test
	void theDerivationIsCheap() {
		// the 0.5 ms budget over a 200-target region: the status work per view is one derivation per target and one winner per part (the
		// SiteWait itself is the view's own, read once). Timing flags, never fails (speed rule 8): printed, with a generous bound
		SiteWait cap = new SiteWait("s", true, 400L, List.of(), 0, SiteWait.BILL_CAP, List.of(), "region");
		long best = Long.MAX_VALUE;
		for (int round = 0; round < 50; round++) {
			long t0 = System.nanoTime();
			BuildStatus w = null;
			for (int i = 0; i < 200; i++) {
				BuildStatus b = BuildStatus.ofTarget("s" + i, State.BUILDING, i % 3 == 0 ? cap : null, i % 7 == 0, false, 0);
				w = w == null ? b : BuildStatus.winner(w, b);
			}
			best = Math.min(best, System.nanoTime() - t0);
			assertNotNull(w);
		}
		System.out.println("[8b BS] 200 targets' status derivation: " + best / 1000 + " us (budget 500 us)");
		assertTrue(best < 50_000_000L, "far past the budget: " + best);
	}
}
