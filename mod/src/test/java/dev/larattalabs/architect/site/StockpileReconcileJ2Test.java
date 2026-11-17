package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Slice J2, RL6 (docs/CONTRACT.md "Slice J2 as built"): after a crash mid-swap the reconcile gives a swap's old block back out of the record,
 * as Builder.refundSwap does, before it charges the new block. The world half is gated in game (rl-crash-j2 RL6). Source guards.
 */
class StockpileReconcileJ2Test {
	@Test
	void theReconcileRedoesALostSwapGiveBack() throws Exception {
		String sp = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "Stockpiles.java");
		String rc = StockpileSaveHFTest.body(sp, "static boolean reconcile(MinecraftServer srv, ServerLevel level, Pile p, Object t, String key");
		int sw = rc.indexOf("swapOldCost(level, r, ahead, free)");
		// (slice T0) the refund and the charge through refundAtStart / consumeAtStart (OVF's unbounded credit: nothing dropped)
		int back = rc.indexOf("refundAtStart(p, id, swapOld");
		int charge = rc.indexOf("consumeAtStart(");
		assertTrue(sw >= 0 && back > sw && charge > back, "the old blocks given back out of the record, then the new ones charged");
		String ra = StockpileSaveHFTest.body(sp, "static AtStart refundAtStart(");
		assertTrue(ra.indexOf("p.ledger.fromPaid(id, cost, placedAt)") < ra.indexOf("p.ledger.giveBack(back, cap, Stockpiles::maxStack, true)"),
			"out of the record, then into the stock");
		String b = StockpileSaveJ1Test.read(StockpileSaveJ1Test.SITE + "Builder.java");
		String rs = StockpileSaveHFTest.body(b, "private static void refundSwap(");
		assertTrue(rs.contains("if (swapRefunds(r, i, free))"), "refundSwap and the reconcile share one rule");
		String so = StockpileSaveHFTest.body(sp, "static Map<String, Integer> swapOldCost(");
		assertTrue(so.contains("Builder.swapRefunds(r, i, free)") && so.contains("Placed.record(level, r.pos(i)) == null"), "a player's cell gives nothing back");
	}
}
