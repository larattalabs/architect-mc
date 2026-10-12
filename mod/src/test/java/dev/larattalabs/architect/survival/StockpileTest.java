package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * 6c Y1 (C24) gate item 1: the stockpile ledger. The identity per item at every step, capacity in stacks (27 per crate), the
 * pooled insert rule with room, refunds credited once per key (with overflow outside the identity), adoption of a legacy crate,
 * withdrawals and drops, a bucket's container, and the persistence round trip.
 */
class StockpileTest {
	static final String COBBLE = "minecraft:cobblestone";
	static final String PLANKS = "minecraft:oak_planks";
	static final String LOG = "minecraft:oak_log";
	static final String DOOR = "minecraft:oak_door";
	static final String LAVA = "minecraft:lava_bucket";
	static final String BUCKET = "minecraft:bucket";
	static final ToIntFunction<String> MAX = id -> id.endsWith("_door") || id.endsWith("bucket") ? (id.equals(BUCKET) ? 16 : id.endsWith("_door") ? 64 : 1)
		: 64;
	static final Equivalents EQ = Equivalents.bundled();

	/** The identity checked by hand: stock = delivered + returned - consumed - withdrawn - dropped, for every item named. */
	static void identity(StockLedger l) {
		java.util.Set<String> ks = new java.util.TreeSet<>();
		for (Map<String, Integer> m : java.util.List.of(l.delivered(), l.returned(), l.consumed(), l.withdrawn(), l.dropped())) {
			ks.addAll(m.keySet());
		}
		for (String k : ks) {
			int s = l.delivered().getOrDefault(k, 0) + l.returned().getOrDefault(k, 0) - l.consumed().getOrDefault(k, 0) - l.withdrawn().getOrDefault(k, 0)
				- l.dropped().getOrDefault(k, 0);
			assertEquals(s, l.stock(k), "identity for " + k);
			assertTrue(s >= 0, "stock >= 0 for " + k);
		}
		assertTrue(l.identityHolds());
	}

	static Map<String, Integer> need(Object... kv) {
		Map<String, Integer> m = new HashMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			m.put((String) kv[i], (Integer) kv[i + 1]);
		}
		return m;
	}

	@Test
	void insertIsPooledNeedAndRoom() {
		StockLedger l = new StockLedger();
		Map<String, Integer> unbuilt = need(COBBLE, 100);
		int cap = 1; // one stack
		for (int i = 0; i < 64; i++) {
			assertNotNull(l.accept(COBBLE, k -> unbuilt.getOrDefault(k, 0), EQ, cap, MAX, true));
		}
		assertEquals(64, l.stock(COBBLE));
		assertEquals(1, l.usedStacks(MAX));
		assertNull(l.accept(COBBLE, k -> unbuilt.getOrDefault(k, 0), EQ, cap, MAX, true), "a 65th cobblestone needs a second stack");
		assertNotNull(l.accept(COBBLE, k -> unbuilt.getOrDefault(k, 0), EQ, 2, MAX, false), "fits with two stacks");
		// not needed: never accepted, even with room
		assertNull(l.accept(DOOR, k -> unbuilt.getOrDefault(k, 0), EQ, 27, MAX, true));
		identity(l);
	}

	@Test
	void equivalentGoesInOnlyWhenItsCountFits() {
		StockLedger l = new StockLedger();
		Map<String, Integer> unbuilt = need(PLANKS, 8);
		// a log becomes 4 planks: it fits while 4 more planks fit
		Ledger.Accepted a = l.accept(LOG, k -> unbuilt.getOrDefault(k, 0), EQ, 1, MAX, true);
		assertNotNull(a);
		assertEquals(PLANKS, a.item());
		assertEquals(4, a.count());
		assertEquals(4, l.stock(PLANKS));
		assertEquals(0, l.stock(LOG));
		identity(l);
	}

	@Test
	void capacityInStacks() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(COBBLE, 65, DOOR, 3), 27, MAX);
		assertEquals(3, l.usedStacks(MAX), "65 cobblestone = 2 stacks, 3 doors = 1 stack");
		assertEquals(63 + 24 * 64, l.room(COBBLE, 27, MAX), "the partial stack plus 24 free stacks");
		assertEquals(0, l.room(COBBLE, 2, MAX), "over capacity: nothing new enters");
	}

	@Test
	void consumeAndIdentityAtEveryStep() {
		StockLedger l = new StockLedger();
		Map<String, Integer> unbuilt = need(COBBLE, 10);
		for (int i = 0; i < 10; i++) {
			l.accept(COBBLE, k -> unbuilt.getOrDefault(k, 0), EQ, 27, MAX, true);
			identity(l);
		}
		Map<String, Integer> over = new TreeMap<>();
		assertTrue(l.consume(COBBLE, 4, 27, MAX, over));
		identity(l);
		assertFalse(l.consume(COBBLE, 7, 27, MAX, over), "short: nothing booked");
		assertEquals(6, l.stock(COBBLE));
		assertEquals(4, l.withdraw(COBBLE, 4));
		identity(l);
		assertEquals(2, l.drop(COBBLE, 99), "a drop is clamped to the stock");
		assertEquals(0, l.stock(COBBLE));
		identity(l);
	}

	@Test
	void refundsAreCreditedOncePerKey() {
		StockLedger l = new StockLedger();
		StockLedger.Credit a = l.credit("site:s1@5", Map.of(COBBLE, 10), 27, MAX);
		assertFalse(a.already());
		assertEquals(Map.of(COBBLE, 10), a.returned());
		StockLedger.Credit b = l.credit("site:s1@5", Map.of(COBBLE, 10), 27, MAX);
		assertTrue(b.already(), "a retried removal finds the key");
		assertTrue(b.isEmpty());
		assertEquals(10, l.stock(COBBLE));
		assertEquals(Map.of(COBBLE, 10), l.returned());
		// another placement of the same site id is another key
		l.credit("site:s1@6", Map.of(COBBLE, 1), 27, MAX);
		assertEquals(11, l.stock(COBBLE));
		identity(l);
		// the keys persist with the ledger
		StockLedger r = StockLedger.fromJson(l.toJson());
		assertTrue(r.credited("site:s1@5"));
		assertTrue(r.credit("site:s1@5", Map.of(COBBLE, 10), 27, MAX).already());
		assertEquals(l.toJson(), r.toJson());
	}

	@Test
	void refundOverflowIsOutsideTheIdentity() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(COBBLE, 60), 1, MAX);
		StockLedger.Credit c = l.credit("delta:e1:s2", Map.of(COBBLE, 10, DOOR, 2), 1, MAX);
		assertEquals(Map.of(COBBLE, 4), c.returned(), "the partial stack fills");
		assertEquals(Map.of(COBBLE, 6, DOOR, 2), c.overflow());
		assertEquals(Map.of(COBBLE, 6, DOOR, 2), l.refundOverflow());
		assertEquals(64, l.stock(COBBLE));
		assertEquals(0, l.stock(DOOR));
		identity(l);
	}

	@Test
	void adoptionKeepsTheIdentityAndDropsOnlyWhatDoesNotFit() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(PLANKS, 64 * 26), 27, MAX); // 26 stacks used, 1 free
		// a legacy crate: delivered 200 cobblestone and 10 doors, placed 70 cobblestone: stock 130 cobblestone (3 stacks) + 10 doors
		Map<String, Integer> dropped = l.adopt("adopt:group:g1@1", Map.of(COBBLE, 200, DOOR, 10), Map.of(COBBLE, 70), 27, MAX);
		identity(l);
		assertEquals(200, l.delivered().get(COBBLE));
		assertEquals(70, l.consumed().get(COBBLE));
		assertTrue(l.usedStacks(MAX) <= 27, "within capacity after the drop");
		int keptCobble = l.stock(COBBLE);
		int keptDoors = l.stock(DOOR);
		assertEquals(130, keptCobble + dropped.getOrDefault(COBBLE, 0), "every adopted cobblestone is in stock or dropped");
		assertEquals(10, keptDoors + dropped.getOrDefault(DOOR, 0));
		assertEquals(dropped, l.dropped());
		// idempotent
		assertEquals(Map.of(), l.adopt("adopt:group:g1@1", Map.of(COBBLE, 200), Map.of(), 27, MAX));
		identity(l);
	}

	@Test
	void aFilledBucketGivesItsBucketBack() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(LAVA, 2), 27, MAX);
		Map<String, Integer> over = new TreeMap<>();
		assertTrue(l.consume(LAVA, 1, 27, MAX, over));
		assertEquals(1, l.stock(BUCKET));
		assertEquals(1, l.stock(LAVA));
		assertEquals(Map.of(), over);
		identity(l);
	}

	@Test
	void persistenceRoundTrip() {
		StockLedger l = new StockLedger();
		Map<String, Integer> unbuilt = need(COBBLE, 50);
		for (int i = 0; i < 30; i++) {
			l.accept(COBBLE, k -> unbuilt.getOrDefault(k, 0), EQ, 27, MAX, true);
		}
		l.consume(COBBLE, 5, 27, MAX, new TreeMap<>());
		l.credit("k", Map.of(DOOR, 1), 27, MAX);
		l.withdraw(COBBLE, 1);
		l.drop(COBBLE, 1);
		StockLedger r = StockLedger.fromJson(l.toJson());
		assertEquals(l.stock(), r.stock());
		assertEquals(l.toJson(), r.toJson());
		identity(r);
	}
}
