package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** (slice T2b fix round) The owed ledger's markers and the receipt pruning's durability rule. */
class OwedLedgerT2bFixTest {
	@AfterEach
	void reset() {
		OwedLedger.clear();
		OwedLedger.PINNED = k -> false;
		OwedLedger.TEST_UNMARKED = false;
	}

	static OwedLedger.Entry entry(String key, int n) {
		return new OwedLedger.Entry(key, "p", "minecraft:overworld", 0, 64, 0, Map.of("minecraft:oak_planks", n), OwedLedger.CRATE_SETTLE, 1, 1, null, null);
	}

	/** Runs a held collect's debit, then 5,000 unrelated effects; answers whether the debit's marker is still there. */
	static boolean markerSurvives() {
		OwedLedger.owe(entry("k", 20), "tx-1/0");
		OwedLedger.debit("k", Map.of("minecraft:oak_planks", 10), "tx-2/0"); // the held collect's debit
		for (int i = 0; i < 5000; i++) {
			OwedLedger.owe(entry("u" + i, 1), "tx-" + (10 + i) + "/0");
		}
		return OwedLedger.applied("tx-2/0");
	}

	/** GPT P1-3, failing first: unpinned (FIFO), the open collect's marker is evicted; its redo would debit the entry twice. */
	@Test
	void anOpenTxnsMarkerIsNeverEvicted() {
		assertFalse(markerSurvives(), "FIFO eviction (the reviewed bug) drops it");
		OwedLedger.clear();
		OwedLedger.PINNED = k -> k.startsWith("tx-2/"); // tx-2 open: pinned
		assertTrue(markerSurvives(), "pinned while its txn is open");
		assertEquals(10, OwedLedger.get("k").items().get("minecraft:oak_planks"));
	}

	/** GPT P2-5: owed state changes only with a txn marker (the TEST hook aside). */
	@Test
	void anUnmarkedOweIsRefused() {
		assertThrows(IllegalStateException.class, () -> OwedLedger.owe(entry("x", 1), null));
		OwedLedger.TEST_UNMARKED = true;
		assertTrue(OwedLedger.owe(entry("x", 1), null));
	}

	/** GPT P1-4: a loaded ledger's write-back keys prune receipts only once its generation is confirmed. */
	@Test
	void pruningWaitsForTheLoadedGenerationsConfirmation() {
		assertFalse(Stockpiles.pruneConfirmed(0, 7, false), "loaded at 7, its re-force not returned (written 0)");
		assertFalse(Stockpiles.pruneConfirmed(7, 7, true), "in doubt");
		assertFalse(Stockpiles.pruneConfirmed(5, 0, false), "nothing loaded");
		assertTrue(Stockpiles.pruneConfirmed(7, 7, false));
		assertTrue(Stockpiles.pruneConfirmed(9, 7, false));
		assertEquals(Set.of(), Set.copyOf(Stockpiles.DURABLE_WB)); // nothing loaded in a unit
	}
}
