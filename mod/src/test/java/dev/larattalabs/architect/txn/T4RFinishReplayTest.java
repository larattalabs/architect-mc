package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R, row T4R-finish-replay; P1-4) A removal txn's cached result is complete: a replayed settle (or REMOVAL_FINISHED after a
 * recovery) rebuilds {@code given}, the restore counts, the hand-down and the cascade from the txn entry, never an empty map; a pile-only
 * refund (the L {@code pile.refund}, no crate) is in {@code refund}.
 */
class T4RFinishReplayTest {
	@Test
	void aReplayedResultIsComplete() {
		System.out.println("ROW T4R-finish-replay");
		TxnEntry t = new TxnEntry("tx-9", RemovalTxn.SITE, 1, "pile-refund:site:s1@5", 0, 0, null, List.of("site:s1"), "none");
		t.effects.add(RemovalTxn.pileRefund("pile:o", "site:s1@5", Map.of("minecraft:stone", 3), BlockPos.ZERO).build(0));
		JsonObject fin = new JsonObject();
		fin.addProperty("kind", "site");
		fin.addProperty("id", "s1");
		fin.addProperty("restored", 12);
		fin.addProperty("kept", 1);
		JsonObject h = new JsonObject();
		h.addProperty("s0", 2);
		fin.add("handed", h);
		JsonArray c = new JsonArray();
		c.add("c1");
		fin.add("cascaded", c);
		t.payloads.add("removal_finished", fin);
		JsonObject r = CrateTxn.resultOf(t);
		System.out.println("ROW T4R-finish-replay result " + r);
		assertTrue(r.get("given") instanceof JsonObject g && g.has("minecraft:stone") && g.get("minecraft:stone").getAsInt() == 3,
			"T4R-finish-replay: given rebuilt from the entry (" + r + ")");
		assertTrue(r.get("refund") instanceof JsonObject f && f.has("minecraft:stone") && f.get("minecraft:stone").getAsInt() == 3,
			"T4R-finish-replay: the pile-only refund is in refund (" + r + ")");
		assertEquals(12, r.has("restored") ? r.get("restored").getAsInt() : 0, "T4R-finish-replay: restore count (" + r + ")");
		assertEquals(1, r.has("kept") ? r.get("kept").getAsInt() : 0, "T4R-finish-replay: kept count (" + r + ")");
		assertTrue(r.get("handed") instanceof JsonObject hh && hh.has("s0"), "T4R-finish-replay: hand-down (" + r + ")");
		assertTrue(r.get("cascaded") instanceof JsonArray cc && cc.size() == 1, "T4R-finish-replay: cascade (" + r + ")");
	}
}
