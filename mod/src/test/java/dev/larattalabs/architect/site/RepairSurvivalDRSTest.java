package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice DR-S) Survival diagnose and repair, the pure parts: what the start and a repair do with a pending credit per key kind (no road's
 * credit booked while it stands, no mech key held), a group removal's credit held pending then booked once under the cap with its custody
 * (items in = items out), and the placement bound (a player's mining after a clean stop is never LAGGING).
 */
class RepairSurvivalDRSTest {
	static {
		UmtRunner.boot();
	}

	private static final String OAK = "minecraft:oak_planks";

	@Test
	void pendingActionPerKeyKind() {
		for (String key : new String[] {"site:s4@17", "road:r2@9"}) {
			assertEquals(Stockpiles.PendingAction.DROP, Stockpiles.pendingAction(key, true, false, false), key + ": credited already");
			assertEquals(Stockpiles.PendingAction.DROP, Stockpiles.pendingAction(key, false, true, false), key + ": stands (never settled)");
			assertEquals(Stockpiles.PendingAction.LEAVE, Stockpiles.pendingAction(key, false, false, true), key + ": pending (a repair settles it)");
			assertEquals(Stockpiles.PendingAction.BOOK, Stockpiles.pendingAction(key, false, false, false), key + ": settled removed: booked");
		}
		// a gate mechanism's key is no target's: never booked by the pending rule (Groups never holds it)
		assertEquals(Stockpiles.PendingAction.LEAVE, Stockpiles.pendingAction("region:g1@5:mech:lot_a", false, false, false));
		assertEquals("s4", Stockpiles.targetIdOf("site:s4@17"));
		assertEquals("r2", Stockpiles.targetIdOf("road:r2@9"));
		assertEquals("", Stockpiles.targetIdOf("region:g1@5:mech:lot_a"));
		assertTrue(StockLedger.isTargetKey("road:r2@9") && !StockLedger.isTargetKey("region:g1@5:mech:lot_a"));
	}

	@Test
	void groupCreditHeldPendingBooksOnceUnderTheCapWithItsCustody() {
		StockLedger led = new StockLedger();
		String key = "site:s7@100";
		// the target paid 20 planks; its fill's 4 flint are in custody; the removal's tally found 18 planks standing (2 were mined)
		led.pay(key, OAK, 20);
		led.pay(key, "minecraft:flint", 4);
		led.holdCustody(key, Map.of("minecraft:flint", 4));
		led.holdPending(key, Map.of(OAK, 18), 0L);
		assertTrue(led.pendingKeys().contains(key));
		StockLedger.Credit c1 = led.credit(key, led.pendingItems(key), 1000, k -> 64);
		assertEquals(Map.of(OAK, 18, "minecraft:flint", 4), c1.returned(), "items in = items out: the tally plus the custody, under the record");
		assertFalse(led.pendingKeys().contains(key), "booked: nothing pending");
		assertTrue(led.custody(key).isEmpty(), "the custody went with the credit");
		assertTrue(led.paid().get(key) == null, "the record spent with its refund (no PAID_ORPHAN after)");
		StockLedger.Credit c2 = led.credit(key, Map.of(OAK, 18), 1000, k -> 64);
		assertTrue(c2.already() && c2.returned().isEmpty(), "a second repair (or the start after it) credits nothing again");
		// never more than the record: a pending credit larger than what was paid is capped (no mint)
		String k2 = "road:r1@5";
		led.pay(k2, OAK, 3);
		led.holdPending(k2, Map.of(OAK, 9), 0L);
		StockLedger.Credit c3 = led.credit(k2, led.pendingItems(k2), 1000, k -> 64);
		assertEquals(Map.of(OAK, 3), c3.returned(), "capped at the paid record");
	}

	@Test
	void placementBoundAfterACleanOrUncleanStop() {
		long saved = 1000, start = 5000;
		JournalStore.Meta lost = JournalStore.Meta.header("j1", "site", "s1", null, "d", Journal.Policy.BOX, 1, Journal.Status.ACTIVE, 1500);
		JournalStore.Meta old = JournalStore.Meta.header("j2", "site", "s2", null, "d", Journal.Policy.BOX, 2, Journal.Status.ACTIVE, 900);
		JournalStore.Meta now = JournalStore.Meta.header("j3", "site", "s3", null, "d", Journal.Policy.BOX, 3, Journal.Status.ACTIVE, 6000);
		assertTrue(Repairs.mayLag(lost, true, start, saved, Set.of()), "committed after the last save before the unclean stop");
		assertFalse(Repairs.mayLag(old, true, start, saved, Set.of()), "saved with the world: a cell at its pre-op value is a player's mining");
		assertTrue(Repairs.mayLag(old, true, start, saved, Set.of("s2")), "a job running at that save");
		assertFalse(Repairs.mayLag(now, true, start, saved, Set.of()), "committed this session: its writes are in memory");
		assertFalse(Repairs.mayLag(lost, false, start, saved, Set.of()), "after a clean stop nothing lags");
	}
}
