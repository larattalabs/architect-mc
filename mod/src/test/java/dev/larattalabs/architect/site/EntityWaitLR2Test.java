package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.placement.Anchors;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * (slice LR2-FIX) The entity wait before a restore's drop snapshot, driven by reflection so the rows compile on 02c05b24 (where they are red:
 * EntityWait does not exist, and the W apply snapshots drops whatever the entities' state). Rows: LR2F-area (the chunks of the drop area, the
 * box inflated by 1, across chunk edges), LR2F-hold (entities not loaded: the W throws "entities not loaded", never snapshots; one ticket per
 * key across retries; snapshot once ready; the ticket goes after the later pass), LR2F-stale (a wait not retried lets go), LR2F-keep (a job's
 * ticket stays until it ends). The unit shows the rule; the in-game rows LR-2s and LR-2p show the call sites.
 */
class EntityWaitLR2Test {
	static final Class<?> EW = cls("dev.larattalabs.architect.site.EntityWait");
	static final Class<?> WORLD = cls("dev.larattalabs.architect.site.EntityWait$World");

	static Class<?> cls(String n) {
		try {
			return Class.forName(n);
		} catch (ClassNotFoundException e) {
			return null;
		}
	}

	static Method m(String name, Class<?>... args) {
		assertNotNull(EW, "LR2-FIX: EntityWait is missing (the W snapshots drops with entities not loaded)");
		try {
			Method x = EW.getDeclaredMethod(name, args);
			x.setAccessible(true);
			return x;
		} catch (NoSuchMethodException e) {
			throw new AssertionError("LR2-FIX: EntityWait." + name + " is missing", e);
		}
	}

	static Object call(Method x, Object... args) throws Throwable {
		try {
			return x.invoke(null, args);
		} catch (InvocationTargetException e) {
			throw e.getCause();
		}
	}

	/** A world whose ready chunks are {@link #ready}, with vanilla-like tickets and a clock. */
	static final class Fake {
		final Set<Long> ready = new HashSet<>();
		final List<String> log = new ArrayList<>();
		final Set<Long> ticket = new HashSet<>();
		int now = 100;
		final ChunkTickets.Source src = new ChunkTickets.Source() {
			@Override
			public void add(long c) {
				ticket.add(c);
				log.add("+" + c);
			}

			@Override
			public void remove(long c) {
				ticket.remove(c);
				log.add("-" + c);
			}
		};

		Object world() {
			assertNotNull(WORLD, "LR2-FIX: EntityWait.World is missing");
			return Proxy.newProxyInstance(WORLD.getClassLoader(), new Class<?>[] {WORLD}, (p, method, a) -> switch (method.getName()) {
				case "ready" -> ready.contains((Long) a[0]);
				case "tickets" -> src;
				case "dimension" -> "minecraft:overworld";
				case "now" -> now;
				default -> throw new UnsupportedOperationException(method.getName());
			});
		}
	}

	@BeforeEach
	void reset() throws Throwable {
		ChunkTickets.reset();
		if (EW != null) {
			call(m("reset"));
		}
	}

	@SuppressWarnings("unchecked")
	static List<Long> chunks(Anchors.Bounds b) throws Throwable {
		return (List<Long>) call(m("chunks", Anchors.Bounds.class), b);
	}

	static long pack(int x, int z) {
		return net.minecraft.world.level.ChunkPos.pack(x, z);
	}

	@Test
	void theDropAreaIsTheChunksVanillasEntityQuerySearches() throws Throwable {
		System.out.println("ROW LR2F-area (unit)");
		// x 15..30, z 0..14: the drop area x [14, 32), z [-1, 16); vanilla's query adds 2: x 12..34 (chunks 0..2), z -3..18 (chunks -1..1)
		Set<Long> want = new HashSet<>();
		for (int x = 0; x <= 2; x++) {
			for (int z = -1; z <= 1; z++) {
				want.add(pack(x, z));
			}
		}
		assertEquals(want, new HashSet<>(chunks(new Anchors.Bounds(15, 64, 0, 30, 70, 14))));
		assertTrue(chunks(new Anchors.Bounds(20, 64, 20, 27, 64, 27)).equals(List.of(pack(1, 1))), "well inside one chunk: that chunk only");
	}

	/** Vanilla's rule: an item (0.25 wide) is found when its bounding box intersects the area; it lives in the chunk of its centre. */
	static boolean found(double cx, double areaMin, double areaMax) {
		return cx + 0.125 > areaMin && cx - 0.125 < areaMax;
	}

	@Test
	void anItemCentredInANeighbourChunkButReachingInIsCovered() throws Throwable {
		System.out.println("ROW LR2F-margin (unit)");
		// (fix round P1-2) box x 1..14: the drop area x [0, 16). An item centred at x = -0.05 (chunk -1) or 16.05 (chunk 1) reaches into it
		Anchors.Bounds b = new Anchors.Bounds(1, 64, 1, 14, 64, 14);
		assertTrue(found(-0.05, 0, 16) && found(16.05, 0, 16), "the probe items do reach into the drop area");
		List<Long> cs = chunks(b);
		assertTrue(cs.contains(pack(Math.floorDiv((int) Math.floor(-0.05), 16), 0)), "LR2F-margin: chunk -1 (an item centred at x = -0.05) is waited for: " + cs);
		assertTrue(cs.contains(pack((int) Math.floor(16.05) >> 4, 0)), "LR2F-margin: chunk 1 (an item centred at x = 16.05) is waited for: " + cs);
		assertTrue(cs.contains(pack(0, -1)) && cs.contains(pack(0, 1)), "LR2F-margin: the same in z: " + cs);
	}

	@Test
	void aWApplyWithEntitiesNotLoadedHoldsAndNeverSnapshots() throws Throwable {
		System.out.println("ROW LR2F-hold (unit)");
		Fake f = new Fake();
		Method gated = m("gated", WORLD, String.class, List.class, Supplier.class);
		Method tick = m("tick", int.class);
		Method held = m("held");
		List<Long> cs = chunks(new Anchors.Bounds(15, 64, 0, 30, 70, 14));
		int[] snaps = {0};
		Supplier<String> snap = () -> {
			snaps[0]++;
			return "drops";
		};
		f.ready.add(cs.get(0)); // one chunk ready, the others not
		for (int i = 0; i < 3; i++) {
			f.now++;
			try {
				call(gated, f.world(), "s1|g1", cs, snap);
				throw new AssertionError("LR2F-hold: the W went on with entities not loaded");
			} catch (IllegalStateException e) {
				assertTrue(e.getMessage().startsWith("entities not loaded"), e.getMessage());
			}
		}
		assertEquals(0, snaps[0], "LR2F-hold: no drop snapshot while entities are not loaded");
		assertEquals(cs.size(), f.log.size(), "LR2F-hold: one ticket per chunk, taken once across the retries: " + f.log);
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-hold: every chunk of the drop area is ticketed (no player near needed)");
		f.ready.addAll(cs);
		f.now++;
		assertEquals("drops", call(gated, f.world(), "s1|g1", cs, snap));
		assertEquals(1, snaps[0], "LR2F-hold: snapshot once the entities are loaded");
		call(tick, f.now + 3);
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-hold: the ticket stays through Drops' later pass (3 ticks)");
		call(tick, f.now + 5);
		assertTrue(f.ticket.isEmpty(), "LR2F-hold: the ticket goes after the later pass: " + f.log);
		assertEquals(0, call(held));
	}

	@Test
	void aReadyWriteStillHoldsItsTicketThroughItsCleanup() throws Throwable {
		System.out.println("ROW LR2F-ready (unit)");
		// (fix round P1-1) ready or not, a gated restore holds its chunks until its drop cleanup is past: a player leaving can't hide them
		Fake f = new Fake();
		List<Long> cs = chunks(new Anchors.Bounds(0, 64, 0, 40, 70, 40));
		f.ready.addAll(cs);
		assertEquals("x", call(m("gated", WORLD, String.class, List.class, Supplier.class), f.world(), "s|g", cs, (Supplier<String>) () -> "x"));
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-ready: the chunks are ticketed from the gate, ready or not");
		call(m("tick", int.class), f.now + 3);
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-ready: kept through Drops' later pass");
		call(m("tick", int.class), f.now + 5);
		assertTrue(f.ticket.isEmpty(), "LR2F-ready: released after it");
		Method ready = m("ready", WORLD, String.class, List.class, boolean.class);
		assertTrue((Boolean) call(ready, f.world(), "job:x", cs, true));
		call(m("tick", int.class), f.now + 5000);
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-ready: a job ready at its first check keeps its ticket over its writes");
	}

	@Test
	void aJobThatThrowsLetsItsTicketGo() throws Throwable {
		System.out.println("ROW LR2F-guard (unit)");
		// (fix round P2-4) Placement drops a job that threw without aborted(): the job's retirement path lets the ticket go
		Fake f = new Fake();
		List<Long> cs = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		assertFalse((Boolean) call(m("ready", WORLD, String.class, List.class, boolean.class), f.world(), "job:t", cs, true));
		Method guard = m("guard", String.class, java.util.function.BooleanSupplier.class);
		assertFalse((Boolean) call(guard, "job:t", (java.util.function.BooleanSupplier) () -> false));
		assertFalse(f.ticket.isEmpty(), "LR2F-guard: a step that goes on keeps it");
		try {
			call(guard, "job:t", (java.util.function.BooleanSupplier) () -> {
				throw new IllegalStateException("writer failed");
			});
			throw new AssertionError("LR2F-guard: the exception was swallowed");
		} catch (IllegalStateException e) {
			assertEquals("writer failed", e.getMessage());
		}
		call(m("tick", int.class), f.now + 5); // (fix-check P1-1) retired: it goes after the delayed clear's window
		assertTrue(f.ticket.isEmpty(), "LR2F-guard: a step that threw let the ticket go: " + f.log);
		assertEquals(0, call(m("held")));
	}

	@Test
	void aLiveRestoreWithEntitiesPendingIsRefusedRetryably() throws Throwable {
		System.out.println("ROW LR2F-live (unit)");
		// (fix round P1-3) a synchronous remove: refused NOT_LOADED before any snapshot or change, its ticket taken so the retry passes
		Fake f = new Fake();
		List<Long> cs = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		Method live = m("requireLive", WORLD, String.class, List.class, String.class);
		try {
			call(live, f.world(), "live:remove:a", cs, "Removing a");
			throw new AssertionError("LR2F-live: a live removal went on with entities not loaded");
		} catch (Sites.SiteException e) {
			assertEquals(dev.larattalabs.architect.api.Reason.NOT_LOADED, e.reason(), e.getMessage());
		}
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-live: its ticket loads them for the retry");
		f.ready.addAll(cs);
		call(live, f.world(), "live:remove:a", cs, "Removing a");
		call(m("tick", int.class), f.now + 5);
		assertTrue(f.ticket.isEmpty(), "LR2F-live: released after the retry's cleanup");
	}

	@Test
	void aWaitNotRetriedLetsGo() throws Throwable {
		System.out.println("ROW LR2F-stale (unit)");
		Fake f = new Fake();
		Method ready = m("ready", WORLD, String.class, List.class, boolean.class);
		List<Long> cs = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		assertFalse((Boolean) call(ready, f.world(), "s|g", cs, false));
		call(m("tick", int.class), f.now + 600);
		assertFalse(f.ticket.isEmpty(), "still waiting");
		call(m("tick", int.class), f.now + 1201);
		assertTrue(f.ticket.isEmpty(), "LR2F-stale: a wait no one retried lets its ticket go");
	}

	@Test
	void aJobKeepsItsTicketUntilItEnds() throws Throwable {
		System.out.println("ROW LR2F-keep (unit)");
		Fake f = new Fake();
		Method ready = m("ready", WORLD, String.class, List.class, boolean.class);
		List<Long> cs = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		assertFalse((Boolean) call(ready, f.world(), "job:s", cs, true));
		f.ready.addAll(cs);
		assertTrue((Boolean) call(ready, f.world(), "job:s", cs, true));
		call(m("tick", int.class), f.now + 5000);
		assertFalse(f.ticket.isEmpty(), "LR2F-keep: a job writing over ticks keeps its ticket");
		call(m("release", String.class), "job:s");
		assertTrue(f.ticket.isEmpty(), "LR2F-keep: released when the job ends");
	}

	@Test
	void aRetiredJobKeepsItsTicketThroughItsLastDelayedClear() throws Throwable {
		System.out.println("ROW LR2F-retire (unit, production RestoreJob.step)");
		// (fix-check P1-1) the job's last write clears its drops again 3 ticks later (Drops.LATER): the player leaving right after the job ends
		// must not let the chunks' entities go hidden before that clear. Driven through RestoreJob.step itself (a job with no record: it ends
		// broken at once), so reverting its retirement call site goes red too.
		Fake f = new Fake();
		List<Long> cs = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		f.ready.addAll(cs);
		RestoreJob job = new RestoreJob("lr2f-none", RestoreJob.REMOVE, null, null);
		assertTrue((Boolean) call(m("ready", WORLD, String.class, List.class, boolean.class), f.world(), job.entityKey(), cs, true));
		call(m("tick", int.class), f.now);
		assertTrue(job.step(null, Long.MAX_VALUE), "the job ends (no record)");
		f.ready.clear(); // the player leaves
		call(m("tick", int.class), f.now + 3);
		assertEquals(new HashSet<>(cs), f.ticket, "LR2F-retire: held through the delayed clear 3 ticks after the job ended: " + f.log);
		call(m("tick", int.class), f.now + 5);
		assertTrue(f.ticket.isEmpty(), "LR2F-retire: released after it: " + f.log);
	}

	@Test
	void aRemovalRefusedUnderKeepThenRetriedAsCascadeTicketsTheLargerFootprint() throws Throwable {
		System.out.println("ROW LR2F-footprint (unit)");
		// (fix-check P2-2) one live key ("live:remove:<site>"), two footprints: the retry's own chunks are ticketed, so it never loops NOT_LOADED
		Fake f = new Fake();
		Method live = m("requireLive", WORLD, String.class, List.class, String.class);
		List<Long> keep = chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14));
		List<Long> cascade = chunks(new Anchors.Bounds(1, 64, 1, 60, 64, 14));
		try {
			call(live, f.world(), "live:remove:a", keep, "Removing a");
			throw new AssertionError("refused");
		} catch (Sites.SiteException e) {
			assertEquals(dev.larattalabs.architect.api.Reason.NOT_LOADED, e.reason());
		}
		f.now++;
		try {
			call(live, f.world(), "live:remove:a", cascade, "Removing a");
			throw new AssertionError("refused");
		} catch (Sites.SiteException e) {
			assertEquals(dev.larattalabs.architect.api.Reason.NOT_LOADED, e.reason());
		}
		assertEquals(new HashSet<>(cascade), f.ticket, "LR2F-footprint: the CASCADE retry's whole footprint is ticketed (the KEEP lease's extra gone): " + f.log);
		f.ready.addAll(f.ticket); // what is ticketed loads
		f.now++;
		call(live, f.world(), "live:remove:a", cascade, "Removing a"); // no loop: it passes
		call(m("tick", int.class), f.now + 5);
		assertTrue(f.ticket.isEmpty(), "LR2F-footprint: released after its cleanup: " + f.log);
		assertEquals(0, call(m("held")));
	}
}
