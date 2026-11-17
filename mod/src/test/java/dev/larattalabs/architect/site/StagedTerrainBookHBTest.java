package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8a HB, docs/CONTRACT.md "Phase 8a" §4) A staged terrain target's RL cell book marks every cell free: every cell known, none standing
 * paid, none owed, saved with the ledger as such (the reconcile charges, owes and gives back nothing for it). A typed wait's payload
 * ({@code architect_mc:waitsFor}) lives only for the wait it was set for: an untyped wait after it clears it.
 */
class StagedTerrainBookHBTest {
	static final int[] QUEUE = {7, 3, 9, 1, 4, 12, 0, 5};

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap(); // (Batches' class init reads the registries)
	}

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
	void anUntypedWaitClearsAStaleTypedPayload() {
		QItem i = new QItem("t:fluids:1", "fluids", List.of(), "tile", "minecraft:overworld", 0, 64, 0, 0, false, new JsonObject(), null, false, false);
		JsonObject w = new JsonObject();
		w.addProperty("kind", RegionTargets.WAIT_KIND_TERRAIN);
		w.addProperty("target", "c4");
		// a typed wait: its writer sets the payload and marks it, so the wait put on next keeps it
		i.ext.add(RegionTargets.EXT_WAITS_FOR, w);
		TypedWaits.typed(i);
		assertTrue(TypedWaits.settle(i), "the typed wait keeps its payload");
		assertTrue(i.ext.has(RegionTargets.EXT_WAITS_FOR));
		// the next wait is untyped (the fluids gate's materials or player wait): the old kind "terrain" payload goes
		assertFalse(TypedWaits.settle(i), "an untyped wait keeps nothing");
		assertFalse(i.ext.has(RegionTargets.EXT_WAITS_FOR), "no stale payload beside the new reason");
	}
}
