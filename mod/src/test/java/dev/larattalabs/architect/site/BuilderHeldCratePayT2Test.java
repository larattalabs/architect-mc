package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (T2b final check P1-1, T2b2-gpt.log) A held crate funds no placement: while a txn holds its ledger, {@code stock()} reports nothing to
 * any affordability check (the builder's, a road's), and {@link Builder#pay} consumes nothing and answers false, so its caller doesn't place
 * (the base ignored {@code consume}'s false and placed for free). Across "ticks" (repeated tries) the stock is unchanged; released, it pays.
 */
class BuilderHeldCratePayT2Test {
	static final String P = "minecraft:oak_planks";

	@Test
	void aHeldCrateFundsNothingAcrossTicksAndPaysOnceReleased() {
		Ledger l = new Ledger();
		l.load(Map.of(P, 8), Map.of());
		boolean[] held = {true};
		l.guard(() -> held[0]);
		List<SurvivalItems.Cost> cell = List.of(new SurvivalItems.Cost(P, 2));
		for (int tick = 0; tick < 5; tick++) {
			assertEquals(0, l.stock(P), "held: the affordability check sees no stock");
			assertTrue(l.stock().isEmpty(), "held: no stock listed");
			assertFalse(Builder.pay(l, cell), "held: not paid, so not placed");
		}
		assertEquals(8, l.heldStock(P), "held across ticks: the stock unchanged");
		assertEquals(0, l.placed(P));
		held[0] = false;
		assertEquals(8, l.stock(P));
		assertTrue(Builder.pay(l, cell));
		assertEquals(6, l.stock(P));
		assertFalse(Builder.pay(l, List.of(new SurvivalItems.Cost(P, 4), new SurvivalItems.Cost(P, 4))), "short: nothing of it consumed");
		assertEquals(6, l.stock(P));
	}
}
