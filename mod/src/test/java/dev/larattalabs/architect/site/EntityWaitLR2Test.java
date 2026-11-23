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
	void theDropAreaIsTheBoxInflatedByOne() throws Throwable {
		System.out.println("ROW LR2F-area (unit)");
		// x 15..30, z 0..14: inflated, x 14..31 (chunks 0, 1), z -1..15 (chunks -1, 0)
		assertEquals(Set.of(pack(0, -1), pack(0, 0), pack(1, -1), pack(1, 0)), new HashSet<>(chunks(new Anchors.Bounds(15, 64, 0, 30, 70, 14))));
		// maxX 15: maxX+1 = 16 crosses into chunk 1; minX 16: minX-1 = 15 reaches back into chunk 0
		assertTrue(chunks(new Anchors.Bounds(1, 64, 1, 15, 64, 14)).contains(pack(1, 0)), "maxX+1 across the chunk edge");
		assertTrue(chunks(new Anchors.Bounds(16, 64, 1, 20, 64, 14)).contains(pack(0, 0)), "minX-1 across the chunk edge");
		assertEquals(1, chunks(new Anchors.Bounds(1, 64, 1, 14, 64, 14)).size(), "inside one chunk");
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
	void aReadyWorldTakesNoTicket() throws Throwable {
		System.out.println("ROW LR2F-ready (unit)");
		Fake f = new Fake();
		List<Long> cs = chunks(new Anchors.Bounds(0, 64, 0, 40, 70, 40));
		f.ready.addAll(cs);
		assertEquals("x", call(m("gated", WORLD, String.class, List.class, Supplier.class), f.world(), "s|g", cs, (Supplier<String>) () -> "x"));
		assertTrue(f.log.isEmpty(), "a live write with its entities loaded takes no ticket");
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
}
