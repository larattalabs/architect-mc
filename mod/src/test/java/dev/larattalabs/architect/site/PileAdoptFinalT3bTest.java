package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.txn.Probe;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/** (slice T3b final check) One unit per P2: the record clear's durability, the event's limiter, a pending release's journal scope. */
class PileAdoptFinalT3bTest {
	@Test
	void aClearedRecordIsAppliedOnlyOnceItsFileIsAcknowledgedDurable() {
		// P2-1: the ordinary save wrote the cleared file (readable), but no confirmed write covers it: never APPLIED
		assertEquals(Probe.ABSENT, PileAdopt.clearProbe(false, false, false), "readable on disk is not durable");
		assertEquals(Probe.APPLIED, PileAdopt.clearProbe(false, true, false));
		assertEquals(Probe.ABSENT, PileAdopt.clearProbe(true, true, false), "memory still names it");
		assertEquals(Probe.ABSENT, PileAdopt.clearProbe(false, true, true), "the confirmed file still names it");
	}

	@Test
	void aTxnEventGoesThroughTheLimiterNeverDoubled() {
		// P2-2: the ledger's own change fired at tick 100; the txn's delivery at tick 105 marks the pile, it fires once at tick 120, not at 105
		Stockpiles.Pile p = new Stockpiles.Pile("p1", "steward", "minecraft:overworld", new StockLedger());
		p.dirty = false;
		p.lastEvent = 100;
		Stockpiles.txnChanged(p);
		assertTrue(p.dirty, "marked for the limiter: at least once");
		assertFalse(Stockpiles.eventDue(p, 105), "within 20 ticks of the last event: not doubled");
		assertTrue(Stockpiles.eventDue(p, 120));
		Stockpiles.txnChanged((Stockpiles.Pile) null); // no pile (dissolved): nothing
	}

	@Test
	void aPendingReleaseCountsOnlyForItsOwnJournal() {
		// P2-3: a release submitted to one world's journal is stale for another (a world switch, a reopen)
		Object a = new Object(), b = new Object();
		CompletableFuture<Void> f = new CompletableFuture<>();
		PileAdopt.Pending pe = new PileAdopt.Pending(a, f);
		assertSame(f, PileAdopt.pendingFor(pe, a));
		assertNull(PileAdopt.pendingFor(pe, b), "another journal instance: ignored");
		assertNull(PileAdopt.pendingFor(pe, null));
		assertEquals(Probe.APPLIED, PileAdopt.releaseProbe(PileAdopt.pendingFor(pe, b), true), "the new journal's own head decides");
		PileAdopt.PENDING_RELEASE.put("tx-1/3", pe);
		PileAdopt.worldClosed();
		assertTrue(PileAdopt.PENDING_RELEASE.isEmpty(), "cleared when the world closes");
	}
}
