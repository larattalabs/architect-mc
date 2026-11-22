package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D) The pure seams of the direct-write core, driven by reflection so the rows compile on the merged head 8cc24326 (where they are
 * red: the members do not exist). Rows: T4RD-busy-typed (A7a/A7b API: Busy, its token, ArchitectRefused.busy, WAITING_BEHIND, RemovalWait,
 * owedParts, removalResult), T4RD-unclaimed (Q1/Q7: placer, site recipient, requester, architect:unclaimed), T4RD-keys (one OWE per
 * recipient, keyed by owner and member), T4RD-admission (§4.2: the begin guard refuses a NEW crate take over an owner footprint, never a
 * removal txn), T4RD-adopt (PT2: its hold is its delta cells only).
 */
class T4RDSeamsTest {
	static Class<?> cls(String n) {
		try {
			return Class.forName(n);
		} catch (ClassNotFoundException e) {
			return null;
		}
	}

	static Method method(Class<?> c, String name, Class<?>... args) {
		if (c == null) {
			return null;
		}
		try {
			Method m = c.getDeclaredMethod(name, args);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	@Test
	void theBusyApiIsTyped() throws Exception {
		System.out.println("ROW T4RD-busy-typed (unit)");
		Class<?> busy = cls("dev.larattalabs.architect.api.Busy");
		Class<?> wait = cls("dev.larattalabs.architect.api.RemovalWait");
		Class<?> part = cls("dev.larattalabs.architect.api.OwedPart");
		boolean waitingBehind = java.util.Arrays.stream(dev.larattalabs.architect.api.RemovalStopCause.values()).anyMatch(v -> v.name().equals("WAITING_BEHIND"));
		Method arBusy = method(dev.larattalabs.architect.api.ArchitectRefused.class, "busy");
		Method owedParts = method(dev.larattalabs.architect.api.RemoveResult.class, "owedParts");
		Method removalResult = method(dev.larattalabs.architect.api.Sites.class, "removalResult", String.class, String.class);
		Method groupWait = method(dev.larattalabs.architect.api.SiteGroup.class, "removalWait");
		Method regionWait = method(dev.larattalabs.architect.api.RegionView.class, "removalWait");
		System.out.println("ROW T4RD-busy-typed: Busy " + busy + ", RemovalWait " + wait + ", OwedPart " + part + ", WAITING_BEHIND " + waitingBehind
			+ ", busy() " + arBusy + ", owedParts() " + owedParts + ", removalResult " + removalResult + ", SiteGroup.removalWait " + groupWait
			+ ", RegionView.removalWait " + regionWait);
		assertTrue(busy != null && wait != null && part != null && waitingBehind && arBusy != null && owedParts != null && removalResult != null
			&& groupWait != null && regionWait != null, "T4RD-busy-typed: the typed busy, wait and owed-part API is missing");
		Class<?> kind = cls("dev.larattalabs.architect.api.Busy$Kind");
		@SuppressWarnings({"unchecked", "rawtypes"})
		Object held = Enum.valueOf((Class) kind, "HELD_DECIDED");
		@SuppressWarnings({"unchecked", "rawtypes"})
		Object behind = Enum.valueOf((Class) kind, "WAITING_BEHIND");
		Object b1 = busy.getConstructors()[0].newInstance(held, "s1", "site", "o");
		Object b2 = busy.getConstructors()[0].newInstance(behind, "g7", "group", null);
		assertEquals("held(decided)", busy.getMethod("token").invoke(b1), "T4RD-busy-typed: A2's token");
		assertEquals("waiting_behind:g7", busy.getMethod("token").invoke(b2), "T4RD-busy-typed: <kind_lower>:<blockingId>");
		dev.larattalabs.architect.api.ArchitectRefused ar = (dev.larattalabs.architect.api.ArchitectRefused) dev.larattalabs.architect.api.ArchitectRefused.class
			.getConstructor(dev.larattalabs.architect.api.Reason.class, String.class, busy).newInstance(dev.larattalabs.architect.api.Reason.SITE_BUSY, "x", b2);
		assertEquals("waiting_behind:g7", ar.detail());
		assertEquals(b2, arBusy.invoke(ar));
	}

	@Test
	void recipientsFollowTheChain() throws Exception {
		System.out.println("ROW T4RD-unclaimed (unit)");
		Method r = method(cls("dev.larattalabs.architect.site.OwnerRemovals"), "recipient", String.class, String.class, String.class);
		assertNotNull(r, "T4RD-unclaimed: no recipient rule (the player's blocks drop at the site)");
		assertEquals("placer", r.invoke(null, "placer", "owner", "req"), "the PT placer first");
		assertEquals("owner", r.invoke(null, null, "owner", "req"), "else the site's recipient");
		assertEquals("req", r.invoke(null, null, "architect:unowned", "req"), "unowned: the requester");
		assertEquals("architect:unclaimed", r.invoke(null, null, "architect:unowned", null), "nobody: unclaimed");
	}

	@Test
	void oneOwePerRecipientKeyedByOwnerAndMember() throws Exception {
		System.out.println("ROW T4RD-keys (unit)");
		Method m = method(cls("dev.larattalabs.architect.site.OwnerRemovals"), "playerOwes", String.class, String.class, String.class, int.class, JsonArray.class);
		assertNotNull(m, "T4RD-keys: no per-recipient OWE of the player's blocks");
		JsonArray player = new JsonArray();
		for (Object[] c : new Object[][] {{1L, "a", "minecraft:sponge"}, {2L, "a", "minecraft:sponge"}, {3L, "b", "minecraft:stone"}}) {
			JsonObject x = new JsonObject();
			x.addProperty("pos", (long) c[0]);
			x.addProperty("block", (String) c[2]);
			x.addProperty("recipient", (String) c[1]);
			JsonObject it = new JsonObject();
			it.addProperty((String) c[2], 1);
			x.add("items", it);
			player.add(x);
		}
		@SuppressWarnings("unchecked")
		List<dev.larattalabs.architect.txn.Effect.Builder> owes = (List<dev.larattalabs.architect.txn.Effect.Builder>) m.invoke(null, "removal:s1@u:s1:9", "s2",
			"minecraft:overworld", 3, player);
		assertEquals(2, owes.size(), "one OWE per recipient");
		Method build = dev.larattalabs.architect.txn.Effect.Builder.class.getDeclaredMethod("build", int.class);
		build.setAccessible(true);
		dev.larattalabs.architect.txn.Effect a = (dev.larattalabs.architect.txn.Effect) build.invoke(owes.get(0), 0);
		assertEquals("player:removal:s1@u:s1:9/s2:a", a.data().get("key").getAsString());
		assertEquals("player_blocks", a.data().get("reason").getAsString());
		assertEquals(3, a.data().get("pof").getAsInt(), "paid from its member's W receipts");
		assertEquals(Map.of("minecraft:sponge", 2), a.items(), "planned: the recorded items");
	}

	@Test
	void theBeginGuardRefusesANewCrateTakeOverAnOwnersFootprint() throws Exception {
		System.out.println("ROW T4RD-admission (unit)");
		Class<?> or = cls("dev.larattalabs.architect.site.OwnerRemovals");
		Method put = method(or, "put", String.class, JsonObject.class);
		Method forget = method(or, "forget", String.class);
		Method guard = method(RemovalAreas.class, "beginGuard", String.class, String.class, List.class);
		assertTrue(put != null && guard != null, "T4RD-admission: no begin guard over owner footprints");
		JsonObject rec = new JsonObject();
		rec.addProperty("base", "s1");
		rec.addProperty("undoGroup", "u:s1:9");
		rec.addProperty("dim", "minecraft:overworld");
		JsonObject members = new JsonObject();
		JsonObject m = new JsonObject();
		JsonArray box = new JsonArray();
		for (int v : new int[] {0, 64, 0, 4, 68, 4}) {
			box.add(v);
		}
		m.add("box", box);
		members.add("s1", m);
		rec.add("members", members);
		put.invoke(null, "removal:s1@u:s1:9", rec);
		try {
			Object in = guard.invoke(null, "crate.take", null, List.of("crate:minecraft:overworld@2,65,2"));
			Object out = guard.invoke(null, "crate.take", null, List.of("crate:minecraft:overworld@20,65,2"));
			Object own = guard.invoke(null, "removal.site", "removal:s1@u:s1:9", List.of("rbox:minecraft:overworld@0,64,0:4,68,4"));
			System.out.println("ROW T4RD-admission: inside " + in + "; outside " + out + "; its own txn " + own);
			assertNotNull(in, "a NEW crate take inside the footprint is refused");
			assertTrue(String.valueOf(in).contains("removal_in_progress:s1"), "typed: " + in);
			assertNull(out, "outside: free");
			assertNull(own, "a removal txn (its own admission) is never refused here");
		} finally {
			forget.invoke(null, "removal:s1@u:s1:9");
		}
	}

	@Test
	void anAdoptedSitesHoldIsItsDeltaCells() throws Exception {
		System.out.println("ROW T4RD-adopt (unit)");
		Method holdsOf = method(cls("dev.larattalabs.architect.site.OwnerRemovals"), "holdsOf", JsonObject.class);
		assertNotNull(holdsOf, "T4RD-adopt: no owner record hold");
		JsonObject rec = new JsonObject();
		rec.addProperty("dim", "minecraft:overworld");
		JsonObject members = new JsonObject();
		JsonObject m = new JsonObject();
		JsonArray box = new JsonArray();
		for (int v : new int[] {0, 64, 0, 9, 70, 9}) {
			box.add(v);
		}
		m.add("box", box);
		JsonArray hold = new JsonArray();
		hold.add(net.minecraft.core.BlockPos.asLong(3, 65, 3));
		m.add("hold", hold);
		members.add("a1", m);
		rec.add("members", members);
		@SuppressWarnings("unchecked")
		List<JsonObject> hs = (List<JsonObject>) holdsOf.invoke(null, rec);
		var held = CrateSettle.heldOf(hs);
		assertTrue(CrateSettle.heldForAny(held, "minecraft:overworld", 3, 65, 3, null), "a delta cell is held");
		assertTrue(!CrateSettle.heldForAny(held, "minecraft:overworld", 4, 65, 3, null), "the house's other cells are never held");
		assertTrue(!CrateSettle.heldForAny(held, "minecraft:overworld", 3, 65, 3, java.util.Set.of("a1")), "its own writes are exempt");
	}
}
