package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (fix/double-credit) Steward's storage_hall survival check on 0.78.0: a lot cancelled mid-build (site s10) had paid nothing; the 6 gravel
 * of the cancelled revision were its road c19's, refunded once under c19's key. DR-S's group removal holds every target's credit pending,
 * s10's too (empty), and the live credit goes through {@link Builder#creditRefund}, whose early return for a credit of nothing returned
 * before anything dropped the pending credit. The empty pending credit was saved, and the next start "booked"
 * it: nothing minted (a credit of nothing books NONE), but the ledger changed across a clean restart. After the fix the live credit of
 * nothing drops its pending credit and paid record by Stockpiles.creditOfNothing, the start's own rule, and the restart changes nothing.
 */
class StockpileEmptyPendingDCTest {
	static final String OWNER = "steward_mc:measure", GRAVEL = "minecraft:gravel";
	static final String S10 = "site:s10@1794955539390", C19 = "road:c19@1794955526296";
	static final int CAP = 8 * StockLedger.STACKS_PER_CRATE;

	@Test
	void aGroupCreditOfNothingLeavesNoPendingCreditForTheRestart() {
		// the stockpile before rid 4's undo: 6 gravel delivered, consumed and paid by road c19; the lot s10 paid nothing
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(GRAVEL, 6), CAP, id -> 64);
		assertTrue(l.consume(GRAVEL, 6, CAP, id -> 64, new TreeMap<>()));
		l.pay(C19, GRAVEL, 6);
		JsonObject pile = new JsonObject();
		pile.addProperty("id", "sp1");
		pile.addProperty("owner", OWNER);
		pile.addProperty("dimension", "minecraft:overworld");
		pile.add("crates", new com.google.gson.JsonArray());
		pile.add("ledger", l.toJson());
		JsonObject root = new JsonObject();
		root.addProperty("format", 2);
		com.google.gson.JsonArray piles = new com.google.gson.JsonArray();
		piles.add(pile);
		root.add("stockpiles", piles);
		Stockpiles.readInto(root);
		Stockpiles.Pile p = Stockpiles.get(OWNER);
		int stock0 = p.ledger().stock(GRAVEL);

		// the group removal (Groups.holdPending): both targets' credits held pending before the commit
		p.ledger().holdPending(S10, Map.of(), 1L);
		p.ledger().holdPending(C19, Map.of(GRAVEL, 6), 2L);
		// the restores written: c19's credit books (the ledger half of Stockpiles.credit; its capacity needs a server) ...
		StockLedger.Credit c19 = p.ledger().credit(C19, Map.of(GRAVEL, 6), CAP, id -> 64);
		assertEquals(Map.of(GRAVEL, 6), c19.returned(), "c19's 6 gravel back once");
		// ... and s10's credit of nothing goes through the live path, Groups.credit's Builder.creditRefund
		assertFalse(Builder.creditRefund(null, OWNER, S10, Map.of(), BlockPos.ZERO, null), "nothing books for s10");
		assertEquals(stock0 + 6, p.ledger().stock(GRAVEL), "the undo gave back what rid 4 consumed, once");
		assertEquals(java.util.Set.of(), p.ledger().pendingKeys(), "no credit is left pending once every restore is written");

		// a clean stop and a start: the file read again, then the start's settle (Stockpiles.settlePendingCredits' decision and booking)
		Stockpiles.readInto(JsonParser.parseString(Stockpiles.toJson().toString()).getAsJsonObject());
		p = Stockpiles.get(OWNER);
		String before = p.ledger().toJson().toString();
		int stockBefore = p.ledger().stock(GRAVEL);
		for (String key : p.ledger().pendingKeys()) {
			Stockpiles.PendingAction a = Stockpiles.pendingAction(key, p.ledger().credited(key), false, false);
			if (a == Stockpiles.PendingAction.BOOK) {
				Stockpiles.credit(null, p, key, new TreeMap<>(p.ledger().pendingItems(key)), BlockPos.of(p.ledger().pendingAt(key)));
				p.ledger().dropPending(key);
			}
		}
		assertEquals(stockBefore, p.ledger().stock(GRAVEL), "nothing minted at the start");
		assertEquals(before, p.ledger().toJson().toString(), "after a restart: the ledger unchanged (nothing pending to settle)");
	}

	/** A clean stop and a start: the file read again, then the start's settle (Stockpiles.settlePendingCredits' decision and booking). */
	static Stockpiles.Pile restartAndSettle() {
		Stockpiles.readInto(JsonParser.parseString(Stockpiles.toJson().toString()).getAsJsonObject());
		Stockpiles.Pile p = Stockpiles.get(OWNER);
		for (String key : p.ledger().pendingKeys()) {
			if (Stockpiles.pendingAction(key, p.ledger().credited(key), false, false) == Stockpiles.PendingAction.BOOK) {
				Stockpiles.credit(null, p, key, new TreeMap<>(p.ledger().pendingItems(key)), BlockPos.of(p.ledger().pendingAt(key)));
				p.ledger().dropPending(key);
			}
		}
		return p;
	}

	static final String C71 = "road:c71@1794960000001", C72 = "road:c72@1794960000002";

	/**
	 * Steward's 0.78.0 RC stock-save flow: roads built, then removed with no refund line, and the reload "credited now" road:c71/c72/c73.
	 * The only holder of a road's pending credit is a group removal (Groups.holdPending: Stockpiles.holdPendingCredits takes sites' decs,
	 * a single road's RestoreJob holds none); its credit, live (Groups.removed -> Groups.credit) or resumed after a load, is
	 * Builder.creditRefund. Here c71 paid 3 gravel and none of it stands to refund (an empty refundOf: the cells mined or another writer's),
	 * c72 paid nothing: both credits of nothing.
	 */
	@Test
	void aGroupRemovalsRoadCreditOfNothingLeavesNoPendingCreditForTheRestart() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(GRAVEL, 3), CAP, id -> 64);
		assertTrue(l.consume(GRAVEL, 3, CAP, id -> 64, new TreeMap<>()));
		l.pay(C71, GRAVEL, 3);
		JsonObject pile = new JsonObject();
		pile.addProperty("id", "sp1");
		pile.addProperty("owner", OWNER);
		pile.addProperty("dimension", "minecraft:overworld");
		pile.add("crates", new com.google.gson.JsonArray());
		pile.add("ledger", l.toJson());
		JsonObject root = new JsonObject();
		root.addProperty("format", 2);
		com.google.gson.JsonArray piles = new com.google.gson.JsonArray();
		piles.add(pile);
		root.add("stockpiles", piles);
		Stockpiles.readInto(root);
		Stockpiles.Pile p = Stockpiles.get(OWNER);

		// the group removal's decCredit for its roads (Groups.start: RoadBuilder.refundOf, here empty), held pending by the real holdPending
		Groups.Removal r = new Groups.Removal("g1", "rv9:ground", null, true);
		r.decCredit.put("c71", new Groups.Credit(OWNER, C71, Map.of(), 11L));
		r.decCredit.put("c72", new Groups.Credit(OWNER, C72, Map.of(), 12L));
		assertTrue(Groups.holdPending(r), "both road credits held pending before the commit");
		assertEquals(java.util.Set.of(C71, C72), p.ledger().pendingKeys());
		// each road's restore written: Groups.credit's call, with the removal's saved credit
		for (Groups.Credit c : r.decCredit.values()) {
			assertFalse(Builder.creditRefund(null, c.owner(), c.key(), c.items(), BlockPos.of(c.at()), null), "nothing books for " + c.key());
		}
		assertEquals(java.util.Set.of(), p.ledger().pendingKeys(), "no road credit is left pending once its restore is written");
		String before = p.ledger().toJson().toString();
		int stockBefore = p.ledger().stock(GRAVEL);

		p = restartAndSettle();
		assertEquals(stockBefore, p.ledger().stock(GRAVEL), "nothing minted at the start");
		assertEquals(before, p.ledger().toJson().toString(), "after a restart: the ledger unchanged (no road: pending credit to settle)");
	}

	/** Every live road credit path reaches Builder.creditRefund (or Stockpiles.credit itself): none returns before the pending credit drops. */
	@Test
	void everyRoadCreditGoesThroughCreditRefund() throws Exception {
		String g = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "Groups.java");
		// (slice T4R, R1) a group member's credit is its removal.group txn's pile.refund (CrateSettle.bookRefund -> Stockpiles.credit, which
		// drops the pending credit by the credit rule). (slice T4R-M) main's direct Groups.credit is back for a pre-T4R removal only (legacyTick
		// and removed()'s legacy branch), through Builder.creditRefund
		String credit = StockpileSaveHFTest.body(g, "private static void credit(MinecraftServer server, Removal r, String id)");
		assertTrue(credit.contains("Builder.creditRefund(level, c.owner(), c.key(), c.items(), BlockPos.of(c.at()), null);"), "main's group credit");
		int calls = g.split("credit\\(server, r, ", -1).length - 1;
		assertTrue(calls == 4, "Groups.credit is called by main's legacy path only (legacyTick 3, removed()'s legacy branch 1): " + calls);
		String cs = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "CrateSettle.java");
		assertTrue(cs.contains("Stockpiles.credit(srv, p, key, new TreeMap<>(items), at);"), "a group member's credit goes through Stockpiles.credit");
		String rj = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "RestoreJob.java");
		assertTrue(rj.contains("Builder.creditRefund(level, credit.owner(), credit.key(), credit.items(), BlockPos.of(credit.at()), null)"), "a single road's");
		String b = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "Builder.java");
		String cr = StockpileSaveHFTest.body(b, "static boolean creditRefund(");
		int nothing = cr.indexOf("if (items.isEmpty() && (p == null || p.ledger().custody(key).isEmpty()))");
		int ret = cr.indexOf("return false;", nothing);
		assertTrue(nothing > 0 && cr.indexOf("Stockpiles.creditOfNothing(p, key);", nothing) > nothing
			&& cr.indexOf("Stockpiles.creditOfNothing(p, key);", nothing) < ret, "a credit of nothing drops its pending credit before it returns");
	}
}
