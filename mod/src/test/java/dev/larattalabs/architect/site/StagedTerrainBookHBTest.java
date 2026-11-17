package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.StockLedger;
import org.junit.jupiter.api.Test;

/**
 * (8a HB, docs/CONTRACT.md "Phase 8a" §4) A staged terrain target's RL cell book marks every cell free: every cell known, none standing
 * paid, none owed, saved with the ledger as such (the reconcile charges, owes and gives back nothing for it); a target recorded BUILT with
 * cells missing builds again, unless a removal has it.
 */
class StagedTerrainBookHBTest {
	static final int[] QUEUE = {7, 3, 9, 1, 4, 12, 0, 5};

	@Test
	void freeBookKnowsEveryCellAndOwesNothing() {
		StockLedger.Book b = Stockpiles.freeBook(QUEUE);
		assertTrue(b.fits(QUEUE), "the book indexes the target's queue");
		assertEquals(QUEUE.length, b.known().cardinality(), "every staged cell known");
		assertTrue(b.standing().isEmpty(), "no staged cell stands paid");
		assertTrue(b.owed().isEmpty(), "no staged cell is owed");
		// saved with the ledger: read back the same (no `o` written)
		StockLedger l = new StockLedger();
		l.book("road:c4@100", b);
		JsonObject j = l.toJson();
		JsonObject cell = j.getAsJsonObject("cells").getAsJsonObject("road:c4@100");
		assertFalse(cell.has("o"), "no owed bits on the disk");
		StockLedger.Book back = StockLedger.fromJson(JsonParser.parseString(j.toString()).getAsJsonObject()).book("road:c4@100");
		assertNotNull(back);
		assertTrue(back.fits(QUEUE) && back.standing().isEmpty() && back.owed().isEmpty() && back.known().cardinality() == QUEUE.length);
	}

	@Test
	void aBuiltTargetWithCellsMissingBuildsAgain() {
		assertTrue(Stockpiles.terrainReopens(false, 3, false), "BUILT, 3 cells missing from the saved world: builds again");
		assertFalse(Stockpiles.terrainReopens(false, 0, false), "BUILT, every cell standing: stays BUILT");
		assertFalse(Stockpiles.terrainReopens(true, 3, false), "still building: nothing to reopen");
		assertFalse(Stockpiles.terrainReopens(false, 3, true), "a removal has it: not reopened");
	}
}
