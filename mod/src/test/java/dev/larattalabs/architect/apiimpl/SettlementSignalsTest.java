package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (8b EV) SETTLEMENT_CHANGED's coalescing: a mark fires within 20 ticks; 100 edges in a tick give one event; an edge inside the window is
 * deferred to the window's end, never dropped; keys are per (owner, region); a player's own (null owner) has no settlement.
 */
class SettlementSignalsTest {
	private static final SettlementSignals.Key A = new SettlementSignals.Key("steward_mc:settlement/1", "rg1");
	private static final SettlementSignals.Key B = new SettlementSignals.Key("steward_mc:settlement/1", null);

	@Test
	void aMarkFiresAtOnceThenTheWindowHolds() {
		var c = new SettlementSignals.Coalescer();
		for (int i = 0; i < 100; i++) {
			c.mark(A);
		}
		assertEquals(List.of(A), c.due(100), "100 edges in a tick: one event");
		assertEquals(List.of(), c.due(101));
		c.mark(A); // t+5: inside the window
		assertEquals(List.of(), c.due(105), "deferred");
		assertEquals(List.of(), c.due(119));
		assertEquals(List.of(A), c.due(120), "fires when the window opens: never dropped");
		assertTrue(c.idle());
	}

	@Test
	void everySourceFiresWithin20Ticks() {
		var c = new SettlementSignals.Coalescer();
		List<SettlementSignals.Key> fired = new ArrayList<>();
		long t = 1000;
		c.due(t); // nothing
		for (int edge = 0; edge < 50; edge++) {
			c.mark(edge % 2 == 0 ? A : B);
			long markedAt = t;
			boolean seen = false;
			for (int k = 0; k <= SettlementSignals.EVERY; k++) {
				List<SettlementSignals.Key> d = c.due(t++);
				fired.addAll(d);
				if (!d.isEmpty()) {
					seen = true;
					assertTrue(t - 1 - markedAt <= SettlementSignals.EVERY);
					break;
				}
			}
			assertTrue(seen, "edge " + edge + " fired within the window");
		}
		assertTrue(fired.contains(A) && fired.contains(B), "keys are per (owner, region)");
	}

	@Test
	void noOwnerNoSettlement() {
		SettlementSignals.C.clear();
		SettlementSignals.mark(null, "rg1");
		SettlementSignals.mark(" ", null);
		assertTrue(SettlementSignals.C.idle());
		SettlementSignals.mark("o", null);
		assertEquals(List.of(new SettlementSignals.Key("o", null)), SettlementSignals.C.due(5));
	}
}
