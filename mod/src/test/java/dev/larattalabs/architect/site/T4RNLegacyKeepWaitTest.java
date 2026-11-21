package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-N, the final check of f7607b13's P2 "legacy KEEP single") A single removal a pre-T4R build left pending (its J2 credit held,
 * its evidence KEEP, no restore job) is progressed by nothing in this session. A new group removal with a member over its box waits before it
 * plans (the coexistence rule), but that wait must end: through the production {@code Groups.tick}, the waiting removal's call is answered
 * (stopped, nothing changed) within the removal wait ({@link Groups#MAX_WAIT}), never left waiting with its future open.
 */
class T4RNLegacyKeepWaitTest {
	@SuppressWarnings("unchecked")
	static <T> T field(Class<?> c, String name) throws Exception {
		java.lang.reflect.Field f = c.getDeclaredField(name);
		f.setAccessible(true);
		return (T) f.get(null);
	}

	static void set(Class<?> c, String name, Object v) throws Exception {
		java.lang.reflect.Field f = c.getDeclaredField(name);
		f.setAccessible(true);
		f.set(null, v);
	}

	static Site site(String id, Anchors.Bounds bx) {
		return new Site(id, "bp", "none", bx, bx, Map.of(), 1, "minecraft:overworld", null, "snapshot", null, null, null, null, new JsonObject(), null, false);
	}

	@Test
	void aWaitOnAPendingLegacySingleEnds() throws Exception {
		System.out.println("ROW T4RN-legacy-keep (unit)");
		List<Groups.Removal> rs = field(Groups.class, "REMOVALS");
		Map<String, Stockpiles.Pile> piles = field(Stockpiles.class, "PILES");
		Object stateWas = field(Sites.class, "state");
		Object tickWas = field(Groups.class, "tick");
		boolean loadFailedWas = field(Placement.class, "loadFailed");
		try {
			Anchors.Bounds bx = new Anchors.Bounds(0, 64, 0, 3, 66, 3);
			Construction con = new Construction(Construction.BUILT, new int[] {0}, "journal", null, new BitSet(), false, "owner");
			Site old = new Site("old", "bp", "none", bx, bx, Map.of(), 1, "minecraft:overworld", bx, "snapshot", null, null, con);
			Site fresh = site("fresh", bx);
			dev.larattalabs.architect.survival.StockLedger ledger = new dev.larattalabs.architect.survival.StockLedger();
			ledger.holdPending(Builder.creditKey(old), Map.of("minecraft:stone", 7), 0); // the pre-T4R J2 credit, held
			piles.put("sp1", new Stockpiles.Pile("sp1", "owner", "minecraft:overworld", ledger));
			Class<?> st = Class.forName(Sites.class.getName() + "$State");
			var ctor = st.getDeclaredConstructor(Map.class, int.class, List.class);
			ctor.setAccessible(true);
			set(Sites.class, "state", ctor.newInstance(Map.of(fresh.id(), fresh), 1, List.of(new Site.Pending(old, 1, "removed"))));
			assertTrue(Sites.settleSite(new Sites.Evidence(false, false, false), false, false, null) == dev.larattalabs.architect.placement.Reconcile.Action.KEEP,
				"fixture: its evidence is KEEP");
			assertTrue(Stockpiles.pendingAction(Builder.creditKey(old), false, false, true) == Stockpiles.PendingAction.LEAVE,
				"fixture: its credit stays held (LEAVE)");
			assertNotNull(RemovalAreas.legacyWhy("minecraft:overworld", List.of(bx), java.util.Set.of()), "fixture: a pre-T4R removal in flight over the box");
			set(Placement.class, "loadFailed", true); // no queue file in a unit test: the end's save is a no-op
			Groups.Removal r = new Groups.Removal("waiting", null, null, false);
			r.started = true;
			r.sites.add("fresh");
			CompletableFuture<Groups.Removed> f = new CompletableFuture<>();
			r.futures.add(f);
			rs.add(r);
			var tick = Groups.class.getDeclaredMethod("tick", net.minecraft.server.MinecraftServer.class, Groups.Removal.class);
			tick.setAccessible(true);
			int n = 0;
			for (; n < (int) (Groups.MAX_WAIT / 20) + 10 && !f.isDone(); n++) {
				set(Groups.class, "tick", 20L * n);
				tick.invoke(null, null, r);
			}
			System.out.println("ROW T4RN-legacy-keep: after " + n + " retries at 20 ticks: answered " + f.isDone() + (f.isDone() ? " " + f.getNow(null)
				.blockers() : "; still waiting: " + r.gtxWait + ", waited " + r.waited));
			assertTrue(f.isDone(), "T4RN-legacy-keep: the new group's wait on a pending pre-T4R single never ends (its call never answered)");
			Groups.Removed res = f.getNow(null);
			assertFalse(res.removed(), "T4RN-legacy-keep: it stops, nothing removed");
			assertTrue(r.planner == null && r.undo == null && r.planned == null, "T4RN-legacy-keep: nothing planned or committed");
			assertFalse(rs.contains(r), "T4RN-legacy-keep: it left the queue");
		} finally {
			rs.clear();
			piles.clear();
			set(Sites.class, "state", stateWas);
			set(Groups.class, "tick", tickWas);
			set(Placement.class, "loadFailed", loadFailedWas);
		}
	}
}
