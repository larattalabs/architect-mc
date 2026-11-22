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
 * (slice T4R-D, D4; row T4RD-wait, T4R-N's P3) The legacy wait has its own persisted counter ({@code legacyWaited}): it never consumes the
 * player/placing wait's budget ({@code waited}), across a reload too. Fixture as T4RN-legacy-keep:
 * <p>
 * (slice T4R-N, the final check of f7607b13's P2 "legacy KEEP single") A single removal a pre-T4R build left pending (its J2 credit held,
 * its evidence KEEP, no restore job) is progressed by nothing in this session. A new group removal with a member over its box waits before it
 * plans (the coexistence rule), but that wait must end: through the production {@code Groups.tick}, the waiting removal's call is answered
 * (stopped, nothing changed) within the removal wait ({@link Groups#MAX_WAIT}), never left waiting with its future open.
 */
class T4RDLegacyWaitedTest {
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
	void theLegacyWaitNeverSpendsThePlayerWait() throws Exception {
		System.out.println("ROW T4RD-wait (unit)");
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
			for (; n < (int) (Groups.MAX_WAIT / 20) - 1 && !f.isDone(); n++) {
				set(Groups.class, "tick", 20L * n);
				tick.invoke(null, null, r);
			}
			JsonObject saved = r.toJson();
			Groups.Removal back = Groups.Removal.fromJson(saved);
			System.out.println("ROW T4RD-wait: after " + n + " legacy checks: waited " + r.waited + ", saved " + saved.get("waited") + " legacyWaited " + saved.get(
				"legacyWaited") + "; reloaded waited " + back.waited);
			assertFalse(f.isDone(), "fixture: still waiting on the legacy removal");
			assertTrue(r.waited == 0, "T4RD-wait: the legacy wait spent the player/placing wait's budget (waited " + r.waited + "): a later player wait stops after "
				+ (Groups.MAX_WAIT - r.waited) / 20 + " check(s)");
			assertTrue(back.waited == 0, "T4RD-wait: reloaded, the player wait starts spent");
			assertTrue(saved.has("legacyWaited") && saved.get("legacyWaited").getAsLong() == 20L * n, "T4RD-wait: the legacy wait's own counter is persisted");
		} finally {
			rs.clear();
			piles.clear();
			set(Sites.class, "state", stateWas);
			set(Groups.class, "tick", tickWas);
			set(Placement.class, "loadFailed", loadFailedWas);
		}
	}
}
