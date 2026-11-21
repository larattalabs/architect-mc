package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * Slice J2 item 2 (FK's durability leftover): a single-site removal's credit held pending in the ledger, saved before the commit, booked
 * once at the next start if the removal settled and the credit's save was lost (kill point CS1, gated in fk-crash), dropped otherwise.
 */
class StockLedgerPendingJ2Test {
	static final String PLANKS = "minecraft:oak_planks", FLINT = "minecraft:flint";
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;
	static final String KEY = "site:s1@100";

	static StockLedger paid() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(PLANKS, 10, FLINT, 18), CAP, MAX);
		assertTrue(l.consume(PLANKS, 10, CAP, MAX, new java.util.TreeMap<>()));
		l.pay(KEY, PLANKS, 10);
		assertTrue(l.consume(FLINT, 18, CAP, MAX, new java.util.TreeMap<>()));
		l.pay(KEY, FLINT, 18);
		return l;
	}

	@Test
	void aPendingCreditRoundTripsAndBooksOnce() {
		StockLedger l = paid();
		l.holdCustody(KEY, Map.of(FLINT, 18));
		l.holdPending(KEY, Map.of(PLANKS, 10), 12345L);
		StockLedger saved = StockLedger.fromJson(JsonParser.parseString(l.toJson().toString()).getAsJsonObject());
		assertEquals(java.util.Set.of(KEY), saved.pendingKeys(), "saved with the custody, before the commit");
		assertEquals(Map.of(PLANKS, 10), saved.pendingItems(KEY));
		assertEquals(12345L, saved.pendingAt(KEY));
		// the start books it (Stockpiles.settlePendingCredits -> credit): blocks and custody, once
		StockLedger.Credit c = saved.credit(KEY, saved.pendingItems(KEY), CAP, MAX);
		assertEquals(Map.of(PLANKS, 10, FLINT, 18), c.returned());
		assertTrue(saved.pendingKeys().isEmpty() && saved.custody(KEY).isEmpty(), "booked: nothing pending, no custody");
		assertTrue(saved.credit(KEY, Map.of(PLANKS, 10), CAP, MAX).already(), "a second credit of the key books nothing");
		StockLedger again = StockLedger.fromJson(JsonParser.parseString(saved.toJson().toString()).getAsJsonObject());
		assertTrue(again.pendingKeys().isEmpty() && again.credited(KEY));
	}

	@Test
	void aPendingCreditWithOnlyCustodyKeepsItsKey() {
		StockLedger l = paid();
		l.holdPending(KEY, Map.of(), 7L);
		StockLedger saved = StockLedger.fromJson(JsonParser.parseString(l.toJson().toString()).getAsJsonObject());
		assertEquals(java.util.Set.of(KEY), saved.pendingKeys());
		saved.dropPending(KEY);
		assertFalse(saved.pendingKeys().contains(KEY));
	}

	@Test
	void theRemovalHoldsItsCreditsBeforeItsCommitAndTheStartSettlesThem() throws Exception {
		String site = "src/main/java/dev/larattalabs/architect/site/";
		String sites = Files.readString(Path.of(site + "Sites.java"));
		// (slice T4b, N8) a stockpile site's refunds are a stash (CrateSettle.pileStash) held durable with the others, saved confirmed, before
		// the commit; its removal txn credits them after the restore (the J2 pending credit is legacy only)
		int pile = sites.indexOf("CrateSettle.pileStash(");
		int hold = sites.indexOf("CrateSettle.holdDurable(stashes)", pile);
		int save = sites.indexOf("Stockpiles.saveWithWorldConfirmed(server);", hold);
		int refused = sites.indexOf("stashes.keySet().forEach(CrateSettle::forgetDurable)", save);
		int kill = sites.indexOf("WorldJournal.kill(\"FKC1\")", hold);
		int commit = sites.indexOf("SiteJournal.submitUndo(plan)", hold); // (slice T4R-L) planned before the save, submitted after it
		assertTrue(pile > 0 && hold > pile && save > hold && refused > save && kill > refused && commit > kill, "held, saved (a refusal undoes the hold), then committed");
		String fills = Files.readString(Path.of(site + "Fills.java"));
		int at = fills.indexOf("public static void atStart(MinecraftServer srv) {");
		assertTrue(fills.indexOf("Stockpiles.settlePendingCredits(srv);", at) - at < 120, "the pending credits settle before the custody write-back");
		String b = Files.readString(Path.of(site + "Builder.java"));
		assertTrue(b.contains("Stockpiles.saveCreditPending(level.getServer());"), "a deconstruct's credit save that SS refuses leaves it pending");
	}
}
